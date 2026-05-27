# RetroWeb - Project Document

> Last updated: 2026-05-25

RetroWeb is a self-hosted retro game launcher and emulator. It runs as a local web server (Rust/Axum backend + TypeScript/Vite frontend) and plays games in the browser via EmulatorJS.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Supported Systems](#supported-systems)
3. [ROM Management](#rom-management)
4. [Thumbnail Scraper](#thumbnail-scraper)
5. [Game Info Scraper](#game-info-scraper)
6. [Controller Support](#controller-support)
6. [Button Mapping & Profiles](#button-mapping--profiles)
7. [Hotkey Combos](#hotkey-combos)
8. [FullView Mode](#fullview-mode)
9. [Themes](#themes)
10. [Favourites & Game Browsing](#favourites--game-browsing)
11. [Settings](#settings)
12. [API Reference](#api-reference)
13. [Configuration & Storage](#configuration--storage)
14. [Build & Run](#build--run)

---

## Architecture

```
┌───────────────────────────────────┐
│  Browser (Frontend)               │
│  ├── main.ts       UI/Navigation  │
│  ├── gamepad-manager.ts  Gamepad  │
│  ├── emulator.ts   EmulatorJS    │
│  ├── api.ts        HTTP Client    │
│  └── styles.css    Styling        │
├───────────────────────────────────┤
│  Rust Backend (src/main.rs)       │
│  ├── Axum web server              │
│  ├── ROM scanner (walkdir)        │
│  ├── Settings persistence (JSON)  │
│  ├── Thumbnail scraper (reqwest)  │
│  └── Static file serving          │
└───────────────────────────────────┘
        │
        ▼
  ~/.retroweb/settings.json   (backend settings)
  localStorage                (frontend settings: mappings, profiles, hotkeys)
  ~/Documents/room-r36-plus/  (ROM directory, configurable)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust, Axum, Tokio, Serde, WalkDir, Reqwest |
| Frontend | TypeScript, Vite |
| Emulation | EmulatorJS (LibRetro cores, loaded from CDN) |
| Storage | JSON files (backend), localStorage (frontend) |

---

## Supported Systems

34 systems supported. Each maps to a LibRetro core:

| System ID | Display Name | Core | Extensions |
|-----------|-------------|------|-----------|
| nes | Nintendo Entertainment System | fceumm | .nes, .zip, .7z |
| snes | Super Nintendo | snes9x | .sfc, .smc, .zip, .7z |
| gb | Game Boy | gambatte | .gb, .zip, .7z |
| gbc | Game Boy Color | gambatte | .gbc, .gb, .zip, .7z |
| gba | Game Boy Advance | mgba | .gba, .zip, .7z |
| n64 | Nintendo 64 | mupen64plus_next | .n64, .z64, .v64, .zip, .7z |
| nds | Nintendo DS | melonds | .nds, .zip, .7z |
| genesis | Sega Genesis | genesis_plus_gx | .md, .bin, .gen, .zip, .7z |
| psx | PlayStation | pcsx_rearmed | .chd, .bin, .cue, .iso, .pbp, .zip |
| psp | PlayStation Portable | ppsspp | .iso, .cso, .pbp, .zip |
| neogeo | Neo Geo | fbneo | .zip, .7z |
| arcade | Arcade | fbneo | .zip, .7z |
| dreamcast | Dreamcast | flycast | .chd, .cdi, .gdi, .zip |
| saturn | Sega Saturn | yabause | .chd, .cue, .iso, .zip |
| ... | (20+ more) | ... | ... |

Full list defined in `src/main.rs` → `system_metadata()`.

---

## ROM Management

### Directory Structure

ROMs are organized by system in a root directory (configurable in Settings > ROMs):

```
~/Documents/room-r36-plus/     ← ROM root (configurable)
├── nes/
│   ├── Super Mario Bros.nes
│   ├── Zelda (USA).nes
│   └── images/                ← Box art (auto-discovered)
│       ├── Super Mario Bros.png
│       └── Zelda.png
├── snes/
│   ├── Chrono Trigger.sfc
│   └── images/
├── bios/                      ← BIOS files (shared)
│   ├── scph1001.bin
│   ├── gba_bios.bin
│   └── ...
└── (other system folders)
```

### Scanning

- Backend scans the ROM root on startup and on manual "Rescan"
- 1st-level subdirectories = system IDs (matched against `system_metadata()`)
- Files filtered by extension per system
- Skip directories: `bios`, `themes`, `images`, `tools`, `backup`, `ports`, etc.
- Game names auto-cleaned: removes region tags `(USA)`, brackets `[!]`, hash suffixes `# xxx`, `Vi-` prefix
- Box art auto-detected from `{system}/images/{stem}.png` or `.jpg`
- Systems sorted by game count (descending)

### BIOS Files

BIOS files go in `{rom_root}/bios/`. Status shown in Settings > BIOS tab:

| System | Required Files |
|--------|---------------|
| GBA | gba_bios.bin (optional, HLE available) |
| PSX | scph1001.bin (NTSC-U), scph5500.bin (J), scph5502.bin (PAL) |
| NDS | bios7.bin, bios9.bin, firmware.bin |
| Sega CD | bios_CD_U.bin, bios_CD_J.bin, bios_CD_E.bin |
| Neo Geo | neogeo.zip (MAME format) |
| Dreamcast | dc_boot.bin |
| Saturn | saturn_bios.bin |
| PC Engine CD | syscard3.pce |
| Atari Lynx | lynxboot.img |

---

## Thumbnail Scraper

Downloads box art from a libretro-thumbnails compatible server.

### Configuration (Settings > ROMs > Thumbnail Scraper)

| Setting | Default | Description |
|---------|---------|-------------|
| Source URL | `https://thumbnails.libretro.com` | Base URL of thumbnail server |
| Delay | 100 ms | Pause between HTTP requests (rate limiting) |

### How It Works

1. User clicks "Scrape Art" on a system's games page
2. Backend iterates all games in that system
3. For each game without an existing image:
   - Constructs URL: `{source}/{libretro_system_name}/Named_Boxarts/{game_stem}.png`
   - Downloads the PNG
   - Saves to `{rom_root}/{system}/images/{stem}.png`
4. Skips games that already have thumbnails
5. Results: `{scraped} new, {skipped} existing, {errors} failed`
6. Library auto-rescanned after scraping

### System Name Mapping

The scraper maps internal system IDs to libretro-thumbnails system names:

| System ID | Libretro Thumbnail Name |
|-----------|------------------------|
| nes | Nintendo - Nintendo Entertainment System |
| snes | Nintendo - Super Nintendo Entertainment System |
| genesis | Sega - Mega Drive - Genesis |
| psx | Sony - PlayStation |
| gba | Nintendo - Game Boy Advance |
| ... | (full list in `libretro_system_name()` in main.rs) |

---

## Game Info Scraper

Downloads game metadata (description, developer, publisher, year, genre, players, rating) from online databases.

### Sources

| Source | Type | Auth Required | Coverage |
|--------|------|--------------|----------|
| **RAWG.io** | Primary | No (free API) | Good for popular titles |
| **ScreenScraper.fr** | Fallback | Yes (free account) | Excellent for retro games |

The scraper tries RAWG first (no auth needed). If RAWG fails and ScreenScraper credentials are configured, it falls back to ScreenScraper.

### Configuration (Settings > ROMs > Game Info Scraper)

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-scrape metadata | Off | Also fetch game info when scraping thumbnails |
| ScreenScraper Username | — | Optional: screenscraper.fr account username |
| ScreenScraper Password | — | Optional: screenscraper.fr account password |

### How It Works

1. User clicks "Scrape Info" for a system (or "Scrape All Info")
2. Backend iterates all games in that system
3. For each game without existing metadata:
   - Tries RAWG.io API (search by game name + platform filter)
   - If RAWG fails and ScreenScraper credentials are set, tries ScreenScraper API
   - Saves metadata JSON to `~/.retroweb/metadata/{system}/{game}.json`
4. Skips games that already have metadata
5. Progress displayed via SSE stream (same UI pattern as thumbnail scraper)

### Auto-Scrape with Thumbnails

When "Auto-scrape metadata with thumbnails" is enabled:
- Thumbnail scraping (`Scrape` / `Scrape All`) also fetches metadata alongside art
- Games that already have thumbnails but no metadata will also get metadata fetched
- Progress messages show `+info(RAWG)` or `+info(ScreenScraper)` when metadata is fetched

### Game Detail View

Clicking a game card opens a full detail page with:
- Large box art cover image
- **Play button** (auto-focused) to launch the game immediately
- **Scrape Art button** — downloads box art for this single game from libretro thumbnails (or DuckDuckGo fallback)
- **Scrape Info button** — fetches metadata (description, developer, genre, etc.) from RAWG.io or ScreenScraper
- Metadata sidebar (system, file, year, developer, publisher, players, rating, genre tags)
- Tabbed content area:
  - **Overview** — game description
  - **Gameplay** — genre, players, developer, publisher, release info
  - **Screenshots** — box art display (if available)
- Back button or Escape key returns to the game list
- After playing, the player back button returns to the detail page

### Metadata Format

```json
{
  "description": "A classic platforming adventure...",
  "developer": "Nintendo",
  "publisher": "Nintendo",
  "genre": "Platformer, Action",
  "release_year": "1985",
  "players": "1-2",
  "rating": 4.5
}
```

### Platform Mapping

Each system maps to platform IDs for both APIs:
- RAWG: `rawg_platform_id()` maps system IDs to RAWG platform numbers
- ScreenScraper: `screenscraper_system_id()` maps system IDs to ScreenScraper systemeid numbers

---

## Controller Support

### Supported Controllers

| Controller | Vendor ID | Profile | Buttons | Notes |
|-----------|-----------|---------|---------|-------|
| Xbox One/Series | 045e | xbox | 17 | Reference layout |
| Xbox 360 | 045e | xbox | 17 | Wired & wireless |
| PS4 DualShock 4 | 054c | playstation | 18 | Touchpad = button 17 |
| PS5 DualSense | 054c | playstation | 18 | Touchpad = button 17 |
| Switch Pro | 057e | switch | 17 | A/B X/Y auto-swapped |
| 8BitDo | 2dc8 | 8bitdo | 17 | Many models |
| Generic USB | — | generic | 16-18 | Index-based fallback |

### Button Index Reference (Standard Gamepad API)

| Index | Xbox | PlayStation | Switch |
|-------|------|------------|--------|
| 0 | A | Cross | B |
| 1 | B | Circle | A |
| 2 | X | Square | Y |
| 3 | Y | Triangle | X |
| 4 | LB | L1 | L |
| 5 | RB | R1 | R |
| 6 | LT (analog) | L2 (analog) | ZL |
| 7 | RT (analog) | R2 (analog) | ZR |
| 8 | View | Share/Create | Minus |
| 9 | Menu | Options | Plus |
| 10 | LS (stick press) | L3 | LS |
| 11 | RS (stick press) | R3 | RS |
| 12 | D-pad Up | D-pad Up | D-pad Up |
| 13 | D-pad Down | D-pad Down | D-pad Down |
| 14 | D-pad Left | D-pad Left | D-pad Left |
| 15 | D-pad Right | D-pad Right | D-pad Right |
| 16 | Xbox button | PS button | Home |
| 17 | Share* | Touchpad click | Capture* |

*Not all controllers/browsers expose buttons 16-17.

### Analog Triggers

L2/R2 (buttons 6/7) are **analog** (value 0.0-1.0). A threshold of **0.1** is used to detect "pressed" state. The raw analog value is available for trigger-sensitive applications.

### Auto-Detection

Controllers are identified by matching `Gamepad.id` string against known patterns (vendor IDs, names). Detection order:
1. Xbox: `045e`, `xbox`, `microsoft`
2. PlayStation: `054c`, `dualshock`, `dualsense`, `playstation`, `wireless controller`
3. Switch: `057e`, `pro controller`, `joy-con`, `nintendo`
4. 8BitDo: `2dc8`, `8bitdo`
5. Generic: everything else

---

## Button Mapping & Profiles

### Mapping System

Each mapping is a `Record<number, CanonicalButtonName>` — maps raw button index to a canonical action name.

**Priority order** (highest first):
1. **Active named profile** — if a saved profile is assigned to this controller
2. **Custom per-gamepad mapping** — if user remapped buttons for this specific controller ID
3. **Profile default** — based on auto-detected profile (xbox/playstation/switch/etc.)

### Visual Mapping Editor (Settings > Controller > Remap)

The mapping editor shows a **visual controller layout**:
- Shoulder buttons (L1, R1, L2, R2 with analog value)
- D-pad (4-way grid)
- Face buttons (diamond: A/B/X/Y)
- Center buttons (Select, Start, Home, Touchpad)
- Analog sticks (L3/R3 with position dot)
- Raw button grid (all indices with press/value state)
- Raw axes display (analog stick values)

**To remap a button:**
1. Click the visual button on the controller diagram
2. An overlay appears: "Press a button for: [X]"
3. Press the physical button on your controller
4. The mapping updates immediately
5. Click "Apply" to save

### Named Profiles

Users can save, load, and delete named controller profiles:

| Action | Description |
|--------|-------------|
| **Save As** | Save current mapping as a named profile (enter name + click Save As) |
| **Load** | Select a saved profile from dropdown and apply to current controller |
| **Delete** | Remove a saved profile |
| **Reset** | Reset to hardware-detected profile defaults |

**Base Profile** selector lets you start from any default (Xbox/PS/Switch/8BitDo/Generic) before customizing.

### Storage

| Data | Storage | Key |
|------|---------|-----|
| Custom per-gamepad mappings | localStorage | `retroweb-controller-mappings` |
| Saved named profiles | localStorage | `retroweb-controller-profiles` |
| Active profile assignments | localStorage | `retroweb-active-profiles` |

---

## Hotkey Combos

Button combinations to control the app during gameplay, without needing a keyboard or mouse.

### How It Works

1. Hold the **hotkey base button** (default: Select)
2. While holding, press the **action button**
3. The assigned action executes
4. 500ms cooldown prevents repeated triggers

### Default Combos

| Action | Default Combo | Description |
|--------|--------------|-------------|
| Exit Game | Select + Start | Return to launcher (or FullView) |
| Fullscreen | Select + Y | Toggle fullscreen mode |
| Quick Save | Select + R1 | Save emulator state |
| Quick Load | Select + L1 | Load last saved state |
| Fast Forward | Select + R2 | Toggle speed up |
| Rewind | Select + L2 | Toggle rewind |
| Pause | Select + A | Pause/resume emulation |
| Screenshot | Select + X | Take screenshot (disabled by default) |
| Reset Game | Select + B | Soft reset (disabled by default) |

### Configuration (Settings > Controller > Hotkey Combos)

| Setting | Options | Description |
|---------|---------|-------------|
| Hotkey Button | Select, Home/PS, L3, R3 | The button held to activate combos |
| Action Button | Any canonical button | Per-combo, the button pressed with hotkey |
| Enabled | Toggle per combo | Enable/disable individual combos |

### Storage

Hotkey configuration is stored in localStorage under key `retroweb-hotkey-config`.

### EmulatorJS Integration

Hotkey actions communicate with EmulatorJS via iframe `contentWindow`:
- `EJS_emulator.quickSave()` / `quickLoad()`
- `EJS_emulator.toggleFastForward()` / `toggleRewind()`
- `EJS_emulator.togglePause()` / `reset()`
- `EJS_emulator.screenshot()`

> Note: Not all EmulatorJS cores support all actions. Unsupported actions show a toast notification.

---

## FullView Mode

Full-screen launcher mode designed for TV/arcade setups. Supports keyboard and controller in parallel — both input methods are always live and can be used interchangeably.

### Activation

- **Header button**: Click the FullView icon (fullscreen icon) in the top-right header bar for quick toggle
- Settings > ROMs > FullView Mode toggle
- Auto-activates on app load if enabled
- Press **Start** to exit FullView mode

### UI Elements

| Element | Description |
|---------|-------------|
| Background | Animated gradient with subtle drift animation |
| Title | "RetroWeb" with shimmer animation |
| Clock | Current time (HH:MM), updates every 30s |
| System wheel | Horizontal scrollable pills, active system highlighted |
| Game carousel | Horizontal scrollable cards with box art |
| Game counter | "3 / 45" position indicator |
| Controls guide | Bottom bar showing all button functions |

### Controller Navigation

| Button | Action |
|--------|--------|
| D-pad Left/Right | Browse games |
| D-pad Up/Down | Change system |
| Left Stick | Navigate (same as D-pad) |
| L1 | Previous system (fast) |
| R1 | Next system (fast) |
| A | Launch selected game |
| B | Jump to first/last game |
| Y | Open game detail overlay |
| X | Open platform detail overlay |
| Start | Exit FullView mode |

### Keyboard Navigation

Keyboard works in parallel with the controller — no need to disconnect either input.

| Key | Action |
|-----|--------|
| Arrow Left/Right | Browse games |
| Arrow Up/Down | Change system |
| PageUp / PageDown | Previous / next system (fast) |
| Enter / Space | Launch selected game |
| I / Y | Open game detail overlay |
| P / X | Open platform detail overlay |
| Backspace | Jump to first/last game |
| Home / End | Jump to first / last game |
| Escape | Exit FullView mode |

### Detail Overlay

FullView shows a detail overlay for the currently selected game or platform without leaving kiosk mode.

- **Game detail** (Y / I key): cover art, system, file, year, developer, publisher, genre, players, rating, and full description. Press A or Enter to launch the game.
- **Platform detail** (X / P key): system ID, game count, RetroArch core, and a sample of titles in the library.
- Press **B**, **Y**, **Backspace**, or **Escape** to close. The overlay also closes on click outside the card.

Metadata is fetched lazily from `/api/metadata/:system/:file` when the overlay opens. If no metadata has been scraped yet, the overlay shows the basic file/system info and prompts the user to scrape from the main view.

### Auto Fullscreen on Launch

When a game is launched from FullView (via A, Enter/Space, or clicking a card), the player iframe automatically requests browser fullscreen. This gives a console-like, distraction-free experience on TV/arcade setups. If the browser denies the request (no user activation), the game still launches normally in the embedded player and fullscreen can be entered manually via the header button or Select+Y hotkey.

### Return to FullView

After exiting a game (via Back button, Escape key, or hotkey combo), the user returns to FullView mode at the same system/game position (not reset to beginning). Exiting fullscreen via the browser's Escape automatically ends fullscreen but keeps the game running until the user explicitly exits it.

---

## Themes

RetroWeb includes 12 console-inspired themes + a custom theme editor. Each theme matches the look and feel of a real game console's launcher UI, with matching fonts, border-radius, background effects, and color palettes. Themes can be changed in Settings > Appearance.

### Console Themes

| Theme | Inspired By | Accent Color | Style |
|-------|------------|-------------|-------|
| Nintendo Switch | Switch Home (default) | #e60012 | Dark gray, red accent, rounded corners |
| PlayStation | PS5 UI | #0070d1 | Deep black/blue, sharp edges |
| Xbox | Xbox Dashboard | #107c10 | Dark minimal, green grid accents |
| Super Nintendo | SNES/SFC | #6c48c4 | Purple with ABXY color dots |
| Game Boy | DMG Game Boy | #8bac0f | Green monochrome, CRT scanlines |
| SEGA | Genesis/Mega Drive | #0060df | Blue gradient with scanlines |
| Game Boy Advance | GBA | #7b5ea7 | Indigo/purple gradient |
| Nintendo 64 | N64 | #cc0000 | Multicolor logo glow (R/G/B/Y) |
| PSP | PSP XMB | #4a8fd4 | Wave gradient, minimal |
| Dreamcast | DC menu | #f26522 | Orange swirl on dark gray |
| Neo Geo | MVS arcade | #ffc107 | Gold/black, arcade grid |
| Retro CRT | CRT monitor | #33ff33 | Green phosphor scanlines |
| Custom | User-defined | User choice | Fully customizable colors |

### System-Specific Backgrounds

When browsing a game system's library, an ambient background gradient activates that represents that console's identity (e.g., red glow for NES, green glow for Game Boy, blue for PlayStation). This overlay transitions smoothly and works with any theme.

### Custom Theme

The "Custom" theme opens a color editor where users can pick colors for background, cards, header, text, accent, and border. Custom colors are saved to localStorage and persist across sessions.

### Game Detail Backdrop

When viewing a game's detail page, the game's thumbnail is displayed as a large blurred background image behind the content, creating an immersive cinematic feel. The backdrop fades in smoothly and updates when art is scraped. Game metadata (system, year, developer, publisher, genre, rating) is displayed alongside the cover art.

### Media Search (YouTube + Screenshots)

Each game's detail page has a "Media" button that searches for gameplay videos and screenshots:

- **Gameplay tab**: Embeds up to 4 YouTube videos (searched by game name + system + "gameplay"). Videos are playable inline. Link to search more on YouTube.
- **Screenshots tab**: Shows box art + up to 8 searched screenshot images (via DuckDuckGo Images). Link to search more on Google Images.
- **Manual trigger**: User clicks "Media" button per game — not automatic. This avoids rate limiting and gives user control.
- **Backend endpoint**: `GET /api/search-media/{system}?file=filename` — searches YouTube (parses videoIds from search page) and DuckDuckGo Images (via vqd token + i.js API), returns `{ youtube_ids, image_urls, search_query }`.

### Unified Theme (Main + FullView)

The theme applies globally to both the main app and FullView/Kiosk mode. No separate FullView theme setting needed — the kiosk inherits fonts, colors, and styling from the selected console theme.

### How It Works

- Each theme sets console-specific CSS variables including `--theme-font` for typography
- Theme background effects are applied via `#app-bg` layer (scanlines, grids, gradients)
- System backgrounds use `#system-bg-overlay` that activates when viewing a system's games
- Game detail view uses blurred thumbnail via `.detail-backdrop` with fade-in transition
- Theme selection stored in localStorage (`retroweb-theme`), default is `switch`
- Custom theme colors stored in localStorage (`retroweb-custom-theme`)
- All UI elements use CSS variables, so theme changes are instant and complete

---

## Settings

### Settings Page Structure (Tabbed)

#### Appearance Tab
- **Theme picker**: Visual grid of console-inspired theme cards with color previews, click to apply (applies to both main UI and FullView)
- **Custom theme editor**: Color pickers for all UI colors when "Custom" theme is selected

#### ROMs Tab
- **ROM Directory**: Path to ROM root directory. Save triggers rescan.
- **Rescan**: Re-scan ROM directory without changing path.
- **Thumbnail Scraper**: Source URL, request delay, save settings.
- **FullView Mode**: Enable/disable toggle (also accessible from header button).

#### BIOS Tab
- Lists all systems that require BIOS files
- Shows found/missing status for each file
- File descriptions and optional/required indicators

#### Hotkeys Tab
- **Hotkey Combos**: Base button selector + per-action combo configuration
  - Hold base button (Select/Home/L3/R3) + press action button
  - Enable/disable per combo, save/reset defaults

#### Controller Tab
- **Controller Cards**: Each connected controller shown as an expandable card
  - Header: controller name, detected profile, custom/active profile badges, live button indicators
  - Click card to expand inline dual-panel mapping editor
- **Dual-Panel Mapping Editor** (per-controller, inline):
  - **Left panel (Game Buttons)**: Shows buttons for the selected game system (NES, SNES, PlayStation, Genesis, etc.)
    - Game profile selector: NES, SNES, GB/GBC, GBA, N64, NDS, PlayStation, PSP, Genesis, Dreamcast, Arcade, Full
    - Click any game button to start mapping
  - **Right panel (Controller)**: SVG visualization of the connected physical controller (auto-detected)
    - Unique SVG shapes for PlayStation, Xbox, Switch, 8BitDo, and Generic controllers
    - Buttons highlight in real-time when pressed
    - Mapped buttons indicated with accent border
  - **Mapping flow**: Click game button (left) → overlay prompt → user presses physical controller button → mapping created
  - Auto-mapping provides sensible defaults per controller type
  - Named profile management (save/load/delete)
  - Profiles can be saved and applied across different game profiles
  - Raw button monitor (collapsible debug section)

### Backend Settings (server-side)

Stored in `~/.retroweb/settings.json`:

```json
{
  "rom_dir": "/Users/name/Documents/room-r36-plus",
  "kiosk_mode": false,
  "kiosk_system_filter": [],
  "controller_mappings": {},
  "scrape_sources": ["https://thumbnails.libretro.com"],
  "scrape_delay_ms": 100,
  "ddg_fallback": false,
  "scrape_metadata": false,
  "screenscraper_user": null,
  "screenscraper_pass": null
}
```

### Frontend Settings (client-side, localStorage)

| Key | Content |
|-----|---------|
| `retroweb-controller-mappings` | Per-gamepad custom button mappings |
| `retroweb-controller-profiles` | Saved named profiles |
| `retroweb-active-profiles` | GamepadID → profile name assignments |
| `retroweb-hotkey-config` | Hotkey combo configuration |
| `retroweb-theme` | Selected theme ID (default: "midnight") |
| `retroweb-favourites` | Array of favourite game entries (gameId + timestamp) |

---

## API Reference

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check, returns "OK" |
| GET | `/api/systems` | List all detected systems |
| GET | `/api/games?system=X&search=Y` | List games, optionally filtered |
| GET | `/api/roms/{system}/{file}` | Serve ROM file (supports range requests) |
| GET | `/api/bios/{file}` | Serve BIOS file |
| GET | `/api/images/{system}/{name}` | Serve box art image |
| GET | `/api/settings` | Get app settings |
| POST | `/api/settings` | Update app settings |
| POST | `/api/rescan` | Rescan ROM directory |
| GET | `/api/bios/status` | Get BIOS file status for all systems |
| GET | `/api/metadata/{system}/{game}` | Get game metadata |
| POST | `/api/scrape/{system}` | Scrape thumbnails for a system |
| GET | `/api/scrape-stream/{system}` | SSE stream: scrape thumbnails with progress |
| GET | `/api/scrape-info-stream/{system}` | SSE stream: scrape game metadata with progress |
| GET | `/api/rescan-stream` | SSE stream: rescan ROMs with progress |
| GET | `/api/scrape-art-single/{system}?file=X` | Scrape thumbnail for a single game |
| GET | `/api/scrape-info-single/{system}?file=X` | Scrape metadata for a single game |

### Response Types

```typescript
interface SystemInfo {
  id: string;          // e.g. "nes"
  name: string;        // e.g. "Nintendo Entertainment System"
  game_count: number;
  core: string;        // LibRetro core name
}

interface GameInfo {
  id: string;          // e.g. "nes:Mario.nes"
  name: string;        // Cleaned display name
  file: string;        // Original filename
  system: string;      // System ID
  has_image: boolean;
  image_path: string | null;  // e.g. "/api/images/nes/Mario"
}

interface AppSettings {
  rom_dir: string;
  kiosk_mode: boolean;
  kiosk_system_filter: string[];
  controller_mappings: Record<string, ControllerMappingConfig>;
  scrape_sources: string[];
  scrape_delay_ms: number | null;
  ddg_fallback: boolean;
  scrape_metadata: boolean;
  screenscraper_user?: string;
  screenscraper_pass?: string;
}

interface ScrapeResult {
  system: string;
  total: number;
  scraped: number;
  skipped: number;
  errors: number;
}
```

---

## Configuration & Storage

### Directories

| Path | Purpose |
|------|---------|
| `~/.retroweb/` | App data directory |
| `~/.retroweb/settings.json` | Backend settings |
| `~/.retroweb/metadata/{system}/` | Game metadata cache |
| `{rom_dir}/bios/` | BIOS files |
| `{rom_dir}/{system}/images/` | Box art thumbnails |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROM_DIR` | `~/Documents/room-r36-plus` | ROM root directory |
| `DATA_DIR` | `~/.retroweb` | App data directory |
| `FRONTEND_DIR` | Auto-detect `frontend/dist` | Built frontend path |
| `PORT` | 3000 | Server port |

---

## Build & Run

### Prerequisites

- Rust toolchain (cargo)
- Node.js 18+ (npm)

### Development

```bash
# Frontend (dev server with HMR)
cd frontend && npm install && npm run dev

# Backend
cargo run

# Or use the quick-start script
./run.sh
```

### Production Build

```bash
# Build frontend
cd frontend && npm run build

# Build backend (release)
cargo build --release

# Run
./target/release/retroweb
```

### Docker

```bash
docker-compose up -d
```

---

## Favourites & Game Browsing

### Favourites System

Users can mark any game as a favourite by clicking the heart icon on the game card. Favourites persist across sessions via localStorage.

| Feature | Description |
|---------|-------------|
| Heart Button | Appears on hover over any game card (top-right corner). Click to toggle. |
| Storage Key | `retroweb-favourites` in localStorage |
| Data Format | Array of `{ gameId: string, addedAt: number }` |

### Main Navigation Tabs

The home screen has three tabs:

| Tab | Description |
|-----|-------------|
| **Systems** | Default view showing system cards (original behavior) |
| **All Games** | Browse all games across all systems with sort and filter |
| **Favourites** | Shows only games marked as favourite |

### Sorting & Filtering

| View | Sort Options | Filter Options |
|------|-------------|----------------|
| All Games | Name A-Z, Name Z-A, By System | Filter by system (dropdown) |
| Favourites | Name A-Z, Name Z-A, By System, Recently Added | — |
| Per-System | Name A-Z, Name Z-A | — |

---

## Changelog

### 2026-05-25 — Game Info Scraper & Game Detail Modal

- **Added**: Game metadata scraping from RAWG.io (primary, no auth) and ScreenScraper.fr (fallback, auth)
- **Added**: Game Info Scraper section in Settings > ROMs with ScreenScraper credentials
- **Added**: Auto-scrape metadata option (fetch info alongside thumbnails)
- **Added**: Game detail modal (click game card → see metadata + play button)
- **Added**: SSE stream endpoint for metadata scraping with progress
- **Added**: `scrape_metadata`, `screenscraper_user`, `screenscraper_pass` settings

### 2026-05-25 — Favourites, Sorting & Game Browsing

- **Added**: Favourites system with heart button on all game cards (localStorage-persisted)
- **Added**: Main navigation tabs: Systems / All Games / Favourites
- **Added**: All Games tab with 8000+ games across all systems, sortable and filterable
- **Added**: Sort controls (Name A-Z, Name Z-A, By System, Recently Added for favourites)
- **Added**: System filter dropdown on All Games tab
- **Added**: System tag on game cards in All Games and Favourites views
- **Added**: Empty state for Favourites tab with guidance

### 2026-05-23 — Theme System

- **Added**: 12 built-in color themes (Midnight, Cyberpunk, Retro Amber, Forest, Ocean, Sakura, Monochrome, Sunset, Dracula, Solarized, Nord, Gruvbox)
- **Added**: Appearance tab in Settings with visual theme picker cards
- **Added**: Theme persists across sessions via localStorage
- **Improved**: All hardcoded accent colors replaced with CSS variables for full theme support

### 2026-05-22 — Controller & Settings Overhaul

- **Fixed**: Remap button click not working (polling was destroying DOM handlers every frame)
- **Added**: Tabbed settings page (ROMs / BIOS / Hotkeys / Controller)
- **Added**: Visual controller diagram for button mapping (interactive, click-to-assign)
- **Added**: Full 18-button support (Home/PS button #16, Touchpad button #17)
- **Added**: Profile-specific button labels (PS: Cross/Circle/Share/Options, Xbox: A/B/View/Menu, Switch: swapped layout)
- **Added**: Analog trigger threshold detection (0.1) for PS5 L2/R2
- **Added**: Named profile management (save/load/delete custom mappings)
- **Added**: Hotkey combo system (9 configurable actions: exit game, save/load state, fullscreen, fast forward, rewind, pause, reset, screenshot)
- **Added**: Configurable thumbnail scraper (custom source URL, request delay)
- **Added**: FullView mode improvements: animated background, clock, game counter, L1/R1 system navigation, return-to-FullView after game exit
- **Added**: Raw button/axes monitor in mapping editor for debugging
