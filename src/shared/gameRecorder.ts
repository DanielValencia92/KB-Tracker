/**
 * gameRecorder.ts
 *
 * Stateful per-session class that:
 *  1. Receives each incoming IGameState update
 *  2. Diffs against the previous snapshot to accumulate CardEvents
 *  3. Parses new log entries for activation events
 *  4. Detects game-end (winners.length > 0) and emits a complete GameRecord
 */

import type {
  BaseHpChange,
  CardEvent,
  GamePlayer,
  GameRecord,
  IChatEntry,
  IGameState,
  PhaseName,
  PlayerStateSummary,
  PlayerSnapshot,
  RoundSnapshot,
  SwuGameFormat,
} from './types';
import { diffSnapshots } from './stateDiffer';
import { parseLogEntries } from './logParser';

const LIMITED_DECK_SIZE_THRESHOLD = 35;

function buildPlayer(playerId: string, state: IGameState): GamePlayer {
  const p = state.players[playerId];
  return {
    id: playerId,
    name: p.name,
    leaderId: p.leader?.id ?? '',
    leaderName: p.leader?.name ?? p.leader?.id ?? '',
    leaderSetId: p.leader?.setId,
    baseId: p.base?.id ?? '',
    baseName: p.base?.name ?? p.base?.id ?? '',
    baseSetId: p.base?.setId,
    baseAspects: p.base?.aspects,
    deckSize: p.numCardsInDeck,
  };
}

export type GameCompleteCallback = (record: GameRecord) => void | Promise<void>;

export class GameRecorder {
  private gameId: string;
  private startedAt: string;
  private prevState: IGameState | null = null;
  private cardEvents: CardEvent[] = [];
  private rawLog: IGameState['newMessages'] = [];
  private players: [GamePlayer, GamePlayer] | null = null;
  private isLimitedFormat = false;
  private format: SwuGameFormat = 'premier';
  private roundNumber = 0;
  private completed = false;
  /** Snapshots captured at the start of each action-phase round */
  private snapshots: RoundSnapshot[] = [];
  /** Log entries buffered for the current round; flushed into snapshot on round boundary */
  private currentRoundLogs: IChatEntry[] = [];
  /** Base HP changes detected during the current round's action phase */
  private currentRoundBaseHpChanges: BaseHpChange[] = [];
  /** Last known base HP for each player — used to detect mid-round changes */
  private lastKnownYouHp: number | null = null;
  private lastKnownOppHp: number | null = null;
  /** Previous phase — used for phase-transition round detection */
  private prevPhase: PhaseName | null = null;
  /** The player ID for the extension user (from state.playerUpdate). */
  private localPlayerId: string | null = null;

  private onComplete: GameCompleteCallback;

  constructor(gameId: string, onComplete: GameCompleteCallback) {
    this.gameId = gameId;
    this.startedAt = new Date().toISOString();
    this.onComplete = onComplete;
  }

  /** Feed the next game state update. Returns true if the game is now complete. */
  public ingest(state: IGameState): boolean {
    if (this.completed) return true;
    if (state.id !== this.gameId) return false;

    // Identify the local player from playerUpdate.
    // playerUpdate may equal a key in state.players, or it may be the player's
    // display name / id field — so we resolve it by checking all three.
    if (!this.localPlayerId && state.playerUpdate) {
      const resolved = Object.keys(state.players).find(
        (k) =>
          k === state.playerUpdate ||
          state.players[k].name === state.playerUpdate ||
          state.players[k].id === state.playerUpdate
      );
      this.localPlayerId = resolved ?? null;
      if (resolved) {
        console.debug('[KB Tracker] local player resolved:', resolved);
      } else {
        console.warn('[KB Tracker] could not resolve localPlayerId from playerUpdate:', state.playerUpdate);
      }
    }

    // Capture players from first snapshot that has both populated
    if (!this.players) {
      const ids = Object.keys(state.players);
      if (ids.length >= 2) {
        // Always put the local player first so DB queries that assume players[0]='you' are correct
        const localId = (this.localPlayerId && state.players[this.localPlayerId]) ? this.localPlayerId : ids[0];
        const oppId = ids.find((id) => id !== localId) ?? ids[1];
        if (!state.players[localId] || !state.players[oppId]) {
          console.warn('[KB Tracker] buildPlayer: missing player data for', localId, 'or', oppId);
        } else {
          this.players = [buildPlayer(localId, state), buildPlayer(oppId, state)];
          // Determine limited format from smaller starting deck
          const minDeck = Math.min(
            state.players[localId].numCardsInDeck,
            state.players[oppId].numCardsInDeck
          );
          this.isLimitedFormat = minDeck <= LIMITED_DECK_SIZE_THRESHOLD;
          this.format = state.gameMode;
        }
      }
    }

    // Accumulate log entries
    if (state.newMessages && state.newMessages.length > 0) {
      this.rawLog.push(...state.newMessages);
      this.currentRoundLogs.push(...state.newMessages);

      // Parse activations from new log entries (use max(1, roundNumber) so
      // pre-game events get round=1 before the first phase transition)
      const logEvents = parseLogEntries(this.gameId, Math.max(1, this.roundNumber), state.newMessages);
      this.cardEvents.push(...logEvents);
    }

    // PRIMARY round detection: phase transition into action phase
    // Every time we enter action (from setup or regroup) = a new round begins.
    const prevPhase = this.prevPhase;
    if (state.phase === 'action' && prevPhase !== 'action' && this.players) {
      // Attach accumulated logs and HP changes to the PREVIOUS round's snapshot
      if (this.snapshots.length > 0) {
        const prev = this.snapshots[this.snapshots.length - 1];
        prev.logEntries = [...this.currentRoundLogs];
        prev.baseHpChanges = [...this.currentRoundBaseHpChanges];
      }
      this.currentRoundLogs = [];
      this.currentRoundBaseHpChanges = [];

      // Advance round number
      this.roundNumber = Math.max(this.roundNumber + 1, 1);

      // Capture arena snapshot for the NEW round
      const snap = this.captureSnapshot(state, this.roundNumber);
      if (snap) this.snapshots.push(snap);

      // Seed the HP baseline from the newly captured snapshot
      if (snap && this.players) {
        const localState = state.players[this.players[0].id];
        const oppState   = state.players[this.players[1].id];
        this.lastKnownYouHp = localState ? Math.max(0, (localState.base?.hp ?? 30) - (localState.base?.damage ?? 0)) : null;
        this.lastKnownOppHp = oppState   ? Math.max(0, (oppState.base?.hp   ?? 30) - (oppState.base?.damage   ?? 0)) : null;
      }

      console.debug(`[KB Tracker] round ${this.roundNumber} started (phase transition ${prevPhase} → action)`);
    } else if (state.phase === 'action' && prevPhase === 'action' && this.players) {
      // Mid-round: detect base HP changes and record them
      const localState = state.players[this.players[0].id];
      const oppState   = state.players[this.players[1].id];
      if (localState && oppState) {
        const youHp = Math.max(0, (localState.base?.hp ?? 30) - (localState.base?.damage ?? 0));
        const oppHp = Math.max(0, (oppState.base?.hp   ?? 30) - (oppState.base?.damage   ?? 0));
        if (
          this.lastKnownYouHp !== null &&
          (youHp !== this.lastKnownYouHp || oppHp !== this.lastKnownOppHp)
        ) {
          this.currentRoundBaseHpChanges.push({ youHp, oppHp });
        }
        this.lastKnownYouHp = youHp;
        this.lastKnownOppHp = oppHp;
      }
    }
    this.prevPhase = state.phase;

    // Diff against previous snapshot (skip on first snapshot)
    if (this.prevState) {
      try {
        const diffEvents = diffSnapshots(this.prevState, state, {
          gameId: this.gameId,
          roundNumber: this.roundNumber,
          localPlayerId: this.localPlayerId ?? undefined,
        });
        this.cardEvents.push(...diffEvents);
        console.debug(`[KB Tracker] ingest: diff produced ${diffEvents.length} events (total: ${this.cardEvents.length})`);
      } catch (err) {
        console.error('[KB Tracker] diffSnapshots threw:', err);
      }
    }

    this.prevState = state;

    // Check for game end
    if (state.winners && state.winners.length > 0 && this.players) {
      this.finalize(state);
      return true;
    }

    return false;
  }

  private captureSnapshot(state: IGameState, round: number): RoundSnapshot | null {
    if (!this.players) return null;
    const [localPlayer, oppPlayer] = this.players;
    const localState = state.players[localPlayer.id];
    const oppState = state.players[oppPlayer.id];
    if (!localState || !oppState) return null;

    const buildPlayerSnapshot = (ps: PlayerStateSummary): PlayerSnapshot => ({
      name: ps.name,
      hasInitiative: ps.hasInitiative,
      availableResources: ps.availableResources,
      totalResources: ps.cardPiles.resources.length,
      credits: ps.cardPiles.credits?.length ?? 0,
      numCardsInDeck: ps.numCardsInDeck,
      base: ps.base,
      leader: ps.leader,
      groundArena: ps.cardPiles.groundArena,
      spaceArena: ps.cardPiles.spaceArena,
      hand: ps.cardPiles.hand,
      discard: ps.cardPiles.discard,
    });

    return {
      round,
      phase: state.phase,
      capturedAt: new Date().toISOString(),
      players: [buildPlayerSnapshot(localState), buildPlayerSnapshot(oppState)],
      logEntries: [],    // filled in when next round starts (or at finalize)
      baseHpChanges: [], // filled in when next round starts (or at finalize)
    };
  }

  private finalize(finalState: IGameState): void {
    this.completed = true;

    // Flush remaining logs and HP changes into the last snapshot
    if (this.snapshots.length > 0) {
      const last = this.snapshots[this.snapshots.length - 1];
      if (this.currentRoundLogs.length > 0) {
        last.logEntries = [...last.logEntries, ...this.currentRoundLogs];
      }
      if (this.currentRoundBaseHpChanges.length > 0) {
        last.baseHpChanges = [...last.baseHpChanges, ...this.currentRoundBaseHpChanges];
      }
    }

    const winners = finalState.winners;
    const winner = winners.length === 1 ? winners[0] : null; // null = draw

    console.log(
      `[KB Tracker] finalizing game ${this.gameId}: ` +
      `${this.cardEvents.length} card events, ` +
      `${this.rawLog.length} log entries, ` +
      `rounds=${this.roundNumber}, ` +
      `winner=${winner}`
    );

    const record: GameRecord = {
      gameId: this.gameId,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      format: this.format,
      isLimitedFormat: this.isLimitedFormat,
      players: this.players!,
      winner,
      rounds: this.roundNumber,
      cardEvents: this.cardEvents,
      rawLog: this.rawLog,
      snapshots: this.snapshots,
    };

    this.onComplete(record);
  }

  get isCompleted(): boolean {
    return this.completed;
  }
}
