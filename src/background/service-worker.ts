/**
 * service-worker.ts
 *
 * Extension background service worker.
 * Receives messages from the content script and persists game records to
 * IndexedDB, then handles stat query messages from the popup and dashboard.
 */

import type { ExtMessage } from '../shared/types';
import {
  saveGameRecord,
  getRecentGames,
  getGameDetail,
  getCardStats,
  getMatchupStats,
  getLeaderList,
  deleteGame,
  exportAll,
} from './db';
import browser from 'webextension-polyfill';

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

    default:
      return null;
  }
}
