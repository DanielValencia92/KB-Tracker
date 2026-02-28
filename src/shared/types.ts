// ---------------------------------------------------------------------------
// Shared types mirroring the forceteki / forceteki-client data shapes.
// We only capture the fields we actually need, so these are partial.
// ---------------------------------------------------------------------------

// ─── Socket.IO frame ────────────────────────────────────────────────────────

export interface SocketIOFrame {
  type: 'event' | 'ack' | 'error' | 'other';
  event?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any[];
}

// ─── Game state (from forceteki Game.getState) ──────────────────────────────

export type PhaseName = 'setup' | 'action' | 'regroup';
export type SwuGameFormat = 'premier' | 'nextSetPreview' | 'open';

export interface CardSummary {
  uuid: string;
  /** Karabast internal card ID  e.g. "han-solo#old-friend" */
  id: string;
  /** Display name sent by the server, e.g. "Han Solo" */
  name?: string;
  /** "SOR", "SHD", etc. */
  setId?: { set: string; number: number };
  damage?: number;
  hp?: number;
  power?: number;
  exhausted?: boolean;
  deployed?: boolean;
  type?: string;
  aspects?: string[];
  upgrades?: CardSummary[];
  capturedUnits?: CardSummary[];
  selectable?: boolean;
  selected?: boolean;
  facedown?: boolean;
}

export interface CardPiles {
  hand: CardSummary[];
  resources: CardSummary[];
  groundArena: CardSummary[];
  spaceArena: CardSummary[];
  discard: CardSummary[];
  outsideTheGame: CardSummary[];
  capturedZone: CardSummary[];
  /** Credit token card summaries — one entry per token in the base zone */
  credits?: CardSummary[];
}

export interface PlayerStateSummary {
  id: string;
  name: string;
  cardPiles: CardPiles;
  leader: CardSummary;
  base: CardSummary;
  numCardsInDeck: number;
  topCardOfDeck?: CardSummary;
  availableResources: number;
  hasInitiative: boolean;
  aspects: string[];
  phase: PhaseName;
  disconnected: boolean;
  left: boolean;
}

// Chat / game-log types
export interface IChatObject {
  type: 'player' | 'card';
  id: string;
  name: string;
  label: string;
  uuid: string;
  setId?: { set: string; number: number };
  controllerId?: string;
  printedType?: string;
}

export type ChatMessagePart = IChatObject | string | number;

export interface IAlertMessage {
  alert: {
    type: 'notification' | 'warning' | 'danger' | 'readyStatus';
    message: ChatMessagePart[];
  };
}

export interface IPlayerChatMessage {
  type: 'playerChat';
  id: string;
  name: string;
}

export type IChatEntry = {
  date: string;
  message: IAlertMessage | [IPlayerChatMessage, ...(string | number)[]] | ChatMessagePart[];
};

export interface IGameState {
  id: string;
  playerUpdate: string;
  manualMode: boolean;
  owner: string;
  players: Record<string, PlayerStateSummary>;
  phase: PhaseName;
  newMessages: IChatEntry[];
  messageOffset: number;
  totalMessages: number;
  initiativeClaimed: boolean;
  started: boolean;
  gameMode: SwuGameFormat;
  winners: string[];
  undoEnabled: boolean;
}

// ─── Extension internal message bus ─────────────────────────────────────────

export type ExtMessage =
  | { type: 'GAME_STATE'; payload: IGameState }
  | { type: 'GAME_RECORD_SAVED'; payload: GameRecord }
  | { type: 'GET_RECENT_GAMES'; limit: number }
  | { type: 'GET_RECENT_GAMES_RESPONSE'; games: GameRecord[] }
  | { type: 'GET_GAME_DETAIL'; gameId: string }
  | { type: 'GET_GAME_DETAIL_RESPONSE'; game: GameRecord | null }
  | { type: 'GET_CARD_STATS'; options: CardStatsOptions }
  | { type: 'GET_CARD_STATS_RESPONSE'; stats: CardStats[] }
  | { type: 'GET_MATCHUP_STATS'; options: MatchupStatsOptions }
  | { type: 'GET_MATCHUP_STATS_RESPONSE'; stats: MatchupRow[] }
  | { type: 'GET_LEADER_LIST'; playerName?: string }
  | { type: 'GET_LEADER_LIST_RESPONSE'; leaders: LeaderOption[] }
  | { type: 'EXPORT_ALL' }
  | { type: 'EXPORT_ALL_RESPONSE'; data: string }
  | { type: 'DELETE_GAME'; gameId: string }
  | { type: 'DELETE_GAME_RESPONSE'; success: boolean };

// ─── Persisted game record ───────────────────────────────────────────────────

export type GameCardMetric = 'played' | 'resourced' | 'activated' | 'drawn' | 'discarded';

export interface CardEvent {
  gameId: string;
  roundNumber: number;
  playerId: string;
  playerName: string;
  cardId: string;
  cardName: string;
  /** Set + number needed to build the card image URL */
  cardSetId?: { set: string; number: number };
  metric: GameCardMetric;
  /** 1-based count (for draw events where multiple cards drawn at once) */
  count: number;
}

export interface GamePlayer {
  id: string;
  name: string;
  leaderId: string;
  leaderName: string;
  leaderSetId?: { set: string; number: number };
  baseId: string;
  baseName: string;
  baseSetId?: { set: string; number: number };
  /** Primary aspects of the base card, e.g. ['aggression'] */
  baseAspects?: string[];
  /** Starting deck size detected from first snapshot */
  deckSize: number;
}

export interface GameRecord {
  gameId: string;
  /** ISO date string */
  startedAt: string;
  completedAt: string;
  format: SwuGameFormat;
  /** true when starting deck size ≤ 35 cards */
  isLimitedFormat: boolean;
  /** when true, excluded from aggregate stats but kept in history */
  hidden?: boolean;
  players: [GamePlayer, GamePlayer];
  /** Name of the winner, or null for draw */
  winner: string | null;
  rounds: number;
  cardEvents: CardEvent[];
  rawLog: IChatEntry[];
  /** Round-by-round arena snapshots captured at the start of each action phase */
  snapshots: RoundSnapshot[];
}

// ─── Round snapshot types ────────────────────────────────────────────────────

/** Slim per-player state captured once per round for post-game review */
export interface PlayerSnapshot {
  name: string;
  hasInitiative: boolean;
  availableResources: number;
  /** Number of cards in the resources zone */
  totalResources: number;
  /** Number of Credit tokens in the base zone */
  credits: number;
  numCardsInDeck: number;
  base: CardSummary;
  leader: CardSummary;
  groundArena: CardSummary[];
  spaceArena: CardSummary[];
  /** Local player's actual hand cards; facedown objects for opponent */
  hand: CardSummary[];
  discard: CardSummary[];
}

/** A base HP data point captured mid-round when damage is dealt to a base */
export interface BaseHpChange {
  youHp: number;
  oppHp: number;
}

export interface RoundSnapshot {
  round: number;
  phase: PhaseName;
  capturedAt: string;
  /** [localPlayer, opponent] — same order as GameRecord.players */
  players: [PlayerSnapshot, PlayerSnapshot];
  /** All game-log chat entries that occurred during this round's action phase */
  logEntries: IChatEntry[];
  /** Base HP changes captured during this round's action phase (after the round-start snapshot) */
  baseHpChanges: BaseHpChange[];
}

// ─── Stats query types ───────────────────────────────────────────────────────

export interface CardStatsOptions {
  limitedOnly?: boolean;
  playerName?: string;
  /** Filter to games where the specified leader was played */
  leaderId?: string;
  /** Filter to games where the base had this aspect, e.g. 'aggression' */
  baseAspect?: string;
}

export interface LeaderOption {
  leaderId: string;
  leaderName: string;
  leaderSetId?: { set: string; number: number };
}

export interface CardStats {
  cardId: string;
  cardName: string;
  cardSetId?: { set: string; number: number };
  // Raw event totals
  played: number;
  resourced: number;
  activated: number;
  drawn: number;
  discarded: number;
  // Per-game appearance counts
  gamesAppeared: number;
  gamesPlayedIn: number;
  gamesDrawnIn: number;
  // Win rates (0–1)
  winRateWhenPlayed: number;
  winRateWhenDrawn: number;
  // Derived rates (0–1)
  resourceRate: number;    // resourced / drawn
  playRate: number;        // gamesPlayedIn / gamesAppeared
  // Averages
  avgCopiesPerGame: number;  // played / gamesPlayedIn
  avgRoundPlayed: number;    // avg roundNumber of play events
}

export interface MatchupStatsOptions {
  limitedOnly?: boolean;
  playerName?: string;
}

export interface MatchupRow {
  yourLeaderId: string;
  yourLeaderName: string;
  yourLeaderSetId?: { set: string; number: number };
  opponentLeaderId: string;
  opponentLeaderName: string;
  opponentLeaderSetId?: { set: string; number: number };
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;
  winRate: number;
}
