/**
 * service-worker.ts
 *
 * Extension background service worker.
 * Receives messages from the content script and persists game records to
 * IndexedDB, then handles stat query messages from the popup and dashboard.
 */

import type { AuthState, ExtMessage, SyncStatus } from '../shared/types';
import {
  saveGameRecord,
  getRecentGames,
  getGameDetail,
  getCardStats,
  getMatchupStats,
  getLeaderList,
  deleteGame,
  exportAll,
  getAllForSync,
  importGames,
} from './db';
import { syncNewGame, pushLocalGames, pullAllGames } from './firestoreSync';
import { firebaseConfig } from '../firebase/config';
import browser from 'webextension-polyfill';

// ─── Auth state helpers ───────────────────────────────────────────────────────

async function getStoredAuth(): Promise<AuthState | null> {
  const res = await browser.storage.local.get('kb_auth');
  return (res['kb_auth'] as AuthState | undefined) ?? null;
}

async function clearStoredAuth(): Promise<void> {
  await browser.storage.local.remove('kb_auth');
}

// ─── Sync status ──────────────────────────────────────────────────────────────

let syncStatus: SyncStatus = { lastSynced: null, syncing: false, error: null };

function broadcastSyncStatus(): void {
  browser.runtime.sendMessage({ type: 'SYNC_STATUS_RESPONSE', status: { ...syncStatus } } as ExtMessage)
    .catch(() => { /* no listeners open — that's fine */ });
}

// webextension-polyfill: returning a Promise from the listener keeps the
// message channel open automatically — no need for sendResponse or return true.
browser.runtime.onMessage.addListener(
  (
    message: ExtMessage,
    _sender: browser.Runtime.MessageSender
  ) => {
    return handleMessage(message)
      .then((resp) => (resp !== null ? resp : undefined))
      .catch((err) => {
        console.error('[KB Tracker] service-worker error:', err);
        return undefined;
      });
  }
);

async function handleMessage(message: ExtMessage): Promise<ExtMessage | null> {
  switch (message.type) {
    case 'GAME_STATE':
      return null;

    case 'GAME_RECORD_SAVED': {
      await saveGameRecord(message.payload);
      console.log('[KB Tracker] Game record saved:', message.payload.gameId);

      // Auto-sync to Firestore if signed in and sync is enabled
      const auth = await getStoredAuth();
      if (auth) {
        const syncRes = await browser.storage.sync.get('kb_settings');
        const settings = syncRes['kb_settings'] as { autoSyncEnabled?: boolean } | undefined;
        if (settings?.autoSyncEnabled !== false) {
          // Fire-and-forget; don't block the response
          const record = message.payload;
          const snapEntry = record.snapshots?.length
            ? { gameId: record.gameId, snapshots: record.snapshots }
            : undefined;
          // Build a StoredGame (strip cardEvents/rawLog/snapshots)
          const { cardEvents: _ce, rawLog: _rl, snapshots: _sn, ...storedGame } = record;
          (async () => {
            try {
              syncStatus = { ...syncStatus, syncing: true, error: null };
              broadcastSyncStatus();
              const updatedAuth = await syncNewGame(
                { auth, projectId: firebaseConfig.projectId, apiKey: firebaseConfig.apiKey },
                storedGame,
                _ce,
                snapEntry
              );
              // Persist potentially refreshed token
              await browser.storage.local.set({ kb_auth: updatedAuth });
              syncStatus = { lastSynced: new Date().toISOString(), syncing: false, error: null };
            } catch (err) {
              console.error('[KB Tracker] auto-sync failed:', err);
              syncStatus = { ...syncStatus, syncing: false, error: String(err) };
            }
            broadcastSyncStatus();
          })();
        }
      }

      // Must respond so the content-script promise resolves cleanly
      return { type: 'GAME_RECORD_SAVED', payload: message.payload };
    }

    case 'GET_RECENT_GAMES': {
      const games = await getRecentGames(message.limit);
      return { type: 'GET_RECENT_GAMES_RESPONSE', games: games as never };
    }

    case 'GET_GAME_DETAIL': {
      const game = await getGameDetail(message.gameId);
      return { type: 'GET_GAME_DETAIL_RESPONSE', game };
    }

    case 'GET_CARD_STATS': {
      const stats = await getCardStats(
        message.options.limitedOnly ?? false,
        message.options.playerName,
        message.options.leaderId,
        message.options.baseId
      );
      console.log('[KB Tracker] GET_CARD_STATS: sending', stats.length, 'stats to dashboard');
      return { type: 'GET_CARD_STATS_RESPONSE', stats };
    }

    case 'GET_LEADER_LIST': {
      const leaders = await getLeaderList(
        (message as { type: 'GET_LEADER_LIST'; playerName?: string }).playerName
      );
      return { type: 'GET_LEADER_LIST_RESPONSE', leaders };
    }

    case 'GET_MATCHUP_STATS': {
      const stats = await getMatchupStats(
        message.options.limitedOnly ?? false,
        message.options.playerName
      );
      return { type: 'GET_MATCHUP_STATS_RESPONSE', stats };
    }

    case 'EXPORT_ALL': {
      const data = await exportAll();
      return { type: 'EXPORT_ALL_RESPONSE', data };
    }

    case 'DELETE_GAME': {
      await deleteGame(message.gameId);
      return { type: 'DELETE_GAME_RESPONSE', success: true };
    }

    // ─── Auth / sync ────────────────────────────────────────────────────────

    case 'AUTH_SIGNED_IN': {
      await browser.storage.local.set({ kb_auth: message.payload });
      console.log('[KB Tracker] Signed in as', message.payload.email);
      // After sign-in, check if local games exist and broadcast a prompt to upload
      const { games } = await getAllForSync();
      if (games.length > 0) {
        // Signal UI to show the "upload existing games?" prompt.
        // The UI listens for SYNC_STATUS_RESPONSE and checks for a special flag.
        browser.runtime.sendMessage({
          type: 'SYNC_STATUS_RESPONSE',
          status: { lastSynced: null, syncing: false, error: null, pendingUploadPrompt: true } as SyncStatus & { pendingUploadPrompt?: boolean },
        } as ExtMessage).catch(() => {});
      }
      return null;
    }

    case 'AUTH_SIGN_OUT': {
      await clearStoredAuth();
      syncStatus = { lastSynced: null, syncing: false, error: null };
      console.log('[KB Tracker] Signed out');
      return null;
    }

    case 'GET_AUTH_STATE': {
      const auth = await getStoredAuth();
      return { type: 'GET_AUTH_STATE_RESPONSE', auth };
    }

    case 'SYNC_PUSH_LOCAL': {
      const auth = await getStoredAuth();
      if (!auth) return { type: 'SYNC_STATUS_RESPONSE', status: { lastSynced: null, syncing: false, error: 'Not signed in' } };
      syncStatus = { ...syncStatus, syncing: true, error: null };
      broadcastSyncStatus();
      try {
        const { games, events, snapshots } = await getAllForSync();
        const { pushed, auth: updatedAuth } = await pushLocalGames(
          { auth, projectId: firebaseConfig.projectId, apiKey: firebaseConfig.apiKey },
          games,
          events,
          snapshots
        );
        await browser.storage.local.set({ kb_auth: updatedAuth });
        syncStatus = { lastSynced: new Date().toISOString(), syncing: false, error: null };
        console.log(`[KB Tracker] Pushed ${pushed} games to Firestore`);
      } catch (err) {
        console.error('[KB Tracker] push failed:', err);
        syncStatus = { ...syncStatus, syncing: false, error: String(err) };
      }
      broadcastSyncStatus();
      return { type: 'SYNC_STATUS_RESPONSE', status: { ...syncStatus } };
    }

    case 'SYNC_PULL': {
      const auth = await getStoredAuth();
      if (!auth) return { type: 'SYNC_STATUS_RESPONSE', status: { lastSynced: null, syncing: false, error: 'Not signed in' } };
      syncStatus = { ...syncStatus, syncing: true, error: null };
      broadcastSyncStatus();
      try {
        const { games, events, snapshots, auth: updatedAuth } = await pullAllGames(
          { auth, projectId: firebaseConfig.projectId, apiKey: firebaseConfig.apiKey }
        );
        await browser.storage.local.set({ kb_auth: updatedAuth });
        const result = await importGames(games, events, [], snapshots);
        syncStatus = { lastSynced: new Date().toISOString(), syncing: false, error: null };
        console.log(`[KB Tracker] Pulled from Firestore: ${result.imported} imported, ${result.skipped} skipped`);
      } catch (err) {
        console.error('[KB Tracker] pull failed:', err);
        syncStatus = { ...syncStatus, syncing: false, error: String(err) };
      }
      broadcastSyncStatus();
      return { type: 'SYNC_STATUS_RESPONSE', status: { ...syncStatus } };
    }

    default:
      return null;
  }
}

