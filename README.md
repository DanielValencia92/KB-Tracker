# KB Tracker

A browser extension (Chrome & Firefox, Manifest V3) that automatically tracks, stores, and analyses your game data on [Karabast](https://play.karabast.net) — the fan-made Star Wars Unlimited simulator.

---

## Features

### Automatic Game Tracking
- Intercepts WebSocket frames from the Karabast game server with zero page modification
- Detects game start, round progression, card plays, resources, and game completion
- Captures per-round arena snapshots for post-game review
- Tracking can be toggled on/off directly from the popup without reloading

### Popup
- Live list of your most recent games with WIN/LOSS/DRAW badges and format badges (number of games shown is configurable in Settings)
- One-click toggle: **Tracking ON / OFF**
- **Format Mode** selector — cycle between **PREMIER → LIMITED → ETERNAL** to set the format before each game. This must be set correctly before you start a game
- **Export All Data** — downloads a full JSON backup of your entire local database
- **Cloud sync status strip** — shows your signed-in Google account and current sync state (Chrome only)

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
- Full game log with date, format badge, leader chips with card-image tooltips, result, and round count
- Filter by format
- **⋮ Options menu** per row:
  - ▶ **Review** — opens the round-by-round review modal
  - ↺ **Change Format** — cycle the saved format (Premier → Limited → Eternal)
  - 👈 **Hide from Stats** / **👀 Show in Stats** — exclude a game from aggregate calculations without deleting it (shown at reduced opacity)
  - ⛔ **Delete** — permanently remove the game record

#### Settings
- Dedicated **Settings** tab for configuring extension behaviour, persisted via `browser.storage.sync`
- **Display**
  - *Games shown in popup* — how many recent games appear in the extension popup (default: 5; set to 0 for all)
  - *Default dashboard tab* — which tab opens when the dashboard loads
  - *Default format filter* — pre-select a format across all filter dropdowns on load
- **Stats**
  - *Minimum games threshold* — hide matchup rows with fewer than N games to avoid misleading small-sample win rates (default: 5)
- **Data**
  - *Data retention limit* — keep only the N most recent games; "Trim Now" applies immediately (0 = unlimited)
  - *Confirm before deleting games* — toggle the confirmation dialog for destructive delete actions
- **Account & Cloud Sync** *(Chrome only)*
  - Sign in with Google to enable cloud backup via Firebase Firestore
  - *Auto-sync new games* — automatically push each recorded game to the cloud as it is saved (default: on)
  - **Push Local Games** — manually upload all locally stored games that are not yet in the cloud
  - **Pull from Cloud** — download all cloud games and merge them into local IndexedDB (duplicate `gameId`s are skipped)
  - Sign-out clears the local auth token; cloud data is retained

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

### Option A — Install without building

**Chrome:** Download the latest **`kb-tracker-chrome.zip`** from the [Releases page](https://github.com/DanielValencia92/KB-Tracker/releases), unzip it, and follow the **Loading into Chrome** steps below.

**Firefox:** Download the latest **`kb-tracker-firefox.xpi`** from the [Releases page](https://github.com/DanielValencia92/KB-Tracker/releases) and follow the **Installing Firefox** steps below.

> You do **not** need Node.js, npm, or any developer tools for either of these.

---

### Option B — Build from source

**Prerequisites:** [Node.js 18+](https://nodejs.org) and npm

```bash
# 1. Clone the repo
git clone https://github.com/DanielValencia92/KB-Tracker.git
cd KB-Tracker

# 2. Install dependencies
npm install

# 3. Build for your browser
npm run build:chrome    # outputs to dist-chrome/
npm run build:firefox   # outputs to dist-firefox/
```

---

### Loading into Chrome

1. Open Chrome and go to **`chrome://extensions`**
2. Turn on **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the **`dist-chrome`** folder
5. KB Tracker will appear in your extensions list — click the puzzle-piece icon in the toolbar and **pin it**

> **After any code update:** run `npm run build:chrome` again, then go back to `chrome://extensions` and click the **↺** (refresh) icon on the KB Tracker card.

---

### Installing Firefox

KB Tracker is distributed as a **signed `.xpi`** file (signed by Mozilla via AMO, unlisted). This means it installs permanently on any standard Firefox release — no Developer Edition or config changes needed.

1. Download **`kb-tracker-firefox.xpi`** from the [Releases page](https://github.com/DanielValencia92/KB-Tracker/releases)
2. Open Firefox and go to **`about:addons`**
3. Click the **⚙ gear icon** → **Install Add-on From File...**
4. Select the downloaded `.xpi` file
5. Accept the permissions prompt — KB Tracker is now permanently installed and survives browser restarts

> **Updates** are not automatic. When a new version is released, download the new `.xpi` from the Releases page and repeat steps 2–4 — Firefox will update the existing install.

---

### Staying up to date

**Chrome:** pull the latest code, rebuild, and reload the extension:
```bash
git pull
npm run build:chrome
```
Then go to `chrome://extensions` and click the **↺** refresh icon on the KB Tracker card.

**Firefox:** download the new `.xpi` from the [Releases page](https://github.com/DanielValencia92/KB-Tracker/releases) and reinstall via `about:addons` → **⚙ gear** → **Install Add-on From File...**. Firefox will update the existing install.

If building from source, use `npm run package:firefox` to produce a correctly formatted `.xpi` in `web-ext-artifacts/`, then submit it to AMO for signing before distributing.

### Watch mode (active development)

```bash
npm run dev:chrome    # rebuilds on save, outputs to dist-chrome/
npm run dev:firefox   # rebuilds on save, outputs to dist-firefox/
```

Still requires a manual reload on `chrome://extensions` after each Chrome rebuild. For Firefox, use `about:debugging` → **This Firefox** → **Load Temporary Add-on...** during development.

---

## Data & Privacy

All data is stored **locally in your browser** using IndexedDB (`kb-tracker` database, schema v2).

If you sign in with Google and enable cloud sync *(Chrome only)*, game records are also written to **Firebase Firestore** under your own Google account (`users/{uid}/...`). No data is shared with other users. Signing out stops future uploads; existing cloud data is not deleted automatically.

Spectated games (games where you are not an active player) are never recorded.

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
| **Extension** | Chrome & Firefox (Manifest V3) |
| **Language** | TypeScript 5 |
| **Bundler** | Vite 5 + [`vite-plugin-web-extension`](https://vite-plugin-web-extension.aklinker1.io) |
| **API compatibility** | [`webextension-polyfill`](https://github.com/mozilla/webextension-polyfill) |
| **Local storage** | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) |
| **Cloud storage** | Firebase Firestore (REST API in service worker; Auth SDK in auth page) |
| **Auth** | Google Sign-In via `chrome.identity.launchWebAuthFlow` + Firebase `signInWithCredential` |
| **Styles** | Plain CSS (dark theme, CSS custom properties) |
| **No runtime frameworks** | Vanilla TypeScript throughout |

---

## Project Structure

```
src/
├── background/
│   ├── db.ts               # IndexedDB schema and all read/write helpers
│   ├── firestoreSync.ts    # Firestore REST API client (push/pull/token refresh)
│   └── service-worker.ts   # MV3 background service worker; message router
├── auth/
│   ├── auth.html           # Standalone sign-in page (opened in a new tab)
│   └── auth.ts             # Google OAuth via chrome.identity + Firebase signInWithCredential
├── content/
│   └── content.ts          # Isolated-world content script; manages GameRecorder instances
├── firebase/
│   └── config.ts           # Firebase project config + OAuth client ID
├── inject/
│   └── interceptor.js      # MAIN-world script; patches WebSocket before Socket.IO loads
├── shared/
│   ├── types.ts            # All shared TypeScript interfaces and types
│   ├── settings.ts         # Settings schema, defaults, and browser.storage.sync helpers
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

## Usage

1. **Set your format** — Before queuing for a game, click the Format Mode button in the popup to set it to **PREMIER**, **LIMITED**, or **ETERNAL**. This must be set correctly before the game starts
2. **Make sure tracking is ON** — The Tracking button should show **⏺ Tracking ON**
3. **Play your game** — KB Tracker captures everything automatically in the background
4. **Review your data** — Open the dashboard from the popup to see your stats, card analytics, and round-by-round replays

> If you forget to set the format before a game, you can correct it afterwards using the **↺ Change Format** option in the Game History ⋮ menu.

---

## Contributing

Issues and pull requests are welcome. Please open an issue first for significant feature changes.

**Repository:** [github.com/DanielValencia92/KB-Tracker](https://github.com/DanielValencia92/KB-Tracker)

---

## Disclaimer

KB Tracker is a fan-made project. It is not affiliated with or endorsed by Fantasy Flight Games or the Karabast development team. Star Wars Unlimited is a trademark of Lucasfilm Ltd.
