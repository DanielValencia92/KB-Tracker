/**
 * logParser.ts
 *
 * Parses forceteki IChatEntry game-log messages to extract card events that
 * cannot be reliably detected through state diffing, primarily:
 *
 *  • Activated  – leader/upgrade abilities triggered
 *
 * Log message format:
 *   { alert: { type: 'notification', message: [...ChatMessagePart[]] } }
 *
 * Each ChatMessagePart is either a plain string/number or an IChatObject
 * (embedded card or player reference with { type, id, name, ... }).
 *
 * We scan the message array for patterns like:
 *   [player] "used" [card] "ability" / "activated" / "uses"
 */

import type { CardEvent, ChatMessagePart, IChatEntry, IChatObject, IAlertMessage } from './types';

// Keywords that indicate an activation event in the log text
const ACTIVATION_KEYWORDS = [
  'activated',
  'uses',
  'used',
  'ability',
  'epic action',
];

function isAlertMessage(msg: IChatEntry['message']): msg is IAlertMessage {
  return typeof msg === 'object' && !Array.isArray(msg) && 'alert' in msg;
}

function isCardObject(part: ChatMessagePart): part is IChatObject {
  return typeof part === 'object' && (part as IChatObject).type === 'card';
}

function isPlayerObject(part: ChatMessagePart): part is IChatObject {
  return typeof part === 'object' && (part as IChatObject).type === 'player';
}

function partsToText(parts: ChatMessagePart[]): string {
  return parts
    .map((p) => (typeof p === 'object' ? (p as IChatObject).name ?? '' : String(p)))
    .join(' ')
    .toLowerCase();
}

export interface ParsedLogEvent {
  playerId: string;
  playerName: string;
  cardId: string;
  cardName: string;
  metric: 'activated';
}

/**
 * Parse a batch of new IChatEntry messages and return activation events found.
 */
export function parseLogEntries(
  gameId: string,
  roundNumber: number,
  entries: IChatEntry[]
): CardEvent[] {
  const events: CardEvent[] = [];

  for (const entry of entries) {
    const msg = entry.message;
    if (!isAlertMessage(msg)) continue;

    const parts = msg.alert.message;
    const text = partsToText(parts);

    const hasActivationKeyword = ACTIVATION_KEYWORDS.some((kw) => text.includes(kw));
    if (!hasActivationKeyword) continue;

    // Find the player and card references in this message
    const playerRef = parts.find(isPlayerObject) as IChatObject | undefined;
    const cardRef = parts.find(isCardObject) as IChatObject | undefined;

    if (!playerRef || !cardRef) continue;

    events.push({
      gameId,
      roundNumber,
      playerId: playerRef.id,
      playerName: playerRef.name,
      cardId: cardRef.id,
      cardName: cardRef.name,
      metric: 'activated',
      count: 1,
    });
  }

  return events;
}

/**
 * Attempt to extract a round number from game log entries.
 * Returns the MAXIMUM round number found, or the provided fallback.
 */
export function extractRoundFromLog(entries: IChatEntry[], fallback: number): number {
  let best = fallback;
  for (const entry of entries) {
    const msg = entry.message;
    if (!isAlertMessage(msg)) continue;
    const text = partsToText(msg.alert.message);
    const m = text.match(/\bround\s+(\d+)\b/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > best) best = n;
    }
  }
  return best;
}

/**
 * Convert a single IChatEntry into a plain-text string for display.
 * Returns null for player-chat messages or unrecognised formats.
 */
export function formatLogEntry(entry: IChatEntry): string | null {
  const msg = entry.message;
  if (isAlertMessage(msg)) {
    const text = partsToText(msg.alert.message).trim();
    return text.length > 0 ? text : null;
  }
  // player chat / other array formats
  if (Array.isArray(msg)) {
    const parts = msg as ChatMessagePart[];
    const text = partsToText(parts).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
