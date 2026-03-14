/**
 * firestoreSync.ts
 *
 * Communicates with Firestore using the REST API (no Firebase SDK in the
 * service worker — keeps MV3 compatibility and avoids CSP issues).
 *
 * Firestore path structure:
 *   users/{uid}/games/{gameId}          – StoredGame document
 *   users/{uid}/card_events/{gameId}    – { events: CardEvent[] } document
 *   users/{uid}/game_snapshots/{gameId} – { snapshots: RoundSnapshot[] } document
 *
 * Authentication: The caller passes an AuthState object.  This module
 * transparently refreshes the ID token when it is about to expire and
 * persists the new token back to browser.storage.local.
 */

import browser from 'webextension-polyfill';
import type { AuthState, SyncStatus } from '../shared/types';
import type { StoredGame, CardEvent } from './db';
import type { RoundSnapshot } from '../shared/types';

// ─── Token helpers ────────────────────────────────────────────────────────────

const TOKEN_REFRESH_URL =
  'https://securetoken.googleapis.com/v1/token?key=';

/** Returns true when the token will expire within the next 5 minutes. */
function isTokenExpiringSoon(auth: AuthState): boolean {
  return Date.now() >= auth.idTokenExpiry - 5 * 60 * 1000;
}

/**
 * Refreshes the ID token using the stored refresh token and persists the
 * updated AuthState to browser.storage.local.  Returns the updated state.
 */
export async function refreshToken(auth: AuthState, apiKey: string): Promise<AuthState> {
  const resp = await fetch(`${TOKEN_REFRESH_URL}${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  }

  const json = await resp.json() as {
    id_token: string;
    refresh_token: string;
    expires_in: string;
  };

  const updated: AuthState = {
    ...auth,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    idTokenExpiry: Date.now() + parseInt(json.expires_in, 10) * 1000,
  };

  await browser.storage.local.set({ kb_auth: updated });
  return updated;
}

/**
 * Returns a valid ID token for the given AuthState, refreshing if needed.
 * Mutates and persists the auth state in place.
 */
async function getValidToken(auth: AuthState, apiKey: string): Promise<{ token: string; auth: AuthState }> {
  if (isTokenExpiringSoon(auth)) {
    const refreshed = await refreshToken(auth, apiKey);
    return { token: refreshed.idToken, auth: refreshed };
  }
  return { token: auth.idToken, auth };
}

// ─── Firestore REST helpers ───────────────────────────────────────────────────

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects';

function docPath(projectId: string, uid: string, collection: string, docId: string): string {
  return `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/users/${uid}/${collection}/${docId}`;
}

function collectionPath(projectId: string, uid: string, collection: string): string {
  return `${FIRESTORE_BASE}/${projectId}/databases/(default)/documents/users/${uid}/${collection}`;
}

/** Serialises a plain JS object into Firestore's REST wire format (fields map). */
function toFirestoreFields(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    fields[k] = valueToFirestore(v);
  }
  return { fields };
}

function valueToFirestore(val: unknown): unknown {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(valueToFirestore) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      fields[k] = valueToFirestore(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

/** Deserialises a Firestore REST response document back to a plain JS object. */
function fromFirestoreDoc(doc: { fields?: Record<string, unknown> }): Record<string, unknown> {
  if (!doc.fields) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    result[k] = fromFirestoreValue(v as Record<string, unknown>);
  }
  return result;
}

function fromFirestoreValue(v: Record<string, unknown>): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue as string, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) {
    const arr = (v.arrayValue as { values?: unknown[] }).values ?? [];
    return arr.map((item) => fromFirestoreValue(item as Record<string, unknown>));
  }
  if ('mapValue' in v) {
    return fromFirestoreDoc(v.mapValue as { fields?: Record<string, unknown> });
  }
  return null;
}

async function firestoreSet(
  url: string,
  token: string,
  body: Record<string, unknown>
): Promise<void> {
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Firestore write failed [${resp.status}]: ${await resp.text()}`);
  }
}

async function firestoreList(
  url: string,
  token: string
): Promise<{ name: string; fields?: Record<string, unknown> }[]> {
  const results: { name: string; fields?: Record<string, unknown> }[] = [];
  let pageToken: string | undefined;

  do {
    const pageUrl = pageToken ? `${url}?pageToken=${encodeURIComponent(pageToken)}` : url;
    const resp = await fetch(pageUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 404) break; // collection doesn't exist yet
    if (!resp.ok) {
      throw new Error(`Firestore list failed [${resp.status}]: ${await resp.text()}`);
    }
    const json = await resp.json() as {
      documents?: { name: string; fields?: Record<string, unknown> }[];
      nextPageToken?: string;
    };
    results.push(...(json.documents ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FirestoreSyncDeps {
  auth: AuthState;
  projectId: string;
  apiKey: string;
}

/** Push a single new game record (game header + events + snapshots) to Firestore. */
export async function syncNewGame(
  deps: FirestoreSyncDeps,
  game: StoredGame,
  events: CardEvent[],
  snapshots: { gameId: string; snapshots: RoundSnapshot[] } | undefined
): Promise<AuthState> {
  let { auth } = deps;
  const { projectId, apiKey } = deps;

  const { token, auth: freshAuth } = await getValidToken(auth, apiKey);
  auth = freshAuth;

  await Promise.all([
    firestoreSet(
      docPath(projectId, auth.uid, 'games', game.gameId),
      token,
      toFirestoreFields(game)
    ),
    firestoreSet(
      docPath(projectId, auth.uid, 'card_events', game.gameId),
      token,
      toFirestoreFields({ events })
    ),
    snapshots
      ? firestoreSet(
          docPath(projectId, auth.uid, 'game_snapshots', game.gameId),
          token,
          toFirestoreFields({ snapshots: snapshots.snapshots })
        )
      : Promise.resolve(),
  ]);

  return auth;
}

/** Push multiple games in bulk — used for the initial local → cloud upload. */
export async function pushLocalGames(
  deps: FirestoreSyncDeps,
  games: StoredGame[],
  events: CardEvent[],
  snapshots: { gameId: string; snapshots: RoundSnapshot[] }[]
): Promise<{ pushed: number; auth: AuthState }> {
  let { auth } = deps;
  const { projectId, apiKey } = deps;
  let pushed = 0;

  for (const game of games) {
    const { token, auth: freshAuth } = await getValidToken(auth, apiKey);
    auth = freshAuth;

    const gameEvents = events.filter((e) => e.gameId === game.gameId);
    const gameSnaps = snapshots.find((s) => s.gameId === game.gameId);

    await Promise.all([
      firestoreSet(
        docPath(projectId, auth.uid, 'games', game.gameId),
        token,
        toFirestoreFields(game)
      ),
      firestoreSet(
        docPath(projectId, auth.uid, 'card_events', game.gameId),
        token,
        toFirestoreFields({ events: gameEvents })
      ),
      gameSnaps
        ? firestoreSet(
            docPath(projectId, auth.uid, 'game_snapshots', game.gameId),
            token,
            toFirestoreFields({ snapshots: gameSnaps.snapshots })
          )
        : Promise.resolve(),
    ]);

    pushed++;
  }

  return { pushed, auth };
}

/** Pull all games from Firestore.  Returns data shaped for importGames(). */
export async function pullAllGames(deps: FirestoreSyncDeps): Promise<{
  games: StoredGame[];
  events: CardEvent[];
  snapshots: { gameId: string; snapshots: RoundSnapshot[] }[];
  auth: AuthState;
}> {
  let { auth } = deps;
  const { projectId, apiKey } = deps;

  const { token, auth: freshAuth } = await getValidToken(auth, apiKey);
  auth = freshAuth;

  const [gameDocs, eventDocs, snapDocs] = await Promise.all([
    firestoreList(collectionPath(projectId, auth.uid, 'games'), token),
    firestoreList(collectionPath(projectId, auth.uid, 'card_events'), token),
    firestoreList(collectionPath(projectId, auth.uid, 'game_snapshots'), token),
  ]);

  const games = gameDocs.map((doc) => fromFirestoreDoc(doc) as unknown as StoredGame);

  const events: CardEvent[] = eventDocs.flatMap((doc) => {
    const data = fromFirestoreDoc(doc) as { events?: CardEvent[] };
    return data.events ?? [];
  });

  const snapshots: { gameId: string; snapshots: RoundSnapshot[] }[] = snapDocs.map((doc) => {
    const data = fromFirestoreDoc(doc) as { snapshots?: RoundSnapshot[] };
    // Extract gameId from the document name: …/game_snapshots/{gameId}
    const parts = doc.name.split('/');
    return { gameId: parts[parts.length - 1], snapshots: data.snapshots ?? [] };
  });

  return { games, events, snapshots, auth };
}
