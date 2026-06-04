# RetroWeb - Project Document

> Last updated: 2026-05-30

RetroWeb is a self-hosted retro game launcher and emulator. It runs as a local web server (Rust/Axum backend + TypeScript/Vite frontend) and plays games in the browser via EmulatorJS.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Supported Systems](#supported-systems)
3. [ROM Management](#rom-management)
4. [Thumbnail Scraper](#thumbnail-scraper)
5. [Game Info Scraper](#game-info-scraper)
6. [Hero Banner & Logo (SteamGridDB)](#hero-banner--logo-steamgriddb)
7. [Custom Art Editor (Upload / Search / URL)](#custom-art-editor-upload--search--url)
8. [Controller Support](#controller-support)
8. [Button Mapping & Profiles](#button-mapping--profiles)
9. [Hotkey Combos](#hotkey-combos)
10. [FullView Mode](#fullview-mode)
11. [Video Preview Autoplay](#video-preview-autoplay)
12. [Themes](#themes)
13. [Game Browsing](#game-browsing)
14. [Favourites & Collections](#favourites--collections)
15. [Recently Played & Playtime Tracking](#recently-played--playtime-tracking)
16. [Resume Last Game](#resume-last-game)
17. [Smart Search](#smart-search)
18. [Virtualized Lists](#virtualized-lists)
19. [Hidden Games](#hidden-games)
20. [Duplicate Detection](#duplicate-detection)
21. [Per-Game Launch Config](#per-game-launch-config)
22. [Save State Browser](#save-state-browser)
23. [Import / Export / Auto Backup](#import--export--auto-backup)
24. [Cloud Save Sync (WebDAV)](#cloud-save-sync-webdav)
25. [Plugin System](#plugin-system)
26. [Diagnostics & Logs](#diagnostics--logs)
27. [Update Check](#update-check)
28. [Settings](#settings)
29. [API Reference](#api-reference)
30. [Configuration & Storage](#configuration--storage)
31. [Build & Run](#build--run)

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

Layout is grouped into **Sources**, **Known servers**, **Options**, and a **Scrape Thumbnails** subsection (divider + system selector + run buttons + progress panel).

| Setting | Default | Description |
|---------|---------|-------------|
| Source URL | `https://thumbnails.libretro.com` | Base URL of thumbnail server |
| Delay | 100 ms | Pause between HTTP requests (rate limiting) |

### Progress Log

Each progress panel (Scan, Thumbnail Scrape, Info Scrape) shows the title, count, and a thin progress bar. The verbose per-item log is collapsed by default; click **Show log / Hide log** in the panel header to toggle it.

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

### Touch Controls (Mobile + Mouse)

The FullView footer renders a row of clickable buttons so the launcher is usable without a keyboard or controller — useful on mobile, touchscreens, or when navigating with a mouse.

| Button | Action |
|---|---|
| &#9650; System | Previous system |
| &#9660; System | Next system |
| &#9664; Game | Previous game |
| &#9432; Info | Open game detail overlay |
| &#9654; Play | Launch the selected game |
| &#8862; Platform | Open platform detail overlay |
| &#9654; Game | Next game |
| &#10005; Exit | Leave FullView mode |

On screens narrower than 720px the text labels collapse to icons only. The original keyboard/controller hint strip is hidden on small screens to save space; on desktop both rows render together so users can see which physical button maps to which on-screen action.

### Auto Fullscreen on Launch

When a game is launched from FullView (via A, Enter/Space, or clicking a card), the player container automatically requests browser fullscreen. This gives a console-like, distraction-free experience on TV/arcade setups. The container — not the iframe — is the fullscreen target so the [Floating Player Controls](#floating-player-controls-mobile) stay reachable while the game is running. If the browser denies the request (no user activation), the game still launches normally in the embedded player and fullscreen can be entered manually via the header button or Select+Y hotkey.

**iOS fallback.** Safari and Chrome on iPhone (both WebKit) don't expose the Fullscreen API on non-`<video>` elements, so `requestFullscreen()` is unavailable. The fullscreen action falls back to a CSS pseudo-fullscreen (`position: fixed; inset: 0; height: 100dvh`) toggled via a `.pseudo-fullscreen` class on the container. Tapping the fullscreen button again exits the mode. The floating Exit (&#10005;) button also remains visible so the user can quit the game directly. For a true edge-to-edge experience on iPhone, install RetroWeb as a PWA (see [PWA / Install as App](#pwa--install-as-app)) — when launched from the home screen, the browser chrome is gone and the pseudo-fullscreen effectively fills the entire screen.

### Floating Player Controls (Mobile)

Two small floating buttons live in the top-right corner of the emulator container during gameplay:

| Button | Action |
|---|---|
| &#10005; | Exit the game (same as the header Back button) |
| &#9974; | Toggle fullscreen |

On hover-capable devices (desktop) the controls fade in when the cursor enters the player area. On touch devices (`@media (hover: none)`) they stay visible at all times so users on phones can always exit a game without needing a physical keyboard, controller, or browser chrome.

**Implementation note.** Because the iframe holding EmulatorJS is appended into `#emulator-container` at launch time, naive `container.innerHTML = ''` would also destroy the floating-controls overlay and leave mobile users stranded in fullscreen. `launchGame()` therefore uses a `clearContainerKeepControls()` helper that removes every child *except* `.player-floating-controls`, so the exit (&#10005;) and fullscreen (&#9974;) buttons survive across game launches.

**Positioning.** The overlay uses `position: fixed` (not `absolute` inside the container) with `top: env(safe-area-inset-top) + 12px` and `right: env(safe-area-inset-right) + 12px`, plus `z-index: 10000`. This avoids two pitfalls observed in testing:

- On iOS Safari, an `<iframe>` can be promoted into its own compositing layer that sits above absolute-positioned siblings inside the same stacking context, hiding the X. `position: fixed` lifts the overlay out of that container's stacking context entirely.
- On iPhone (especially when launched as a PWA), `top: 10px` would sit under the notch / status bar. `env(safe-area-inset-top)` pushes the overlay below it.

The exit button (`#pf-back-btn`) is tinted red and uses a 48&nbsp;px touch target with a heavy backdrop blur so it remains obvious against bright game graphics. The global header is hidden whenever the player view is active (`#header.hidden`), giving the game the full viewport and eliminating any chance of overlap with the always-on overlay.

### Mobile Audio on iOS (Known Limitation)

iOS Safari and Chrome (both WebKit) refuse to start Web Audio until a user gesture fires **inside the iframe** that owns the AudioContext. EmulatorJS auto-starts the game when the ROM finishes loading, before any in-iframe gesture, so on iPhone/iPad the AudioContext stays `suspended` and the game plays muted.

Both Proxy-wrapping and `class extends` of `window.AudioContext` to retrofit a gesture-based unlock have been tried and both produced regressions on real iPhone/iPad Chrome (loading hang in one case, post-load frame-freeze in the other) while passing on desktop Chrome and Chromium mobile emulation. The unlock code has been removed for now; audio on iPhone/iPad is silent by design until a different approach is validated against real WebKit.

### Return to FullView

After exiting a game (via Back button, Escape key, or hotkey combo), the user returns to FullView mode at the same system/game position (not reset to beginning). Exiting fullscreen via the browser's Escape automatically ends fullscreen but keeps the game running until the user explicitly exits it.

### PWA / Install as App

RetroWeb is shipped as an installable Progressive Web App. The motivation is iPhone fullscreen — Safari/Chrome on iPhone don't support the Fullscreen API for arbitrary elements, but a PWA launched from the home screen runs **without browser chrome**, giving an effectively fullscreen, app-like experience that complements the CSS pseudo-fullscreen fallback.

**Assets** (all in `frontend/public/`, served from the dist root):

| File | Purpose |
|---|---|
| `manifest.webmanifest` | Web App Manifest: name, icons, `display: standalone`, theme color |
| `icon.svg` / `icon-192.png` / `icon-512.png` | Standard app icons |
| `icon-maskable-512.png` | Android adaptive icon (safe-zone padded) |
| `apple-touch-icon.png` (180×180) | iOS home-screen icon |

**Meta tags in `index.html`** that make PWA work, especially on iOS:

- `<meta name="apple-mobile-web-app-capable" content="yes">` — the actual switch that hides Safari's chrome when launched from home screen
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` — full-bleed status bar styling
- `<meta name="viewport" ... viewport-fit=cover>` — allows content under the notch/safe areas (combine with `env(safe-area-inset-*)` in CSS)
- `<link rel="manifest" href="/manifest.webmanifest">` — Chromium discovers the manifest

**Install UX:**

- **iPhone / iPad:** must use Safari (Chrome/Firefox/Edge on iOS are all Safari under the hood, but only Safari's Share menu exposes "Add to Home Screen"). Once installed, opening RetroWeb from the home-screen icon runs without URL bar.
- **Android Chrome / Edge / Samsung Internet:** the browser fires `beforeinstallprompt`. RetroWeb captures it and surfaces a dismissible install banner plus a Settings → Appearance → "Install RetroWeb" button. (Note: full installability on Android requires a service worker with a `fetch` handler; RetroWeb currently ships without one, so the install banner there appears only if the browser allows install without SW. Adding a minimal passthrough SW is a future enhancement.)
- **Desktop Chrome / Edge:** address-bar install icon, plus the same in-app Install button when supported.

**Per-platform in-app help.** Settings → Appearance → "Install as App" expands to show step-by-step instructions for iPhone, Android, and Desktop. A dismissible banner at the bottom of the page shows on first eligible visit (iOS Safari, or any browser firing `beforeinstallprompt`) and remembers dismissal for 14 days via `localStorage` (`pwa-banner-dismissed`).

**Standalone detection.** `window.matchMedia('(display-mode: standalone)').matches` and the iOS-only `navigator.standalone` flag are used to suppress install prompts when already running as an installed app.

**HTTPS.** PWA install (beyond `localhost`) requires HTTPS. The local dev server (`localhost:5173`) and the Rust server on `localhost:3999` both qualify under the localhost exemption. For LAN testing on a phone, use a reverse-proxy with TLS (Caddy, `mkcert` + nginx) or a tunnel like `cloudflared`/`ngrok` — pointing the phone at `http://192.168.x.x:3999` will NOT allow install on iOS Safari.

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
| `retroweb-savestates-{gameId}` | Save state slot metadata (slot, screenshot, timestamp) |
| `retroweb-saves-backup-index` | Auto-backup rolling index entries |
| `retroweb-saves-backup-{gameId}-{ts}` | Per-snapshot save state metadata |
| `retroweb-plugins` | Installed plugin manifests (name, version, source, enabled) |

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
| GET | `/api/playtime` | All playtime stats sorted by recent |
| GET | `/api/playtime/recent` | Top 50 recent (last_played > 0) |
| GET | `/api/playtime/last` | Most recently played game stats or null |
| GET | `/api/playtime/{game_id}` | Stats for one game |
| POST | `/api/playtime/start` | Begin a session; body `{game_id, system, file, name}` |
| POST | `/api/playtime/end` | End a session; body `{game_id, duration_seconds}` |
| GET | `/api/collections` | List user collections |
| POST | `/api/collections` | Create collection; body `{name, icon?}` |
| POST | `/api/collections/{id}` | Update name/icon/game_ids |
| DELETE | `/api/collections/{id}` | Delete collection |
| POST | `/api/collections/{id}/add` | Add game to collection; body `{game_id}` |
| POST | `/api/collections/{id}/remove` | Remove game from collection |
| GET | `/api/game-config/{system}/{file}` | Get per-game launch override |
| POST | `/api/game-config/{system}/{file}` | Set per-game launch override |
| GET | `/api/alternate-cores/{system}` | List alternate cores for a system |
| GET | `/api/hidden-games` | List hidden game IDs |
| POST | `/api/hidden-games` | Replace hidden set; body is `string[]` |
| POST | `/api/duplicates/scan` | Scan for content-duplicate ROMs |
| POST | `/api/duplicates/delete` | Delete a duplicate ROM (and sidecar art) to reclaim storage; body `{game_id}` |
| GET | `/api/banner/{system}/{file}` | Serve cached hero banner |
| GET | `/api/logo/{system}/{file}` | Serve cached transparent logo |
| POST | `/api/scrape-banner/{system}/{file}` | Fetch hero banner from SteamGridDB |
| POST | `/api/scrape-logo/{system}/{file}` | Fetch logo from SteamGridDB |
| GET | `/api/search-images?q=Q` | DuckDuckGo image search (used by Edit Art modal) |
| POST | `/api/upload-art/{system}?file=X` | Upload raw image bytes as a game's art |
| POST | `/api/apply-art/{system}?file=X` | Download `{url}` and save as a game's art |
| GET | `/api/system-art/{system}` | Serve a system's custom art override |
| POST | `/api/upload-system-art/{system}` | Upload raw image bytes as a system art override |
| POST | `/api/apply-system-art/{system}` | Download `{url}` and save as a system art override |
| DELETE | `/api/system-art/{system}` | Remove the system art override |
| GET | `/api/version` | Backend version + GitHub latest tag |
| GET | `/api/logs` | Recent backend log entries (last 500) |
| DELETE | `/api/logs` | Clear backend log buffer |
| GET | `/api/config/export` | Export config snapshot as JSON |
| POST | `/api/config/import` | Import a previously exported snapshot |

### Response Types

```typescript
interface SystemInfo {
  id: string;          // e.g. "nes"
  name: string;        // e.g. "Nintendo Entertainment System"
  game_count: number;
  core: string;        // LibRetro core name
  cover_image: string | null;  // e.g. "/api/images/nes/Super Mario Bros (USA)" — picked from a representative game
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
  rawg_api_key?: string;
  steamgriddb_api_key?: string;
  autoplay_previews?: boolean;
  cloud_sync_url?: string;
  cloud_sync_user?: string;
  cloud_sync_pass?: string;
  auto_backup_saves?: boolean;
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
| `~/.retroweb/playtime.json` | Playtime stats per game |
| `~/.retroweb/collections.json` | User-defined collections |
| `~/.retroweb/game-configs.json` | Per-game launch overrides |
| `~/.retroweb/hidden-games.json` | Hidden game IDs |
| `~/.retroweb/banners/` | Cached hero banners (SteamGridDB) |
| `~/.retroweb/logos/` | Cached transparent logos (SteamGridDB) |
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

## Hero Banner & Logo (SteamGridDB)

Steam-style hero banners and transparent PNG logos are fetched from [SteamGridDB](https://www.steamgriddb.com).

### Configuration

| Setting | Path | Description |
|---|---|---|
| API Key | Settings > ROMs > Game Info Scraper > SteamGridDB | Free account API key |

### How It Works

1. On the game detail page, click **🏆 Banner** or **✨ Logo** action button.
2. Backend searches SteamGridDB by game name, picks first match, downloads the best asset.
3. Banner cached at `~/.retroweb/banners/{system}_{stem}.png`; Logo at `~/.retroweb/logos/...`.
4. The detail page shows banner as a full-bleed hero image with logo overlaid at bottom-left (Steam Big Picture style).

Endpoints: `GET /api/banner/{system}/{file}`, `GET /api/logo/{system}/{file}`, `POST /api/scrape-banner/...`, `POST /api/scrape-logo/...`.

---

## Custom Art Editor (Upload / Search / URL)

When auto-scraping fails (or the user just wants different art), the **Edit Art** modal lets users pick any image for a game or for a whole system. Three sources are supported: image search, local file upload, and a pasted URL.

### How to open

| Target | How |
|---|---|
| Game art | Hover a game card → click the small ✎ button (top-left), **or** right-click the card → **Edit Art**, **or** open the game's detail page → **✎ Edit Art** button / click the cover. |
| System art | Systems tab → hover a system card → click the small ✎ button (top-right of the cover), **or** right-click the system card. |

### Modal tabs

| Tab | What it does |
|---|---|
| 🔍 **Search** | Free-form image search via DuckDuckGo. Pre-filled with a sensible query (`{game name} {system} box art` or `{system name} console logo`). Results render as a thumbnail grid — click any image to download + apply. A **Open Google** link launches the same query on Google Images for cases when DDG doesn't have what's needed. |
| 📤 **Upload** | Click or drag/drop an image file from disk (max 20 MB). Image type is sniffed from magic bytes (PNG/JPG/WebP/GIF) and saved with the correct extension. |
| 🔗 **URL** | Paste any image URL (right-click any web image → "Copy image address"). Server downloads it on the user's behalf, avoiding browser CORS issues. |
| ♻ **Reset** | **System only**: removes the custom override and reverts to the auto-picked cover (chosen from a representative game's box art). |

After any apply/upload, the visible cover refreshes immediately (detail view, game grid, or systems grid) — no manual reload needed.

### Storage

| Type | Location |
|---|---|
| Game art | `{rom_dir}/{system}/images/{stem}.{ext}` — same path as scraped art. Pre-existing variants (png/jpg/jpeg/webp/gif) for the same stem are removed before save so only one image remains. |
| System art override | `~/.retroweb/system-art/{system}.{ext}` — separate from ROM dir so it never pollutes the user's ROM collection. |

`pick_system_cover()` checks the override path first; if present, the system's `cover_image` field points to `/api/system-art/{system}` instead of a game's image.

### Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/api/search-images?q={query}` | — | DuckDuckGo image search; returns up to 20 `{ image, thumbnail, title, source }` results. |
| POST | `/api/upload-art/{system}?file=X` | raw image bytes | Save uploaded bytes as game art (≤20 MB). |
| POST | `/api/apply-art/{system}?file=X` | `{url}` JSON | Download URL server-side and save as game art. |
| GET | `/api/system-art/{system}` | — | Serve a system's custom art override. 404 if none set. |
| POST | `/api/upload-system-art/{system}` | raw image bytes | Save uploaded bytes as system override. |
| POST | `/api/apply-system-art/{system}` | `{url}` JSON | Download URL and save as system override. |
| DELETE | `/api/system-art/{system}` | — | Remove the system override; cover reverts to the auto-picked game image. |

---

## Video Preview Autoplay

When enabled, hovering/focusing on a game in FullView autoplays a YouTube gameplay video as the background.

### Configuration

| Setting | Path | Description |
|---|---|---|
| Autoplay previews | Settings > Appearance > FullView Preview | Toggle on/off (default: off) |

### How It Works

1. After 900ms of focus on a game card in FullView, RetroWeb queries the backend `/api/search-media/{system}?file=...` to find a YouTube video ID.
2. Top result is cached in-memory per session.
3. An invisible-controls iframe loads the embed with `?autoplay=1&mute=1&loop=1`, scaled and dimmed (40% opacity) behind the carousel.
4. Switching games cancels in-flight preview and fades out the iframe.

---

## System Cards

The **Systems** tab renders each detected system as a media card with its own representative cover image — picked automatically from a game in that system's library (the middle entry of the alphabetically-sorted games-with-art, so the choice is varied and stable across rescans).

| Field | Source |
|---|---|
| Cover image | Backend `SystemInfo.cover_image` — points to `/api/images/{system}/{stem}` of a picked game |
| Fallback | `SYSTEM_ICONS[id]` emoji over an accent-tinted gradient when no game has scraped art yet |
| Title / ID / Game count | Overlaid in a body strip under the cover |

Cards refresh automatically when ROMs are rescanned and when new art is scraped. Backend logic lives in `pick_system_cover()` in `src/main.rs`; frontend rendering in `renderSystems()` in `frontend/src/main.ts`; styling in `.system-card*` rules in `styles.css`.

---

## Game Browsing

The home screen has 5 navigation tabs:

| Tab | Description |
|-----|-------------|
| **Systems** | Default view — system cards (NES, SNES, etc.) |
| **All Games** | Browse all games across all systems, with sort/filter/search |
| **Recently Played** | Games played recently, sorted by last-played descending |
| **Favourites** | Heart-marked games |
| **Collections** | User-defined collections |

### All Games tab controls

- **Search box**: realtime fuzzy match (180ms debounce). Substring matches rank above subsequence matches; prefix matches rank highest.
- **Sort**: Name A-Z, Name Z-A, By System, Most Played, Last Played.
- **System filter**: dropdown to limit to one system.
- **Show hidden toggle**: include hidden games in results.
- **View-mode toggle**: switch between **Grid** (card thumbnails, virtualized for >200 games) and **List** (compact rows with name, system, playtime, last played, and quick-action buttons). Preference is persisted to `localStorage` (`allGamesViewMode`).

---

## Favourites & Collections

### Favourites

Heart button on every game card toggles favourite status. Storage: `localStorage` under `retroweb-favourites`.

### Collections

User-defined game groupings. Cross-system. Each collection has: id, name, optional emoji icon, list of game IDs, created timestamp.

| Action | How |
|---|---|
| Create | Collections tab → enter name + icon → "+ Create" |
| Add to collection | Right-click any game card → toggle collection |
| Remove from collection | Right-click game → toggle, OR from Collections tab → Remove from all |
| Rename | Collection header → Rename |
| Delete | Collection header → Delete (confirms) |

Storage: backend `~/.retroweb/collections.json`. Endpoints: `GET/POST /api/collections`, `POST /api/collections/{id}`, `DELETE /api/collections/{id}`, `POST /api/collections/{id}/add`, `POST /api/collections/{id}/remove`.

---

## Recently Played & Playtime Tracking

Every game session is tracked: a start event records `last_played_at` and increments `play_count`; an end event adds elapsed seconds to `total_seconds`.

### Tracking points

| Trigger | Action |
|---|---|
| Game launches (Play button, FullView A, or context menu) | `POST /api/playtime/start` |
| Player view exits (Back, hotkey exit, kiosk return) | `POST /api/playtime/end` with duration |

Sessions under 3 seconds are ignored to avoid noise.

### Storage

Backend persists `~/.retroweb/playtime.json` — a map of `gameId → PlaytimeStats`.

```json
{
  "nes:Super Mario Bros.nes": {
    "game_id": "nes:Super Mario Bros.nes",
    "system": "nes",
    "file": "Super Mario Bros.nes",
    "name": "Super Mario Bros",
    "total_seconds": 4823,
    "last_played_at": 1716800000,
    "play_count": 12
  }
}
```

### UI

- **Recently Played tab**: card grid sorted by `last_played_at desc`, with playtime + relative time ("3h ago"). Search box filters.
- **Most Played / Last Played sort** options on All Games tab.

Endpoints: `GET /api/playtime`, `GET /api/playtime/recent`, `GET /api/playtime/last`, `GET /api/playtime/{game_id}`, `POST /api/playtime/start`, `POST /api/playtime/end`.

---

## Resume Last Game

If there's a last-played game, a **Continue Playing** bar appears at the top of the Systems view with cover art, system, total playtime, and a Resume button.

Source: `GET /api/playtime/last`. Refreshed on app load and after each session ends.

---

## Smart Search

Fuzzy matching algorithm (in `fuzzyScore()`):
- **Exact substring** match: highest priority. Earlier index = higher score. Prefix match adds 500 bonus.
- **Subsequence** match: target must contain every query character in order, not necessarily contiguous. Streak length scales the score.
- Case-insensitive.

Used in:
1. Header search bar (cross-system or per-system).
2. All Games tab search input.
3. Recently Played search input.

Debounce: 180ms.

---

## Virtualized Lists

For libraries >200 games (e.g., the 4000+ All Games view), the grid switches to **virtual scrolling**:
- Probes a dummy card in an isolated **sandbox container** (sibling to the live grid) to measure exact column count + row height + gap. The sandbox isolates measurement from any leftover spacer in the live grid, which would otherwise create a feedback loop that explodes the spacer height.
- Renders only visible rows + 2-row buffer above and below.
- Uses `requestAnimationFrame` to schedule renders on scroll.
- Attaches scroll listeners to all plausible document-scroll targets (`window`, `document`, `documentElement`, `body`) because `html, body { height: 100% }` causes scrolling to land on `body` in this layout — `window.scrollY` / `documentElement.scrollTop` stay at 0 and miss the events.
- `ResizeObserver` re-mounts **only when the container width changes** (column count update). Height changes are ignored so the spacer's height contribution doesn't trigger an infinite remount loop.
- For ≤200 games, the standard grid is used (no overhead).

Implementation: `mountVirtualGameGrid()` / `unmountVirtualGameGrid()` / `measureGridCols()` in `main.ts`.

---

## Hidden Games

Mark individual ROMs as hidden so they don't appear in library views.

| Action | How |
|---|---|
| Hide a game | Right-click game card → "🔕 Hide from library" |
| Unhide | Toggle "Show hidden" on All Games tab → right-click hidden game → "👁 Unhide" |
| List | `GET /api/hidden-games` |
| Bulk update | `POST /api/hidden-games` with array of game IDs |

Storage: `~/.retroweb/hidden-games.json` (array of game IDs).

Server filters hidden games by default. Pass `?include_hidden=true` to `/api/games` to include them.

---

## Duplicate Detection

Settings > ROMs > **Duplicate Detection** scans all ROMs in the library and groups files with identical content hashes.

### Algorithm

1. Group ROMs by file size (fast, hits disk metadata only).
2. For groups with ≥2 files, compute an FNV-1a 64-bit hash of the first 64 KB of each file.
3. Files with matching size + hash form a duplicate group.
4. Each group surfaces: hash, size, list of `GameInfo`.

### Why first 64 KB

Most ROM headers (NES, SNES, GB, etc.) live in the first few KB. Two same-sized files with matching headers are almost always the same game (different region tags / filenames). This avoids hashing multi-GB ISO files.

### UI

The result panel lists each group with two actions per duplicate row:

- **Hide** — adds that ID to the hidden games set (keeps the file on disk).
- **Delete** — permanently removes the ROM file (and any sidecar artwork with the same stem under `<system>/images/`) from disk. Use this to reclaim storage. The status bar tracks total bytes reclaimed across deletions, and groups with fewer than 2 copies remaining are removed automatically.

The Delete button prompts a confirmation dialog before removing the file; the operation cannot be undone.

Endpoints:

- `POST /api/duplicates/scan` — scan for duplicate groups.
- `POST /api/duplicates/delete` — body `{ "game_id": "<system>:<file>" }`. Validates the resolved path stays inside the ROM directory, removes the ROM and sidecar art, refreshes the library, and returns `{ ok, bytes_freed }`.

---

## Per-Game Launch Config

Override the default emulator core per game (e.g., use `mednafen_psx_hw` instead of `pcsx_rearmed` for a specific PSX title).

### UI

Game detail page → **Launch Config** tab → select Core dropdown → Save.

### Supported alternate cores

| System | Cores |
|--------|-------|
| nes / famicom / fds | fceumm, nestopia |
| snes / sfc | snes9x, bsnes |
| n64 | mupen64plus_next, parallel_n64 |
| psx | pcsx_rearmed, mednafen_psx_hw |
| genesis / megadrive | genesis_plus_gx, genesis_plus_gx_wide, picodrive |
| mastersystem / gamegear | genesis_plus_gx, picodrive |
| arcade / neogeo / cps1/2/3 / fbneo | fbneo, mame2003, mame2003_plus |
| mame | mame2003, mame2003_plus, fbneo |

### Storage

Backend: `~/.retroweb/game-configs.json` — map of `"{system}:{file}"` → `{ core?, shader?, options? }`.

Endpoints: `GET/POST /api/game-config/{system}/{file}`, `GET /api/alternate-cores/{system}`.

---

## Save State Browser

The **Save States** tab on the game detail page shows all recorded slots for that game, with a screenshot, slot number, and timestamp.

### How metadata is captured

When the **Quick Save** hotkey (`Select + R1` by default) fires:
1. RetroWeb calls `EJS_emulator.quickSave()` inside the iframe.
2. Snapshots the `<canvas>` content, downscales to 320px wide, encodes as JPEG (60%).
3. Stores in `localStorage` under `retroweb-savestates-{gameId}` as `[{ slot, screenshot, timestamp }, ...]`.

### UI

| Action | Behavior |
|---|---|
| **Load** | Sets `sessionStorage.retroweb-load-slot` then launches the game; EmulatorJS loads the slot on init |
| **Delete** | Removes the slot from the metadata index |

> Note: EmulatorJS owns the actual save state binary in its IndexedDB. RetroWeb tracks UI metadata only.

---

## Import / Export / Auto Backup

### Export

Settings > Management > **Export Config (JSON)** downloads a single JSON file containing:
- Backend settings, playtime, collections, game configs, hidden games
- All `retroweb-*` localStorage keys (favourites, themes, profiles, save state index, etc.)

File name: `retroweb-config-YYYY-MM-DD.json`.

### Import

Settings > Management > **Import Config...** uploads a JSON file (same format). On success, page auto-reloads.

Endpoints: `GET /api/config/export`, `POST /api/config/import`.

### Auto Backup Saves

Toggle in Settings > Management > **Auto-backup save states on game exit**. When enabled:
- On each `endPlaytimeSession()`, save state metadata for the current game is copied to `localStorage` under `retroweb-saves-backup-{gameId}-{timestamp}`.
- An index entry is added to `retroweb-saves-backup-index`.
- Entries older than 7 days are trimmed.

**Backup Now** button forces an immediate snapshot. **Show Backups** lists the index.

---

## Cloud Save Sync (WebDAV)

Optional. Push/pull save state metadata to a WebDAV server (e.g., Nextcloud, sync.com).

### Configuration

Settings > Management > Cloud Save Sync (WebDAV):
- URL: e.g., `https://webdav.example.com/retroweb/`
- Username + Password (HTTP Basic auth)

**Test Connection** sends a WebDAV `PROPFIND` request and reports OK / status code.

> Note: This is a settings + test scaffold. Actual push/pull during gameplay is not yet wired (planned). The settings + test let you verify your server before sync is enabled in a future update.

---

## Plugin System

Plugins are JavaScript ES modules that extend RetroWeb. They load on startup.

### Plugin API

Plugins export a default object with an `onLoad(api)` hook that receives:

```typescript
interface RetroWebPluginAPI {
  registerScraper(name: string, fn: (game: GameInfo) => Promise<any>): void;
  registerCommand(id: string, label: string, fn: (game: GameInfo) => void): void;
  registerWidget(slot: string, html: string): void;
  fetchGames(): Promise<GameInfo[]>;
  fetchSystems(): Promise<SystemInfo[]>;
  toast(msg: string): void;
}
```

### Example plugin

```javascript
export default {
  name: 'my-plugin',
  version: '1.0.0',
  onLoad(api) {
    api.registerCommand('hello', 'Say Hello', (game) => {
      api.toast(`Hello from ${game.name}!`);
    });
  },
};
```

### Install

Settings > Plugins > enter name + URL → **Install from URL**. The plugin source is fetched and stored in `localStorage` under `retroweb-plugins`. Reload the page to activate.

### Disable / Remove

Toggle the checkbox per plugin, or click Remove. Changes apply on next page load.

> Plugins run in the page's JS context (no sandbox). Only install plugins you trust.

---

## Diagnostics & Logs

Settings > Diagnostics tab shows the backend log buffer (last 500 entries in memory).

| Action | Endpoint |
|---|---|
| Refresh | `GET /api/logs` |
| Copy to clipboard | (client-side) |
| Clear | `DELETE /api/logs` |

Log entries: `{ timestamp, level, message }`.

---

## Update Check

Settings > Management > Version shows current version + latest from GitHub releases.

- Current version: derived from `CARGO_PKG_VERSION`.
- Latest: `GET https://api.github.com/repos/anthropics/retroweb/releases/latest` (with 5s timeout, fails gracefully).

Endpoint: `GET /api/version` → `{ current, latest, update_available }`.

---

## Changelog

### 2026-05-29 — iPhone Fullscreen Fix + PWA Install

- **Fixed**: Fullscreen button did nothing on Chrome / Safari on iPhone. Both browsers use WebKit and don't expose `requestFullscreen()` on non-`<video>` elements. `enterFullscreen()` now falls back to a CSS pseudo-fullscreen (`position: fixed; inset: 0; height: 100dvh`) toggled via a `.pseudo-fullscreen` class on `#emulator-container`. Tapping the button again exits. See [Auto Fullscreen on Launch / iOS fallback](#auto-fullscreen-on-launch).
- **Added**: PWA / Installable App support — `manifest.webmanifest`, generated icons (192/512/maskable), `apple-touch-icon`, and the iOS-specific meta tags (`apple-mobile-web-app-capable`, status bar style, `viewport-fit=cover`). Installing as a PWA on iPhone removes the browser chrome and gives a true edge-to-edge app experience that complements the pseudo-fullscreen. See [PWA / Install as App](#pwa--install-as-app).
- **Added**: Per-platform install instructions in Settings → Appearance → "Install as App", plus a dismissible install banner on first eligible visit (iOS Safari users, or Chromium browsers that fire `beforeinstallprompt`). Dismissal is remembered for 14 days in `localStorage` (`pwa-banner-dismissed`).

### 2026-05-28 — Mobile-Friendly FullView & Player Controls

- **Added**: FullView touch button row (▲▼ system, ◀▶ game, Play, Info, Platform, Exit) so the launcher is usable on mobile, touchscreens, and with a mouse. Labels collapse to icons on screens narrower than 720px. See [Touch Controls (Mobile + Mouse)](#touch-controls-mobile--mouse).
- **Added**: Floating in-player controls (Exit + Fullscreen) overlaid in the top-right of the emulator. Always visible on touch devices; fade in on hover for desktop. See [Floating Player Controls (Mobile)](#floating-player-controls-mobile).
- **Changed**: `enterFullscreen` now targets `#emulator-container` rather than the iframe, keeping the floating controls reachable during fullscreen gameplay.
- **Changed**: FullView no longer hides the OS mouse cursor (`cursor: none` removed) so desktop users can click the new touch buttons.

### 2026-05-28 — Custom Art Editor

- **Added**: **Edit Art** modal for games and systems with three sources — image search (DuckDuckGo, with a Google Images escape hatch), local file upload (drag/drop or picker), and pasted URL. Server-side download avoids CORS issues. See [Custom Art Editor](#custom-art-editor-upload--search--url).
- **Added**: System art override stored at `~/.retroweb/system-art/{system}.{ext}`, surfaced as `cover_image` on `/api/systems` and served at `GET /api/system-art/{system}`. Reset button removes the override and reverts to auto-picked cover.
- **Added**: Endpoints — `GET /api/search-images`, `POST /api/upload-art/{system}?file=X`, `POST /api/apply-art/{system}?file=X`, `GET/DELETE /api/system-art/{system}`, `POST /api/upload-system-art/{system}`, `POST /api/apply-system-art/{system}`.
- **Added**: Game detail page now has a clickable cover and an **✎ Edit Art** button; system cards expose a hover ✎ button and a right-click shortcut.

### 2026-05-27 — Per-System Cover Cards

- **Added**: Each system on the Systems tab now renders as a media card with its own representative cover image (auto-picked from a game in that system's library). Falls back to an emoji + accent-tinted gradient when no scraped art is available. See [System Cards](#system-cards).
- **Added**: `SystemInfo.cover_image` field on `/api/systems`.

### 2026-05-27 — Major Feature Roll-out (Sprints 1–4)

A 13-feature update aligning RetroWeb with the feature set of mainstream launchers (Playnite / LaunchBox / ES-DE).

**Library & Browsing**
- **Added**: Recently Played tab — sorted by last-played desc, with playtime and relative time.
- **Added**: Resume Last Game bar at top of home view (cover, system, time-played, Resume button).
- **Added**: Collections — user-defined cross-system game groupings (create/rename/delete, right-click to add).
- **Added**: Hidden Games — right-click a card to hide; "Show hidden" toggle on All Games.
- **Added**: Smart Search — fuzzy match (substring + subsequence with prefix bonus), 180ms debounce, available on header / All Games / Recently Played.
- **Added**: Sort by Most Played and Last Played on All Games tab.
- **Added**: Virtualized list rendering for libraries >200 games (IntersectionObserver-based windowing).

**Metadata & Media**
- **Added**: SteamGridDB integration — hero banners + transparent PNG logos on game detail page.
- **Added**: Video preview autoplay in FullView (toggle in Appearance settings).

**Runtime**
- **Added**: Playtime Tracking — start/end events per session, persisted in `~/.retroweb/playtime.json`.
- **Added**: Per-game Launch Config — override core per game (UI on game detail page, Launch Config tab).
- **Added**: Multi-emulator support — alternate cores per system (NES: fceumm/nestopia, N64: mupen64plus_next/parallel_n64, PSX: pcsx_rearmed/mednafen_psx_hw, etc.).
- **Added**: Save State Browser tab — slot grid with screenshot, timestamp, Load/Delete (canvas snapshot on Quick Save).

**Tools**
- **Added**: Duplicate Detection — size-grouped + FNV-1a 64KB hash, panel in Settings > ROMs.
- **Added**: Import / Export Configuration — single JSON with backend state + localStorage.
- **Added**: Auto Backup Saves — rolling 7-day metadata snapshots.
- **Added**: Cloud Save Sync (WebDAV) — settings + connection test scaffold.
- **Added**: Plugin System — JS ES module loader with `registerScraper / registerCommand / registerWidget` API.
- **Added**: Update Check — GitHub releases latest-version probe.
- **Added**: Logs viewer — Settings > Diagnostics tab with refresh/copy/clear.

**Settings tabs added**: Management, Diagnostics, Plugins (in addition to existing Appearance / ROMs / BIOS / Hotkeys / Controller).

**Backend additions**: 17 new endpoints (`/api/playtime/*`, `/api/collections/*`, `/api/game-config/*`, `/api/alternate-cores/*`, `/api/hidden-games`, `/api/duplicates/scan`, `/api/banner/*`, `/api/logo/*`, `/api/scrape-banner/*`, `/api/scrape-logo/*`, `/api/version`, `/api/logs`, `/api/config/export`, `/api/config/import`).

**Storage additions** under `~/.retroweb/`: `playtime.json`, `collections.json`, `game-configs.json`, `hidden-games.json`, `banners/`, `logos/`.

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
