/**
 * db.ts
 *
 * IndexedDB schema and typed access via `idb`.
 *
 * Object stores:
 *  games       – one row per GameRecord (minus cardEvents & rawLog for perf)
 *  card_events – one row per CardEvent (foreign key: gameId)
 *  raw_logs    – one row per game: { gameId, entries: IChatEntry[] }
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { CardEvent, CardStats, GameRecord, GamePlayer, IChatEntry, MatchupRow, RoundSnapshot } from '../shared/types';

const DB_NAME = 'kb-tracker';
const DB_VERSION = 2;

// Stored game header (no cardEvents, rawLog or snapshots inline — stored separately)
export type StoredGame = Omit<GameRecord, 'cardEvents' | 'rawLog' | 'snapshots'>;

interface KBTrackerDB extends DBSchema {
  games: {
    key: string; // gameId
    value: StoredGame;
    indexes: {
      by_date: string;
      by_limited: boolean;
    };
  };
  card_events: {
    key: number; // auto-increment
    value: CardEvent;
    indexes: {
      by_game: string;
      by_card: string;
      by_player: string;
    };
  };
  raw_logs: {
    key: string; // gameId
    value: { gameId: string; entries: IChatEntry[] };
  };
  game_snapshots: {
    key: string; // gameId
    value: { gameId: string; snapshots: RoundSnapshot[] };
  };
}

let _db: IDBPDatabase<KBTrackerDB> | null = null;

async function getDb(): Promise<IDBPDatabase<KBTrackerDB>> {
  if (_db) return _db;
  _db = await openDB<KBTrackerDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        // games store
        const gamesStore = db.createObjectStore('games', { keyPath: 'gameId' });
        gamesStore.createIndex('by_date', 'completedAt');
        gamesStore.createIndex('by_limited', 'isLimitedFormat');

        // card_events store
        const eventsStore = db.createObjectStore('card_events', {
          autoIncrement: true,
        });
        eventsStore.createIndex('by_game', 'gameId');
        eventsStore.createIndex('by_card', 'cardId');
        eventsStore.createIndex('by_player', 'playerId');

        // raw_logs store
        db.createObjectStore('raw_logs', { keyPath: 'gameId' });
      }
      if (oldVersion < 2) {
        // round snapshots store (added in v2)
        db.createObjectStore('game_snapshots', { keyPath: 'gameId' });
      }
    },
  });
  return _db;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export async function saveGameRecord(record: GameRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['games', 'card_events', 'raw_logs', 'game_snapshots'], 'readwrite');

  // 1. Save stripped game header
  const header: StoredGame = {
    gameId: record.gameId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    format: record.format,
    isLimitedFormat: record.isLimitedFormat,
    players: record.players,
    winner: record.winner,
    rounds: record.rounds,
  };
  await tx.objectStore('games').put(header);

  // 2. Save card events
  for (const evt of record.cardEvents) {
    await tx.objectStore('card_events').add(evt);
  }

  // 3. Save raw log
  await tx.objectStore('raw_logs').put({ gameId: record.gameId, entries: record.rawLog });

  // 4. Save round snapshots
  await tx.objectStore('game_snapshots').put({ gameId: record.gameId, snapshots: record.snapshots });

  await tx.done;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getRecentGames(limit: number): Promise<StoredGame[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('games', 'by_date');
  // by_date index returns ascending; reverse for most-recent-first
  return all.reverse().slice(0, limit);
}

export async function getGameDetail(gameId: string): Promise<GameRecord | null> {
  const db = await getDb();
  const header = await db.get('games', gameId);
  if (!header) return null;

  const cardEvents = await db.getAllFromIndex('card_events', 'by_game', gameId);
  const logRow = await db.get('raw_logs', gameId);

  return {
    ...header,
    cardEvents,
    rawLog: logRow?.entries ?? [],
  };
}

export async function getAllCardEvents(gameId?: string): Promise<CardEvent[]> {
  const db = await getDb();
  if (gameId) {
    return db.getAllFromIndex('card_events', 'by_game', gameId);
  }
  return db.getAll('card_events');
}

// ─── Aggregations ────────────────────────────────────────────────────────────

/** Returns unique leaders (from `you` perspective) seen across recorded games. */
export async function getLeaderList(
  playerName?: string
): Promise<Pick<GamePlayer, 'leaderId' | 'leaderName' | 'leaderSetId'>[]> {
  const db = await getDb();
  const games = await db.getAll('games');
  const seen = new Map<string, Pick<GamePlayer, 'leaderId' | 'leaderName' | 'leaderSetId'>>();
  for (const g of games) {
    const you = playerName
      ? g.players.find((p) => p.name === playerName)
      : g.players[0];
    if (!you || !you.leaderId) continue;
    if (!seen.has(you.leaderId)) {
      seen.set(you.leaderId, {
        leaderId: you.leaderId,
        leaderName: you.leaderName,
        leaderSetId: you.leaderSetId,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.leaderName.localeCompare(b.leaderName));
}

export async function getBaseColorList(
  leaderId?: string,
  playerName?: string
): Promise<string[]> {
  const db = await getDb();
  const games = await db.getAll('games');
  const aspects = new Set<string>();
  for (const g of games) {
    const you = playerName
      ? g.players.find((p) => p.name === playerName)
      : g.players[0];
    if (!you) continue;
    if (leaderId && you.leaderId !== leaderId) continue;
    for (const a of (you.baseAspects ?? [])) aspects.add(a);
  }
  return [...aspects].sort();
}

export async function getCardStats(
  formatFilter: string,
  playerName?: string,
  leaderId?: string,
  baseAspect?: string
): Promise<CardStats[]> {
  const db = await getDb();
  let games: StoredGame[] = await db.getAll('games');
  games = games.filter((g) => !g.hidden);
  if (formatFilter === 'limited') games = games.filter((g) => g.isLimitedFormat);
  else if (formatFilter === 'eternal') games = games.filter((g) => g.format === 'open');
  else if (formatFilter === 'premier') games = games.filter((g) => !g.isLimitedFormat && g.format !== 'open');

  // Leader / base-aspect filter (applied to players[0] = local player)
  if (leaderId || baseAspect) {
    games = games.filter((g) => {
      const you = playerName
        ? g.players.find((p) => p.name === playerName)
        : g.players[0];
      if (!you) return false;
      if (leaderId && you.leaderId !== leaderId) return false;
      if (baseAspect && !(you.baseAspects ?? []).includes(baseAspect)) return false;
      return true;
    });
  }

  // Build win-result lookup keyed by gameId
  const gameWinnerMap = new Map<string, string | null>(); // gameId → winner name
  const gameLocalMap = new Map<string, string>();          // gameId → local player name
  for (const g of games) {
    const you = playerName
      ? g.players.find((p) => p.name === playerName)
      : g.players[0];
    gameWinnerMap.set(g.gameId, g.winner);
    gameLocalMap.set(g.gameId, you?.name ?? '');
  }

  const gameIds = new Set(games.map((g) => g.gameId));

  const allEvents = await db.getAll('card_events');
  const filtered = allEvents.filter(
    (e) =>
      gameIds.has(e.gameId) &&
      (playerName == null || e.playerName === playerName) &&
      e.cardId !== '__unknown__'
  );

  // Per-card accumulators
  interface Accum {
    stat: CardStats;
    appearedIn: Set<string>;
    playedIn: Set<string>;
    drawnIn: Set<string>;
    wonWhenPlayed: Set<string>;
    wonWhenDrawn: Set<string>;
    playRoundSum: number;
    playEventCount: number;
    firstSetId?: { set: string; number: number };
  }
  const map = new Map<string, Accum>();

  for (const evt of filtered) {
    let acc = map.get(evt.cardId);
    if (!acc) {
      acc = {
        stat: {
          cardId: evt.cardId,
          cardName: evt.cardName,
          played: 0, resourced: 0, activated: 0, drawn: 0, discarded: 0,
          gamesAppeared: 0, gamesPlayedIn: 0, gamesDrawnIn: 0,
          winRateWhenPlayed: 0, winRateWhenDrawn: 0,
          resourceRate: 0, playRate: 0,
          avgCopiesPerGame: 0, avgRoundPlayed: 0,
        },
        appearedIn: new Set(),
        playedIn: new Set(),
        drawnIn: new Set(),
        wonWhenPlayed: new Set(),
        wonWhenDrawn: new Set(),
        playRoundSum: 0,
        playEventCount: 0,
      };
      map.set(evt.cardId, acc);
    }

    if (evt.cardSetId && !acc.firstSetId) acc.firstSetId = evt.cardSetId;

    acc.stat[evt.metric] += evt.count;
    acc.appearedIn.add(evt.gameId);

    const winner = gameWinnerMap.get(evt.gameId) ?? null;
    const localPlayer = gameLocalMap.get(evt.gameId) ?? '';
    const isWin = winner !== null && winner === localPlayer;

    if (evt.metric === 'played') {
      acc.playedIn.add(evt.gameId);
      if (isWin) acc.wonWhenPlayed.add(evt.gameId);
      acc.playRoundSum += evt.roundNumber;
      acc.playEventCount += 1;
    }
    if (evt.metric === 'drawn') {
      acc.drawnIn.add(evt.gameId);
      if (isWin) acc.wonWhenDrawn.add(evt.gameId);
    }
  }

  // Finalise derived stats
  const result: CardStats[] = [];
  for (const acc of map.values()) {
    const s = acc.stat;
    s.cardSetId = acc.firstSetId;
    s.gamesAppeared = acc.appearedIn.size;
    s.gamesPlayedIn = acc.playedIn.size;
    s.gamesDrawnIn = acc.drawnIn.size;
    s.winRateWhenPlayed = s.gamesPlayedIn > 0 ? acc.wonWhenPlayed.size / s.gamesPlayedIn : 0;
    s.winRateWhenDrawn = s.gamesDrawnIn > 0 ? acc.wonWhenDrawn.size / s.gamesDrawnIn : 0;
    s.resourceRate = s.drawn > 0 ? s.resourced / s.drawn : 0;
    s.playRate = s.gamesAppeared > 0 ? s.gamesPlayedIn / s.gamesAppeared : 0;
    s.avgCopiesPerGame = s.gamesPlayedIn > 0 ? s.played / s.gamesPlayedIn : 0;
    s.avgRoundPlayed = acc.playEventCount > 0 ? acc.playRoundSum / acc.playEventCount : 0;
    result.push(s);
  }

  return result.sort((a, b) => b.played - a.played);
}

export async function getMatchupStats(
  formatFilter: string,
  playerName?: string
): Promise<MatchupRow[]> {
  const db = await getDb();
  let games: StoredGame[] = await db.getAll('games');
  games = games.filter((g) => !g.hidden);
  if (formatFilter === 'limited') games = games.filter((g) => g.isLimitedFormat);
  else if (formatFilter === 'eternal') games = games.filter((g) => g.format === 'open');
  else if (formatFilter === 'premier') games = games.filter((g) => !g.isLimitedFormat && g.format !== 'open');

  const map = new Map<string, MatchupRow>();

  for (const g of games) {
    const you = playerName
      ? g.players.find((p) => p.name === playerName)
      : g.players[0];
    const opp = playerName
      ? g.players.find((p) => p.name !== playerName)
      : g.players[1];

    if (!you || !opp) continue;

    const key = `${you.leaderId}|${opp.leaderId}`;
    let row = map.get(key);
    if (!row) {
      row = {
        yourLeaderId: you.leaderId,
        yourLeaderName: you.leaderName,
        yourLeaderSetId: you.leaderSetId,
        opponentLeaderId: opp.leaderId,
        opponentLeaderName: opp.leaderName,
        opponentLeaderSetId: opp.leaderSetId,
        wins: 0,
        losses: 0,
        draws: 0,
        totalGames: 0,
        winRate: 0,
      };
      map.set(key, row);
    }

    row.totalGames++;
    if (g.winner === null) {
      row.draws++;
    } else if (g.winner === you.name) {
      row.wins++;
    } else {
      row.losses++;
    }
  }

  for (const row of map.values()) {
    row.winRate =
      row.totalGames > 0 ? row.wins / row.totalGames : 0;
  }

  return [...map.values()].sort((a, b) => b.totalGames - a.totalGames);
}

export async function getSnapshots(gameId: string): Promise<RoundSnapshot[]> {
  const db = await getDb();
  const row = await db.get('game_snapshots', gameId);
  return row?.snapshots ?? [];
}

export async function deleteGame(gameId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['games', 'card_events', 'raw_logs', 'game_snapshots'], 'readwrite');
  await tx.objectStore('games').delete(gameId);
  await tx.objectStore('raw_logs').delete(gameId);
  await tx.objectStore('game_snapshots').delete(gameId);

  // Delete card events for this game
  const eventStore = tx.objectStore('card_events');
  const idx = eventStore.index('by_game');
  let cursor = await idx.openCursor(IDBKeyRange.only(gameId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}

export async function updateGameFormat(
  gameId: string,
  formatMode: 'premier' | 'limited' | 'eternal'
): Promise<void> {
  const db = await getDb();
  const game = await db.get('games', gameId);
  if (!game) return;
  if (formatMode === 'limited') {
    game.isLimitedFormat = true;
    game.format = 'premier';
  } else if (formatMode === 'eternal') {
    game.isLimitedFormat = false;
    game.format = 'open';
  } else {
    game.isLimitedFormat = false;
    game.format = 'premier';
  }
  await db.put('games', game);
}

export async function toggleGameHidden(gameId: string, hidden: boolean): Promise<void> {
  const db = await getDb();
  const game = await db.get('games', gameId);
  if (!game) return;
  game.hidden = hidden;
  await db.put('games', game);
}

export async function exportAll(): Promise<string> {
  const db = await getDb();
  const games     = await db.getAll('games');
  const events    = await db.getAll('card_events');
  const rawLogs   = await db.getAll('raw_logs');
  const snapshots = await db.getAll('game_snapshots');
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), games, events, rawLogs, snapshots },
    null,
    2
  );
}

export async function importGames(
  games: StoredGame[],
  events: CardEvent[],
  rawLogs: { gameId: string; entries: IChatEntry[] }[] = [],
  snapshots: { gameId: string; snapshots: RoundSnapshot[] }[] = []
): Promise<{ imported: number; skipped: number }> {
  const db = await getDb();
  const existingKeys = new Set(await db.getAllKeys('games'));
  let imported = 0;
  let skipped = 0;

  for (const game of games) {
    if (existingKeys.has(game.gameId)) {
      skipped++;
      continue;
    }
    const tx = db.transaction(['games', 'card_events', 'raw_logs', 'game_snapshots'], 'readwrite');
    await tx.objectStore('games').put(game);

    const gameEvents = events.filter((e) => e.gameId === game.gameId);
    for (const ev of gameEvents) {
      await (tx.objectStore('card_events') as unknown as { add: (v: CardEvent) => Promise<unknown> }).add(ev);
    }

    const log = rawLogs.find((r) => r.gameId === game.gameId);
    if (log) await tx.objectStore('raw_logs').put(log);

    const snap = snapshots.find((s) => s.gameId === game.gameId);
    if (snap) await tx.objectStore('game_snapshots').put(snap);

    await tx.done;
    imported++;
    existingKeys.add(game.gameId);
  }

  return { imported, skipped };
}
