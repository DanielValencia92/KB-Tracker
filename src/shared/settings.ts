import browser from 'webextension-polyfill';

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface KBSettings {
  /** Max recent games shown in the popup (0 = show all) */
  popupGameLimit: number;
  /** Hide matchup rows with fewer than this many games (0 = show all) */
  minGamesThreshold: number;
  /** Default format filter applied to all dropdowns on load */
  defaultFormat: '' | 'premier' | 'limited' | 'eternal';
  /** Tab to activate when the dashboard opens */
  defaultTab: 'overview' | 'matchups' | 'cards' | 'history' | 'tools';
  /** Max number of games to retain in the DB (0 = unlimited) */
  dataRetentionLimit: number;
  /** Show a confirm() dialog before permanently deleting a game */
  confirmBeforeClear: boolean;
}

export const DEFAULT_SETTINGS: KBSettings = {
  popupGameLimit: 5,
  minGamesThreshold: 5,
  defaultFormat: '',
  defaultTab: 'overview',
  dataRetentionLimit: 0,
  confirmBeforeClear: true,
};

const STORAGE_KEY = 'kb_settings';

export async function loadSettings(): Promise<KBSettings> {
  const res = await browser.storage.sync.get(STORAGE_KEY);
  const stored = (res[STORAGE_KEY] ?? {}) as Partial<KBSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: KBSettings): Promise<void> {
  await browser.storage.sync.set({ [STORAGE_KEY]: settings });
}
