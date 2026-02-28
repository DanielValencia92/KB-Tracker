import type {
  CardEvent,
  CardStats,
  GameRecord,
  LeaderOption,
  MatchupRow,
  PlayerSnapshot,
  RoundSnapshot,
} from '../shared/types';
import { cardImageUrl } from '../shared/cardUtils';
import { formatLogEntry } from '../shared/logParser';
import {
  getRecentGames,
  getCardStats,
  getMatchupStats,
  getLeaderList,
  getBaseColorList,
  getSnapshots,
  deleteGame,
  updateGameFormat,
  toggleGameHidden,
  exportAll,
  importGames,
  type StoredGame,
} from '../background/db';

// ─── Helpers ─────────────────────────────────────────────────────────────────────────

type GameSummary = Omit<GameRecord, 'cardEvents' | 'rawLog'>;

/**
 * Render a card name as a hoverable chip. On hover a tooltip shows the
 * full card image loaded from the Karabast S3 bucket.
 */
function cardChip(
  name: string,
  setId?: { set: string; number: number } | null
): string {
  const imgUrl = cardImageUrl(setId ?? null);
  if (!imgUrl) return `<span>${escHtml(name)}</span>`;

  // Tiny inline thumbnail + data-tooltip-img for the shared tooltip handler
  return (
    `<span class="card-chip" data-tooltip-img="${escHtml(imgUrl)}">` +
    `<img class="card-chip-img" src="${escHtml(imgUrl)}" alt="" loading="lazy" />` +
    `${escHtml(name)}` +
    `</span>`
  );
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Card image tooltip ────────────────────────────────────────────────────────────

const tooltip = document.getElementById('card-tooltip') as HTMLDivElement;
const tooltipImg = document.getElementById('card-tooltip-img') as HTMLImageElement;

document.addEventListener('mouseover', (e: MouseEvent) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip-img]');
  if (!chip) { tooltip.style.display = 'none'; return; }
  tooltipImg.src = chip.dataset.tooltipImg!;
  tooltip.style.display = 'block';
  positionTooltip(e);
});

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (tooltip.style.display === 'none') return;
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip-img]');
  if (!chip) { tooltip.style.display = 'none'; return; }
  positionTooltip(e);
});

document.addEventListener('mouseout', (e: MouseEvent) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip-img]');
  if (chip && !chip.contains(e.relatedTarget as Node)) {
    tooltip.style.display = 'none';
  }
});

function positionTooltip(e: MouseEvent): void {
  const OFFSET = 14;
  const tw = 200 + 4; // image width + border
  let left = e.clientX + OFFSET;
  let top = e.clientY + OFFSET;
  if (left + tw > window.innerWidth) left = e.clientX - tw - OFFSET;
  if (top + 280 > window.innerHeight) top = e.clientY - 280 - OFFSET;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// ─── Tab routing ─────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll<HTMLButtonElement>('.nav-btn[data-tab]');
const contents = document.querySelectorAll<HTMLDivElement>('.tab-content');

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.remove('active'));
    contents.forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    const tabId = `tab-${btn.dataset.tab}`;
    document.getElementById(tabId)?.classList.add('active');
  });
});

// ─── Table sorting ───────────────────────────────────────────────────────────

interface SortState {
  col: string;
  dir: 1 | -1;
}

function makeSortable<T extends Record<string, unknown>>(
  tableId: string,
  getData: () => T[],
  renderRows: (rows: T[]) => void,
  defaultCol: string
): void {
  const table = document.getElementById(tableId) as HTMLTableElement;
  const ths = table.querySelectorAll<HTMLTableCellElement>('thead th[data-col]');

  const sort: SortState = { col: defaultCol, dir: -1 };

  function apply(): void {
    const data = getData().slice().sort((a, b) => {
      const av = a[sort.col];
      const bv = b[sort.col];
      if (typeof av === 'number' && typeof bv === 'number') return sort.dir * (bv - av);
      return sort.dir * String(av ?? '').localeCompare(String(bv ?? ''));
    });
    renderRows(data);
    ths.forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.col === sort.col) {
        th.classList.add(sort.dir === -1 ? 'sort-desc' : 'sort-asc');
      }
    });
  }

  ths.forEach((th) => {
    th.addEventListener('click', () => {
      if (sort.col === th.dataset.col) {
        sort.dir = sort.dir === -1 ? 1 : -1;
      } else {
        sort.col = th.dataset.col!;
        sort.dir = -1;
      }
      apply();
    });
  });

  // expose apply for external refresh
  (table as unknown as Record<string, unknown>)['__sort'] = apply;
}

// ─── Overview ────────────────────────────────────────────────────────────────

let _allGames: GameSummary[] = [];
let _ghGames:  GameSummary[] = [];

async function loadOverview(): Promise<void> {
  const formatFilter = (document.getElementById('ov-format') as HTMLSelectElement).value;
  const player = (document.getElementById('ov-player-name') as HTMLInputElement).value.trim() || undefined;

  let games = (await getRecentGames(5000)) as GameSummary[];
  games = games.filter((g) => !g.hidden);
  if (formatFilter === 'limited') games = games.filter((g) => g.isLimitedFormat);
  else if (formatFilter === 'eternal') games = games.filter((g) => g.format === 'open');
  else if (formatFilter === 'premier') games = games.filter((g) => !g.isLimitedFormat && g.format !== 'open');

  _allGames = games;

  const you = games.map((g) => player ? g.players.find((p) => p.name === player) ?? g.players[0] : g.players[0]);

  const wins = games.filter((g, i) => g.winner === you[i].name).length;
  const losses = games.filter((g, i) => g.winner !== null && g.winner !== you[i].name).length;
  const draws = games.filter((g) => g.winner === null).length;
  const total = games.length;
  const winRate = total > 0 ? wins / total : 0;
  const limitedGames = games.filter((g) => g.isLimitedFormat).length;
  const eternalGames = games.filter((g) => g.format === 'open').length;

  const container = document.getElementById('ov-stat-cards')!;
  container.innerHTML = `
    <div class="stat-card"><div class="val">${total}</div><div class="lbl">Total Games</div></div>
    <div class="stat-card"><div class="val">${wins}</div><div class="lbl">Wins</div></div>
    <div class="stat-card"><div class="val">${losses}</div><div class="lbl">Losses</div></div>
    <div class="stat-card"><div class="val">${draws}</div><div class="lbl">Draws</div></div>
    <div class="stat-card"><div class="val">${pct(winRate)}</div><div class="lbl">Win Rate</div></div>
    <div class="stat-card"><div class="val">${limitedGames}</div><div class="lbl">Limited Games</div></div>
    <div class="stat-card"><div class="val">${eternalGames}</div><div class="lbl">Eternal Games</div></div>
  `;

  // ── Leader / Base breakdown ──────────────────────────────────────────────
  type LeaderEntry = {
    leaderId: string;
    leaderName: string;
    leaderSetId?: { set: string; number: number };
    baseAspect: string;
    formatType: 'premier' | 'limited' | 'eternal';
    wins: number;
    losses: number;
    draws: number;
  };

  const leaderMap = new Map<string, LeaderEntry>();
  games.forEach((g, i) => {
    const p = you[i];
    const ft: 'premier' | 'limited' | 'eternal' = g.isLimitedFormat ? 'limited' : g.format === 'open' ? 'eternal' : 'premier';
    const key = `${p.leaderId}|${ft}`;
    const won   = g.winner === p.name;
    const lost  = g.winner !== null && g.winner !== p.name;
    const drw   = g.winner === null;
    const aspect = (p.baseAspects?.[0] ?? '').replace(/^\w/, (c) => c.toUpperCase());
    if (!leaderMap.has(key)) {
      leaderMap.set(key, {
        leaderId: p.leaderId,
        leaderName: p.leaderName || p.leaderId,
        leaderSetId: p.leaderSetId,
        baseAspect: aspect,
        formatType: ft,
        wins: 0, losses: 0, draws: 0,
      });
    }
    const entry = leaderMap.get(key)!;
    if (won) entry.wins++;
    else if (lost) entry.losses++;
    else if (drw) entry.draws++;
  });

  const allLeaders = [...leaderMap.values()].sort((a, b) => (b.wins + b.losses + b.draws) - (a.wins + a.losses + a.draws));
  const premierLeaders = allLeaders.filter((l) => l.formatType === 'premier');
  const limitedLeaders = allLeaders.filter((l) => l.formatType === 'limited');
  const eternalLeaders = allLeaders.filter((l) => l.formatType === 'eternal');

  function leaderCardHtml(l: LeaderEntry): string {
    const imgUrl = cardImageUrl(l.leaderSetId ?? null);
    const total  = l.wins + l.losses + l.draws;
    const wr     = total > 0 ? (l.wins / total).toFixed(2) : '—';
    const wrClass = total === 0 ? 'neutral' : l.wins / total >= 0.5 ? '' : 'loss';
    const title = l.baseAspect ? `${escHtml(l.leaderName)} - ${escHtml(l.baseAspect)}` : escHtml(l.leaderName);
    return (
      `<div class="ov-leader-card">` +
      `<div class="ov-leader-card-title" title="${title}">${title}</div>` +
      (imgUrl
        ? `<img src="${escHtml(imgUrl)}" alt="${escHtml(l.leaderName)}" loading="lazy">`
        : `<div class="ov-leader-card-img-placeholder"></div>`) +
      `<div class="ov-leader-card-stats">` +
      `<div class="ov-leader-stat-row">` +
      `<span>Wins - <span class="ov-leader-stat-val">${l.wins}</span></span>` +
      `<span>WR - <span class="ov-leader-stat-val ${wrClass}">${wr}</span></span>` +
      `</div>` +
      `<div>Losses - <span class="ov-leader-stat-val loss">${l.losses}</span></div>` +
      (l.draws > 0 ? `<div>Draws - <span class="ov-leader-stat-val neutral">${l.draws}</span></div>` : '') +
      `</div>` +
      `</div>`
    );
  }

  function formatSection(label: string, leaders: LeaderEntry[]): string {
    if (leaders.length === 0) return '';
    return (
      `<div class="ov-format-label">${escHtml(label)}</div>` +
      `<div class="ov-leader-grid">${leaders.map(leaderCardHtml).join('')}</div>`
    );
  }

  const leaderSection = document.getElementById('ov-leader-section')!;
  if (allLeaders.length === 0) {
    leaderSection.innerHTML = '';
  } else {
    leaderSection.innerHTML =
      `<div class="ov-leaders-heading">Leader / Bases</div>` +
      formatSection('Premier', premierLeaders) +
      formatSection('Limited', limitedLeaders) +
      formatSection('Eternal', eternalLeaders);
  }
}

document.getElementById('ov-format')!.addEventListener('change', loadOverview);
document.getElementById('ov-player-name')!.addEventListener('change', loadOverview);

// ─── Matchups ────────────────────────────────────────────────────────────────

let _muData: MatchupRow[] = [];

function renderMuRows(rows: MatchupRow[]): void {
  const body = document.getElementById('mu-body')!;
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${cardChip(r.yourLeaderName || r.yourLeaderId, r.yourLeaderSetId)}</td>
      <td>${cardChip(r.opponentLeaderName || r.opponentLeaderId, r.opponentLeaderSetId)}</td>
      <td style="color:var(--win)">${r.wins}</td>
      <td style="color:var(--loss)">${r.losses}</td>
      <td style="color:var(--draw)">${r.draws}</td>
      <td>${r.totalGames}</td>
      <td>
        <div class="win-rate-bar">
          <span style="width:36px;text-align:right">${pct(r.winRate)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct(r.winRate)}"></div></div>
        </div>
      </td>
    </tr>`
    )
    .join('');
}

makeSortable('mu-table', () => _muData, renderMuRows, 'totalGames');
// cs-table sortable initialised lazily in loadCardStats

async function loadMatchups(): Promise<void> {
  const formatFilter = (document.getElementById('mu-format') as HTMLSelectElement).value;
  const player = (document.getElementById('mu-player-name') as HTMLInputElement).value.trim() || undefined;

  _muData = await getMatchupStats(formatFilter, player);
  renderMuRows(_muData);
}

document.getElementById('mu-refresh')!.addEventListener('click', loadMatchups);
document.getElementById('mu-format')!.addEventListener('change', loadMatchups);

// ─── Card Stats ───────────────────────────────────────────────────────────────

let _selectedLeaderId = '';
let _selectedBaseAspect = '';
let _cgData: CardStats[] = [];

// Floating stats tooltip element (created once)
const cgTooltipEl = (() => {
  const d = document.createElement('div');
  d.className = 'cg-tooltip';
  d.id = 'cg-tooltip';
  document.body.appendChild(d);
  return d;
})();

function csStatus(msg: string): void {
  const el = document.getElementById('cs-status');
  if (el) el.textContent = msg;
}

function cgStatBar(label: string, val: number, color: string): string {
  const pctStr = (val * 100).toFixed(0) + '%';
  return (
    `<div class="cg-stat-row">` +
    `<span class="cg-stat-label">${label}</span>` +
    `<div class="cg-stat-track"><div class="cg-stat-fill" style="width:${pctStr};background:${color}"></div></div>` +
    `<span class="cg-stat-val" style="color:${color}">${pctStr}</span>` +
    `</div>`
  );
}

function cgWinColor(wr: number): string {
  return wr >= 0.6 ? 'var(--win)' : wr >= 0.45 ? '#e8a010' : 'var(--loss)';
}

function renderCardGrid(rows: CardStats[]): void {
  const grid = document.getElementById('cs-card-grid')!;
  if (!grid) return;
  if (rows.length === 0) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:16px">No card data — play a game first.</div>';
    csStatus('');
    return;
  }

  // Sort
  const sortSel = document.getElementById('cs-sort') as HTMLSelectElement | null;
  const sortKey = (sortSel?.value ?? 'winRateWhenPlayed') as keyof CardStats;
  const sortAsc = sortSel?.selectedOptions[0]?.dataset.sortAsc !== undefined;
  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortKey] as number) ?? 0;
    const bv = (b[sortKey] as number) ?? 0;
    return sortAsc ? av - bv : bv - av;
  });

  csStatus(`${rows.length} cards`);

  grid.innerHTML = sorted.map((r) => {
    const imgUrl = cardImageUrl(r.cardSetId ?? null);
    const img = imgUrl
      ? `<img class="cg-card-img" src="${escHtml(imgUrl)}" alt="${escHtml(r.cardName)}" loading="lazy" title="${escHtml(r.cardName)}" />`
      : `<div class="cg-card-img" style="background:var(--surface2)" title="${escHtml(r.cardName)}"></div>`;

    const bars =
      cgStatBar('Win%P', r.winRateWhenPlayed, cgWinColor(r.winRateWhenPlayed)) +
      cgStatBar('Win%D', r.winRateWhenDrawn,  cgWinColor(r.winRateWhenDrawn)) +
      cgStatBar('Play',  r.playRate,           'var(--accent)') +
      cgStatBar('Rsrc',  r.resourceRate,       '#6a8fd8');

    return (
      `<div class="cg-item"` +
      ` data-card-id="${escHtml(r.cardId)}"` +
      ` data-wr-played="${r.winRateWhenPlayed.toFixed(4)}"` +
      ` data-wr-drawn="${r.winRateWhenDrawn.toFixed(4)}"` +
      ` data-resource-rate="${r.resourceRate.toFixed(4)}"` +
      ` data-play-rate="${r.playRate.toFixed(4)}"` +
      ` data-avg-copies="${r.avgCopiesPerGame.toFixed(2)}"` +
      ` data-avg-round="${r.avgRoundPlayed.toFixed(1)}"` +
      ` data-games="${r.gamesAppeared}"` +
      ` data-played="${r.played}"` +
      ` data-drawn="${r.drawn}"` +
      ` data-resourced="${r.resourced}"` +
      ` data-discarded="${r.discarded}"` +
      ` data-activated="${r.activated}"` +
      `>` +
      img +
      `<div class="cg-stat-bars">${bars}</div>` +
      `</div>`
    );
  }).join('');
}

// Tooltip for card grid
function cgTooltipRow(key: string, val: string): string {
  return `<div class="cg-tooltip-row"><span class="cg-tooltip-key">${key}</span><span class="cg-tooltip-val">${val}</span></div>`;
}

document.getElementById('cs-card-grid')!.addEventListener('mouseover', (e: MouseEvent) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.cg-item');
  if (!item) { cgTooltipEl.style.display = 'none'; return; }
  const d = item.dataset;
  cgTooltipEl.innerHTML =
    cgTooltipRow('Win% played', pct(parseFloat(d.wrPlayed ?? '0'))) +
    cgTooltipRow('Win% drawn', pct(parseFloat(d.wrDrawn ?? '0'))) +
    cgTooltipRow('Resource rate', pct(parseFloat(d.resourceRate ?? '0'))) +
    cgTooltipRow('Play rate', pct(parseFloat(d.playRate ?? '0'))) +
    cgTooltipRow('Avg copies/game', parseFloat(d.avgCopies ?? '0').toFixed(2)) +
    cgTooltipRow('Avg round played', parseFloat(d.avgRound ?? '0').toFixed(1)) +
    cgTooltipRow('Games appeared', d.games ?? '0') +
    cgTooltipRow('Total played', d.played ?? '0') +
    cgTooltipRow('Total drawn', d.drawn ?? '0') +
    cgTooltipRow('Resourced', d.resourced ?? '0') +
    cgTooltipRow('Discarded', d.discarded ?? '0') +
    cgTooltipRow('Activated', d.activated ?? '0');
  cgTooltipEl.style.display = 'block';
  positionCgTooltip(e);
});

document.getElementById('cs-card-grid')!.addEventListener('mousemove', (e: MouseEvent) => {
  if (cgTooltipEl.style.display === 'none') return;
  const item = (e.target as HTMLElement).closest<HTMLElement>('.cg-item');
  if (!item) { cgTooltipEl.style.display = 'none'; return; }
  positionCgTooltip(e);
});

document.getElementById('cs-card-grid')!.addEventListener('mouseleave', () => {
  cgTooltipEl.style.display = 'none';
});

function positionCgTooltip(e: MouseEvent): void {
  const OFFSET = 14;
  const tw = 180;
  let left = e.clientX + OFFSET;
  let top = e.clientY + OFFSET;
  if (left + tw > window.innerWidth) left = e.clientX - tw - OFFSET;
  if (top + 240 > window.innerHeight) top = e.clientY - 240 - OFFSET;
  cgTooltipEl.style.left = `${left}px`;
  cgTooltipEl.style.top = `${top}px`;
}

async function loadBaseColorDropdown(): Promise<void> {
  const player = (document.getElementById('cs-player-name') as HTMLInputElement).value.trim() || undefined;
  const select = document.getElementById('cs-base-color') as HTMLSelectElement;
  let aspects: string[];
  try {
    aspects = await getBaseColorList(_selectedLeaderId || undefined, player);
  } catch {
    aspects = [];
  }
  const prev = _selectedBaseAspect;
  select.innerHTML = '<option value="">(all bases)</option>';
  for (const a of aspects) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a.charAt(0).toUpperCase() + a.slice(1);
    if (a === prev) opt.selected = true;
    select.appendChild(opt);
  }
  _selectedBaseAspect = aspects.includes(prev) ? prev : '';
  select.value = _selectedBaseAspect;
}

async function loadLeaderPanel(): Promise<void> {
  const player = (document.getElementById('cs-player-name') as HTMLInputElement).value.trim() || undefined;
  let leaders: LeaderOption[];
  try {
    leaders = await getLeaderList(player);
  } catch {
    leaders = [];
  }

  const panel = document.getElementById('cs-leaders')!;
  // Keep the title element
  const titleEl = panel.querySelector('.cs-panel-title')!;
  panel.innerHTML = '';
  panel.appendChild(titleEl);

  // "All" entry
  const allItem = document.createElement('div');
  allItem.className = 'cs-leader-item' + (_selectedLeaderId === '' ? ' active' : '');
  allItem.dataset.leaderId = '';
  allItem.innerHTML = `<span style="font-size:10px;color:var(--muted);padding:4px">All Leaders</span>`;
  allItem.addEventListener('click', () => selectLeader(''));
  panel.appendChild(allItem);

  for (const l of leaders) {
    const imgUrl = cardImageUrl(l.leaderSetId ?? null);
    const item = document.createElement('div');
    item.className = 'cs-leader-item' + (l.leaderId === _selectedLeaderId ? ' active' : '');
    item.dataset.leaderId = l.leaderId;
    item.innerHTML =
      (imgUrl ? `<img src="${escHtml(imgUrl)}" alt="" loading="lazy">` : '') +
      `<span class="cs-leader-name">${escHtml(l.leaderName || l.leaderId)}</span>`;
    item.addEventListener('click', () => selectLeader(l.leaderId));
    panel.appendChild(item);
  }
}

async function selectLeader(leaderId: string): Promise<void> {
  _selectedLeaderId = leaderId;
  // Update active states
  document.querySelectorAll('.cs-leader-item').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.leaderId === leaderId);
  });
  const titleEl = document.getElementById('cs-leader-title')!;
  if (!leaderId) {
    titleEl.textContent = 'All Leaders';
  } else {
    const name = (document.querySelector(`.cs-leader-item[data-leader-id="${leaderId}"] .cs-leader-name`) as HTMLElement)?.textContent ?? leaderId;
    titleEl.textContent = name;
  }
  await loadBaseColorDropdown();
  await loadCardStats();
}

async function loadCardStats(): Promise<void> {
  csStatus('Loading…');
  const formatFilter = (document.getElementById('cs-format') as HTMLSelectElement).value;
  const player = (document.getElementById('cs-player-name') as HTMLInputElement).value.trim() || undefined;
  _selectedBaseAspect = (document.getElementById('cs-base-color') as HTMLSelectElement).value;

  let data: CardStats[];
  try {
    data = await getCardStats(
      formatFilter,
      player,
      _selectedLeaderId || undefined,
      _selectedBaseAspect || undefined
    );
  } catch (err) {
    console.error('[KB Tracker] loadCardStats failed:', err);
    csStatus(`Error: ${String(err)}`);
    return;
  }
  _cgData = data;
  renderCardGrid(data);
}

document.getElementById('cs-sort')!.addEventListener('change', () => {
  if (_cgData.length > 0) renderCardGrid(_cgData);
});

document.getElementById('cs-refresh')!.addEventListener('click', async () => {
  await loadLeaderPanel();
  await loadBaseColorDropdown();
  await loadCardStats();
});
document.getElementById('cs-format')!.addEventListener('change', loadCardStats);
document.getElementById('cs-base-color')!.addEventListener('change', loadCardStats);

// ─── Game History ────────────────────────────────────────────────────────────

async function loadHistory(): Promise<void> {
  const formatFilter = (document.getElementById('gh-format') as HTMLSelectElement).value;

  let games = (await getRecentGames(5000)) as GameSummary[];
  if (formatFilter === 'limited') games = games.filter((g) => g.isLimitedFormat);
  else if (formatFilter === 'eternal') games = games.filter((g) => g.format === 'open');
  else if (formatFilter === 'premier') games = games.filter((g) => !g.isLimitedFormat && g.format !== 'open');

  _ghGames = games;
  const body = document.getElementById('gh-body')!;
  body.innerHTML = games
    .map((g) => {
      const p0 = g.players[0];
      const p1 = g.players[1];
      const isWin = g.winner === p0.name;
      const isDraw = g.winner === null;
      const res = isDraw ? 'Draw' : isWin ? 'Win' : 'Loss';
      const resColor = isDraw ? 'var(--draw)' : isWin ? 'var(--win)' : 'var(--loss)';
      const fmtClass = g.isLimitedFormat ? 'limited' : g.format === 'open' ? 'eternal' : 'premier';
      const fmtLabel = g.isLimitedFormat ? 'Limited' : g.format === 'open' ? 'Eternal' : 'Premier';
      const isHidden = g.hidden ?? false;
      const curFmt: 'premier' | 'limited' | 'eternal' = g.isLimitedFormat ? 'limited' : g.format === 'open' ? 'eternal' : 'premier';
      const FMT_NEXT: Record<string, string> = { premier: 'Limited', limited: 'Eternal', eternal: 'Premier' };

      return `
        <tr${isHidden ? ' class="gh-row-hidden"' : ''}>
          <td>${formatDate(g.completedAt)}</td>
          <td><span class="badge ${fmtClass}">${fmtLabel}</span></td>
          <td>${cardChip(p0.leaderName || p0.leaderId, p0.leaderSetId)}</td>
          <td>${cardChip(p1.leaderName || p1.leaderId, p1.leaderSetId)}</td>
          <td style="color:${resColor};font-weight:600">${res}</td>
          <td>${g.rounds}</td>
          <td><button class="gh-3dot"
            data-gameid="${g.gameId}"
            data-hidden="${isHidden ? '1' : '0'}"
            data-curfmt="${curFmt}"
            data-nextfmt="${FMT_NEXT[curFmt]}"
          >&#8942;</button></td>
        </tr>`;
    })
    .join('');
}

document.getElementById('gh-format')!.addEventListener('change', loadHistory);

// ─── Game History 3-dot menu ──────────────────────────────────────────────────

const _ghMenu = document.getElementById('gh-popup-menu')!;
let _ghMenuGameId = '';

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.gh-3dot');
  if (btn) {
    e.stopPropagation();
    _ghMenuGameId = btn.dataset.gameid!;
    const isHidden = btn.dataset.hidden === '1';
    const curFmt  = btn.dataset.curfmt  ?? 'premier';
    const nextFmt = btn.dataset.nextfmt ?? 'Limited';
    (document.getElementById('gh-menu-hide') as HTMLButtonElement).textContent =
      isHidden ? '\u{1F440} Show in Stats' : '\u{1F648} Hide from Stats';
    (document.getElementById('gh-menu-format') as HTMLButtonElement).textContent =
      `\u21BA ${curFmt.charAt(0).toUpperCase() + curFmt.slice(1)} \u2192 ${nextFmt}`;
    const r = btn.getBoundingClientRect();
    _ghMenu.style.display = 'flex';
    _ghMenu.style.top  = (r.bottom + 4) + 'px';
    _ghMenu.style.left = r.left + 'px';
    requestAnimationFrame(() => {
      const w = _ghMenu.offsetWidth;
      if (r.left + w > window.innerWidth - 8)
        _ghMenu.style.left = (r.right - w) + 'px';
    });
    return;
  }
  if (!(e.target as HTMLElement).closest('#gh-popup-menu'))
    _ghMenu.style.display = 'none';
}, true);

document.getElementById('gh-menu-review')!.addEventListener('click', async () => {
  _ghMenu.style.display = 'none';
  const game = _ghGames.find((g) => g.gameId === _ghMenuGameId);
  if (game) await openReview(game);
});

document.getElementById('gh-menu-format')!.addEventListener('click', async () => {
  _ghMenu.style.display = 'none';
  const game = _ghGames.find((g) => g.gameId === _ghMenuGameId);
  if (!game) return;
  const cur: 'premier' | 'limited' | 'eternal' =
    game.isLimitedFormat ? 'limited' : game.format === 'open' ? 'eternal' : 'premier';
  const ORDER: Array<'premier' | 'limited' | 'eternal'> = ['premier', 'limited', 'eternal'];
  const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
  await updateGameFormat(_ghMenuGameId, next);
  await Promise.all([loadHistory(), loadOverview()]);
});

document.getElementById('gh-menu-hide')!.addEventListener('click', async () => {
  _ghMenu.style.display = 'none';
  const game = _ghGames.find((g) => g.gameId === _ghMenuGameId);
  if (!game) return;
  await toggleGameHidden(_ghMenuGameId, !(game.hidden ?? false));
  await Promise.all([loadHistory(), loadOverview()]);
});

document.getElementById('gh-menu-delete')!.addEventListener('click', async () => {
  _ghMenu.style.display = 'none';
  if (!confirm('Delete this game record?')) return;
  await deleteGame(_ghMenuGameId);
  await Promise.all([loadHistory(), loadOverview()]);
});

// ─── Round Review Modal ────────────────────────────────────────────────────────

const reviewOverlay = document.getElementById('review-overlay')!;
const reviewTitle   = document.getElementById('review-title')!;
const reviewMeta    = document.getElementById('review-meta')!;
const reviewRounds  = document.getElementById('review-rounds')!;
const reviewCharts  = document.getElementById('review-charts')!;
const reviewBody    = document.getElementById('review-body')!;

/** Stored when a review is opened — used by the Export PDF button. */
let _reviewSnaps: RoundSnapshot[] = [];
let _reviewGame:  GameSummary | null = null;

document.getElementById('review-close')!.addEventListener('click', () => {
  reviewOverlay.classList.remove('open');
});
reviewOverlay.addEventListener('click', (e) => {
  if (e.target === reviewOverlay) reviewOverlay.classList.remove('open');
});

/** Renders a small SVG line chart with two series.
 * @param xLabels  - text label for each x data point; empty string = no label
 * @param roundMarkers - optional: draw a vertical round-boundary line + label at these indices
 */
function svgLineChart(
  series: { label: string; color: string; values: number[] }[],
  xLabels: string[],
  roundMarkers?: Array<{ index: number; label: string }>
): string {
  const W = 260, H = 110;
  const padL = 28, padR = 8, padT = 16, padB = 20;
  const w = W - padL - padR;
  const h = H - padT - padB;

  const allValues = series.flatMap((s) => s.values);
  const maxV = Math.max(...allValues, 1);
  const minV = Math.min(...allValues, 0);
  const range = maxV - minV || 1;

  const n = xLabels.length;
  const xScale = (i: number): number => padL + (n > 1 ? (i / (n - 1)) * w : w / 2);
  const yScale = (v: number): number => padT + h - ((v - minV) / range) * h;

  const yTicks: number[] = [minV];
  if (maxV - minV >= 4) yTicks.push(Math.round((minV + maxV) / 2));
  yTicks.push(maxV);
  const uniqueYTicks = [...new Set(yTicks)];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block">`;

  // Axes
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + h}" stroke="var(--border)" stroke-width="1"/>`;
  svg += `<line x1="${padL}" y1="${padT + h}" x2="${padL + w}" y2="${padT + h}" stroke="var(--border)" stroke-width="1"/>`;

  // Y ticks + horizontal grid lines
  for (const v of uniqueYTicks) {
    const y = yScale(v).toFixed(1);
    svg += `<text x="${padL - 3}" y="${parseFloat(y) + 3}" text-anchor="end" font-size="7" fill="var(--muted)" font-family="inherit">${v}</text>`;
    if (v > minV) {
      svg += `<line x1="${padL}" y1="${y}" x2="${padL + w}" y2="${y}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,2"/>`;
    }
  }

  // X axis labels and round-boundary lines
  if (roundMarkers && roundMarkers.length > 0) {
    // Only show labels/lines at round boundaries
    for (const { index, label } of roundMarkers) {
      const x = xScale(index).toFixed(1);
      svg += `<text x="${x}" y="${padT + h + 13}" text-anchor="middle" font-size="7" fill="var(--muted)" font-family="inherit">${label}</text>`;
      if (index > 0) {
        // vertical dashed line for round boundary
        svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + h}" stroke="var(--muted)" stroke-width="0.8" stroke-dasharray="3,2" opacity="0.7"/>`;
      }
    }
  } else {
    // Simple mode: label every data point
    for (let i = 0; i < n; i++) {
      const x = xScale(i).toFixed(1);
      if (xLabels[i]) {
        svg += `<text x="${x}" y="${padT + h + 13}" text-anchor="middle" font-size="7" fill="var(--muted)" font-family="inherit">${xLabels[i]}</text>`;
      }
      if (i > 0) {
        svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + h}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,4"/>`;
      }
    }
  }

  // Lines + dots per series
  for (const s of series) {
    if (s.values.length > 1) {
      const pts = s.values.map((v, i) => `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
      svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-linejoin="round"/>`;
    }
    for (let i = 0; i < s.values.length; i++) {
      // Round-start dots are larger; intra-round dots are smaller
      const isRoundStart = !roundMarkers || roundMarkers.some((m) => m.index === i);
      const r = isRoundStart ? '2.5' : '1.8';
      svg += `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(s.values[i]).toFixed(1)}" r="${r}" fill="${s.color}"/>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

/**
 * Flattens round-start snapshots + intra-round base HP changes into
 * a single ordered series suitable for `svgLineChart` with round markers.
 */
function buildBaseHpSeries(snaps: RoundSnapshot[]): {
  youValues: number[];
  oppValues: number[];
  roundMarkers: Array<{ index: number; label: string }>;
} {
  const youValues: number[] = [];
  const oppValues: number[] = [];
  const roundMarkers: Array<{ index: number; label: string }> = [];

  for (const snap of snaps) {
    roundMarkers.push({ index: youValues.length, label: `R${snap.round}` });
    youValues.push(Math.max(0, (snap.players[0].base.hp ?? 30) - (snap.players[0].base.damage ?? 0)));
    oppValues.push(Math.max(0, (snap.players[1].base.hp ?? 30) - (snap.players[1].base.damage ?? 0)));

    for (const chg of snap.baseHpChanges ?? []) {
      youValues.push(chg.youHp);
      oppValues.push(chg.oppHp);
    }
  }

  return { youValues, oppValues, roundMarkers };
}

/** Replaces the per-round chart section in the modal. */
function renderCharts(snaps: RoundSnapshot[]): void {
  if (snaps.length === 0) { reviewCharts.innerHTML = ''; return; }
  reviewCharts.innerHTML = buildChartsHtml(snaps);
}

async function openReview(game: GameSummary): Promise<void> {
  const p0 = game.players[0];
  const p1 = game.players[1];
  const isWin = game.winner === p0.name;
  const isDraw = game.winner === null;
  const res = isDraw ? 'Draw' : isWin ? 'Win' : 'Loss';

  reviewTitle.textContent = `${p0.leaderName || p0.leaderId}  vs  ${p1.leaderName || p1.leaderId}`;
  reviewMeta.textContent  = `${formatDate(game.completedAt)} · ${game.rounds} rounds · ${res}`;

  reviewRounds.innerHTML = '<span style="font-size:11px;color:var(--muted)">Loading…</span>';
  reviewCharts.innerHTML = '';
  reviewBody.innerHTML   = '';
  reviewOverlay.classList.add('open');

  const snaps = await getSnapshots(game.gameId);
  _reviewSnaps = snaps;
  _reviewGame  = game;

  if (snaps.length === 0) {
    reviewRounds.innerHTML = '';
    reviewBody.innerHTML   = '<div class="review-no-data">No round snapshots available for this game.<br>Snapshots are captured starting from newly recorded games.</div>';
    return;
  }

  // Build round pills
  let activeRound = snaps[0].round;
  function renderPills(): void {
    reviewRounds.innerHTML = snaps
      .map((s) =>
        `<button class="review-pill${s.round === activeRound ? ' active' : ''}" data-snap-round="${s.round}">` +
        `Round ${s.round}` +
        `</button>`
      )
      .join('');
    reviewRounds.querySelectorAll<HTMLButtonElement>('[data-snap-round]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeRound = parseInt(btn.dataset.snapRound!);
        renderPills();
        const snap = snaps.find((s) => s.round === activeRound);
        if (snap) renderReviewRound(snap);
      });
    });
  }

  renderPills();
  renderCharts(snaps);
  renderReviewRound(snaps[0]);
}

document.getElementById('review-export-pdf')!.addEventListener('click', () => {
  if (_reviewGame && _reviewSnaps.length > 0) {
    const g = _reviewGame;
    const p0 = g.players[0];
    const p1 = g.players[1];
    const isWin  = g.winner === p0.name;
    const isDraw = g.winner === null;
    const res    = isDraw ? 'Draw' : isWin ? 'Win' : 'Loss';
    const title  = `${p0.leaderName || p0.leaderId} vs ${p1.leaderName || p1.leaderId}`;
    const meta   = `${formatDate(g.completedAt)} · ${g.rounds} rounds · ${res}`;
    printGameReview(title, meta, _reviewSnaps);
  }
});

type CardLike = { id?: string; name?: string; setId?: { set: string; number: number }; facedown?: boolean; damage?: number; exhausted?: boolean };

function reviewCardHtml(card: CardLike): string {
  if (card.facedown) {
    return `<div class="review-card-placeholder">▦</div>`;
  }
  const imgUrl = cardImageUrl(card.setId ?? null);
  const damBadge = card.damage ? `<div class="review-card-damage">${card.damage}</div>` : '';
  const exhaustedClass = card.exhausted ? ' exhausted' : '';
  const damagedClass   = card.damage    ? ' damaged'   : '';
  return (
    `<div class="review-card${exhaustedClass}${damagedClass}">` +
    (imgUrl
      ? `<img src="${escHtml(imgUrl)}" alt="" loading="lazy">`
      : `<div style="width:70px;height:98px;background:var(--surface);"></div>`) +
    damBadge +
    `<div class="review-card-label">${escHtml(card.name ?? card.id ?? '')}</div>` +
    `</div>`
  );
}

/** Same layout as reviewCardHtml but using print-* classes (no CSS variables) */
function printCardHtml(card: CardLike): string {
  if (card.facedown) {
    return `<div class="print-card-placeholder">▦</div>`;
  }
  const imgUrl = cardImageUrl(card.setId ?? null);
  const damBadge = card.damage ? `<div class="print-card-damage">${card.damage}</div>` : '';
  const exhaustedClass = card.exhausted ? ' exhausted' : '';
  return (
    `<div class="print-card${exhaustedClass}">` +
    (imgUrl ? `<img src="${escHtml(imgUrl)}" alt="">` : '') +
    damBadge +
    `<div class="print-card-label">${escHtml(card.name ?? card.id ?? '')}</div>` +
    `</div>`
  );
}

function reviewPlayerHtml(p: PlayerSnapshot, label: string): string {
  const maxHp    = p.base.hp ?? 30;
  const curHp    = Math.max(0, maxHp - (p.base.damage ?? 0));
  const hpPct    = (curHp / maxHp) * 100;
  const hpClass  = hpPct > 50 ? '' : hpPct > 25 ? ' low' : ' critical';
  const initBadge = p.hasInitiative ? '<span class="review-initiative">INITIATIVE</span>' : '';

  const allGround = p.groundArena ?? [];
  const allSpace  = p.spaceArena  ?? [];
  const hand      = p.hand ?? [];

  const arenaSection = (cards: CardLike[], title: string): string => {
    if (cards.length === 0) return '';
    return (
      `<div class="review-section">` +
      `<div class="review-section-title">${title} (${cards.length})</div>` +
      `<div class="review-cards">${cards.map(reviewCardHtml).join('')}</div>` +
      `</div>`
    );
  };

  const visibleHandCards = hand.filter((c) => !c.facedown);
  const facedownCount    = hand.filter((c) => c.facedown).length;
  const handContent =
    visibleHandCards.length > 0
      ? `<div class="review-cards">${visibleHandCards.map(reviewCardHtml).join('')}` +
        (facedownCount > 0 ? `<div class="review-card-placeholder">${facedownCount}×▦</div>` : '') +
        `</div>`
      : `<span class="review-hand-count">🂠 ${hand.length}</span>`;

  return (
    `<div class="review-player">` +
    `<div class="review-player-title">${escHtml(label)} ${initBadge}</div>` +
    `<div class="review-section">` +
    `<div class="review-section-title">Base · ${escHtml(p.base.name ?? p.base.id ?? 'Base')}</div>` +
    `<div class="review-hp-bar-wrap">` +
    `<div class="review-hp-track"><div class="review-hp-fill${hpClass}" style="width:${hpPct.toFixed(1)}%"></div></div>` +
    `<span class="review-hp-text" style="color:${hpClass.includes('critical') ? 'var(--loss)' : hpClass.includes('low') ? '#e88010' : 'var(--win)'}">${curHp}/${maxHp}</span>` +
    `</div></div>` +
    `<div class="review-section"><div class="review-section-title">Leader</div>` +
    `<div class="review-cards">${reviewCardHtml(p.leader)}</div></div>` +
    `<div class="review-section"><div class="review-section-title">Resources</div>` +
    `<div class="review-stat-row"><span class="review-stat-label">Available</span><span class="review-stat-val">${p.availableResources} / ${p.totalResources}</span></div>` +
    (p.credits > 0 ? `<div class="review-stat-row"><span class="review-stat-label">Credits</span><span class="review-stat-val">${p.credits}</span></div>` : '') +
    `<div class="review-stat-row"><span class="review-stat-label">Cards in Deck</span><span class="review-stat-val">${p.numCardsInDeck}</span></div>` +
    `</div>` +
    `<div class="review-section"><div class="review-section-title">Hand (${hand.length})</div>${handContent}</div>` +
    arenaSection(allGround, 'Ground Arena') +
    arenaSection(allSpace, 'Space Arena') +
    `</div>`
  );
}

function printPlayerHtml(p: PlayerSnapshot, label: string): string {
  const maxHp   = p.base.hp ?? 30;
  const curHp   = Math.max(0, maxHp - (p.base.damage ?? 0));
  const hpPct   = (curHp / maxHp) * 100;
  const hpColor = hpPct > 50 ? '#27ae60' : hpPct > 25 ? '#e67e22' : '#c0392b';
  const initBadge = p.hasInitiative ? '<span class="print-initiative-badge">INITIATIVE</span>' : '';

  const allGround = p.groundArena ?? [];
  const allSpace  = p.spaceArena  ?? [];
  const hand      = p.hand ?? [];

  const arenaSection = (cards: CardLike[], title: string): string => {
    if (cards.length === 0) return '';
    return (
      `<div class="print-section">` +
      `<div class="print-section-title">${title} (${cards.length})</div>` +
      `<div class="print-cards">${cards.map(printCardHtml).join('')}</div>` +
      `</div>`
    );
  };

  const visibleHandCards = hand.filter((c) => !c.facedown);
  const facedownCount    = hand.filter((c) => c.facedown).length;
  const handContent =
    visibleHandCards.length > 0
      ? `<div class="print-cards">${visibleHandCards.map(printCardHtml).join('')}` +
        (facedownCount > 0 ? `<span style="font-size:9px;color:#888">&nbsp;+${facedownCount} hidden</span>` : '') +
        `</div>`
      : `<span style="font-size:10px">${hand.length} cards (hidden)</span>`;

  return (
    `<div>` +
    `<div class="print-player-title">${escHtml(label)}${initBadge}</div>` +
    `<div class="print-section">` +
    `<div class="print-section-title">Base · ${escHtml(p.base.name ?? p.base.id ?? 'Base')}</div>` +
    `<div class="print-hp-bar-wrap">` +
    `<div class="print-hp-track"><div class="print-hp-fill" style="width:${hpPct.toFixed(1)}%;background:${hpColor}"></div></div>` +
    `<span class="print-hp-text">${curHp}/${maxHp}</span>` +
    `</div></div>` +
    `<div class="print-section"><div class="print-section-title">Leader</div>` +
    `<div class="print-cards">${printCardHtml(p.leader)}</div></div>` +
    `<div class="print-section"><div class="print-section-title">Resources</div>` +
    `<div class="print-stat-row"><span class="print-stat-label">Available</span><span class="print-stat-val">${p.availableResources} / ${p.totalResources}</span></div>` +
    (p.credits > 0 ? `<div class="print-stat-row"><span class="print-stat-label">Credits</span><span class="print-stat-val">${p.credits}</span></div>` : '') +
    `<div class="print-stat-row"><span class="print-stat-label">Cards in Deck</span><span class="print-stat-val">${p.numCardsInDeck}</span></div>` +
    `</div>` +
    `<div class="print-section"><div class="print-section-title">Hand (${hand.length})</div>${handContent}</div>` +
    arenaSection(allGround, 'Ground Arena') +
    arenaSection(allSpace, 'Space Arena') +
    `</div>`
  );
}

/** Returns plain HTML for one round (used by both modal and print). */
function buildRoundBodyHtml(snap: RoundSnapshot, useReviewClasses: boolean): string {
  const [you, opp] = snap.players;
  const initiativeHolder = you.hasInitiative ? you.name : opp.hasInitiative ? opp.name : null;

  const logLines = snap.logEntries
    .map((e) => formatLogEntry(e))
    .filter((s): s is string => s !== null && s.trim().length > 0);

  if (useReviewClasses) {
    const logHtml = logLines.length > 0
      ? logLines.map((l) => `<div class="review-log-line">${escHtml(l)}</div>`).join('')
      : `<div class="review-log-empty">No actions recorded for this round.</div>`;
    return (
      `<div class="review-initiative-header">` +
      (initiativeHolder ? `⚡ <strong>${escHtml(initiativeHolder)}</strong> has initiative this round` : 'Initiative unknown') +
      `</div>` +
      reviewPlayerHtml(you, `You — ${you.name}`) +
      reviewPlayerHtml(opp, `Opponent — ${opp.name}`) +
      `<div class="review-log">` +
      `<div class="review-section-title" style="margin-bottom:8px">Round ${snap.round} Action Log</div>` +
      logHtml +
      `</div>`
    );
  } else {
    const logHtml = logLines.length > 0
      ? logLines.map((l) => `<div class="print-log-line">${escHtml(l)}</div>`).join('')
      : `<div style="font-size:9px;color:#888;font-style:italic">No actions recorded.</div>`;
    return (
      `<div class="print-round-header">Round ${snap.round}</div>` +
      `<div class="print-initiative-note">` +
      (initiativeHolder ? `⚡ ${escHtml(initiativeHolder)} has initiative` : 'Initiative unknown') +
      `</div>` +
      `<div class="print-players">` +
      printPlayerHtml(you, `You — ${you.name}`) +
      printPlayerHtml(opp, `Opponent — ${opp.name}`) +
      `</div>` +
      `<div class="print-log">` +
      `<div class="print-log-title">Action Log</div>` +
      logHtml +
      `</div>`
    );
  }
}

/** Builds the charts HTML string (reused by modal + cover page). */
function buildChartsHtml(snaps: RoundSnapshot[]): string {
  const rounds   = snaps.map((s) => s.round);
  const youName  = snaps[0].players[0].name;
  const oppName  = snaps[0].players[1].name;
  const colorYou = '#4caf50';
  const colorOpp = '#e07060';

  const baseHp = buildBaseHpSeries(snaps);
  const baseHpChartHtml =
    `<div class="review-chart-wrap">` +
    `<div class="review-chart-title">Base HP</div>` +
    svgLineChart(
      [{ label: youName, color: colorYou, values: baseHp.youValues }, { label: oppName, color: colorOpp, values: baseHp.oppValues }],
      baseHp.youValues.map(() => ''),
      baseHp.roundMarkers
    ) + `</div>`;

  const xLabels = rounds.map(String);
  const simpleChartDefs: Array<{ title: string; youVals: number[]; oppVals: number[] }> = [
    { title: 'Hand Size',       youVals: snaps.map((s) => s.players[0].hand.length),          oppVals: snaps.map((s) => s.players[1].hand.length) },
    { title: 'Avail. Resources',youVals: snaps.map((s) => s.players[0].availableResources),   oppVals: snaps.map((s) => s.players[1].availableResources) },
    { title: 'Total Resources', youVals: snaps.map((s) => s.players[0].totalResources),        oppVals: snaps.map((s) => s.players[1].totalResources) },
    { title: 'Credits',         youVals: snaps.map((s) => s.players[0].credits),               oppVals: snaps.map((s) => s.players[1].credits) },
    { title: 'Cards in Deck',   youVals: snaps.map((s) => s.players[0].numCardsInDeck),        oppVals: snaps.map((s) => s.players[1].numCardsInDeck) },
  ];
  const simpleChartsHtml = simpleChartDefs
    .map(({ title, youVals, oppVals }) =>
      `<div class="review-chart-wrap">` +
      `<div class="review-chart-title">${escHtml(title)}</div>` +
      svgLineChart([{ label: youName, color: colorYou, values: youVals }, { label: oppName, color: colorOpp, values: oppVals }], xLabels) +
      `</div>`
    ).join('');

  return (
    `<div class="review-chart-legend">` +
    `<span style="color:${colorYou};margin-right:3px">▬</span>${escHtml(youName)}` +
    `<span style="color:${colorOpp};margin-left:12px;margin-right:3px">▬</span>${escHtml(oppName)}` +
    `</div>` +
    `<div class="review-chart-grid">${baseHpChartHtml}${simpleChartsHtml}</div>`
  );
}

/** Populates #print-area and triggers window.print(). */
function printGameReview(
  titleText: string,
  metaText: string,
  snaps: RoundSnapshot[]
): void {
  const printArea = document.getElementById('print-area')!;

  // Cover page: title + charts overview
  const coverHtml =
    `<div class="print-page">` +
    `<div class="print-cover-title">${escHtml(titleText)}</div>` +
    `<div class="print-cover-meta">${escHtml(metaText)}</div>` +
    `<div class="print-cover-charts">${buildChartsHtml(snaps)}</div>` +
    `</div>`;

  // One page per round
  const roundPages = snaps
    .map((snap) => `<div class="print-page">${buildRoundBodyHtml(snap, false)}</div>`)
    .join('');

  printArea.innerHTML = coverHtml + roundPages;
  window.print();
  // Clean up after the print dialog closes
  printArea.innerHTML = '';
}


function renderReviewRound(snap: RoundSnapshot): void {
  reviewBody.innerHTML = buildRoundBodyHtml(snap, true);
}


// ─── Export ───────────────────────────────────────────────────────────────────

document.getElementById('export-btn')!.addEventListener('click', async () => {
  try {
    const data = await exportAll();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kb-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[KB Tracker] export failed:', err);
  }
});

// ─── Tools / Import & Aggregate ──────────────────────────────────────────────

type ImportedDataset = {
  filename: string;
  exportedAt: string;
  games: StoredGame[];
  events: CardEvent[];
  rawLogs: { gameId: string; entries: import('../shared/types').IChatEntry[] }[];
  snapshots: { gameId: string; snapshots: import('../shared/types').RoundSnapshot[] }[];
};

let _importedDatasets: ImportedDataset[] = [];

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderToolsView(): void {
  const sourcesWrap = document.getElementById('tools-sources-wrap')!;
  const list        = document.getElementById('tools-import-list')!;
  const summary     = document.getElementById('tools-agg-summary')!;
  const statCards   = document.getElementById('tools-agg-stat-cards')!;
  const leaderSec   = document.getElementById('tools-agg-leader-section')!;
  const mergeBtn    = document.getElementById('tools-merge-btn') as HTMLButtonElement;

  if (_importedDatasets.length === 0) { sourcesWrap.style.display = 'none'; return; }
  sourcesWrap.style.display = '';

  // Source list
  list.innerHTML = _importedDatasets.map((ds, i) => {
    const dates = ds.games.map((g) => g.completedAt).sort();
    const dateRange = dates.length ? `${fmtDateShort(dates[0])} – ${fmtDateShort(dates[dates.length - 1])}` : 'No games';
    const players = [...new Set(ds.games.map((g) => g.players[0].name))].join(', ');
    return `
      <li class="import-source">
        <div>
          <div class="src-name">${ds.filename}</div>
          <div class="src-meta">${ds.games.length} game${ds.games.length !== 1 ? 's' : ''} · ${dateRange}${players ? ' · ' + players : ''}</div>
        </div>
        <button class="src-remove" data-idx="${i}">✕ Remove</button>
      </li>`;
  }).join('');

  list.querySelectorAll<HTMLButtonElement>('.src-remove').forEach((btn) => {
    btn.addEventListener('click', () => { _importedDatasets.splice(Number(btn.dataset.idx), 1); renderToolsView(); });
  });

  // Aggregate stats
  const allGames: StoredGame[] = _importedDatasets.flatMap((ds) => ds.games);
  const totalSrcs = _importedDatasets.length;

  summary.innerHTML = `<p style="font-size:12px;color:var(--muted);margin-bottom:16px">
    Showing <strong style="color:var(--text)">${allGames.length}</strong> game${allGames.length !== 1 ? 's' : ''} across
    <strong style="color:var(--text)">${totalSrcs}</strong> source${totalSrcs !== 1 ? 's' : ''}.
  </p>`;

  const wins    = allGames.filter((g) => g.winner === g.players[0].name).length;
  const losses  = allGames.filter((g) => g.winner !== null && g.winner !== g.players[0].name).length;
  const draws   = allGames.filter((g) => g.winner === null).length;
  const wr      = allGames.length ? wins / allGames.length : 0;
  const limited = allGames.filter((g) => g.isLimitedFormat).length;
  const eternal = allGames.filter((g) => g.format === 'open').length;

  statCards.innerHTML = `
    <div class="stat-card"><div class="val">${allGames.length}</div><div class="lbl">Total Games</div></div>
    <div class="stat-card"><div class="val">${wins}</div><div class="lbl">Wins</div></div>
    <div class="stat-card"><div class="val">${losses}</div><div class="lbl">Losses</div></div>
    <div class="stat-card"><div class="val">${draws}</div><div class="lbl">Draws</div></div>
    <div class="stat-card"><div class="val">${pct(wr)}</div><div class="lbl">Win Rate</div></div>
    <div class="stat-card"><div class="val">${limited}</div><div class="lbl">Limited</div></div>
    <div class="stat-card"><div class="val">${eternal}</div><div class="lbl">Eternal</div></div>
  `;

  // Leader breakdown
  type LRow = { leaderId: string; leaderName: string; leaderSetId?: { set: string; number: number }; wins: number; total: number };
  const lmap = new Map<string, LRow>();
  for (const g of allGames) {
    const p = g.players[0];
    if (!lmap.has(p.leaderId)) lmap.set(p.leaderId, { leaderId: p.leaderId, leaderName: p.leaderName || p.leaderId, leaderSetId: p.leaderSetId, wins: 0, total: 0 });
    const row = lmap.get(p.leaderId)!;
    row.total++;
    if (g.winner === p.name) row.wins++;
  }
  const topLeaders = [...lmap.values()].sort((a, b) => b.total - a.total).slice(0, 30);

  leaderSec.innerHTML = topLeaders.length === 0 ? '' : `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <thead><tr style="font-size:11px;color:var(--muted);text-align:left">
        <th style="padding:6px 10px">Leader</th>
        <th style="padding:6px 10px;text-align:right">Games</th>
        <th style="padding:6px 10px;text-align:right">Wins</th>
        <th style="padding:6px 10px;text-align:right">Win %</th>
      </tr></thead>
      <tbody>${topLeaders.map((l) => `
        <tr style="border-top:1px solid var(--border)">
          <td style="padding:7px 10px">
            <div style="display:flex;align-items:center;gap:8px">
              ${l.leaderSetId ? `<img src="${cardImageUrl(l.leaderSetId.set, l.leaderSetId.number)}" style="height:28px;border-radius:3px" loading="lazy">` : ''}
              <span style="font-size:12px">${l.leaderName}</span>
            </div>
          </td>
          <td style="padding:7px 10px;text-align:right;font-size:12px">${l.total}</td>
          <td style="padding:7px 10px;text-align:right;font-size:12px">${l.wins}</td>
          <td style="padding:7px 10px;text-align:right;font-size:12px;font-weight:600;color:${
            l.wins / l.total >= 0.5 ? 'var(--win)' : 'var(--loss)'
          }">${pct(l.wins / l.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  mergeBtn.disabled = allGames.length === 0;
}

function loadFileIntoTools(file: File): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target!.result as string) as {
        exportedAt?: string;
        games: StoredGame[];
        events?: CardEvent[];
        rawLogs?: { gameId: string; entries: import('../shared/types').IChatEntry[] }[];
        snapshots?: { gameId: string; snapshots: import('../shared/types').RoundSnapshot[] }[];
      };
      if (!Array.isArray(json.games)) throw new Error('Not a valid KB Tracker export (missing games array)');
      _importedDatasets.push({
        filename: file.name,
        exportedAt: json.exportedAt ?? new Date().toISOString(),
        games: json.games,
        events:    Array.isArray(json.events)    ? json.events    : [],
        rawLogs:   Array.isArray(json.rawLogs)   ? json.rawLogs   : [],
        snapshots: Array.isArray(json.snapshots) ? json.snapshots : [],
      });
      renderToolsView();
    } catch (err) {
      alert(`Could not load "${file.name}":\n${String(err)}`);
    }
  };
  reader.readAsText(file);
}

const toolsDropZone  = document.getElementById('tools-drop-zone')!;
const toolsFileInput = document.getElementById('tools-file-input') as HTMLInputElement;

toolsDropZone.addEventListener('click', () => toolsFileInput.click());
toolsFileInput.addEventListener('change', () => {
  [...(toolsFileInput.files ?? [])].forEach(loadFileIntoTools);
  toolsFileInput.value = '';
});
toolsDropZone.addEventListener('dragover',  (e) => { e.preventDefault(); toolsDropZone.classList.add('drag-over'); });
toolsDropZone.addEventListener('dragleave', ()  => toolsDropZone.classList.remove('drag-over'));
toolsDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  toolsDropZone.classList.remove('drag-over');
  [...(e.dataTransfer?.files ?? [])].filter((f) => f.name.endsWith('.json')).forEach(loadFileIntoTools);
});

document.getElementById('tools-merge-btn')!.addEventListener('click', async () => {
  const allGames  = _importedDatasets.flatMap((ds) => ds.games);
  const allEvents = _importedDatasets.flatMap((ds) => ds.events);
  if (allGames.length === 0) return;

  const confirmed = confirm(
    `⚠️ IRREVERSIBLE ACTION\n\nThis will merge ${allGames.length} game(s) from ${_importedDatasets.length} source(s) into your local database.\n\nGames already present (matching game ID) will be skipped.\n\nThis cannot be undone. Continue?`
  );
  if (!confirmed) return;

  const btn = document.getElementById('tools-merge-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Merging…';
  try {
    const { imported, skipped } = await importGames(
      allGames,
      allEvents,
      _importedDatasets.flatMap((ds) => ds.rawLogs),
      _importedDatasets.flatMap((ds) => ds.snapshots)
    );
    alert(`Merge complete!\n\n✅ ${imported} game(s) imported\n⏭ ${skipped} duplicate(s) skipped`);
    _importedDatasets = [];
    renderToolsView();
    await Promise.all([loadOverview(), loadMatchups(), loadCardStats(), loadHistory()]);
  } catch (err) {
    alert(`Merge failed: ${String(err)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Merge All Imports into Local DB';
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await loadLeaderPanel();
  await loadBaseColorDropdown();
  await Promise.all([loadOverview(), loadMatchups(), loadCardStats(), loadHistory()]);

  // If URL has ?game=... open that game's detail (future: detail modal)
  const params = new URLSearchParams(location.search);
  const gameId = params.get('game');
  if (gameId) {
    // Switch to history tab and scroll to row
    tabs.forEach((b) => b.classList.remove('active'));
    contents.forEach((c) => c.classList.remove('active'));
    const histBtn = document.querySelector<HTMLButtonElement>('[data-tab="history"]');
    histBtn?.classList.add('active');
    document.getElementById('tab-history')?.classList.add('active');
  }
}

init();
