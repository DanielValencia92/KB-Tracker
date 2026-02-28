/**
 * stateDiffer.ts
 *
 * Compares two consecutive game state snapshots and produces a list of
 * inferred CardEvents by diffing the card pile contents.
 *
 * Accuracy notes per metric:
 *  Played       – card left hand AND appeared in ground/space arena → exact for both players
 *  Resourced    – card left hand AND appeared in resources  → exact for local player only
 *                 (opponent hand is face-down; we can't see which card became a resource)
 *  Discarded    – card uuid appeared in discard not present before → exact for both players
 *  Drawn (count)– numCardsInDeck decreased → exact count
 *  Drawn (which)– new card uuids appeared in local player's hand → exact for local player
 *                 (opponent hand face-down; we only know count)
 */

import type { CardEvent, CardSummary, IGameState, PlayerStateSummary } from './types';

function uuidSet(cards: CardSummary[]): Set<string> {
  return new Set(cards.map((c) => c.uuid));
}

function byUuid(cards: CardSummary[]): Map<string, CardSummary> {
  const m = new Map<string, CardSummary>();
  for (const c of cards) m.set(c.uuid, c);
  return m;
}

function cardLabel(c: CardSummary): string {
  return c.name ?? c.id ?? c.uuid;
}

function allArena(p: PlayerStateSummary): CardSummary[] {
  return [...p.cardPiles.groundArena, ...p.cardPiles.spaceArena];
}

interface DiffContext {
  gameId: string;
  roundNumber: number;
  /** Only generate events for this player ID. If omitted, all players are diffed. */
  localPlayerId?: string;
}

export function diffSnapshots(
  prev: IGameState,
  next: IGameState,
  ctx: DiffContext
): CardEvent[] {
  const events: CardEvent[] = [];

  for (const playerId of Object.keys(next.players)) {
    // Only track the local player's cards — opponent hand is mostly facedown
    // and we can't reliably identify their cards anyway.
    if (ctx.localPlayerId && playerId !== ctx.localPlayerId) continue;

    const p0 = prev.players[playerId];
    const p1 = next.players[playerId];
    if (!p0 || !p1) continue;

    // Guard: card piles must be present
    if (!p0.cardPiles || !p1.cardPiles) {
      console.warn('[KB Tracker] diffSnapshots: missing cardPiles for player', playerId);
      continue;
    }

    const playerName = p1.name;

    // ── Hand UUIDs ──────────────────────────────────────────────────────
    const prevHand = byUuid(p0.cardPiles.hand ?? []);
    const nextHand = uuidSet(p1.cardPiles.hand ?? []);

    // Cards that left the hand
    const leftHand = [...prevHand.entries()].filter(([uuid]) => !nextHand.has(uuid));

    // ── Arena UUIDs ──────────────────────────────────────────────────────
    const prevArena = uuidSet(allArena(p0));
    const nextArena = uuidSet(allArena(p1));

    // ── Resource UUIDs ───────────────────────────────────────────────────
    const prevRes = uuidSet(p0.cardPiles.resources ?? []);
    const nextRes = uuidSet(p1.cardPiles.resources ?? []);

    // ── Discard UUIDs ────────────────────────────────────────────────────
    const prevDiscard = uuidSet(p0.cardPiles.discard ?? []);
    const nextDiscard = byUuid(p1.cardPiles.discard ?? []);

    console.debug(
      `[KB Tracker] diff player=${playerName} ` +
      `hand:${prevHand.size}→${nextHand.size} ` +
      `leftHand:${leftHand.length} ` +
      `arena:${prevArena.size}→${nextArena.size} ` +
      `res:${prevRes.size}→${nextRes.size} ` +
      `discard:${prevDiscard.size}→${nextDiscard.size}`
    );

    // Track event cards played from hand → discard (so we don't double-count them)
    const playedFromHandToDiscard = new Set<string>();

    // ─ PLAYED: left hand → appeared in arena (unit/upgrade) ──────────────
    //           OR: left hand → appeared in discard (event card) ───────────
    for (const [uuid, card] of leftHand) {
      if (!prevArena.has(uuid) && nextArena.has(uuid)) {
        // Unit or upgrade deployed to arena
        console.debug(`[KB Tracker] PLAYED (arena) ${cardLabel(card)} by ${playerName}`);
        events.push({
          gameId: ctx.gameId,
          roundNumber: ctx.roundNumber,
          playerId,
          playerName,
          cardId: card.id ?? card.uuid,
          cardName: cardLabel(card),
          cardSetId: card.setId,
          metric: 'played',
          count: 1,
        });
      } else if (!prevRes.has(uuid) && nextRes.has(uuid)) {
        // Resourced (handled below, but skip discard check for this uuid)
        // intentionally fall-through to the RESOURCED loop
      } else if (nextDiscard.has(uuid) && !prevDiscard.has(uuid)) {
        // Event card played from hand (goes directly to discard)
        const card2 = nextDiscard.get(uuid)!;
        console.debug(`[KB Tracker] PLAYED (event) ${cardLabel(card2)} by ${playerName}`);
        events.push({
          gameId: ctx.gameId,
          roundNumber: ctx.roundNumber,
          playerId,
          playerName,
          cardId: card2.id ?? card2.uuid,
          cardName: cardLabel(card2),
          cardSetId: card2.setId,
          metric: 'played',
          count: 1,
        });
        playedFromHandToDiscard.add(uuid);
      } else {
        console.debug(`[KB Tracker] left hand but unknown destination: ${cardLabel(card)} uuid=${uuid}`);
      }
    }

    // ─ RESOURCED: left hand → appeared in resources ──────────────────────
    for (const [uuid, card] of leftHand) {
      if (!prevRes.has(uuid) && nextRes.has(uuid)) {
        console.debug(`[KB Tracker] RESOURCED ${cardLabel(card)} by ${playerName}`);
        events.push({
          gameId: ctx.gameId,
          roundNumber: ctx.roundNumber,
          playerId,
          playerName,
          cardId: card.id ?? card.uuid,
          cardName: cardLabel(card),
          cardSetId: card.setId,
          metric: 'resourced',
          count: 1,
        });
      }
    }

    // ─ DISCARDED: appeared in discard, not there before, and NOT a played event ─
    for (const [uuid, card] of nextDiscard.entries()) {
      if (!prevDiscard.has(uuid) && !playedFromHandToDiscard.has(uuid)) {
        console.debug(`[KB Tracker] DISCARDED ${cardLabel(card)} by ${playerName}`);
        events.push({
          gameId: ctx.gameId,
          roundNumber: ctx.roundNumber,
          playerId,
          playerName,
          cardId: card.id ?? card.uuid,
          cardName: cardLabel(card),
          cardSetId: card.setId,
          metric: 'discarded',
          count: 1,
        });
      }
    }

    // ─ DRAWN: deck size decreased + new uuids in hand ────────────────────
    const deckDecrease = (p0.numCardsInDeck ?? 0) - (p1.numCardsInDeck ?? 0);
    if (deckDecrease > 0) {
      // Find which new cards appeared in hand
      const newInHand = (p1.cardPiles.hand ?? []).filter((c) => !prevHand.has(c.uuid));
      if (newInHand.length > 0) {
        // We know which exact cards — emit one event per card
        for (const card of newInHand) {
          console.debug(`[KB Tracker] DRAWN ${cardLabel(card)} by ${playerName}`);
          events.push({
            gameId: ctx.gameId,
            roundNumber: ctx.roundNumber,
            playerId,
            playerName,
            cardId: card.id ?? card.uuid,
            cardName: cardLabel(card),
            cardSetId: card.setId,
            metric: 'drawn',
            count: 1,
          });
        }
      } else if (deckDecrease > 0) {
        // Opponent (face-down hand) — emit a synthetic event with unknown cardId
        console.debug(`[KB Tracker] DRAWN x${deckDecrease} (unknown) by ${playerName}`);
        events.push({
          gameId: ctx.gameId,
          roundNumber: ctx.roundNumber,
          playerId,
          playerName,
          cardId: '__unknown__',
          cardName: '(unknown)',
          metric: 'drawn',
          count: deckDecrease,
        });
      }
    }
  }

  console.debug(`[KB Tracker] diffSnapshots → ${events.length} event(s)`);
  return events;
}
