import {
  fetchSystems, fetchGames, fetchSettings, updateSettings, rescanRoms,
  fetchBiosStatus, browseDirs, fetchMetadata, scrapeArtSingle, scrapeInfoSingle, searchMedia,
  type SystemInfo, type GameInfo, type AppSettings, type GameMetadata, type MediaSearchResult,
} from './api';
import {
  GamepadManager, type MappedGamepad, type ProfileName, type CanonicalButtonName,
  type SavedProfile,
  CANONICAL_BUTTON_NAMES, PROFILE_DEFAULTS, detectProfile, getButtonLabels,
} from './gamepad-manager';
import { launchGame, cleanup, enterFullscreen } from './emulator';
import {
  type GameSystemProfile, GAME_PROFILES, getDefaultGameProfile,
  getControllerSVG,
} from './controller-svg';

// ── State ───────────────────────────────────────────────────────────────

let systems: SystemInfo[] = [];
let currentSystem: SystemInfo | null = null;
let currentGames: GameInfo[] = [];
let settings: AppSettings | null = null;
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let kioskSystemIndex = 0;
let kioskGameIndex = 0;
let kioskGames: GameInfo[] = [];
let kioskWasActive = false;
let kioskDetailOpen = false;
let kioskDetailKind: 'game' | 'system' | null = null;

// Favourites system
const FAVOURITES_STORAGE_KEY = 'retroweb-favourites';

interface FavouriteEntry {
  gameId: string;   // e.g. "nes:Mario.nes"
  addedAt: number;  // timestamp
}

function loadFavourites(): FavouriteEntry[] {
  try {
    const saved = localStorage.getItem(FAVOURITES_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return [];
}

function saveFavourites(favs: FavouriteEntry[]): void {
  localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(favs));
}

function isFavourite(gameId: string): boolean {
  return loadFavourites().some(f => f.gameId === gameId);
}

function toggleFavourite(gameId: string): boolean {
  const favs = loadFavourites();
  const idx = favs.findIndex(f => f.gameId === gameId);
  if (idx >= 0) {
    favs.splice(idx, 1);
    saveFavourites(favs);
    return false;
  } else {
    favs.push({ gameId, addedAt: Date.now() });
    saveFavourites(favs);
    return true;
  }
}

// All games cache
let allGamesCache: GameInfo[] = [];
let activeMainTab: 'systems' | 'all-games' | 'favourites' = 'systems';

// Mapping editor state
let mappingEditorGamepadIndex = -1;
let mappingEditorGamepadId = '';
let mappingEditorProfile: ProfileName = 'generic';
let mappingEditorCurrent: Record<number, CanonicalButtonName> = {};
let mappingListeningFor: CanonicalButtonName | null = null;
let mappingListenPollId: number | null = null;
let mappingVisPollId: number | null = null;

// Hotkey combo system
interface HotkeyCombo {
  id: string;
  label: string;
  description: string;
  actionButton: CanonicalButtonName;
  enabled: boolean;
}

interface HotkeyConfig {
  baseButton: CanonicalButtonName;
  combos: HotkeyCombo[];
}

const DEFAULT_HOTKEYS: HotkeyConfig = {
  baseButton: 'select',
  combos: [
    { id: 'exit_game', label: 'Exit Game', description: 'Return to launcher', actionButton: 'start', enabled: true },
    { id: 'fullscreen', label: 'Fullscreen', description: 'Toggle fullscreen', actionButton: 'y', enabled: true },
    { id: 'save_state', label: 'Quick Save', description: 'Save game state', actionButton: 'r1', enabled: true },
    { id: 'load_state', label: 'Quick Load', description: 'Load game state', actionButton: 'l1', enabled: true },
    { id: 'fast_forward', label: 'Fast Forward', description: 'Speed up emulation', actionButton: 'r2', enabled: true },
    { id: 'rewind', label: 'Rewind', description: 'Rewind gameplay', actionButton: 'l2', enabled: true },
    { id: 'screenshot', label: 'Screenshot', description: 'Take screenshot', actionButton: 'x', enabled: false },
    { id: 'pause', label: 'Pause', description: 'Pause/resume emulation', actionButton: 'a', enabled: true },
    { id: 'reset', label: 'Reset Game', description: 'Soft reset current game', actionButton: 'b', enabled: false },
  ],
};

const HOTKEY_STORAGE_KEY = 'retroweb-hotkey-config';
let hotkeyConfig: HotkeyConfig = loadHotkeyConfig();
let hotkeyPollId: number | null = null;
let hotkeyCooldown = 0;

function loadHotkeyConfig(): HotkeyConfig {
  try {
    const saved = localStorage.getItem(HOTKEY_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULT_HOTKEYS));
}

function saveHotkeyConfig(): void {
  localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(hotkeyConfig));
}

// ── Theme System ────────────────────────────────────────────────────────

const THEME_STORAGE_KEY = 'retroweb-theme';

interface ThemeDef {
  id: string;
  name: string;
  icon: string;
  colors: { bg: string; bgCard: string; header: string; text: string; accent: string; border: string };
}

const THEMES: ThemeDef[] = [
  { id: 'switch',      name: 'Nintendo Switch', icon: '🔴', colors: { bg: '#2d2d2d', bgCard: '#3a3a3a', header: '#1a1a1a', text: '#fafafa', accent: '#e60012', border: '#4a4a4a' } },
  { id: 'ps5',         name: 'PlayStation',     icon: '🔵', colors: { bg: '#000000', bgCard: '#101020', header: '#060610', text: '#ffffff', accent: '#0070d1', border: '#1a1a3a' } },
  { id: 'xbox',        name: 'Xbox',            icon: '🟢', colors: { bg: '#0a0a0a', bgCard: '#1a1a1a', header: '#0f0f0f', text: '#f0f0f0', accent: '#107c10', border: '#2d2d2d' } },
  { id: 'snes',        name: 'Super Nintendo',  icon: '🌈', colors: { bg: '#1a1a2e', bgCard: '#242444', header: '#16162a', text: '#f0eef5', accent: '#6c48c4', border: '#3a3860' } },
  { id: 'gameboy',     name: 'Game Boy',        icon: '🟩', colors: { bg: '#0f2318', bgCard: '#1a3828', header: '#0a1a10', text: '#9bbc0f', accent: '#8bac0f', border: '#2a4830' } },
  { id: 'sega',        name: 'SEGA',            icon: '💙', colors: { bg: '#000820', bgCard: '#0c1a3c', header: '#000418', text: '#e0e8ff', accent: '#0060df', border: '#1a2850' } },
  { id: 'gba',         name: 'Game Boy Advance',icon: '🟣', colors: { bg: '#10082a', bgCard: '#1a1040', header: '#0c0620', text: '#e0d8f0', accent: '#7b5ea7', border: '#2a1850' } },
  { id: 'n64',         name: 'Nintendo 64',     icon: '🎯', colors: { bg: '#0a0a10', bgCard: '#18182a', header: '#060610', text: '#f0f0f0', accent: '#cc0000', border: '#2a2a40' } },
  { id: 'psp',         name: 'PSP',             icon: '⬛', colors: { bg: '#0c0c14', bgCard: '#181828', header: '#0a0a12', text: '#e8e8f8', accent: '#4a8fd4', border: '#282848' } },
  { id: 'dreamcast',   name: 'Dreamcast',       icon: '🌀', colors: { bg: '#18181e', bgCard: '#28282e', header: '#10101a', text: '#f5f5f5', accent: '#f26522', border: '#404048' } },
  { id: 'neogeo',      name: 'Neo Geo',         icon: '👑', colors: { bg: '#0a0800', bgCard: '#1a1808', header: '#060400', text: '#ffe8a0', accent: '#ffc107', border: '#3a3418' } },
  { id: 'retro-crt',   name: 'Retro CRT',       icon: '📺', colors: { bg: '#0a0a00', bgCard: '#1a1800', header: '#0e0e00', text: '#33ff33', accent: '#33ff33', border: '#224422' } },
  { id: 'custom',      name: 'Custom',          icon: '🎨', colors: { bg: '#1a1a2e', bgCard: '#242444', header: '#16162a', text: '#f0eef5', accent: '#6c48c4', border: '#3a3860' } },
];

const CUSTOM_THEME_KEY = 'retroweb-custom-theme';

function loadTheme(): string {
  return localStorage.getItem(THEME_STORAGE_KEY) || 'switch';
}

function applyTheme(themeId: string) {
  document.documentElement.setAttribute('data-theme', themeId);
  localStorage.setItem(THEME_STORAGE_KEY, themeId);
  if (themeId === 'custom') applyCustomThemeColors();
}

function loadCustomColors(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || '{}'); } catch { return {}; }
}

function saveCustomColors(colors: Record<string, string>) {
  localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(colors));
}

function applyCustomThemeColors() {
  const c = loadCustomColors();
  const root = document.documentElement;
  if (c.bg) root.style.setProperty('--bg', c.bg);
  if (c.bgCard) root.style.setProperty('--bg-card', c.bgCard);
  if (c.header) root.style.setProperty('--bg-header', c.header);
  if (c.text) root.style.setProperty('--text', c.text);
  if (c.accent) {
    root.style.setProperty('--accent', c.accent);
    root.style.setProperty('--accent-hover', c.accent);
    root.style.setProperty('--accent-glow', c.accent + '40');
  }
  if (c.border) root.style.setProperty('--border', c.border);
  // Derive other vars
  if (c.bgCard) root.style.setProperty('--bg-card-hover', lighten(c.bgCard, 15));
  if (c.text) root.style.setProperty('--text-dim', c.text + '88');
}

function clearCustomThemeInline() {
  const root = document.documentElement;
  ['--bg','--bg-card','--bg-card-hover','--bg-header','--text','--text-dim',
   '--accent','--accent-hover','--accent-glow','--border'].forEach(p => root.style.removeProperty(p));
}

function lighten(hex: string, amount: number): string {
  const r = Math.min(255, parseInt(hex.slice(1,3),16) + amount);
  const g = Math.min(255, parseInt(hex.slice(3,5),16) + amount);
  const b = Math.min(255, parseInt(hex.slice(5,7),16) + amount);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

// ── System-specific background colors ─────────────────────────────────

const SYSTEM_BG_COLORS: Record<string, { gradient: string }> = {
  nes:           { gradient: 'radial-gradient(ellipse at 50% 30%, rgba(188,50,50,0.1) 0%, transparent 60%)' },
  famicom:       { gradient: 'radial-gradient(ellipse at 50% 30%, rgba(188,50,50,0.1) 0%, transparent 60%)' },
  snes:          { gradient: 'radial-gradient(circle at 30% 40%, rgba(108,72,196,0.08) 0%, transparent 40%), radial-gradient(circle at 70% 60%, rgba(76,175,80,0.06) 0%, transparent 40%)' },
  sfc:           { gradient: 'radial-gradient(circle at 30% 40%, rgba(108,72,196,0.08) 0%, transparent 40%), radial-gradient(circle at 70% 60%, rgba(76,175,80,0.06) 0%, transparent 40%)' },
  gb:            { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(139,172,15,0.1) 0%, transparent 50%)' },
  gbc:           { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(139,172,15,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(200,50,50,0.06) 0%, transparent 30%)' },
  gba:           { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(123,94,167,0.1) 0%, transparent 50%)' },
  nds:           { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(100,100,200,0.08) 0%, transparent 50%)' },
  n64:           { gradient: 'radial-gradient(circle at 30% 50%, rgba(0,128,0,0.06) 0%, transparent 30%), radial-gradient(circle at 50% 30%, rgba(204,0,0,0.06) 0%, transparent 30%), radial-gradient(circle at 70% 50%, rgba(0,0,204,0.06) 0%, transparent 30%), radial-gradient(circle at 50% 70%, rgba(255,200,0,0.06) 0%, transparent 30%)' },
  genesis:       { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(0,96,223,0.1) 0%, transparent 50%)' },
  megadrive:     { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(0,96,223,0.1) 0%, transparent 50%)' },
  mastersystem:  { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(0,96,223,0.08) 0%, transparent 50%)' },
  gamegear:      { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(0,96,223,0.08) 0%, transparent 50%)' },
  psx:           { gradient: 'radial-gradient(ellipse at 50% 30%, rgba(0,112,209,0.1) 0%, transparent 50%)' },
  psp:           { gradient: 'linear-gradient(135deg, rgba(74,143,212,0.08) 0%, transparent 40%), linear-gradient(315deg, rgba(74,143,212,0.05) 0%, transparent 40%)' },
  saturn:        { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(100,100,140,0.08) 0%, transparent 50%)' },
  dreamcast:     { gradient: 'radial-gradient(ellipse at 40% 50%, rgba(242,101,34,0.1) 0%, transparent 50%)' },
  neogeo:        { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(255,193,7,0.1) 0%, transparent 50%)' },
  arcade:        { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(255,193,7,0.08) 0%, transparent 50%), radial-gradient(circle at 20% 80%, rgba(255,0,0,0.06) 0%, transparent 30%)' },
  cps1:          { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(255,50,50,0.08) 0%, transparent 50%)' },
  cps2:          { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(255,50,50,0.08) 0%, transparent 50%)' },
  cps3:          { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(255,50,50,0.08) 0%, transparent 50%)' },
  fbneo:         { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(255,100,0,0.08) 0%, transparent 50%)' },
  mame:          { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(255,100,0,0.06) 0%, transparent 50%)' },
  pcengine:      { gradient: 'radial-gradient(ellipse at 50% 40%, rgba(200,50,50,0.08) 0%, transparent 50%)' },
  atari2600:     { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(180,120,40,0.1) 0%, transparent 50%)' },
  atari7800:     { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(180,120,40,0.08) 0%, transparent 50%)' },
  atarilynx:     { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(100,100,100,0.08) 0%, transparent 50%)' },
  wonderswan:    { gradient: 'radial-gradient(ellipse at 50% 50%, rgba(80,80,160,0.08) 0%, transparent 50%)' },
  wonderswancolor:{ gradient: 'radial-gradient(ellipse at 50% 50%, rgba(80,80,160,0.08) 0%, transparent 50%)' },
};

function showSystemBackground(systemId: string | null) {
  const overlay = document.getElementById('system-bg-overlay');
  if (!overlay) return;
  if (!systemId || !SYSTEM_BG_COLORS[systemId]) {
    overlay.classList.remove('active');
    return;
  }
  const sys = SYSTEM_BG_COLORS[systemId];
  overlay.style.background = sys.gradient;
  overlay.classList.add('active');
}

// Apply saved theme immediately
applyTheme(loadTheme());

// FullView/Kiosk mode now uses the same theme as the main app (unified)

const gamepadManager = new GamepadManager();

// ── DOM refs ────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const $header = $('header');
const $systemsView = $('systems-view');
const $gamesView = $('games-view');
const $detailView = $('detail-view');
const $playerView = $('player-view');
const $settingsView = $('settings-view');
const $kioskView = $('kiosk-view');
const $systemsGrid = $('systems-grid');
const $gamesGrid = $('games-grid');
const $systemTitle = $('system-title');
const $gameCount = $('game-count');
const $playerTitle = $('player-title');
const $searchInput = $('search-input') as HTMLInputElement;
const $controllerBtn = $('controller-btn');
const $controllerCount = $('controller-count');
const $controllerModal = $('controller-modal');
const $controllerList = $('controller-list');
const $closeModalBtn = $('close-modal-btn');
const $backBtn = $('back-btn');
const $playerBackBtn = $('player-back-btn');
const $fullscreenBtn = $('fullscreen-btn');
const $logoBtn = $('logo-btn');
const $fullviewBtn = $('fullview-btn');
const $settingsBtn = $('settings-btn');
const $settingsBackBtn = $('settings-back-btn');
const $romDirInput = $('rom-dir-input') as HTMLInputElement;
const $saveRomDirBtn = $('save-rom-dir-btn');
const $rescanBtn = $('rescan-btn');
const $romDirStatus = $('rom-dir-status');
const $biosStatusList = $('bios-status-list');
const $kioskSystemWheel = $('kiosk-system-wheel');
const $kioskSystemName = $('kiosk-system-name');
const $kioskGamesCarousel = $('kiosk-games-carousel');
const $settingsControllerList = $('settings-controller-list');
const $mappingListenOverlay = $('mapping-listen-overlay');
const $mappingListenLabel = $('mapping-listen-label');
const $mappingListenCancel = $('mapping-listen-cancel');
const $kioskClock = $('kiosk-clock');
const $kioskGameCounter = $('kiosk-game-counter');
const $kioskDetailOverlay = $('kiosk-detail-overlay');
const $kioskDetailEyebrow = $('kiosk-detail-eyebrow');
const $kioskDetailTitle = $('kiosk-detail-title');
const $kioskDetailCover = $('kiosk-detail-cover');
const $kioskDetailMeta = $('kiosk-detail-meta');
const $kioskDetailDesc = $('kiosk-detail-desc');
const $kioskDetailPlayBtn = $('kiosk-detail-play-btn') as HTMLButtonElement;
const $kioskDetailBackBtn = $('kiosk-detail-back-btn');
const $kioskDetailCloseBtn = $('kiosk-detail-close-btn');
const $scrapeSourcesList = $('scrape-sources-list');
const $scrapeKnownSources = $('scrape-known-sources');
const $scrapeSourceAddInput = $('scrape-source-add-input') as HTMLInputElement;
const $scrapeSourceAddBtn = $('scrape-source-add-btn');
const $scrapeDelayInput = $('scrape-delay-input') as HTMLInputElement;
const $ddgFallbackInput = $('ddg-fallback-input') as HTMLInputElement;
const $saveScrapeSettingsBtn = $('save-scrape-settings-btn');
const $scrapeSettingsStatus = $('scrape-settings-status');
const $hotkeyBaseBtn = $('hotkey-base-btn') as HTMLSelectElement;
const $hotkeyCombosList = $('hotkey-combos-list');
const $hotkeySaveBtn = $('hotkey-save-btn');
const $hotkeyResetBtn = $('hotkey-reset-btn');

// Browse modal
const $browseModal = $('browse-modal');
const $browseCloseBtn = $('browse-close-btn');
const $browsePathInput = $('browse-path-input') as HTMLInputElement;
const $browseGoBtn = $('browse-go-btn');
const $browseUpBtn = $('browse-up-btn');
const $browseDirsList = $('browse-dirs-list');
const $browseSelectBtn = $('browse-select-btn');
const $browseRomDirBtn = $('browse-rom-dir-btn');

// Scan progress
const $scanProgressPanel = $('scan-progress-panel');
const $scanProgressTitle = $('scan-progress-title');
const $scanProgressCount = $('scan-progress-count');
const $scanProgressBar = $('scan-progress-bar');
const $scanProgressLog = $('scan-progress-log');

// Scrape progress
const $scrapeSystemSelect = $('scrape-system-select') as HTMLSelectElement;
const $scrapeRunBtn = $('scrape-run-btn');
const $scrapeAllBtn = $('scrape-all-btn');
const $scrapeProgressPanel = $('scrape-progress-panel');
const $scrapeProgressTitle = $('scrape-progress-title');
const $scrapeProgressCount = $('scrape-progress-count');
const $scrapeProgressBar = $('scrape-progress-bar');
const $scrapeProgressLog = $('scrape-progress-log');

// Game info scraper
const $scrapeMetadataInput = $('scrape-metadata-input') as HTMLInputElement;
const $ssUserInput = $('ss-user-input') as HTMLInputElement;
const $ssPassInput = $('ss-pass-input') as HTMLInputElement;
const $rawgKeyInput = $('rawg-key-input') as HTMLInputElement;
const $saveInfoSettingsBtn = $('save-info-settings-btn');
const $infoSettingsStatus = $('info-settings-status');
const $scrapeInfoSystemSelect = $('scrape-info-system-select') as HTMLSelectElement;
const $scrapeInfoRunBtn = $('scrape-info-run-btn');
const $scrapeInfoAllBtn = $('scrape-info-all-btn');
const $scrapeInfoProgressPanel = $('scrape-info-progress-panel');
const $scrapeInfoProgressTitle = $('scrape-info-progress-title');
const $scrapeInfoProgressCount = $('scrape-info-progress-count');
const $scrapeInfoProgressBar = $('scrape-info-progress-bar');
const $scrapeInfoProgressLog = $('scrape-info-progress-log');

// Hotkey input status
const $hotkeyKeyboardStatus = $('hotkey-keyboard-status');
const $hotkeyControllerStatus = $('hotkey-controller-status');

// Game detail modal
const $gameDetailModal = $('game-detail-modal');
const $gameDetailTitle = $('game-detail-title');
const $gameDetailBody = $('game-detail-body');
const $gameDetailCloseBtn = $('game-detail-close-btn');

// Default controller
const $defaultControllerSection = $('default-controller-section');
const $defaultControllerProfile = $('default-controller-profile') as HTMLSelectElement;
const $defaultControllerSvg = $('default-controller-svg');
const $defaultControllerMapping = $('default-controller-mapping');

// Currently expanded controller card gamepad index (-1 = none)
let expandedCardIndex = -1;
// Currently selected game profile for the mapping editor
let mappingGameProfile: GameSystemProfile = getDefaultGameProfile();

// ── Views ───────────────────────────────────────────────────────────────

type ViewName = 'systems' | 'games' | 'detail' | 'player' | 'settings';

function showView(view: ViewName) {
  $systemsView.classList.toggle('active', view === 'systems');
  $gamesView.classList.toggle('active', view === 'games');
  $detailView.classList.toggle('active', view === 'detail');
  $playerView.classList.toggle('active', view === 'player');
  $settingsView.classList.toggle('active', view === 'settings');
  if (view !== 'player') { cleanup(); stopHotkeyPolling(); }
  if (view === 'player') startHotkeyPolling();
  if (view !== 'settings') { stopMappingVisPoll(); expandedCardIndex = -1; }
  // Hide system background when not viewing games or detail
  if (view === 'systems' || view === 'settings') showSystemBackground(null);
  // Hide detail backdrop when leaving detail view
  if (view !== 'detail') {
    const bdImg = document.getElementById('detail-backdrop-img');
    if (bdImg) bdImg.classList.remove('loaded');
  }
}

// ── Systems ─────────────────────────────────────────────────────────────

const SYSTEM_ICONS: Record<string, string> = {
  nes: '🎮', famicom: '🎮', snes: '🕹️', sfc: '🕹️',
  gb: '📱', gbc: '📱', gba: '📱', nds: '📱',
  genesis: '🎯', megadrive: '🎯', mastersystem: '🎯', gamegear: '📱',
  n64: '🏠', psx: '💿', psp: '📀', saturn: '💿', dreamcast: '💿',
  neogeo: '🕹️', arcade: '🕹️', pcengine: '🖥️',
  atari2600: '🏛️', atari7800: '🏛️', atarilynx: '📱',
  cps1: '🥊', cps2: '🥊', cps3: '🥊', fbneo: '🔥', mame: '🏗️',
};

function renderSystems(list: SystemInfo[]) {
  $systemsGrid.innerHTML = list.map(sys => `
    <div class="system-card" data-system-id="${sys.id}">
      <div class="system-name">${SYSTEM_ICONS[sys.id] || '🎲'} ${esc(sys.name)}</div>
      <div class="system-id">${sys.id}</div>
      <div class="system-count">${sys.game_count} games</div>
    </div>
  `).join('');

  $systemsGrid.querySelectorAll('.system-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = (card as HTMLElement).dataset.systemId!;
      const sys = systems.find(s => s.id === id);
      if (sys) openSystem(sys);
    });
  });
}

async function openSystem(system: SystemInfo) {
  currentSystem = system;
  $systemTitle.textContent = system.name;
  $gamesGrid.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
  showSystemBackground(system.id);
  showView('games');
  const $systemGamesSort = document.getElementById('system-games-sort') as HTMLSelectElement;
  try {
    currentGames = await fetchGames(system.id);
    $gameCount.textContent = `${currentGames.length} games`;
    const sorted = sortGames(currentGames, $systemGamesSort.value);
    renderGames(sorted);
  } catch { $gamesGrid.innerHTML = '<div class="loading">Failed to load games</div>'; }
}

// ── Games ───────────────────────────────────────────────────────────────

function buildGameCardHTML(game: GameInfo, idx: number, showSystem = false): string {
  const fav = isFavourite(game.id);
  return `
    <div class="game-card" data-game-idx="${idx}">
      <div class="game-image">
        ${game.image_path
          ? `<img src="${game.image_path}" alt="${esc(game.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>🎮</div>'" />`
          : `<div class="placeholder">🎮</div>`}
        <button class="fav-btn${fav ? ' active' : ''}" data-game-id="${esc(game.id)}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}">
          ${fav ? '&#9829;' : '&#9825;'}
        </button>
      </div>
      <div class="game-info">
        <div class="game-title">${esc(game.name)}</div>
        ${showSystem ? `<div class="game-system-tag">${esc(game.system)}</div>` : ''}
      </div>
    </div>`;
}

function attachGameCardEvents(container: HTMLElement, list: GameInfo[]) {
  container.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.fav-btn')) return;
      const idx = parseInt((card as HTMLElement).dataset.gameIdx!, 10);
      const game = list[idx];
      if (game) openGameDetail(game);
    });
  });
  container.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gameId = (btn as HTMLElement).dataset.gameId!;
      const nowFav = toggleFavourite(gameId);
      (btn as HTMLElement).classList.toggle('active', nowFav);
      (btn as HTMLElement).innerHTML = nowFav ? '&#9829;' : '&#9825;';
      (btn as HTMLElement).title = nowFav ? 'Remove from favourites' : 'Add to favourites';
      // Refresh favourites tab if visible
      if (activeMainTab === 'favourites') renderFavouritesTab();
    });
  });
}

function renderGames(list: GameInfo[]) {
  $gamesGrid.innerHTML = list.map((game, i) => buildGameCardHTML(game, i)).join('');
  attachGameCardEvents($gamesGrid, list);
}

function sortGames(list: GameInfo[], sortBy: string): GameInfo[] {
  const sorted = [...list];
  switch (sortBy) {
    case 'name-asc': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'name-desc': sorted.sort((a, b) => b.name.localeCompare(a.name)); break;
    case 'system': sorted.sort((a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name)); break;
    case 'recent': {
      const favs = loadFavourites();
      const favMap = new Map(favs.map(f => [f.gameId, f.addedAt]));
      sorted.sort((a, b) => (favMap.get(b.id) || 0) - (favMap.get(a.id) || 0));
      break;
    }
  }
  return sorted;
}

// ── Main Tabs (Systems / All Games / Favourites) ─────────────────────

function switchMainTab(tabId: string) {
  activeMainTab = tabId as typeof activeMainTab;
  document.querySelectorAll('.main-tab').forEach(t =>
    t.classList.toggle('active', (t as HTMLElement).dataset.mainTab === tabId));
  document.querySelectorAll('.main-tab-content').forEach(c =>
    c.classList.toggle('active', c.id === `main-tab-${tabId}`));

  if (tabId === 'all-games') renderAllGamesTab();
  if (tabId === 'favourites') renderFavouritesTab();
}

async function renderAllGamesTab() {
  const $grid = document.getElementById('all-games-grid')!;
  const $count = document.getElementById('all-games-count')!;
  const $sort = document.getElementById('all-games-sort') as HTMLSelectElement;
  const $filter = document.getElementById('all-games-system-filter') as HTMLSelectElement;

  // Populate system filter if empty
  if ($filter.options.length <= 1) {
    $filter.innerHTML = '<option value="">All Systems</option>' +
      systems.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  // Load all games if not cached
  if (allGamesCache.length === 0) {
    $grid.innerHTML = '<div class="loading"><div class="spinner"></div>Loading all games...</div>';
    try {
      allGamesCache = await fetchGames();
    } catch {
      $grid.innerHTML = '<div class="loading">Failed to load games</div>';
      return;
    }
  }

  let filtered = allGamesCache;
  const systemFilter = $filter.value;
  if (systemFilter) filtered = filtered.filter(g => g.system === systemFilter);

  const sorted = sortGames(filtered, $sort.value);
  $count.textContent = `${sorted.length} games`;
  $grid.innerHTML = sorted.map((game, i) => buildGameCardHTML(game, i, true)).join('');
  attachGameCardEvents($grid, sorted);
}

function renderFavouritesTab() {
  const $grid = document.getElementById('fav-games-grid')!;
  const $count = document.getElementById('fav-games-count')!;
  const $sort = document.getElementById('fav-games-sort') as HTMLSelectElement;
  const $empty = document.getElementById('fav-empty')!;

  const favs = loadFavourites();
  const favIds = new Set(favs.map(f => f.gameId));

  const favGames = allGamesCache.filter(g => favIds.has(g.id));
  const sorted = sortGames(favGames, $sort.value);

  $empty.classList.toggle('hidden', sorted.length > 0);
  $grid.classList.toggle('hidden', sorted.length === 0);
  $count.textContent = `${sorted.length} favourites`;
  $grid.innerHTML = sorted.map((game, i) => buildGameCardHTML(game, i, true)).join('');
  attachGameCardEvents($grid, sorted);
}

function playGame(game: GameInfo) {
  const sys = currentSystem || systems.find(s => s.id === game.system);
  if (!sys) return;
  currentSystem = sys;
  $playerTitle.textContent = game.name;
  showView('player');
  launchGame(game, sys, 'emulator-container');
}

// ── Game Detail View ─────────────────────────────────────────────────

let currentDetailGame: GameInfo | null = null;

function renderDetailMeta(meta: GameMetadata | null, $meta: HTMLElement) {
  const sysName = systems.find(s => s.id === currentDetailGame?.system)?.name || currentDetailGame?.system || '';
  let rows = `
    <div class="detail-meta-row"><span class="detail-meta-label">System</span><span class="detail-meta-value">${esc(sysName)}</span></div>
    <div class="detail-meta-row"><span class="detail-meta-label">File</span><span class="detail-meta-value" style="font-family:monospace;font-size:0.78rem;">${esc(currentDetailGame?.file || '')}</span></div>`;
  if (meta) {
    if (meta.release_year) rows += `<div class="detail-meta-row"><span class="detail-meta-label">Year</span><span class="detail-meta-value">${esc(meta.release_year)}</span></div>`;
    if (meta.developer) rows += `<div class="detail-meta-row"><span class="detail-meta-label">Developer</span><span class="detail-meta-value">${esc(meta.developer)}</span></div>`;
    if (meta.publisher) rows += `<div class="detail-meta-row"><span class="detail-meta-label">Publisher</span><span class="detail-meta-value">${esc(meta.publisher)}</span></div>`;
    if (meta.players) rows += `<div class="detail-meta-row"><span class="detail-meta-label">Players</span><span class="detail-meta-value">${esc(meta.players)}</span></div>`;
    if (meta.rating) rows += `<div class="detail-meta-row"><span class="detail-meta-label">Rating</span><span class="detail-meta-value detail-rating">${meta.rating.toFixed(1)} / 5</span></div>`;
    if (meta.genre) {
      const tags = meta.genre.split(',').map(g => `<span class="detail-tag">${esc(g.trim())}</span>`).join('');
      rows += `<div class="detail-tags">${tags}</div>`;
    }
  } else {
    rows += '<div class="detail-meta-loading">No metadata available. Click "Scrape Info" to fetch.</div>';
  }
  $meta.innerHTML = rows;
}

function renderDetailDescription(meta: GameMetadata | null) {
  const $desc = document.getElementById('detail-description')!;
  if (meta?.description) {
    $desc.innerHTML = esc(meta.description);
    $desc.classList.remove('empty');
  } else {
    $desc.innerHTML = 'No description available. Click "Scrape Info" to fetch game information.';
    $desc.classList.add('empty');
  }
}

function renderDetailGameplay(meta: GameMetadata | null) {
  const $gameplay = document.getElementById('detail-gameplay')!;
  if (meta && (meta.genre || meta.players)) {
    let html = '';
    if (meta.genre) html += `<p><strong>Genre:</strong> ${esc(meta.genre)}</p>`;
    if (meta.players) html += `<p><strong>Players:</strong> ${esc(meta.players)}</p>`;
    if (meta.developer) html += `<p><strong>Developer:</strong> ${esc(meta.developer)}</p>`;
    if (meta.publisher) html += `<p><strong>Publisher:</strong> ${esc(meta.publisher)}</p>`;
    if (meta.release_year) html += `<p><strong>Released:</strong> ${esc(meta.release_year)}</p>`;
    if (meta.rating) html += `<p><strong>Rating:</strong> ${meta.rating.toFixed(1)} / 5</p>`;
    $gameplay.innerHTML = html;
    $gameplay.classList.remove('empty');
  } else {
    $gameplay.innerHTML = 'No gameplay info available. Click "Info" or "Media" to fetch.';
    $gameplay.classList.add('empty');
  }
}

function renderDetailVideos(ytIds: string[], searchQuery: string) {
  const $videos = document.getElementById('detail-videos')!;
  if (ytIds.length === 0) {
    $videos.innerHTML = `<div class="detail-media-hint">No videos found. <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery + ' gameplay')}" target="_blank">Search YouTube</a></div>`;
    $videos.classList.add('empty');
    return;
  }
  let html = ytIds.map(id =>
    `<div class="detail-video-item"><iframe src="https://www.youtube.com/embed/${esc(id)}" allowfullscreen loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>`
  ).join('');
  html += `<div class="detail-media-hint"><a href="https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery + ' gameplay')}" target="_blank">More on YouTube</a></div>`;
  $videos.innerHTML = html;
  $videos.classList.remove('empty');
}

function renderDetailScreenshots(game: GameInfo, imageUrls?: string[], searchQuery?: string) {
  const $screenshots = document.getElementById('detail-screenshots')!;
  let html = '';

  // Box art
  if (game.image_path) {
    html += `<div class="detail-screenshot-item"><img src="${game.image_path}" alt="${esc(game.name)}" /></div>`;
  }

  // Searched images
  if (imageUrls && imageUrls.length > 0) {
    html += imageUrls.map(url =>
      `<div class="detail-screenshot-search-item"><img src="${esc(url)}" alt="screenshot" loading="lazy" onerror="this.parentElement.remove()" /></div>`
    ).join('');
  }

  if (html) {
    $screenshots.innerHTML = html;
    $screenshots.classList.remove('empty');
  } else {
    $screenshots.innerHTML = 'No screenshots. Click "Media" to search.';
    $screenshots.classList.add('empty');
  }

  if (searchQuery) {
    $screenshots.innerHTML += `<div class="detail-media-hint" style="grid-column:1/-1;"><a href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(searchQuery + ' screenshot')}" target="_blank">More on Google Images</a></div>`;
  }
}

function showScrapeStatus(msg: string, duration = 3000) {
  const $status = document.getElementById('detail-scrape-status')!;
  $status.textContent = msg;
  $status.classList.remove('hidden');
  setTimeout(() => $status.classList.add('hidden'), duration);
}

async function openGameDetail(game: GameInfo) {
  currentDetailGame = game;
  const $title = document.getElementById('detail-title')!;
  const $cover = document.getElementById('detail-cover')!;
  const $meta = document.getElementById('detail-meta')!;
  const $playBtn = document.getElementById('detail-play-btn')!;
  const $scrapeArtBtn = document.getElementById('detail-scrape-art-btn')!;
  const $scrapeInfoBtn = document.getElementById('detail-scrape-info-btn')!;
  const $searchMediaBtn = document.getElementById('detail-search-media-btn')!;
  const $backdropImg = document.getElementById('detail-backdrop-img') as HTMLImageElement;

  $title.textContent = game.name;

  // Cover image + backdrop
  $backdropImg.classList.remove('loaded');
  if (game.image_path) {
    $cover.innerHTML = `<img src="${game.image_path}" alt="${esc(game.name)}" />`;
    $backdropImg.src = game.image_path;
    $backdropImg.onload = () => $backdropImg.classList.add('loaded');
  } else {
    $cover.innerHTML = '<div class="placeholder">&#127918;</div>';
    $backdropImg.src = '';
  }

  // Loading state for meta
  $meta.innerHTML = '<div class="detail-meta-loading">Loading metadata...</div>';

  // Reset videos
  document.getElementById('detail-videos')!.innerHTML = '';

  // Reset tabs to overview
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.detailTab === 'overview'));
  document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.id === 'detail-tab-overview'));

  showView('detail');

  // Auto-focus play button
  setTimeout(() => $playBtn.focus(), 100);

  // Clone buttons to remove old listeners
  const newPlayBtn = $playBtn.cloneNode(true) as HTMLButtonElement;
  $playBtn.parentNode!.replaceChild(newPlayBtn, $playBtn);
  newPlayBtn.addEventListener('click', () => playGame(game));

  const newArtBtn = $scrapeArtBtn.cloneNode(true) as HTMLButtonElement;
  $scrapeArtBtn.parentNode!.replaceChild(newArtBtn, $scrapeArtBtn);

  const newInfoBtn = $scrapeInfoBtn.cloneNode(true) as HTMLButtonElement;
  $scrapeInfoBtn.parentNode!.replaceChild(newInfoBtn, $scrapeInfoBtn);

  // Scrape Art handler
  newArtBtn.addEventListener('click', async () => {
    newArtBtn.disabled = true;
    newArtBtn.textContent = 'Scraping...';
    try {
      const result = await scrapeArtSingle(game.system, game.file);
      if (result.ok) {
        newArtBtn.classList.add('success');
        newArtBtn.textContent = '✓ ' + result.message;
        if (result.image_path) {
          game.image_path = result.image_path;
          game.has_image = true;
          $cover.innerHTML = `<img src="${result.image_path}" alt="${esc(game.name)}" />`;
          $backdropImg.src = result.image_path;
          $backdropImg.onload = () => $backdropImg.classList.add('loaded');
          renderDetailScreenshots(game);
        }
      } else {
        newArtBtn.classList.add('error');
        newArtBtn.textContent = '✗ ' + result.message;
      }
      showScrapeStatus(result.message);
    } catch {
      newArtBtn.classList.add('error');
      newArtBtn.textContent = '✗ Failed';
      showScrapeStatus('Failed to scrape art');
    }
    setTimeout(() => {
      newArtBtn.disabled = false;
      newArtBtn.className = 'detail-action-btn';
      newArtBtn.innerHTML = '&#128247; Art';
    }, 3000);
  });

  // Scrape Info handler
  newInfoBtn.addEventListener('click', async () => {
    newInfoBtn.disabled = true;
    newInfoBtn.textContent = 'Scraping...';
    try {
      const result = await scrapeInfoSingle(game.system, game.file);
      if (result.ok && result.metadata) {
        newInfoBtn.classList.add('success');
        newInfoBtn.textContent = '✓ ' + result.message;
        renderDetailMeta(result.metadata, $meta);
        renderDetailDescription(result.metadata);
        renderDetailGameplay(result.metadata);
      } else {
        newInfoBtn.classList.add('error');
        newInfoBtn.textContent = '✗ ' + (result.message || 'Not found');
      }
      showScrapeStatus(result.message);
    } catch {
      newInfoBtn.classList.add('error');
      newInfoBtn.textContent = '✗ Failed';
      showScrapeStatus('Failed to scrape info');
    }
    setTimeout(() => {
      newInfoBtn.disabled = false;
      newInfoBtn.className = 'detail-action-btn';
      newInfoBtn.innerHTML = '&#128269; Info';
    }, 3000);
  });

  // Search Media handler (YouTube + Images)
  const newMediaBtn = $searchMediaBtn.cloneNode(true) as HTMLButtonElement;
  $searchMediaBtn.parentNode!.replaceChild(newMediaBtn, $searchMediaBtn);
  newMediaBtn.addEventListener('click', async () => {
    newMediaBtn.disabled = true;
    newMediaBtn.textContent = 'Searching...';
    try {
      const result = await searchMedia(game.system, game.file);
      if (result.ok) {
        newMediaBtn.classList.add('success');
        const count = result.youtube_ids.length + result.image_urls.length;
        newMediaBtn.textContent = `✓ Found ${count} items`;
        renderDetailVideos(result.youtube_ids, result.search_query);
        renderDetailScreenshots(game, result.image_urls, result.search_query);
        // Switch to gameplay tab if we got videos
        if (result.youtube_ids.length > 0) {
          document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.detailTab === 'gameplay'));
          document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.id === 'detail-tab-gameplay'));
        } else if (result.image_urls.length > 0) {
          document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.detailTab === 'screenshots'));
          document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.id === 'detail-tab-screenshots'));
        }
        showScrapeStatus(`Found ${result.youtube_ids.length} videos, ${result.image_urls.length} images`);
      } else {
        newMediaBtn.classList.add('error');
        newMediaBtn.textContent = '✗ Not found';
      }
    } catch {
      newMediaBtn.classList.add('error');
      newMediaBtn.textContent = '✗ Failed';
      showScrapeStatus('Media search failed');
    }
    setTimeout(() => {
      newMediaBtn.disabled = false;
      newMediaBtn.className = 'detail-action-btn';
      newMediaBtn.innerHTML = '&#127916; Media';
    }, 3000);
  });

  // Fetch metadata
  const cleanName = game.file.replace(/\.[^.]+$/, '').replace(/ \(.*/, '').replace(/ \[.*/, '').replace(/ # .*/, '');
  const meta = await fetchMetadata(game.system, cleanName);
  renderDetailMeta(meta, $meta);
  renderDetailDescription(meta);
  renderDetailGameplay(meta);
  renderDetailScreenshots(game);
}

// ── Search ──────────────────────────────────────────────────────────────

function handleSearch(query: string) {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    if (!query.trim()) {
      if ($gamesView.classList.contains('active') && currentSystem) {
        currentGames = await fetchGames(currentSystem.id);
        renderGames(currentGames);
      } else { renderSystems(systems); showView('systems'); }
      return;
    }
    try {
      const results = await fetchGames(currentSystem?.id, query);
      currentGames = results;
      if (!$gamesView.classList.contains('active')) {
        $systemTitle.textContent = 'Search Results';
        showView('games');
      }
      $gameCount.textContent = `${results.length} results`;
      renderGames(results);
    } catch (e) { console.error('Search failed:', e); }
  }, 300);
}

// ── Settings Tabs ───────────────────────────────────────────────────────

function switchSettingsTab(tabId: string) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.tab === tabId));
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabId}`));
}

// ── Settings ────────────────────────────────────────────────────────────

async function loadSettingsPage() {
  try {
    settings = await fetchSettings();
    $romDirInput.value = settings.rom_dir;
    renderScrapeSources();
    $scrapeDelayInput.value = String(settings.scrape_delay_ms ?? 100);
    $ddgFallbackInput.checked = settings.ddg_fallback ?? false;
    $scrapeMetadataInput.checked = settings.scrape_metadata ?? false;
    $ssUserInput.value = settings.screenscraper_user ?? '';
    $ssPassInput.value = settings.screenscraper_pass ?? '';
    $rawgKeyInput.value = settings.rawg_api_key ?? '';
  } catch { toast('Failed to load settings'); }

  // BIOS status
  try {
    const biosStatus = await fetchBiosStatus();
    $biosStatusList.innerHTML = biosStatus.map(sys => `
      <div class="bios-system">
        <div class="bios-system-name">${esc(sys.system_name)} (${sys.system})</div>
        ${sys.required.map(f => `
          <div class="bios-file">
            <span class="bios-indicator ${f.found ? 'found' : 'missing'}"></span>
            <span>${esc(f.file)}</span>
            <span style="color:${f.found ? 'var(--success)' : 'var(--danger)'}">${f.found ? 'Found' : 'Missing'}</span>
            <span style="margin-left:auto;font-size:0.75rem;color:var(--text-dim)">${esc(f.description)}</span>
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch { $biosStatusList.innerHTML = '<p class="setting-hint">Failed to load BIOS status</p>'; }

  // Theme pickers
  renderThemeGrid();
  // Build controller list once (not in a poll loop!)
  buildControllerList();
  // Start visual polling for button indicators only
  startControllerPoll();
  // Hotkey combos UI
  renderHotkeyCombos();
  // Populate scrape system selects
  populateScrapeSystemSelect();
  populateScrapeInfoSystemSelect();
  // Default controller display
  renderDefaultController();
}

// ── Controller Settings (NO innerHTML rebuild during polling!) ─────────

let controllerPollId: number | null = null;
let lastControllerCount = -1;

function buildControllerList() {
  const gamepads = gamepadManager.getGamepads();
  lastControllerCount = gamepads.length;

  if (gamepads.length === 0) {
    $settingsControllerList.innerHTML = '<p class="setting-hint">No controllers connected. Press any button on your controller.</p>';
    return;
  }

  $settingsControllerList.innerHTML = gamepads.map(gp => {
    const labels = getButtonLabels(gp.profile);
    const btnKeys: CanonicalButtonName[] = ['a','b','x','y','l1','r1','l2','r2','select','start','l3','r3','dpadUp','dpadDown','dpadLeft','dpadRight','home','touchpad'];
    const hasCustom = gamepadManager.getCustomMapping(gp.id) !== null;
    const activeProfile = gamepadManager.getActiveProfileName(gp.id);
    const isExpanded = expandedCardIndex === gp.index;

    return `
      <div class="controller-card${isExpanded ? ' expanded' : ''}" data-gp-index="${gp.index}" data-gp-id="${esc(gp.id)}" data-gp-profile="${gp.profile}">
        <div class="controller-card-header" data-gp-index="${gp.index}">
          <div class="controller-card-info">
            <div class="controller-card-name">${esc(gp.id.substring(0, 50))}</div>
            <div class="controller-card-meta">
              <span class="controller-card-profile">${gp.profile}</span>
              ${hasCustom ? '<span class="controller-card-custom">custom</span>' : ''}
              ${activeProfile ? `<span class="controller-card-custom">${esc(activeProfile)}</span>` : ''}
            </div>
          </div>
          <div class="controller-card-buttons" data-gp-btns="${gp.index}">
            ${btnKeys.map(k => {
              const isAnalog = k === 'l2' || k === 'r2';
              return `<div class="ctrl-btn-vis${isAnalog ? ' analog' : ''}" data-btn="${k}">${labels[k]}</div>`;
            }).join('')}
          </div>
          <div class="controller-card-toggle">
            <span>Mapping</span>
            <span class="chevron">&#x25BC;</span>
          </div>
        </div>
        <div class="controller-card-body" data-card-body="${gp.index}">
          ${buildMappingEditorHTML(gp.index, gp.id, gp.profile)}
        </div>
      </div>`;
  }).join('');

  // Attach card toggle handlers
  $settingsControllerList.querySelectorAll('.controller-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const el = header as HTMLElement;
      const gpIndex = parseInt(el.dataset.gpIndex!, 10);
      const card = el.closest('.controller-card') as HTMLElement;
      const gpId = card.dataset.gpId!;
      const gpProfile = card.dataset.gpProfile! as ProfileName;

      if (expandedCardIndex === gpIndex) {
        // Collapse
        expandedCardIndex = -1;
        card.classList.remove('expanded');
        closeMappingEditor();
      } else {
        // Collapse old
        const oldExpanded = $settingsControllerList.querySelector('.controller-card.expanded');
        if (oldExpanded) oldExpanded.classList.remove('expanded');
        closeMappingEditor();
        // Expand new
        expandedCardIndex = gpIndex;
        card.classList.add('expanded');
        openMappingEditor(gpIndex, gpId, gpProfile);
      }
    });
  });

  // Attach mapping editor event listeners inside each card body
  gamepads.forEach(gp => {
    const body = $settingsControllerList.querySelector(`[data-card-body="${gp.index}"]`);
    if (!body) return;
    attachMappingEditorEvents(body as HTMLElement, gp.index, gp.id, gp.profile);
  });
}

function buildMappingEditorHTML(gpIndex: number, gpId: string, profile: ProfileName): string {
  const gameProfileOptions = GAME_PROFILES.map(gp =>
    `<option value="${gp.id}"${gp.id === mappingGameProfile.id ? ' selected' : ''}>${gp.name}</option>`
  ).join('');

  return `
    <!-- Toolbar -->
    <div class="mapping-toolbar">
      <div class="mapping-toolbar-group">
        <label class="mapping-toolbar-label">Game:</label>
        <select class="setting-input compact-select mapping-game-profile-select" data-gp-index="${gpIndex}">
          ${gameProfileOptions}
        </select>
      </div>
      <div class="mapping-toolbar-group">
        <label class="mapping-toolbar-label">Saved:</label>
        <select class="setting-input compact-select mapping-saved-profiles" data-gp-index="${gpIndex}">
          <option value="">-- None --</option>
        </select>
        <button class="action-btn sm mapping-load-profile-btn" data-gp-index="${gpIndex}">Load</button>
        <button class="action-btn sm danger mapping-delete-profile-btn" data-gp-index="${gpIndex}">Del</button>
      </div>
      <div class="mapping-toolbar-group">
        <input type="text" class="setting-input compact-input mapping-profile-name" data-gp-index="${gpIndex}" placeholder="Profile name..." />
        <button class="action-btn sm mapping-save-profile-btn" data-gp-index="${gpIndex}">Save As</button>
      </div>
      <div class="mapping-toolbar-group">
        <button class="action-btn sm danger mapping-reset-btn" data-gp-index="${gpIndex}">Reset</button>
        <button class="action-btn sm mapping-apply-btn" data-gp-index="${gpIndex}">Apply</button>
      </div>
    </div>

    <!-- Dual-panel mapping area -->
    <div class="mapping-dual-panel">
      <!-- LEFT: Game buttons panel -->
      <div class="mapping-panel mapping-panel-game">
        <h4 class="mapping-panel-title">Game Buttons</h4>
        <p class="mapping-panel-hint">Click a button to remap it</p>
        <div class="game-buttons-grid" data-game-btns="${gpIndex}">
          ${buildGameButtonsHTML(mappingGameProfile)}
        </div>
      </div>

      <!-- CENTER: Mapping lines indicator -->
      <div class="mapping-connector">
        <svg class="connector-arrow" viewBox="0 0 24 60"><path d="M12,0 L12,50 M6,44 L12,52 L18,44" stroke="var(--accent)" fill="none" stroke-width="2"/></svg>
      </div>

      <!-- RIGHT: Controller SVG visualization -->
      <div class="mapping-panel mapping-panel-controller">
        <h4 class="mapping-panel-title">Your Controller <span class="ctrl-profile-badge">${profile}</span></h4>
        <p class="mapping-panel-hint">Physical button layout</p>
        <div class="controller-svg-container" data-ctrl-svg="${gpIndex}">
          ${getControllerSVG(profile)}
        </div>
      </div>
    </div>

    <!-- Raw debug (collapsible) -->
    <details class="mapping-raw-details">
      <summary>Raw Button Monitor</summary>
      <div class="raw-buttons-area">
        <h4>Raw Buttons</h4>
        <div class="raw-buttons-grid" data-raw-btns="${gpIndex}"></div>
        <h4 style="margin-top:8px;">Axes</h4>
        <div class="raw-axes-grid" data-raw-axes="${gpIndex}"></div>
      </div>
    </details>`;
}

function buildGameButtonsHTML(gameProfile: GameSystemProfile): string {
  const defaultLabels: Record<string, string> = {
    a: 'A', b: 'B', x: 'X', y: 'Y', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
    select: 'Select', start: 'Start', l3: 'L3', r3: 'R3',
    dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
    home: 'Home', touchpad: 'Misc',
  };

  // Categorize buttons
  const shoulders = gameProfile.buttons.filter(b => ['l1','r1','l2','r2'].includes(b));
  const dpad = gameProfile.buttons.filter(b => b.startsWith('dpad'));
  const face = gameProfile.buttons.filter(b => ['a','b','x','y'].includes(b));
  const center = gameProfile.buttons.filter(b => ['select','start'].includes(b));
  const extras = gameProfile.buttons.filter(b => ['l3','r3','home','touchpad'].includes(b));

  function btnHTML(name: CanonicalButtonName, cssClass = ''): string {
    const label = gameProfile.labels[name] || defaultLabels[name] || name;
    return `<button class="game-map-btn ${cssClass}" data-game-btn="${name}"><span class="game-map-label">${label}</span><span class="game-map-mapped"></span></button>`;
  }

  let html = '';

  // Shoulders row
  if (shoulders.length > 0) {
    html += `<div class="game-btn-row game-btn-shoulders">${shoulders.map(b => btnHTML(b, 'shoulder')).join('')}</div>`;
  }

  // Main row: dpad + center + face
  html += '<div class="game-btn-row game-btn-main">';
  if (dpad.length > 0) {
    html += `<div class="game-btn-dpad">
      ${dpad.includes('dpadUp') ? btnHTML('dpadUp', 'dpad dpad-u') : ''}
      <div class="game-btn-dpad-mid">
        ${dpad.includes('dpadLeft') ? btnHTML('dpadLeft', 'dpad dpad-l') : ''}
        <div class="game-dpad-center"></div>
        ${dpad.includes('dpadRight') ? btnHTML('dpadRight', 'dpad dpad-r') : ''}
      </div>
      ${dpad.includes('dpadDown') ? btnHTML('dpadDown', 'dpad dpad-d') : ''}
    </div>`;
  }
  if (center.length > 0) {
    html += `<div class="game-btn-center">${center.map(b => btnHTML(b, 'center')).join('')}</div>`;
  }
  if (face.length > 0) {
    html += `<div class="game-btn-face">`;
    if (face.includes('y')) html += btnHTML('y', 'face face-u');
    html += '<div class="game-btn-face-mid">';
    if (face.includes('x')) html += btnHTML('x', 'face face-l');
    if (face.includes('b')) html += btnHTML('b', 'face face-r');
    html += '</div>';
    if (face.includes('a')) html += btnHTML('a', 'face face-d');
    html += `</div>`;
  }
  html += '</div>';

  // Extras
  if (extras.length > 0) {
    html += `<div class="game-btn-row game-btn-extras">${extras.map(b => btnHTML(b, 'extra')).join('')}</div>`;
  }

  return html;
}

function attachMappingEditorEvents(body: HTMLElement, gpIndex: number, gpId: string, profile: ProfileName) {
  // Game buttons -> start listening
  body.querySelectorAll('.game-map-btn[data-game-btn]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mappingEditorGamepadIndex < 0) return;
      const name = (btn as HTMLElement).dataset.gameBtn as CanonicalButtonName;
      startListeningForButton(name);
    });
  });

  // Game profile select change
  const gameProfileSelect = body.querySelector('.mapping-game-profile-select') as HTMLSelectElement;
  gameProfileSelect?.addEventListener('change', () => {
    const gp = GAME_PROFILES.find(p => p.id === gameProfileSelect.value);
    if (gp) {
      mappingGameProfile = gp;
      const gameBtnsContainer = body.querySelector(`[data-game-btns="${gpIndex}"]`);
      if (gameBtnsContainer) {
        gameBtnsContainer.innerHTML = buildGameButtonsHTML(gp);
        // Re-attach game button click handlers
        gameBtnsContainer.querySelectorAll('.game-map-btn[data-game-btn]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mappingEditorGamepadIndex < 0) return;
            const name = (btn as HTMLElement).dataset.gameBtn as CanonicalButtonName;
            startListeningForButton(name);
          });
        });
      }
      updateMappingLabels();
    }
  });

  // Apply
  body.querySelector('.mapping-apply-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    applyMappingEditor();
  });

  // Reset
  body.querySelector('.mapping-reset-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    gamepadManager.resetMapping(mappingEditorGamepadId);
    gamepadManager.setActiveProfile(mappingEditorGamepadId, null);
    mappingEditorCurrent = { ...PROFILE_DEFAULTS[mappingEditorProfile] };
    updateMappingLabels();
    applyMappingEditor();
    toast('Mapping reset to default');
  });

  // Save profile
  body.querySelector('.mapping-save-profile-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const nameInput = body.querySelector('.mapping-profile-name') as HTMLInputElement;
    saveCurrentAsProfile(nameInput, body);
  });

  // Load profile
  body.querySelector('.mapping-load-profile-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = body.querySelector('.mapping-saved-profiles') as HTMLSelectElement;
    loadSelectedProfile(dropdown, body);
  });

  // Delete profile
  body.querySelector('.mapping-delete-profile-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = body.querySelector('.mapping-saved-profiles') as HTMLSelectElement;
    deleteSelectedProfile(dropdown);
  });
}

function updateControllerIndicators() {
  const gamepads = gamepadManager.getGamepads();

  // If count changed, rebuild the list
  if (gamepads.length !== lastControllerCount) {
    buildControllerList();
    return;
  }

  // Update button pressed states in card headers
  for (const gp of gamepads) {
    const container = $settingsControllerList.querySelector(`[data-gp-btns="${gp.index}"]`);
    if (!container) continue;
    const btns = container.querySelectorAll('.ctrl-btn-vis');
    btns.forEach(el => {
      const key = (el as HTMLElement).dataset.btn as CanonicalButtonName;
      if (!key) return;
      const val = gp.buttons[key as keyof typeof gp.buttons];
      const isAnalog = key === 'l2' || key === 'r2';
      if (isAnalog) {
        const numVal = val as number;
        el.classList.toggle('pressed', numVal > 0.1);
        (el as HTMLElement).style.setProperty('--fill', `${Math.round(numVal * 100)}%`);
      } else {
        el.classList.toggle('pressed', !!val);
      }
    });
  }

  // Update expanded card's mapping visuals
  if (expandedCardIndex >= 0) {
    updateMappingVisuals();
  }
}

function startControllerPoll() {
  stopControllerPoll();
  const poll = () => {
    if (!$settingsView.classList.contains('active')) { controllerPollId = null; return; }
    updateControllerIndicators();
    controllerPollId = requestAnimationFrame(poll);
  };
  controllerPollId = requestAnimationFrame(poll);
}

function stopControllerPoll() {
  if (controllerPollId !== null) { cancelAnimationFrame(controllerPollId); controllerPollId = null; }
}

// ── Button Mapping Editor ──────────────────────────────────────────────

function openMappingEditor(gamepadIndex: number, gamepadId: string, profile: ProfileName) {
  mappingEditorGamepadIndex = gamepadIndex;
  mappingEditorGamepadId = gamepadId;
  mappingEditorProfile = profile;

  const activeMapping = gamepadManager.getActiveMapping(gamepadId, profile);
  mappingEditorCurrent = { ...activeMapping };

  updateSavedProfilesDropdown();
  updateMappingLabels();
  startMappingVisPoll();
}

function updateVisualController() {
  updateMappingLabels();
}

function updateMappingLabels() {
  if (mappingEditorGamepadIndex < 0) return;
  const body = $settingsControllerList.querySelector(`[data-card-body="${mappingEditorGamepadIndex}"]`);
  if (!body) return;

  const ctrlLabels = getButtonLabels(mappingEditorProfile);

  // Build reverse map: canonical name -> raw button index
  const reverseMap: Partial<Record<CanonicalButtonName, number>> = {};
  for (const [idx, name] of Object.entries(mappingEditorCurrent)) {
    reverseMap[name as CanonicalButtonName] = Number(idx);
  }

  // Update game buttons panel: show which controller button is mapped
  body.querySelectorAll('.game-map-btn[data-game-btn]').forEach(el => {
    const btn = el as HTMLElement;
    const name = btn.dataset.gameBtn as CanonicalButtonName;
    const mappedEl = btn.querySelector('.game-map-mapped');
    const rawIdx = reverseMap[name];
    if (mappedEl) {
      if (rawIdx !== undefined) {
        mappedEl.textContent = `\u2192 ${ctrlLabels[name]} (#${rawIdx})`;
      } else {
        mappedEl.textContent = '\u2014 unmapped';
      }
    }
  });

  // Update controller SVG: show mapped game button on each controller button
  body.querySelectorAll('[data-ctrl-btn]').forEach(el => {
    const svgBtn = el as SVGElement;
    const canonicalName = svgBtn.dataset.ctrlBtn as CanonicalButtonName;
    const isMapped = reverseMap[canonicalName] !== undefined;
    svgBtn.classList.toggle('ctrl-svg-mapped', isMapped);
  });
}

function startMappingVisPoll() {
  stopMappingVisPoll();
  const poll = () => {
    if (expandedCardIndex < 0) { mappingVisPollId = null; return; }
    updateMappingVisuals();
    mappingVisPollId = requestAnimationFrame(poll);
  };
  mappingVisPollId = requestAnimationFrame(poll);
}

function stopMappingVisPoll() {
  if (mappingVisPollId !== null) { cancelAnimationFrame(mappingVisPollId); mappingVisPollId = null; }
}

function updateMappingVisuals() {
  if (mappingEditorGamepadIndex < 0) return;
  const body = $settingsControllerList.querySelector(`[data-card-body="${mappingEditorGamepadIndex}"]`);
  if (!body) return;

  const rawStates = gamepadManager.getRawButtonStates(mappingEditorGamepadIndex);
  const rawValues = gamepadManager.getRawButtonValues(mappingEditorGamepadIndex);
  const gp = navigator.getGamepads()[mappingEditorGamepadIndex];
  const axes = gp ? Array.from(gp.axes) : [];

  // Update controller SVG button pressed states
  const gamepads = gamepadManager.getGamepads();
  const mapped = gamepads.find(g => g.index === mappingEditorGamepadIndex);
  if (mapped) {
    body.querySelectorAll('[data-ctrl-btn]').forEach(el => {
      const svgBtn = el as SVGElement;
      const name = svgBtn.dataset.ctrlBtn as CanonicalButtonName;
      if (name === 'l2' || name === 'r2') {
        const val = mapped.buttons[name] as number;
        svgBtn.classList.toggle('ctrl-svg-pressed', val > 0.1);
      } else {
        svgBtn.classList.toggle('ctrl-svg-pressed', !!mapped.buttons[name]);
      }
    });

    // Update game button panel pressed states (mirror)
    body.querySelectorAll('.game-map-btn[data-game-btn]').forEach(el => {
      const btn = el as HTMLElement;
      const name = btn.dataset.gameBtn as CanonicalButtonName;
      if (name === 'l2' || name === 'r2') {
        btn.classList.toggle('pressed', (mapped.buttons[name] as number) > 0.1);
      } else {
        btn.classList.toggle('pressed', !!mapped.buttons[name]);
      }
    });
  }

  // Update raw buttons grid
  const rawBtnsGrid = body.querySelector(`[data-raw-btns="${mappingEditorGamepadIndex}"]`) as HTMLElement;
  const rawAxesGrid = body.querySelector(`[data-raw-axes="${mappingEditorGamepadIndex}"]`) as HTMLElement;

  if (rawBtnsGrid) {
    if (rawStates.length > 0 && rawBtnsGrid.children.length !== rawStates.length) {
      rawBtnsGrid.innerHTML = rawStates.map((_, i) => `<div class="raw-btn" data-raw-idx="${i}">${i}</div>`).join('');
    }
    rawStates.forEach((pressed, i) => {
      const el = rawBtnsGrid.children[i] as HTMLElement;
      if (el) {
        el.classList.toggle('pressed', pressed);
        const val = rawValues[i];
        el.textContent = val > 0.01 && val < 1 ? `${i}:${val.toFixed(1)}` : `${i}`;
      }
    });
  }

  if (rawAxesGrid) {
    if (axes.length > 0 && rawAxesGrid.children.length !== axes.length) {
      rawAxesGrid.innerHTML = axes.map((_, i) => `<div class="raw-axis" data-axis-idx="${i}">A${i}: 0.00</div>`).join('');
    }
    axes.forEach((val, i) => {
      const el = rawAxesGrid.children[i] as HTMLElement;
      if (el) el.textContent = `A${i}: ${val.toFixed(2)}`;
    });
  }
}

function startListeningForButton(canonicalName: CanonicalButtonName) {
  // Use game profile label for the prompt
  const defaultLabels: Record<string, string> = {
    a: 'A', b: 'B', x: 'X', y: 'Y', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
    select: 'Select', start: 'Start', l3: 'L3', r3: 'R3',
    dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
    home: 'Home', touchpad: 'Misc',
  };
  const gameLabel = mappingGameProfile.labels[canonicalName] || defaultLabels[canonicalName] || canonicalName;
  mappingListeningFor = canonicalName;
  $mappingListenLabel.innerHTML = `Press a button on your controller for: <strong>${gameLabel}</strong>`;
  $mappingListenOverlay.classList.remove('hidden');

  // Highlight the game button
  const body = $settingsControllerList.querySelector(`[data-card-body="${mappingEditorGamepadIndex}"]`);
  if (body) {
    body.querySelectorAll('.game-map-btn[data-game-btn]').forEach(el => {
      (el as HTMLElement).classList.toggle('listening', (el as HTMLElement).dataset.gameBtn === canonicalName);
    });
  }

  const initialState = gamepadManager.getRawButtonStates(mappingEditorGamepadIndex);

  mappingListenPollId = requestAnimationFrame(function poll() {
    if (!mappingListeningFor) return;
    const current = gamepadManager.getRawButtonStates(mappingEditorGamepadIndex);

    for (let i = 0; i < current.length; i++) {
      if (current[i] && !initialState[i]) {
        // Build new mapping: remove old assignments for this index and this canonical name
        const newMapping: Record<number, CanonicalButtonName> = {};
        for (const [idx, name] of Object.entries(mappingEditorCurrent)) {
          if (Number(idx) !== i && name !== mappingListeningFor) {
            newMapping[Number(idx)] = name as CanonicalButtonName;
          }
        }
        newMapping[i] = mappingListeningFor!;
        mappingEditorCurrent = newMapping;

        stopListening();
        updateMappingLabels();
        return;
      }
    }

    mappingListenPollId = requestAnimationFrame(poll);
  });
}

function stopListening() {
  mappingListeningFor = null;
  $mappingListenOverlay.classList.add('hidden');
  if (mappingListenPollId !== null) { cancelAnimationFrame(mappingListenPollId); mappingListenPollId = null; }
  $settingsControllerList.querySelectorAll('.game-map-btn.listening').forEach(el => el.classList.remove('listening'));
}

function applyMappingEditor() {
  const mapping: Record<string, string> = {};
  for (const [idx, name] of Object.entries(mappingEditorCurrent)) {
    mapping[String(idx)] = name;
  }
  gamepadManager.setCustomMapping(mappingEditorGamepadId, mapping);
  buildControllerList(); // Refresh list to show "(custom)"
  // Re-populate saved profiles dropdown since buildControllerList regenerated the DOM
  if (expandedCardIndex >= 0) {
    updateSavedProfilesDropdown();
    updateMappingLabels();
  }
  toast('Mapping applied');
}

function closeMappingEditor() {
  stopListening();
  stopMappingVisPoll();
  mappingEditorGamepadIndex = -1;
}

// ── Profile Management ──────────────────────────────────────────────────

function updateSavedProfilesDropdown() {
  if (mappingEditorGamepadIndex < 0) return;
  const body = $settingsControllerList.querySelector(`[data-card-body="${mappingEditorGamepadIndex}"]`);
  if (!body) return;

  const dropdown = body.querySelector('.mapping-saved-profiles') as HTMLSelectElement;
  if (!dropdown) return;

  const profiles = gamepadManager.getAllProfiles();
  dropdown.innerHTML = '<option value="">-- None --</option>' +
    profiles.map(p => `<option value="${esc(p.name)}">${esc(p.name)} (${p.baseProfile})</option>`).join('');

  const active = gamepadManager.getActiveProfileName(mappingEditorGamepadId);
  if (active) dropdown.value = active;
}

function saveCurrentAsProfile(nameInput: HTMLInputElement, _body: HTMLElement) {
  const name = nameInput.value.trim();
  if (!name) { toast('Enter a profile name'); return; }

  const profile: SavedProfile = {
    name,
    baseProfile: mappingEditorProfile,
    mapping: { ...mappingEditorCurrent },
  };
  gamepadManager.saveProfile(profile);
  gamepadManager.setActiveProfile(mappingEditorGamepadId, name);
  applyMappingEditor();
  updateSavedProfilesDropdown();
  toast(`Profile "${name}" saved`);
}

function loadSelectedProfile(dropdown: HTMLSelectElement, _body: HTMLElement) {
  const name = dropdown.value;
  if (!name) return;
  const profile = gamepadManager.getProfile(name);
  if (!profile) { toast('Profile not found'); return; }

  mappingEditorProfile = profile.baseProfile;
  mappingEditorCurrent = { ...profile.mapping };
  gamepadManager.setActiveProfile(mappingEditorGamepadId, name);
  applyMappingEditor();
  updateMappingLabels();
  toast(`Loaded "${name}"`);
}

function deleteSelectedProfile(dropdown: HTMLSelectElement) {
  const name = dropdown.value;
  if (!name) return;
  gamepadManager.deleteProfile(name);
  updateSavedProfilesDropdown();
  toast(`Deleted "${name}"`);
}

// ── Hotkey Combos UI ────────────────────────────────────────────────────

const COMBO_BUTTON_OPTIONS: { value: CanonicalButtonName; label: string }[] = [
  { value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' },
  { value: 'l1', label: 'L1' }, { value: 'r1', label: 'R1' }, { value: 'l2', label: 'L2' }, { value: 'r2', label: 'R2' },
  { value: 'start', label: 'Start' }, { value: 'select', label: 'Select' },
  { value: 'l3', label: 'L3' }, { value: 'r3', label: 'R3' },
  { value: 'dpadUp', label: 'D-Up' }, { value: 'dpadDown', label: 'D-Down' },
  { value: 'dpadLeft', label: 'D-Left' }, { value: 'dpadRight', label: 'D-Right' },
  { value: 'home', label: 'Home' }, { value: 'touchpad', label: 'Touchpad' },
];

function renderHotkeyCombos() {
  $hotkeyBaseBtn.value = hotkeyConfig.baseButton;
  updateHotkeyInputStatus();

  $hotkeyCombosList.innerHTML = hotkeyConfig.combos.map(combo => {
    const optionsHtml = COMBO_BUTTON_OPTIONS.map(o =>
      `<option value="${o.value}" ${o.value === combo.actionButton ? 'selected' : ''}>${o.label}</option>`
    ).join('');

    const kbKey = KEYBOARD_HOTKEY_MAP[combo.id] || '';

    return `
      <div class="hotkey-combo-row" data-combo-id="${combo.id}">
        <div class="hotkey-combo-action">${esc(combo.label)}</div>
        <div class="hotkey-combo-desc">${esc(combo.description)}</div>
        <div class="hotkey-keyboard-col">
          ${kbKey ? `<span class="kbd-badge">${esc(kbKey)}</span>` : '<span style="color:var(--text-dim)">--</span>'}
        </div>
        <div class="hotkey-combo-keys">
          <span class="hotkey-key-badge">${esc($hotkeyBaseBtn.options[$hotkeyBaseBtn.selectedIndex]?.text || 'Select')}</span>
          <span class="hotkey-plus">+</span>
          <select class="hotkey-action-select" data-combo-id="${combo.id}">${optionsHtml}</select>
        </div>
        <label class="toggle-label" style="margin-left:8px;">
          <input type="checkbox" class="hotkey-enabled-check" data-combo-id="${combo.id}" ${combo.enabled ? 'checked' : ''} />
          <span class="toggle-switch"></span>
        </label>
      </div>`;
  }).join('');
}

function readHotkeyCombosFromUI() {
  hotkeyConfig.baseButton = $hotkeyBaseBtn.value as CanonicalButtonName;
  $hotkeyCombosList.querySelectorAll('.hotkey-combo-row').forEach(row => {
    const id = (row as HTMLElement).dataset.comboId!;
    const combo = hotkeyConfig.combos.find(c => c.id === id);
    if (!combo) return;
    const selectEl = row.querySelector('.hotkey-action-select') as HTMLSelectElement;
    const checkEl = row.querySelector('.hotkey-enabled-check') as HTMLInputElement;
    if (selectEl) combo.actionButton = selectEl.value as CanonicalButtonName;
    if (checkEl) combo.enabled = checkEl.checked;
  });
}

// ── Hotkey Polling During Gameplay ──────────────────────────────────────

function startHotkeyPolling() {
  stopHotkeyPolling();
  hotkeyPollId = requestAnimationFrame(function poll() {
    if (!$playerView.classList.contains('active')) { hotkeyPollId = null; return; }
    pollHotkeys();
    hotkeyPollId = requestAnimationFrame(poll);
  });
}

function stopHotkeyPolling() {
  if (hotkeyPollId !== null) { cancelAnimationFrame(hotkeyPollId); hotkeyPollId = null; }
}

function pollHotkeys() {
  const gamepads = gamepadManager.getGamepads();
  if (gamepads.length === 0) return;
  const now = Date.now();
  if (now - hotkeyCooldown < 500) return;

  const gp = gamepads[0];
  const base = hotkeyConfig.baseButton;
  const basePressed = isButtonPressed(gp, base);
  if (!basePressed) return;

  for (const combo of hotkeyConfig.combos) {
    if (!combo.enabled) continue;
    if (combo.actionButton === base) continue;
    if (isButtonPressed(gp, combo.actionButton)) {
      executeHotkeyAction(combo.id);
      hotkeyCooldown = now;
      return;
    }
  }
}

function isButtonPressed(gp: MappedGamepad, btn: CanonicalButtonName): boolean {
  const val = gp.buttons[btn as keyof typeof gp.buttons];
  if (typeof val === 'number') return val > 0.3;
  return !!val;
}

function executeHotkeyAction(actionId: string) {
  const iframe = document.querySelector('#emulator-container iframe') as HTMLIFrameElement | null;

  switch (actionId) {
    case 'exit_game':
      cleanup();
      if (kioskWasActive) { returnToKiosk(); }
      else if (currentDetailGame) { showView('detail'); }
      else { showView(currentSystem ? 'games' : 'systems'); }
      break;
    case 'fullscreen':
      enterFullscreen('emulator-container');
      break;
    case 'save_state':
      // EmulatorJS exposes EJS_emulator.quickSave() in the iframe
      try { (iframe?.contentWindow as any)?.EJS_emulator?.quickSave?.(); toast('State saved'); } catch { toast('Save not supported'); }
      break;
    case 'load_state':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.quickLoad?.(); toast('State loaded'); } catch { toast('Load not supported'); }
      break;
    case 'fast_forward':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.toggleFastForward?.(); toast('Fast forward toggled'); } catch { /* */ }
      break;
    case 'rewind':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.toggleRewind?.(); toast('Rewind toggled'); } catch { /* */ }
      break;
    case 'pause':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.togglePause?.(); toast('Paused/Resumed'); } catch { /* */ }
      break;
    case 'reset':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.reset?.(); toast('Game reset'); } catch { /* */ }
      break;
    case 'screenshot':
      try { (iframe?.contentWindow as any)?.EJS_emulator?.screenshot?.(); toast('Screenshot taken'); } catch { toast('Screenshot not supported'); }
      break;
  }
}

// ── Keyboard Shortcut Mapping ────────────────────────────────────────────

const KEYBOARD_HOTKEY_MAP: Record<string, string> = {
  exit_game: 'Escape',
  fullscreen: 'F11',
  save_state: 'F5',
  load_state: 'F7',
  fast_forward: 'F',
  rewind: 'R',
  screenshot: 'F12',
  pause: 'P',
  reset: 'F9',
};

function handleKeyboardHotkeys(e: KeyboardEvent) {
  if (!$playerView.classList.contains('active')) return;
  const now = Date.now();
  if (now - hotkeyCooldown < 500) return;

  for (const combo of hotkeyConfig.combos) {
    if (!combo.enabled) continue;
    const key = KEYBOARD_HOTKEY_MAP[combo.id];
    if (key && (e.key === key || e.key.toLowerCase() === key.toLowerCase())) {
      e.preventDefault();
      executeHotkeyAction(combo.id);
      hotkeyCooldown = now;
      return;
    }
  }
}

// ── Folder Browser ──────────────────────────────────────────────────────

let browseCurrent = '/';

async function openBrowseModal() {
  const currentPath = $romDirInput.value.trim() || '/';
  browseCurrent = currentPath;
  $browsePathInput.value = browseCurrent;
  $browseModal.classList.remove('hidden');
  await loadBrowseDir(browseCurrent);
}

async function loadBrowseDir(path: string) {
  browseCurrent = path;
  $browsePathInput.value = path;
  $browseDirsList.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
  try {
    const result = await browseDirs(path);
    if (!result.is_valid) {
      $browseDirsList.innerHTML = '<p class="setting-hint" style="padding:20px;text-align:center;">Directory not found. Enter a valid path.</p>';
      return;
    }
    if (result.dirs.length === 0) {
      $browseDirsList.innerHTML = '<p class="setting-hint" style="padding:20px;text-align:center;">No subdirectories.</p>';
      return;
    }
    $browseDirsList.innerHTML = result.dirs.map(d => `
      <div class="browse-dir-item" data-dir="${esc(d)}">
        <span class="folder-icon">&#128193;</span>
        <span>${esc(d)}</span>
      </div>
    `).join('');
    $browseDirsList.querySelectorAll('.browse-dir-item').forEach(item => {
      item.addEventListener('dblclick', () => {
        const dir = (item as HTMLElement).dataset.dir!;
        const newPath = browseCurrent.endsWith('/') ? browseCurrent + dir : browseCurrent + '/' + dir;
        loadBrowseDir(newPath);
      });
    });
  } catch { $browseDirsList.innerHTML = '<p class="setting-hint" style="padding:20px;">Failed to browse directory.</p>'; }
}

// ── SSE Rescan with progress ────────────────────────────────────────────

function startRescanStream() {
  $scanProgressPanel.classList.remove('hidden');
  $scanProgressLog.innerHTML = '';
  $scanProgressBar.style.width = '0%';
  $scanProgressTitle.textContent = 'Preparing scan...';
  $scanProgressCount.textContent = '';
  $rescanBtn.setAttribute('disabled', '');
  $saveRomDirBtn.setAttribute('disabled', '');

  const es = new EventSource('/api/rescan-stream');
  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'start':
          $scanProgressTitle.textContent = `Scanning ${data.total} directories...`;
          break;
        case 'scanning':
          $scanProgressTitle.textContent = `Scanning: ${data.name}`;
          $scanProgressCount.textContent = `${data.index + 1} / ${data.total}`;
          $scanProgressBar.style.width = `${((data.index) / data.total) * 100}%`;
          appendLogEntry($scanProgressLog, `Scanning ${data.name}...`, 'scanning');
          break;
        case 'system_done': {
          const pct = (data.index / data.total) * 100;
          $scanProgressBar.style.width = `${pct}%`;
          $scanProgressCount.textContent = `${data.index} / ${data.total}`;
          appendLogEntry($scanProgressLog, `${data.name}: ${data.game_count} games found`, 'system_done');
          break;
        }
        case 'done':
          $scanProgressTitle.textContent = 'Scan complete!';
          $scanProgressBar.style.width = '100%';
          $scanProgressCount.textContent = `${data.systems} systems, ${data.games} games`;
          appendLogEntry($scanProgressLog, `Done: ${data.systems} systems, ${data.games} games`, 'system_done');
          es.close();
          systems = await fetchSystems();
          renderSystems(systems);
          populateScrapeSystemSelect();
          allGamesCache = await fetchGames();
          $rescanBtn.removeAttribute('disabled');
          $saveRomDirBtn.removeAttribute('disabled');
          $romDirStatus.textContent = `Found ${data.systems} systems, ${data.games} games`;
          break;
        case 'error':
          appendLogEntry($scanProgressLog, `Error: ${data.message}`, 'error');
          es.close();
          $rescanBtn.removeAttribute('disabled');
          $saveRomDirBtn.removeAttribute('disabled');
          break;
      }
    } catch { /* parse error */ }
  };
  es.onerror = () => {
    es.close();
    $rescanBtn.removeAttribute('disabled');
    $saveRomDirBtn.removeAttribute('disabled');
  };
}

// ── SSE Scrape with progress ────────────────────────────────────────────

function startScrapeStream(systemId: string) {
  $scrapeProgressPanel.classList.remove('hidden');
  $scrapeProgressLog.innerHTML = '';
  $scrapeProgressBar.style.width = '0%';
  $scrapeProgressTitle.textContent = `Scraping ${systemId}...`;
  $scrapeProgressCount.textContent = '';
  $scrapeRunBtn.setAttribute('disabled', '');
  $scrapeAllBtn.setAttribute('disabled', '');

  const es = new EventSource(`/api/scrape-stream/${encodeURIComponent(systemId)}`);
  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'start':
          $scrapeProgressTitle.textContent = `Scraping ${data.system}: ${data.total} games`;
          break;
        case 'progress': {
          const pct = (data.index / data.total) * 100;
          $scrapeProgressBar.style.width = `${pct}%`;
          $scrapeProgressCount.textContent = `${data.index} / ${data.total}`;
          appendLogEntry($scrapeProgressLog, data.message, data.status);
          break;
        }
        case 'done':
          $scrapeProgressTitle.textContent = 'Scrape complete!';
          $scrapeProgressBar.style.width = '100%';
          $scrapeProgressCount.textContent = `${data.scraped} downloaded, ${data.not_found} not found, ${data.errors} errors, ${data.already_have} already have`;
          appendLogEntry($scrapeProgressLog, `Done: ${data.scraped} downloaded, ${data.not_found} not found, ${data.errors} errors`, 'system_done');
          es.close();
          $scrapeRunBtn.removeAttribute('disabled');
          $scrapeAllBtn.removeAttribute('disabled');
          // Refresh games view if currently viewing this system
          if (currentSystem?.id === systemId) {
            currentGames = await fetchGames(currentSystem.id);
            renderGames(currentGames);
          }
          break;
        case 'error':
          appendLogEntry($scrapeProgressLog, `Error: ${data.message}`, 'error');
          es.close();
          $scrapeRunBtn.removeAttribute('disabled');
          $scrapeAllBtn.removeAttribute('disabled');
          break;
      }
    } catch { /* parse error */ }
  };
  es.onerror = () => {
    es.close();
    $scrapeRunBtn.removeAttribute('disabled');
    $scrapeAllBtn.removeAttribute('disabled');
  };
}

async function scrapeAllSystems() {
  const systemIds = systems.map(s => s.id);
  for (const sid of systemIds) {
    await new Promise<void>((resolve) => {
      $scrapeProgressPanel.classList.remove('hidden');
      $scrapeProgressLog.innerHTML = '';
      $scrapeProgressBar.style.width = '0%';
      $scrapeProgressTitle.textContent = `Scraping ${sid}...`;
      $scrapeProgressCount.textContent = '';
      $scrapeRunBtn.setAttribute('disabled', '');
      $scrapeAllBtn.setAttribute('disabled', '');

      const es = new EventSource(`/api/scrape-stream/${encodeURIComponent(sid)}`);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'start':
              $scrapeProgressTitle.textContent = `Scraping ${data.system}: ${data.total} games`;
              break;
            case 'progress': {
              const pct = (data.index / data.total) * 100;
              $scrapeProgressBar.style.width = `${pct}%`;
              $scrapeProgressCount.textContent = `${data.index} / ${data.total}`;
              appendLogEntry($scrapeProgressLog, data.message, data.status);
              break;
            }
            case 'done':
              $scrapeProgressTitle.textContent = `${sid} done!`;
              $scrapeProgressBar.style.width = '100%';
              appendLogEntry($scrapeProgressLog, `${sid}: ${data.scraped} downloaded, ${data.not_found} not found`, 'system_done');
              es.close();
              resolve();
              break;
            case 'error':
              appendLogEntry($scrapeProgressLog, `Error: ${data.message}`, 'error');
              es.close();
              resolve();
              break;
          }
        } catch { es.close(); resolve(); }
      };
      es.onerror = () => { es.close(); resolve(); };
    });
  }
  $scrapeRunBtn.removeAttribute('disabled');
  $scrapeAllBtn.removeAttribute('disabled');
  toast('All systems scraped');
}

function appendLogEntry(logEl: HTMLElement, message: string, cssClass: string) {
  const entry = document.createElement('div');
  entry.className = `progress-log-entry ${cssClass}`;
  entry.textContent = message;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

const KNOWN_SCRAPE_SOURCES: { name: string; url: string }[] = [
  { name: 'LibRetro Thumbnails (official)', url: 'https://thumbnails.libretro.com' },
  { name: 'LibRetro GitHub Raw', url: 'https://raw.githubusercontent.com/libretro-thumbnails' },
];

function renderScrapeSources() {
  if (!settings) return;
  const sources = settings.scrape_sources || [];

  // Active sources list
  $scrapeSourcesList.innerHTML = sources.length === 0
    ? '<div class="setting-hint" style="padding:6px 0;">No sources configured. Add one below.</div>'
    : sources.map((src, i) => `
    <div class="scrape-source-item${i === 0 ? ' primary' : ''}" data-idx="${i}">
      <span class="scrape-source-num">${i === 0 ? '&#9733;' : (i + 1) + '.'}</span>
      <span class="scrape-source-url" title="${esc(src)}">${esc(src)}</span>
      ${i > 0 ? `<button class="action-btn sm scrape-src-primary" data-idx="${i}" title="Set as primary">&#9733;</button>` : ''}
      <button class="action-btn sm scrape-src-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">&#x25B2;</button>
      <button class="action-btn sm scrape-src-down" data-idx="${i}" ${i === sources.length - 1 ? 'disabled' : ''} title="Move down">&#x25BC;</button>
      <button class="action-btn sm danger scrape-src-rm" data-idx="${i}" title="Remove">&#x2715;</button>
    </div>
  `).join('');

  // Set as primary (move to index 0)
  $scrapeSourcesList.querySelectorAll('.scrape-src-primary').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      const [item] = settings!.scrape_sources.splice(idx, 1);
      settings!.scrape_sources.unshift(item);
      renderScrapeSources();
    });
  });
  $scrapeSourcesList.querySelectorAll('.scrape-src-up').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      if (idx > 0) { [settings!.scrape_sources[idx - 1], settings!.scrape_sources[idx]] = [settings!.scrape_sources[idx], settings!.scrape_sources[idx - 1]]; renderScrapeSources(); }
    });
  });
  $scrapeSourcesList.querySelectorAll('.scrape-src-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      if (idx < settings!.scrape_sources.length - 1) { [settings!.scrape_sources[idx], settings!.scrape_sources[idx + 1]] = [settings!.scrape_sources[idx + 1], settings!.scrape_sources[idx]]; renderScrapeSources(); }
    });
  });
  $scrapeSourcesList.querySelectorAll('.scrape-src-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      settings!.scrape_sources.splice(idx, 1);
      renderScrapeSources();
    });
  });

  // Known sources grid — show which are added and which are available
  $scrapeKnownSources.innerHTML = KNOWN_SCRAPE_SOURCES.map(ks => {
    const added = sources.includes(ks.url);
    return `<div class="scrape-known-item${added ? ' added' : ''}" data-url="${esc(ks.url)}">
      <span class="scrape-known-name">${esc(ks.name)}</span>
      <span class="scrape-known-url">${esc(ks.url)}</span>
      <button class="action-btn sm scrape-known-toggle" data-url="${esc(ks.url)}">${added ? 'Added &#x2713;' : '+ Add'}</button>
    </div>`;
  }).join('');

  $scrapeKnownSources.querySelectorAll('.scrape-known-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!settings) return;
      const url = (btn as HTMLElement).dataset.url!;
      const idx = settings.scrape_sources.indexOf(url);
      if (idx >= 0) {
        settings.scrape_sources.splice(idx, 1);
      } else {
        settings.scrape_sources.push(url);
      }
      renderScrapeSources();
    });
  });
}

function populateScrapeSystemSelect() {
  $scrapeSystemSelect.innerHTML = '<option value="">-- Select System --</option>' +
    systems.map(s => `<option value="${s.id}">${esc(s.name)} (${s.game_count} games)</option>`).join('');
}

function populateScrapeInfoSystemSelect() {
  $scrapeInfoSystemSelect.innerHTML = '<option value="">-- Select System --</option>' +
    systems.map(s => `<option value="${s.id}">${esc(s.name)} (${s.game_count} games)</option>`).join('');
}

// ── SSE Info Scrape with progress ────────────────────────────────────────

function startInfoScrapeStream(systemId: string) {
  $scrapeInfoProgressPanel.classList.remove('hidden');
  $scrapeInfoProgressLog.innerHTML = '';
  $scrapeInfoProgressBar.style.width = '0%';
  $scrapeInfoProgressTitle.textContent = `Scraping info for ${systemId}...`;
  $scrapeInfoProgressCount.textContent = '';
  $scrapeInfoRunBtn.setAttribute('disabled', '');
  $scrapeInfoAllBtn.setAttribute('disabled', '');

  const es = new EventSource(`/api/scrape-info-stream/${encodeURIComponent(systemId)}`);
  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'start':
          $scrapeInfoProgressTitle.textContent = `Scraping info for ${data.system}: ${data.total} games`;
          break;
        case 'progress': {
          const pct = (data.index / data.total) * 100;
          $scrapeInfoProgressBar.style.width = `${pct}%`;
          $scrapeInfoProgressCount.textContent = `${data.index} / ${data.total}`;
          appendLogEntry($scrapeInfoProgressLog, data.message, data.status);
          break;
        }
        case 'done':
          $scrapeInfoProgressTitle.textContent = 'Info scrape complete!';
          $scrapeInfoProgressBar.style.width = '100%';
          $scrapeInfoProgressCount.textContent = `${data.scraped} fetched, ${data.not_found} not found, ${data.already_have} already have`;
          appendLogEntry($scrapeInfoProgressLog, `Done: ${data.scraped} fetched, ${data.not_found} not found`, 'system_done');
          es.close();
          $scrapeInfoRunBtn.removeAttribute('disabled');
          $scrapeInfoAllBtn.removeAttribute('disabled');
          break;
        case 'error':
          appendLogEntry($scrapeInfoProgressLog, `Error: ${data.message}`, 'error');
          es.close();
          $scrapeInfoRunBtn.removeAttribute('disabled');
          $scrapeInfoAllBtn.removeAttribute('disabled');
          break;
      }
    } catch { /* parse error */ }
  };
  es.onerror = () => {
    es.close();
    $scrapeInfoRunBtn.removeAttribute('disabled');
    $scrapeInfoAllBtn.removeAttribute('disabled');
  };
}

async function scrapeAllInfo() {
  const systemIds = systems.map(s => s.id);
  for (const sid of systemIds) {
    await new Promise<void>((resolve) => {
      $scrapeInfoProgressPanel.classList.remove('hidden');
      $scrapeInfoProgressLog.innerHTML = '';
      $scrapeInfoProgressBar.style.width = '0%';
      $scrapeInfoProgressTitle.textContent = `Scraping info for ${sid}...`;
      $scrapeInfoProgressCount.textContent = '';
      $scrapeInfoRunBtn.setAttribute('disabled', '');
      $scrapeInfoAllBtn.setAttribute('disabled', '');

      const es = new EventSource(`/api/scrape-info-stream/${encodeURIComponent(sid)}`);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'start':
              $scrapeInfoProgressTitle.textContent = `Scraping info for ${data.system}: ${data.total} games`;
              break;
            case 'progress': {
              const pct = (data.index / data.total) * 100;
              $scrapeInfoProgressBar.style.width = `${pct}%`;
              $scrapeInfoProgressCount.textContent = `${data.index} / ${data.total}`;
              appendLogEntry($scrapeInfoProgressLog, data.message, data.status);
              break;
            }
            case 'done':
              $scrapeInfoProgressTitle.textContent = `${sid} info done!`;
              $scrapeInfoProgressBar.style.width = '100%';
              appendLogEntry($scrapeInfoProgressLog, `${sid}: ${data.scraped} fetched, ${data.not_found} not found`, 'system_done');
              es.close();
              resolve();
              break;
            case 'error':
              appendLogEntry($scrapeInfoProgressLog, `Error: ${data.message}`, 'error');
              es.close();
              resolve();
              break;
          }
        } catch { es.close(); resolve(); }
      };
      es.onerror = () => { es.close(); resolve(); };
    });
  }
  $scrapeInfoRunBtn.removeAttribute('disabled');
  $scrapeInfoAllBtn.removeAttribute('disabled');
  toast('All systems info scraped');
}

// ── Default Controller Display ──────────────────────────────────────────

function renderDefaultController() {
  const profile = $defaultControllerProfile.value as ProfileName;
  $defaultControllerSvg.innerHTML = getControllerSVG(profile);

  const labels = getButtonLabels(profile);
  const btnKeys: CanonicalButtonName[] = ['a','b','x','y','l1','r1','l2','r2','select','start','l3','r3','dpadUp','dpadDown','dpadLeft','dpadRight','home','touchpad'];
  $defaultControllerMapping.innerHTML = btnKeys.map(key => {
    const label = labels[key];
    return `<div class="default-mapping-item"><span class="map-label">${key}</span><span class="map-value">${label}</span></div>`;
  }).join('');
}

// ── Theme Picker UI ─────────────────────────────────────────────────────

function renderThemeGrid() {
  const $themeGrid = $('theme-grid');
  const currentTheme = loadTheme();
  const $editor = document.getElementById('custom-theme-editor')!;

  $themeGrid.innerHTML = THEMES.map(t => `
    <div class="theme-card${t.id === currentTheme ? ' active' : ''}" data-theme-id="${t.id}">
      <div class="theme-card-preview">
        <div class="theme-preview-header" style="background:${t.colors.header}; border: 1px solid ${t.colors.border};"></div>
        <div class="theme-preview-body" style="background:${t.colors.bg};">
          <div class="theme-preview-card" style="background:${t.colors.bgCard}; border-color:${t.colors.border};"></div>
          <div class="theme-preview-card" style="background:${t.colors.bgCard}; border-color:${t.colors.border};"></div>
          <div class="theme-preview-card" style="background:${t.colors.bgCard}; border-color:${t.colors.border};"></div>
        </div>
      </div>
      <div class="theme-preview-accent" style="background:${t.colors.accent};"></div>
      <div class="theme-card-name" style="color:${t.colors.text};">${t.icon} ${t.name}</div>
    </div>
  `).join('');

  // Show/hide custom editor
  $editor.classList.toggle('visible', currentTheme === 'custom');

  // Load saved custom colors into inputs
  const saved = loadCustomColors();
  const fields: [string, string][] = [['custom-bg','bg'],['custom-card','bgCard'],['custom-header','header'],['custom-text','text'],['custom-accent','accent'],['custom-border','border']];
  const customDef = THEMES.find(t => t.id === 'custom')!;
  fields.forEach(([inputId, key]) => {
    const el = document.getElementById(inputId) as HTMLInputElement;
    if (el) el.value = saved[key] || (customDef.colors as any)[key];
  });

  $themeGrid.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      const themeId = (card as HTMLElement).dataset.themeId!;
      clearCustomThemeInline();
      applyTheme(themeId);
      $themeGrid.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      $editor.classList.toggle('visible', themeId === 'custom');
      toast(`Theme: ${THEMES.find(t => t.id === themeId)?.name || themeId}`);
    });
  });

  // Custom theme apply button
  document.getElementById('apply-custom-theme')?.addEventListener('click', () => {
    const colors: Record<string, string> = {};
    fields.forEach(([inputId, key]) => {
      const el = document.getElementById(inputId) as HTMLInputElement;
      if (el) colors[key] = el.value;
    });
    saveCustomColors(colors);
    applyTheme('custom');
    toast('Custom theme applied!');
  });
}

// renderFvThemeGrid removed - FullView now uses unified theme

// ── Update Hotkey Input Status ──────────────────────────────────────────

function updateHotkeyInputStatus() {
  const gamepads = gamepadManager.getGamepads();
  const hasController = gamepads.length > 0;
  $hotkeyKeyboardStatus.classList.remove('hidden');
  $hotkeyControllerStatus.classList.toggle('hidden', !hasController);
}

// ── Kiosk Mode ──────────────────────────────────────────────────────────

let kioskClockInterval: ReturnType<typeof setInterval> | null = null;

function updateKioskClock() {
  $kioskClock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function enterKioskMode() {
  kioskWasActive = true;
  $header.classList.add('hidden');
  $kioskView.classList.remove('hidden');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

  if (systems.length === 0) return;
  kioskSystemIndex = 0;
  renderKioskSystems();
  await loadKioskGames();

  updateKioskClock();
  if (kioskClockInterval) clearInterval(kioskClockInterval);
  kioskClockInterval = setInterval(updateKioskClock, 30000);

  gamepadManager.startPolling(handleKioskInput);
}

function exitKioskMode() {
  kioskWasActive = false;
  closeKioskDetail();
  $header.classList.remove('hidden');
  $kioskView.classList.add('hidden');
  gamepadManager.stopPolling();
  if (kioskClockInterval) { clearInterval(kioskClockInterval); kioskClockInterval = null; }
  showView('systems');
}

function returnToKiosk() {
  $header.classList.add('hidden');
  $kioskView.classList.remove('hidden');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  cleanup();
  updateKioskClock();
  if (!kioskClockInterval) kioskClockInterval = setInterval(updateKioskClock, 30000);
  gamepadManager.startPolling(handleKioskInput);
  renderKioskSystems();
  renderKioskGames();
}

function renderKioskSystems() {
  $kioskSystemWheel.innerHTML = systems.map((sys, i) => `
    <div class="kiosk-system-pill ${i === kioskSystemIndex ? 'active' : ''}" data-idx="${i}">
      ${SYSTEM_ICONS[sys.id] || '🎲'} ${esc(sys.name)}
    </div>
  `).join('');

  const active = $kioskSystemWheel.querySelector('.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

  $kioskSystemWheel.querySelectorAll('.kiosk-system-pill').forEach(pill => {
    pill.addEventListener('click', async () => {
      kioskSystemIndex = parseInt((pill as HTMLElement).dataset.idx!, 10);
      renderKioskSystems();
      await loadKioskGames();
    });
  });
}

async function loadKioskGames() {
  const sys = systems[kioskSystemIndex];
  if (!sys) return;
  $kioskSystemName.textContent = sys.name;
  kioskGames = await fetchGames(sys.id);
  kioskGameIndex = 0;
  renderKioskGames();
}

function renderKioskGames() {
  if (kioskGames.length > 0) {
    $kioskGameCounter.textContent = `${kioskGameIndex + 1} / ${kioskGames.length}`;
  } else {
    $kioskGameCounter.textContent = 'No games';
  }

  $kioskGamesCarousel.innerHTML = kioskGames.map((game, i) => `
    <div class="kiosk-game-card ${i === kioskGameIndex ? 'selected' : ''}" data-idx="${i}">
      <div class="kiosk-game-img">
        ${game.image_path
          ? `<img src="${game.image_path}" alt="${esc(game.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>🎮</div>'" />`
          : `<div class="placeholder">🎮</div>`}
      </div>
      <div class="kiosk-game-name">${esc(game.name)}</div>
    </div>
  `).join('');

  const selected = $kioskGamesCarousel.querySelector('.selected');
  if (selected) selected.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

  $kioskGamesCarousel.querySelectorAll('.kiosk-game-card').forEach(card => {
    card.addEventListener('click', () => {
      kioskGameIndex = parseInt((card as HTMLElement).dataset.idx!, 10);
      renderKioskGames();
      launchKioskGame();
    });
  });
}

function launchKioskGame() {
  const game = kioskGames[kioskGameIndex];
  const sys = systems[kioskSystemIndex];
  if (!game || !sys) return;
  currentSystem = sys;
  closeKioskDetail();
  $kioskView.classList.add('hidden');
  gamepadManager.stopPolling();
  if (kioskClockInterval) { clearInterval(kioskClockInterval); kioskClockInterval = null; }
  $header.classList.remove('hidden');
  $playerTitle.textContent = game.name;
  showView('player');
  launchGame(game, sys, 'emulator-container');
  enterFullscreen('emulator-container');
}

// ── FullView Detail Overlay (game + platform) ─────────────────────────
function closeKioskDetail() {
  kioskDetailOpen = false;
  kioskDetailKind = null;
  $kioskDetailOverlay.classList.add('hidden');
}

function renderKioskGameMeta(game: GameInfo, sys: SystemInfo, meta: GameMetadata | null) {
  let rows = `
    <div class="kd-label">System</div><div class="kd-value">${esc(sys.name)}</div>
    <div class="kd-label">File</div><div class="kd-value" style="font-family:monospace;font-size:0.78rem;word-break:break-all;">${esc(game.file)}</div>`;
  if (meta) {
    if (meta.release_year) rows += `<div class="kd-label">Year</div><div class="kd-value">${esc(meta.release_year)}</div>`;
    if (meta.developer)    rows += `<div class="kd-label">Developer</div><div class="kd-value">${esc(meta.developer)}</div>`;
    if (meta.publisher)    rows += `<div class="kd-label">Publisher</div><div class="kd-value">${esc(meta.publisher)}</div>`;
    if (meta.genre)        rows += `<div class="kd-label">Genre</div><div class="kd-value">${esc(meta.genre)}</div>`;
    if (meta.players)      rows += `<div class="kd-label">Players</div><div class="kd-value">${esc(meta.players)}</div>`;
    if (meta.rating)       rows += `<div class="kd-label">Rating</div><div class="kd-value rating">&#9733; ${meta.rating.toFixed(1)} / 5</div>`;
  }
  $kioskDetailMeta.innerHTML = rows;
}

async function openKioskGameDetail() {
  const game = kioskGames[kioskGameIndex];
  const sys = systems[kioskSystemIndex];
  if (!game || !sys) return;

  kioskDetailOpen = true;
  kioskDetailKind = 'game';

  $kioskDetailEyebrow.textContent = 'Game';
  $kioskDetailTitle.textContent = game.name;

  $kioskDetailCover.innerHTML = game.image_path
    ? `<img src="${esc(game.image_path)}" alt="${esc(game.name)}" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>&#127918;</div>'" />`
    : `<div class="placeholder">&#127918;</div>`;

  renderKioskGameMeta(game, sys, null);
  $kioskDetailDesc.classList.add('empty');
  $kioskDetailDesc.textContent = 'Loading metadata...';

  $kioskDetailPlayBtn.style.display = '';
  $kioskDetailOverlay.classList.remove('hidden');
  setTimeout(() => $kioskDetailPlayBtn.focus(), 30);

  try {
    const meta = await fetchMetadata(game.system, game.file);
    if (kioskDetailOpen && kioskDetailKind === 'game' && kioskGames[kioskGameIndex]?.id === game.id) {
      renderKioskGameMeta(game, sys, meta);
      if (meta?.description) {
        $kioskDetailDesc.textContent = meta.description;
        $kioskDetailDesc.classList.remove('empty');
      } else {
        $kioskDetailDesc.textContent = 'No description available. Use the main view to scrape info.';
        $kioskDetailDesc.classList.add('empty');
      }
    }
  } catch {
    if (kioskDetailOpen) {
      $kioskDetailDesc.textContent = 'Failed to load metadata.';
      $kioskDetailDesc.classList.add('empty');
    }
  }
}

function openKioskSystemDetail() {
  const sys = systems[kioskSystemIndex];
  if (!sys) return;

  kioskDetailOpen = true;
  kioskDetailKind = 'system';

  const icon = SYSTEM_ICONS[sys.id] || '🎲';
  $kioskDetailEyebrow.textContent = 'Platform';
  $kioskDetailTitle.textContent = `${icon} ${sys.name}`;

  $kioskDetailCover.innerHTML = `<div class="placeholder" style="font-size:6rem;opacity:0.7;">${icon}</div>`;

  $kioskDetailMeta.innerHTML = `
    <div class="kd-label">ID</div><div class="kd-value" style="font-family:monospace;">${esc(sys.id)}</div>
    <div class="kd-label">Games</div><div class="kd-value">${sys.game_count}</div>
    <div class="kd-label">Core</div><div class="kd-value" style="font-family:monospace;">${esc(sys.core)}</div>`;

  const previewNames = kioskGames.slice(0, 6).map(g => g.name);
  if (previewNames.length > 0) {
    const list = previewNames.map(n => `&bull; ${esc(n)}`).join('<br/>');
    const more = kioskGames.length > previewNames.length ? `<br/><span style="opacity:0.6;">…and ${kioskGames.length - previewNames.length} more</span>` : '';
    $kioskDetailDesc.innerHTML = `<strong>Sample titles</strong><br/>${list}${more}`;
    $kioskDetailDesc.classList.remove('empty');
  } else {
    $kioskDetailDesc.textContent = 'No games scanned for this platform yet.';
    $kioskDetailDesc.classList.add('empty');
  }

  $kioskDetailPlayBtn.style.display = 'none';
  $kioskDetailOverlay.classList.remove('hidden');
  setTimeout(() => $kioskDetailBackBtn.focus(), 30);
}

let kioskInputCooldown = 0;
function handleKioskInput(gamepads: MappedGamepad[]) {
  if (gamepads.length === 0) return;
  const now = Date.now();
  if (now - kioskInputCooldown < 200) return;

  const gp = gamepads[0];
  const b = gp.buttons;
  const axisX = gp.axes[0] ?? 0;
  const axisY = gp.axes[1] ?? 0;
  let acted = false;

  if (kioskDetailOpen) {
    if (b.a && kioskDetailKind === 'game') { launchKioskGame(); acted = true; }
    else if (b.b || b.y) { closeKioskDetail(); acted = true; }
    else if (b.start) { closeKioskDetail(); exitKioskMode(); acted = true; }
    if (acted) kioskInputCooldown = now;
    return;
  }

  if (b.dpadRight || axisX > 0.5) {
    kioskGameIndex = Math.min(kioskGameIndex + 1, kioskGames.length - 1);
    renderKioskGames(); acted = true;
  } else if (b.dpadLeft || axisX < -0.5) {
    kioskGameIndex = Math.max(kioskGameIndex - 1, 0);
    renderKioskGames(); acted = true;
  }

  if (b.dpadUp || axisY < -0.5) {
    kioskSystemIndex = Math.max(kioskSystemIndex - 1, 0);
    renderKioskSystems(); loadKioskGames(); acted = true;
  } else if (b.dpadDown || axisY > 0.5) {
    kioskSystemIndex = Math.min(kioskSystemIndex + 1, systems.length - 1);
    renderKioskSystems(); loadKioskGames(); acted = true;
  }

  if (b.l1) {
    kioskSystemIndex = Math.max(kioskSystemIndex - 1, 0);
    renderKioskSystems(); loadKioskGames(); acted = true;
  } else if (b.r1) {
    kioskSystemIndex = Math.min(kioskSystemIndex + 1, systems.length - 1);
    renderKioskSystems(); loadKioskGames(); acted = true;
  }

  if (b.a) { launchKioskGame(); acted = true; }
  else if (b.y) { openKioskGameDetail(); acted = true; }
  else if (b.x) { openKioskSystemDetail(); acted = true; }
  else if (b.b) {
    if (kioskGameIndex > 0) { kioskGameIndex = 0; }
    else { kioskGameIndex = Math.max(kioskGames.length - 1, 0); }
    renderKioskGames(); acted = true;
  }
  if (b.start) { exitKioskMode(); acted = true; }

  if (acted) kioskInputCooldown = now;
}

function handleKioskKeyboard(e: KeyboardEvent) {
  if ($kioskView.classList.contains('hidden')) return;
  const now = Date.now();
  if (now - kioskInputCooldown < 200) return;

  let acted = false;

  if (kioskDetailOpen) {
    switch (e.key) {
      case 'Escape':
      case 'Backspace':
      case 'y':
      case 'Y':
        closeKioskDetail(); acted = true; break;
      case 'Enter':
      case ' ':
        if (kioskDetailKind === 'game') { launchKioskGame(); acted = true; }
        else { closeKioskDetail(); acted = true; }
        break;
    }
    if (acted) { e.preventDefault(); kioskInputCooldown = now; }
    return;
  }

  switch (e.key) {
    case 'ArrowRight':
      kioskGameIndex = Math.min(kioskGameIndex + 1, kioskGames.length - 1);
      renderKioskGames(); acted = true; break;
    case 'ArrowLeft':
      kioskGameIndex = Math.max(kioskGameIndex - 1, 0);
      renderKioskGames(); acted = true; break;
    case 'ArrowUp':
      kioskSystemIndex = Math.max(kioskSystemIndex - 1, 0);
      renderKioskSystems(); loadKioskGames(); acted = true; break;
    case 'ArrowDown':
      kioskSystemIndex = Math.min(kioskSystemIndex + 1, systems.length - 1);
      renderKioskSystems(); loadKioskGames(); acted = true; break;
    case 'PageUp':
      kioskSystemIndex = Math.max(kioskSystemIndex - 1, 0);
      renderKioskSystems(); loadKioskGames(); acted = true; break;
    case 'PageDown':
      kioskSystemIndex = Math.min(kioskSystemIndex + 1, systems.length - 1);
      renderKioskSystems(); loadKioskGames(); acted = true; break;
    case 'Enter':
    case ' ':
      launchKioskGame(); acted = true; break;
    case 'i':
    case 'I':
    case 'y':
    case 'Y':
      openKioskGameDetail(); acted = true; break;
    case 'p':
    case 'P':
    case 'x':
    case 'X':
      openKioskSystemDetail(); acted = true; break;
    case 'Backspace':
      if (kioskGameIndex > 0) { kioskGameIndex = 0; }
      else { kioskGameIndex = Math.max(kioskGames.length - 1, 0); }
      renderKioskGames(); acted = true; break;
    case 'Home':
      kioskGameIndex = 0; renderKioskGames(); acted = true; break;
    case 'End':
      kioskGameIndex = Math.max(kioskGames.length - 1, 0);
      renderKioskGames(); acted = true; break;
  }

  if (acted) {
    e.preventDefault();
    kioskInputCooldown = now;
  }
}

// ── Controllers (header modal) ──────────────────────────────────────────

function updateControllerUI() {
  const gamepads = gamepadManager.getGamepads();
  $controllerCount.textContent = String(gamepads.length);
  $controllerCount.classList.toggle('hidden', gamepads.length === 0);

  if (gamepads.length === 0) {
    $controllerList.innerHTML = '<p class="no-controllers">No controllers detected. Connect a gamepad and press any button.</p>';
    return;
  }
  $controllerList.innerHTML = gamepads.map(gp => {
    const b = gp.buttons;
    const indicators = [
      {l:'A',p:b.a},{l:'B',p:b.b},{l:'X',p:b.x},{l:'Y',p:b.y},
      {l:'L1',p:b.l1},{l:'R1',p:b.r1},{l:'L2',p:b.l2>0.1},{l:'R2',p:b.r2>0.1},
      {l:'Se',p:b.select},{l:'St',p:b.start},{l:'L3',p:b.l3},{l:'R3',p:b.r3},
      {l:'U',p:b.dpadUp},{l:'D',p:b.dpadDown},{l:'L',p:b.dpadLeft},{l:'R',p:b.dpadRight},
      {l:'H',p:b.home},{l:'T',p:b.touchpad},
    ];
    return `
      <div class="controller-item">
        <div>
          <div class="ctrl-name">P${gp.index+1}: ${esc(gp.id.substring(0,40))}</div>
          <div class="ctrl-buttons">
            ${indicators.map(i => `<div class="ctrl-btn-indicator ${i.p?'pressed':''}" title="${i.l}"></div>`).join('')}
          </div>
        </div>
        <span class="ctrl-profile">${gp.profile}</span>
      </div>`;
  }).join('');
}

// ── Helpers ─────────────────────────────────────────────────────────────

function esc(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg: string, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Init ────────────────────────────────────────────────────────────────

async function init() {
  $systemsGrid.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
  try {
    systems = await fetchSystems();
    renderSystems(systems);
  } catch {
    $systemsGrid.innerHTML = '<div class="loading">Failed to load. Is the server running?</div>';
  }

  try {
    settings = await fetchSettings();
  } catch { /* settings not critical */ }

  // Pre-load all games for All Games / Favourites tabs
  try { allGamesCache = await fetchGames(); } catch { /* non-critical */ }

  // ── Event listeners ──────────────────────────────────────────────────

  // Main tabs (Systems / All Games / Favourites)
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMainTab((tab as HTMLElement).dataset.mainTab!));
  });

  // Sort/filter controls for All Games tab
  document.getElementById('all-games-sort')!.addEventListener('change', () => renderAllGamesTab());
  document.getElementById('all-games-system-filter')!.addEventListener('change', () => renderAllGamesTab());

  // Sort control for Favourites tab
  document.getElementById('fav-games-sort')!.addEventListener('change', () => renderFavouritesTab());

  // Sort control for per-system games view
  const $systemGamesSort = document.getElementById('system-games-sort') as HTMLSelectElement;
  $systemGamesSort.addEventListener('change', () => {
    const sorted = sortGames(currentGames, $systemGamesSort.value);
    renderGames(sorted);
  });

  $searchInput.addEventListener('input', () => handleSearch($searchInput.value));

  $backBtn.addEventListener('click', () => {
    currentSystem = null; currentDetailGame = null; $searchInput.value = ''; showView('systems');
  });

  $playerBackBtn.addEventListener('click', () => {
    cleanup();
    if (kioskWasActive) { returnToKiosk(); return; }
    if (currentDetailGame) { showView('detail'); return; }
    showView(currentSystem ? 'games' : 'systems');
  });

  $logoBtn.addEventListener('click', () => {
    cleanup(); currentSystem = null; currentDetailGame = null; $searchInput.value = ''; showView('systems');
  });

  $fullscreenBtn.addEventListener('click', () => enterFullscreen('emulator-container'));

  // FullView toggle from header
  $fullviewBtn.addEventListener('click', () => enterKioskMode());

  // FullView detail overlay actions
  $kioskDetailCloseBtn.addEventListener('click', () => closeKioskDetail());
  $kioskDetailBackBtn.addEventListener('click', () => closeKioskDetail());
  $kioskDetailPlayBtn.addEventListener('click', () => {
    if (kioskDetailKind === 'game') launchKioskGame();
  });
  $kioskDetailOverlay.addEventListener('click', (e) => {
    if (e.target === $kioskDetailOverlay) closeKioskDetail();
  });

  // Settings
  $settingsBtn.addEventListener('click', () => { showView('settings'); loadSettingsPage(); });
  $settingsBackBtn.addEventListener('click', () => { stopControllerPoll(); showView('systems'); });

  // Settings tabs
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSettingsTab((tab as HTMLElement).dataset.tab!));
  });

  $saveRomDirBtn.addEventListener('click', async () => {
    if (!settings) return;
    settings.rom_dir = $romDirInput.value;
    try {
      await updateSettings(settings);
      $romDirStatus.textContent = 'Saved. Rescanning...';
      toast('ROM directory updated');
      startRescanStream();
    } catch (e) {
      $romDirStatus.textContent = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
  });

  $rescanBtn.addEventListener('click', () => {
    startRescanStream();
  });


  // Scrape sources add
  $scrapeSourceAddBtn.addEventListener('click', () => {
    if (!settings) return;
    const url = $scrapeSourceAddInput.value.trim();
    if (!url) return;
    if (!settings.scrape_sources) settings.scrape_sources = [];
    settings.scrape_sources.push(url);
    $scrapeSourceAddInput.value = '';
    renderScrapeSources();
  });

  // Scrape settings
  $saveScrapeSettingsBtn.addEventListener('click', async () => {
    if (!settings) return;
    settings.scrape_delay_ms = parseInt($scrapeDelayInput.value, 10) || 100;
    settings.ddg_fallback = $ddgFallbackInput.checked;
    try {
      await updateSettings(settings);
      $scrapeSettingsStatus.textContent = 'Saved.';
      toast('Scrape settings saved');
    } catch (e) {
      $scrapeSettingsStatus.textContent = `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
    }
  });

  // Hotkey combos
  $hotkeySaveBtn.addEventListener('click', () => {
    readHotkeyCombosFromUI();
    saveHotkeyConfig();
    toast('Hotkeys saved');
  });
  $hotkeyResetBtn.addEventListener('click', () => {
    hotkeyConfig = JSON.parse(JSON.stringify(DEFAULT_HOTKEYS));
    saveHotkeyConfig();
    renderHotkeyCombos();
    toast('Hotkeys reset to defaults');
  });
  $hotkeyBaseBtn.addEventListener('change', () => {
    hotkeyConfig.baseButton = $hotkeyBaseBtn.value as CanonicalButtonName;
    renderHotkeyCombos();
  });

  // Browse modal
  $browseRomDirBtn.addEventListener('click', () => openBrowseModal());
  $browseCloseBtn.addEventListener('click', () => $browseModal.classList.add('hidden'));
  $browseModal.addEventListener('click', e => { if (e.target === $browseModal) $browseModal.classList.add('hidden'); });
  $browseGoBtn.addEventListener('click', () => loadBrowseDir($browsePathInput.value.trim()));
  $browsePathInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadBrowseDir($browsePathInput.value.trim()); });
  $browseUpBtn.addEventListener('click', () => {
    const parent = browseCurrent.replace(/\/[^/]+\/?$/, '') || '/';
    loadBrowseDir(parent);
  });
  $browseSelectBtn.addEventListener('click', () => {
    $romDirInput.value = browseCurrent;
    $browseModal.classList.add('hidden');
    toast(`Selected: ${browseCurrent}`);
  });

  // Scrape from settings
  $scrapeRunBtn.addEventListener('click', () => {
    const sid = $scrapeSystemSelect.value;
    if (!sid) { toast('Select a system first'); return; }
    startScrapeStream(sid);
  });
  $scrapeAllBtn.addEventListener('click', () => scrapeAllSystems());

  // Info scrape settings save
  $saveInfoSettingsBtn.addEventListener('click', async () => {
    if (!settings) return;
    settings.scrape_metadata = $scrapeMetadataInput.checked;
    settings.screenscraper_user = $ssUserInput.value.trim() || undefined;
    settings.screenscraper_pass = $ssPassInput.value.trim() || undefined;
    settings.rawg_api_key = $rawgKeyInput.value.trim() || undefined;
    try {
      await updateSettings(settings);
      $infoSettingsStatus.textContent = 'Saved.';
      toast('Info scrape settings saved');
    } catch (e) {
      $infoSettingsStatus.textContent = `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
    }
  });

  // Info scrape run
  $scrapeInfoRunBtn.addEventListener('click', () => {
    const sid = $scrapeInfoSystemSelect.value;
    if (!sid) { toast('Select a system first'); return; }
    startInfoScrapeStream(sid);
  });
  $scrapeInfoAllBtn.addEventListener('click', () => scrapeAllInfo());

  // Default controller profile change
  $defaultControllerProfile.addEventListener('change', () => renderDefaultController());

  // Keyboard hotkeys during gameplay
  document.addEventListener('keydown', handleKeyboardHotkeys);

  // Keyboard navigation in FullView/kiosk mode (parallel to controller)
  document.addEventListener('keydown', handleKioskKeyboard);

  // Mapping listen cancel (global overlay)
  $mappingListenCancel.addEventListener('click', stopListening);

  // Game detail modal (legacy)
  $gameDetailCloseBtn.addEventListener('click', () => $gameDetailModal.classList.add('hidden'));
  $gameDetailModal.addEventListener('click', e => {
    if (e.target === $gameDetailModal) $gameDetailModal.classList.add('hidden');
  });

  // Game detail view
  document.getElementById('detail-back-btn')!.addEventListener('click', () => {
    showView(currentSystem ? 'games' : 'systems');
  });
  // Detail tab switching
  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.detailTab!;
      document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.detailTab === tabName));
      document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.id === `detail-tab-${tabName}`));
    });
  });

  // Controller modal
  $controllerBtn.addEventListener('click', () => {
    $controllerModal.classList.remove('hidden');
    updateControllerUI();
  });
  $closeModalBtn.addEventListener('click', () => $controllerModal.classList.add('hidden'));
  $controllerModal.addEventListener('click', e => {
    if (e.target === $controllerModal) $controllerModal.classList.add('hidden');
  });

  gamepadManager.on('connected', gp => { console.log(`Connected: ${gp.id} (${gp.profile})`); updateControllerUI(); updateHotkeyInputStatus(); });
  gamepadManager.on('disconnected', () => { updateControllerUI(); updateHotkeyInputStatus(); });

  // Modal polling (only for the quick-view modal, not settings)
  let modalPollId: number | null = null;
  const pollModal = () => {
    if ($controllerModal.classList.contains('hidden')) { modalPollId = null; return; }
    updateControllerUI();
    modalPollId = requestAnimationFrame(pollModal);
  };
  new MutationObserver(() => { if (!modalPollId && !$controllerModal.classList.contains('hidden')) modalPollId = requestAnimationFrame(pollModal); })
    .observe($controllerModal, { attributes: true, attributeFilter: ['class'] });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (mappingListeningFor) { stopListening(); return; }
      if (expandedCardIndex >= 0) {
        const card = $settingsControllerList.querySelector(`.controller-card[data-gp-index="${expandedCardIndex}"]`);
        if (card) card.classList.remove('expanded');
        expandedCardIndex = -1;
        closeMappingEditor();
        return;
      }
      if (!$controllerModal.classList.contains('hidden')) { $controllerModal.classList.add('hidden'); return; }
      if (!$kioskView.classList.contains('hidden')) { exitKioskMode(); return; }
      if ($detailView.classList.contains('active')) {
        showView(currentSystem ? 'games' : 'systems');
        return;
      }
      if ($playerView.classList.contains('active')) {
        cleanup();
        if (kioskWasActive) { returnToKiosk(); return; }
        if (currentDetailGame) { showView('detail'); return; }
        showView(currentSystem ? 'games' : 'systems');
        return;
      }
      if ($settingsView.classList.contains('active')) { stopControllerPoll(); showView('systems'); return; }
    }
  });
}

init();
