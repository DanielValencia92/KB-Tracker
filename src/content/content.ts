/**
 * content.ts
 *
 * Content script – runs in the extension sandbox but has access to the DOM.
 *
 * Responsibilities:
 *  1. Inject interceptor.ts into the page's own JS context at document_start
 *     so it can patch WebSocket before Socket.IO initialises.
 *  2. Listen for KB_TRACKER_WS_MSG postMessages from the interceptor.
 *  3. Parse them with socketParser, feed to a GameRecorder instance.
 *  4. When a game completes, send the GameRecord to the background SW for
 *     persistence via browser.runtime.sendMessage.
 */

import browser from 'webextension-polyfill';
import { parseFrame, extractGameState } from '../shared/socketParser';
import { GameRecorder } from '../shared/gameRecorder';
import type { ExtMessage, GameRecord } from '../shared/types';
// The WebSocket interceptor runs as a separate MAIN-world content script
// declared in manifest.json. It patches window.WebSocket before Socket.IO
// initialises and forwards frames here via window.postMessage.
// No injection needed from this isolated-world script.

// ─── Tracking enabled flag ───────────────────────────────────────────────────

let trackingEnabled = true;
let forceFormat: 'premier' | 'limited' | 'eternal' = 'premier';

browser.storage.local.get(['trackingEnabled', 'formatMode']).then((res) => {
  trackingEnabled = res['trackingEnabled'] !== false;
  forceFormat = (res['formatMode'] as 'premier' | 'limited' | 'eternal') || 'premier';
  console.debug('[KB Tracker] tracking enabled on load:', trackingEnabled);
  console.debug('[KB Tracker] format mode on load:', forceFormat);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('trackingEnabled' in changes) {
    trackingEnabled = changes['trackingEnabled'].newValue !== false;
    console.debug('[KB Tracker] tracking toggled:', trackingEnabled);
  }
  if ('formatMode' in changes) {
    forceFormat = (changes['formatMode'].newValue as 'premier' | 'limited' | 'eternal') || 'premier';
    console.debug('[KB Tracker] format mode changed:', forceFormat);
  }
});

// ─── Step 2: Manage game recorders ──────────────────────────────────────────────────────

// Map of gameId → active recorder. Multiple games can theoretically overlap
// (Bo3), so we keep one per gameId.
const recorders = new Map<string, GameRecorder>();

async function handleGameComplete(record: GameRecord): Promise<void> {
  if (!trackingEnabled) {
    console.log('[KB Tracker] Tracking disabled — discarding completed game:', record.gameId);
    return;
  }

  // Apply manual format override from popup setting
  if (forceFormat === 'limited') {
    record = { ...record, isLimitedFormat: true };
  } else if (forceFormat === 'eternal') {
    record = { ...record, format: 'open' };
  }
  console.log('[KB Tracker] Game complete:', record.gameId, 'Winner:', record.winner);

  const msg: ExtMessage = {
    type: 'GAME_RECORD_SAVED',
    payload: record,
  };

  try {
    const response = await browser.runtime.sendMessage(msg);
    console.debug('[KB Tracker] Record acknowledged:', response);
  } catch (err) {
    // Extension was reloaded/updated while the content script was still live.
    // The game record is lost for this session but we should not throw.
    console.warn('[KB Tracker] Could not send record — extension context invalidated. Reload the page to re-attach.', err);
  }
}

// ─── Step 3: Listen for WebSocket messages from the interceptor ──────────────

window.addEventListener('message', (event: MessageEvent) => {
  // Security: only accept messages from the same frame
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'KB_TRACKER_WS_MSG') return;

  const raw: string = event.data.data;
  if (typeof raw !== 'string') return;

  const frame = parseFrame(raw);
  if (!frame) return;
  if (frame.type === 'other') return; // non-event frames (ping/pong/etc)

  const state = extractGameState(frame);
  if (!state) {
    // Log non-gamestate events so we can see what events ARE arriving
    if (frame.type === 'event' && frame.event !== 'gamestate') {
      console.debug('[KB Tracker] non-gamestate event:', frame.event);
    }
    return;
  }

  console.debug('[KB Tracker] gamestate received, id:', state.id,
    '| started:', state.started,
    '| phase:', state.phase,
    '| winners:', state.winners,
    '| players:', Object.keys(state.players));

  const { id: gameId } = state;

  // Remove completed recorders (keep memory clean)
  if (recorders.has(gameId)) {
    const rec = recorders.get(gameId)!;
    if (rec.isCompleted) {
      recorders.delete(gameId);
      return;
    }
  } else {
    // Don't create a recorder for a game that's already over — this prevents
    // a phantom 0-event record when the server sends a post-game state update
    // after we already finished and removed the recorder from the map.
    if (state.winners && state.winners.length > 0) return;

    // New game — create recorder unconditionally.
    // Don't gate on state.started: it may be false on reconnect or lobby
    // pre-game state, meaning we'd never create the recorder at all.
    if (!trackingEnabled) {
      console.debug('[KB Tracker] Tracking disabled — skipping recorder for game:', gameId);
      return;
    }
    console.debug('[KB Tracker] creating recorder for game:', gameId);
    recorders.set(gameId, new GameRecorder(gameId, handleGameComplete));
  }

  const recorder = recorders.get(gameId);
  if (!recorder) return;

  const done = recorder.ingest(state);
  if (done) {
    console.debug('[KB Tracker] recorder finished for game:', gameId);
    recorders.delete(gameId);
  }
});

console.debug('[KB Tracker] Content script loaded');
