import browser from 'webextension-polyfill';
import type { ExtMessage, StoredGame } from '../shared/types';

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// We need StoredGame from db but it's not exported from types —
// the popup uses the 'games' shape which omits cardEvents & rawLog.
// Re-import the type from background/db isn't possible cross-bundle,
// so we just work with GameRecord directly (those fields will be undefined).

// Fix StoredGame import: use the full GameRecord but treat cardEvents/rawLog as optional
type GameSummary = Omit<import('../shared/types').GameRecord, 'cardEvents' | 'rawLog'>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendMessage<T extends ExtMessage>(
  msg: Extract<ExtMessage, { type: T['type'] }>
): Promise<ExtMessage> {
  return browser.runtime.sendMessage(msg) as Promise<ExtMessage>;
}

function resultClass(game: GameSummary, perspective?: string): 'win' | 'loss' | 'draw' {
  if (game.winner === null) return 'draw';
  if (perspective && game.winner === perspective) return 'win';
  if (perspective) return 'loss';
  // No perspective — just show win
  return 'win';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderGameList(games: GameSummary[]): void {
  const list = document.getElementById('game-list')!;
  const empty = document.getElementById('empty')!;
  const status = document.getElementById('status')!;

  status.textContent = `${games.length} game${games.length !== 1 ? 's' : ''} recorded`;

  if (games.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = '';

  for (const game of games) {
    const li = document.createElement('li');
    li.className = 'game-row';

    const p0 = game.players[0];
    const p1 = game.players[1];
    const res = resultClass(game, p0.name);

    const badgeHTML = `<span class="badge ${res}">${res.toUpperCase()}</span>` +
      (game.isLimitedFormat ? '<span class="badge limited">Limited</span>' : '') +
      (game.format === 'open' ? '<span class="badge eternal">Eternal</span>' : '');

    li.innerHTML = `
      <div>
        <div class="main">${escHtml(p0.leaderName ?? p0.leaderId)} vs ${escHtml(p1.leaderName ?? p1.leaderId)}</div>
        <div class="sub">${formatDate(game.completedAt)} · Round ${game.rounds} · ${game.format}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">${badgeHTML}</div>
    `;

    li.addEventListener('click', () => {
      const url = browser.runtime.getURL(`src/dashboard/dashboard.html?game=${game.gameId}`);
      browser.tabs.create({ url });
    });

    list.appendChild(li);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Set dashboard link
  const dashLink = document.getElementById('dashboard-link') as HTMLAnchorElement;
  dashLink.href = browser.runtime.getURL('src/dashboard/dashboard.html');

  // Load recent games
  const syncRes = await browser.storage.sync.get('kb_settings');
  const popupLimit: number = (syncRes['kb_settings'] as { popupGameLimit?: number } | undefined)?.popupGameLimit ?? 20;
  try {
    const resp = await sendMessage({
      type: 'GET_RECENT_GAMES',
      limit: popupLimit > 0 ? popupLimit : 5000,
    } as Extract<ExtMessage, { type: 'GET_RECENT_GAMES' }>);

    if (resp.type === 'GET_RECENT_GAMES_RESPONSE') {
      renderGameList(resp.games as GameSummary[]);
    }
  } catch (err) {
    const status = document.getElementById('status')!;
    status.textContent = 'Error loading games.';
    console.error('[KB Tracker] popup error:', err);
  }

  // Format mode toggle (premier → limited → eternal → premier)
  const fmtBtn = document.getElementById('format-mode-btn')!;
  const FORMAT_CYCLE: Array<'premier' | 'limited' | 'eternal'> = ['premier', 'limited', 'eternal'];
  const FORMAT_LABELS: Record<string, string> = {
    premier: '\u25B6 FORMAT: PREMIER',
    limited: '\u25B6 FORMAT: LIMITED',
    eternal: '\u25B6 FORMAT: ETERNAL',
  };

  function setFormatModeUI(mode: 'premier' | 'limited' | 'eternal'): void {
    fmtBtn.textContent = FORMAT_LABELS[mode];
    fmtBtn.className = mode;
  }

  browser.storage.local.get('formatMode').then((res) => {
    setFormatModeUI((res['formatMode'] as 'premier' | 'limited' | 'eternal') || 'premier');
  });

  fmtBtn.addEventListener('click', () => {
    browser.storage.local.get('formatMode').then((res) => {
      const current: 'premier' | 'limited' | 'eternal' = (res['formatMode'] as 'premier' | 'limited' | 'eternal') || 'premier';
      const next = FORMAT_CYCLE[(FORMAT_CYCLE.indexOf(current) + 1) % FORMAT_CYCLE.length];
      browser.storage.local.set({ formatMode: next });
      setFormatModeUI(next);
    });
  });

  // Tracking toggle
  const trackingBtn = document.getElementById('tracking-btn')!;

  function setTrackingUI(enabled: boolean): void {
    if (enabled) {
      trackingBtn.textContent = '\u23FA Tracking ON';
      trackingBtn.className = 'enabled';
    } else {
      trackingBtn.textContent = '\u23F8 Tracking OFF';
      trackingBtn.className = 'disabled';
    }
  }

  // Read initial state (default: enabled)
  browser.storage.local.get('trackingEnabled').then((res) => {
    setTrackingUI(res['trackingEnabled'] !== false);
  });

  trackingBtn.addEventListener('click', () => {
    browser.storage.local.get('trackingEnabled').then((res) => {
      const current = res['trackingEnabled'] !== false;
      const next = !current;
      browser.storage.local.set({ trackingEnabled: next });
      setTrackingUI(next);
    });
  });

  // Export button
  document.getElementById('export-btn')!.addEventListener('click', async () => {
    const resp = await sendMessage({ type: 'EXPORT_ALL' } as Extract<ExtMessage, { type: 'EXPORT_ALL' }>);
    if (resp.type === 'EXPORT_ALL_RESPONSE') {
      const blob = new Blob([resp.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kb-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  });
}

init();
