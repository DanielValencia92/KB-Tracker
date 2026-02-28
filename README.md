# KB Tracker

A Chrome extension (Manifest V3) that automatically tracks, stores, and analyses your game data on [Karabast](https://play.karabast.net) — the fan-made Star Wars Unlimited simulator.

---

## Features

### Automatic Game Tracking
- Intercepts WebSocket frames from the Karabast game server with zero page modification
- Detects game start, round progression, card plays, resources, and game completion
- Captures per-round arena snapshots for post-game review
- Supports **Premier**, **Limited**, and **Eternal** (`open`) formats
- Tracking can be toggled on/off directly from the popup without reloading

### Popup
- Live list of your 20 most recent games with WIN/LOSS/DRAW badges and format badges
- One-click toggle: **Tracking ON / OFF**
- Format mode selector: cycle between **PREMIER → LIMITED → ETERNAL** to manually tag games to a specific format before they're recorded
- **Export All Data** — downloads a full JSON backup of your entire local database

### Dashboard

Open the full dashboard from the popup or click any game row.

#### Overview
- Top-level stat cards: Total Games, Wins, Losses, Draws, Win Rate, Limited, Eternal
- Filter by format and player name
- **Leader Breakdown** — per-leader cards with image, W/L/D counts and win rate, grouped into Premier, Limited, and Eternal sections

#### Matchups
- Full matchup matrix: your leader vs. every opponent leader
- Win/loss/draw counts and win rate per pairing
- Filter by format; sortable columns

#### Card Stats
- Per-card statistics across all your tracked games: Win % when played, Win % when drawn, Play rate, Resource rate, Avg copies per game, Avg round played, Appearances
- Visual inline percentage bars for each metric
- Filter by format, player, leader, and base aspect colour
- Sort by any metric via dropdown

#### Game History
- Full paginated game log with date, format badge, leader chips with card-image tooltips, result, and round count
- Filter by format
- **⋮ Options menu** per row:
  - ▶ **Review** — opens the round-by-round review modal
  - ↺ **Change Format** — cycle the saved format (Premier → Limited → Eternal)
  - 👈 **Hide from Stats** / **👀 Show in Stats** — exclude a game from aggregate calculations without deleting it (shown at reduced opacity)
  - ⛔ **Delete** — permanently remove the game record

#### Round Review Modal
- Step through each round's arena snapshot: hand, ground arena, space arena, discard, resources
- Side-by-side win/loss indicator per player
- **Export PDF** — prints a formatted multi-page PDF of the full game review

#### Import & Aggregate (Tools)
- Drag-and-drop or browse to load one or more JSON exports from other players
- Aggregate stat cards and leader win-rate table across all loaded sources
- Sources stay **in memory only** — your local database is never touched unless you explicitly merge
- **Merge to Local DB** — guarded with a confirmation warning; duplicate games (same `gameId`) are automatically skipped

---

## Installation

### Option A — Download a release (no build required)

If a pre-built release is available on the [Releases page](https://github.com/DanielValencia92/KB-Tracker/releases):

1. Download the latest **`kb-tracker-dist.zip`** (or similar) from the Releases page
2. Unzip it anywhere on your computer — you'll get a `dist/` folder
3. Open Chrome and go to **`chrome://extensions`**
4. Turn on **Developer mode** using the toggle in the top-right corner
5. Click **Load unpacked**
6. Select the **`dist`** folder you just unzipped
7. KB Tracker will appear in your extensions list — click the puzzle-piece icon in the toolbar and **pin it**

> You do **not** need Node.js, npm, or any developer tools for this option.

---

### Option B — Build from source

**Prerequisites:** [Node.js 18+](https://nodejs.org) and npm

```bash
# 1. Clone the repo
git clone https://github.com/DanielValencia92/KB-Tracker.git
cd KB-Tracker

# 2. Install dependencies
npm install

# 3. Build
npm run build
```

### Loading the built extension into Chrome

Same steps as Option A — after `npm run build` finishes, a `dist/` folder will be created:

1. Open Chrome and go to **`chrome://extensions`**
2. Turn on **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Browse to the project folder and select the **`dist`** folder inside it
5. KB Tracker will appear in your extensions list — click the puzzle-piece icon in the toolbar and **pin it** for easy access

> **After any code update:** run `npm run build` again, then go back to `chrome://extensions` and click the **↺** (refresh) icon on the KB Tracker card to reload it.

### Staying up to date

```bash
git pull
npm run build
```

Then reload the extension as above.

### Watch mode (active development)

```bash
npm run dev
```

Rebundles automatically on every file save. Still requires a manual reload on `chrome://extensions` after each rebuild.

---

## Data & Privacy

All data is stored **locally in your browser** using IndexedDB (`kb-tracker` database, schema v2). Nothing is sent to any external server.

### IndexedDB stores

| Store | Contents |
|---|---|
| `games` | Stripped game headers (format, players, winner, rounds) |
| `card_events` | Per-card play/draw/resource events |
| `raw_logs` | Full raw chat log per game |
| `game_snapshots` | Round-by-round arena snapshots |

### Export format

The **Export All Data** button (popup or dashboard) produces a single JSON file:

```json
{
  "exportedAt": "2026-02-27T12:00:00.000Z",
  "games": [...],
  "events": [...],
  "rawLogs": [...],
  "snapshots": [...]
}
```

This file contains everything needed to fully reconstruct your database on another machine, including game snapshots for the Review modal.

---

## Tech Stack

| | |
|---|---|
| **Extension** | Chrome Manifest V3 |
| **Language** | TypeScript 5 |
| **Bundler** | Vite 5 + [`@crxjs/vite-plugin`](https://crxjs.dev) |
| **Storage** | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) |
| **Styles** | Plain CSS (dark theme, CSS custom properties) |
| **No runtime frameworks** | Vanilla TypeScript throughout |

---

## Project Structure

```
src/
├── background/
│   ├── db.ts               # IndexedDB schema and all read/write helpers
│   └── service-worker.ts   # MV3 background service worker; message router
├── content/
│   └── content.ts          # Isolated-world content script; manages GameRecorder instances
├── inject/
│   └── interceptor.js      # MAIN-world script; patches WebSocket before Socket.IO loads
├── shared/
│   ├── types.ts            # All shared TypeScript interfaces and types
│   ├── gameRecorder.ts     # Stateful per-game recorder; ingests game states
│   ├── socketParser.ts     # Parses raw Socket.IO frames into typed game states
│   ├── logParser.ts        # Formats raw chat log entries
│   └── cardUtils.ts        # Card image URL helpers
├── popup/
│   ├── popup.html
│   └── popup.ts
├── dashboard/
│   ├── dashboard.html
│   └── dashboard.ts
└── manifest.json
```

---

## Format Detection

Formats are detected from the server's `gameMode` field:

| `gameMode` value | Format |
|---|---|
| `premier` | Premier |
| `nextSetPreview` | Premier (Next Set Preview) |
| `open` | Eternal |

**Limited** is detected independently: if either player's starting deck size is ≤ 35 cards, `isLimitedFormat` is set to `true` regardless of `gameMode`.

The **Format Mode** button in the popup lets you manually override this before a game is saved — useful if the server doesn't report the expected `gameMode` for a given lobby type.

---

## Contributing

Issues and pull requests are welcome. Please open an issue first for significant feature changes.

**Repository:** [github.com/DanielValencia92/KB-Tracker](https://github.com/DanielValencia92/KB-Tracker)

---

## Disclaimer

KB Tracker is a fan-made project. It is not affiliated with or endorsed by Fantasy Flight Games, Atomic Mass Games, or the Karabast development team. Star Wars Unlimited is a trademark of Lucasfilm Ltd.
