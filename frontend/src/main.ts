import {
  fetchSystems, fetchGames, fetchSettings, updateSettings, rescanRoms,
  fetchBiosStatus, browseDirs, fetchMetadata, scrapeArtSingle, scrapeInfoSingle, searchMedia,
  playtimeStart, playtimeEnd, fetchRecentPlaytime, fetchLastPlayed,
  listCollections, createCollection, updateCollection, deleteCollection,
  collectionAddGame, collectionRemoveGame,
  fetchGameConfig, saveGameConfig, fetchAlternateCores,
  fetchHiddenGames, saveHiddenGames, scanDuplicates,
  fetchVersion, fetchLogs, clearLogs, exportConfig, importConfig,
  bannerUrl, logoUrl, scrapeBanner, scrapeLogo,
  searchImages, uploadArt, applyArtUrl,
  uploadSystemArt, applySystemArtUrl, clearSystemArt,
  type SystemInfo, type GameInfo, type AppSettings, type GameMetadata, type MediaSearchResult,
  type PlaytimeStats, type Collection, type GameLaunchConfig,
  type DuplicateGroup, type LogEntry,
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
let activeMainTab: 'systems' | 'all-games' | 'favourites' | 'recent' | 'collections' = 'systems';

// ── Playtime tracking ────────────────────────────────────────────────
let currentPlaytimeSession: { gameId: string; startedAt: number } | null = null;
let recentPlaytimeCache: PlaytimeStats[] = [];
let lastPlayedCache: PlaytimeStats | null = null;

async function refreshPlaytimeCaches(): Promise<void> {
  try {
    [recentPlaytimeCache, lastPlayedCache] = await Promise.all([
      fetchRecentPlaytime(),
      fetchLastPlayed(),
    ]);
  } catch { /* offline ok */ }
}

function formatPlaytime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return '';
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

async function beginPlaytimeSession(game: GameInfo): Promise<void> {
  currentPlaytimeSession = { gameId: game.id, startedAt: Date.now() };
  await playtimeStart(game);
}

async function endPlaytimeSession(): Promise<void> {
  if (!currentPlaytimeSession) return;
  const duration = Math.max(0, Math.round((Date.now() - currentPlaytimeSession.startedAt) / 1000));
  const gameId = currentPlaytimeSession.gameId;
  const wasActive = currentPlaytimeSession;
  currentPlaytimeSession = null;
  if (duration >= 3) {
    await playtimeEnd(gameId, duration);
    await refreshPlaytimeCaches();
  }
  // Auto-backup saves on exit
  if (settings?.auto_backup_saves) {
    currentPlaytimeSession = wasActive; // temporarily restore for rollingBackupAllSaves
    rollingBackupAllSaves();
    currentPlaytimeSession = null;
  }
  // Refresh resume bar
  renderResumeBar();
}

// ── Collections cache ────────────────────────────────────────────────
let collectionsCache: Collection[] = [];
let hiddenGameIds: Set<string> = new Set();

async function refreshHiddenGames(): Promise<void> {
  try {
    const ids = await fetchHiddenGames();
    hiddenGameIds = new Set(ids);
  } catch { /* ignore */ }
}

async function refreshCollections(): Promise<void> {
  try { collectionsCache = await listCollections(); }
  catch { /* ignore */ }
}

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
const $sgdbKeyInput = $('sgdb-key-input') as HTMLInputElement;
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
  const wasPlayer = $playerView.classList.contains('active');
  $systemsView.classList.toggle('active', view === 'systems');
  $gamesView.classList.toggle('active', view === 'games');
  $detailView.classList.toggle('active', view === 'detail');
  $playerView.classList.toggle('active', view === 'player');
  $settingsView.classList.toggle('active', view === 'settings');
  if (view !== 'player') { cleanup(); stopHotkeyPolling(); }
  if (view === 'player') startHotkeyPolling();
  // End playtime session when leaving player view
  if (wasPlayer && view !== 'player' && currentPlaytimeSession) {
    void endPlaytimeSession();
  }
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
  $systemsGrid.innerHTML = list.map(sys => {
    const icon = SYSTEM_ICONS[sys.id] || '🎲';
    const hasCover = !!sys.cover_image;
    const cover = hasCover
      ? `<img class="system-card-img" src="${sys.cover_image}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-cover')" />`
      : '';
    return `
    <div class="system-card ${hasCover ? '' : 'no-cover'}" data-system-id="${sys.id}">
      <div class="system-card-cover">
        ${cover}
        <div class="system-card-fallback">${icon}</div>
        <div class="system-card-gradient"></div>
        <button class="system-card-edit-btn" title="Edit art" data-edit-system="${esc(sys.id)}">&#9999;&#65039;</button>
      </div>
      <div class="system-card-body">
        <div class="system-name">${esc(sys.name)}</div>
        <div class="system-card-foot">
          <span class="system-id">${esc(sys.id)}</span>
          <span class="system-count">${sys.game_count} games</span>
        </div>
      </div>
    </div>
  `;
  }).join('');

  $systemsGrid.querySelectorAll('.system-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.system-card-edit-btn')) return;
      const id = (card as HTMLElement).dataset.systemId!;
      const sys = systems.find(s => s.id === id);
      if (sys) openSystem(sys);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = (card as HTMLElement).dataset.systemId!;
      const sys = systems.find(s => s.id === id);
      if (sys) openEditArt({ kind: 'system', system: sys });
    });
  });
  $systemsGrid.querySelectorAll<HTMLButtonElement>('.system-card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.editSystem!;
      const sys = systems.find(s => s.id === id);
      if (sys) openEditArt({ kind: 'system', system: sys });
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
        <button class="game-card-edit-btn" data-edit-game-idx="${idx}" title="Edit art">&#9999;&#65039;</button>
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
      const t = e.target as HTMLElement;
      if (t.closest('.fav-btn') || t.closest('.game-card-edit-btn')) return;
      const idx = parseInt((card as HTMLElement).dataset.gameIdx!, 10);
      const game = list[idx];
      if (game) openGameDetail(game);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt((card as HTMLElement).dataset.gameIdx!, 10);
      const game = list[idx];
      if (game) openGameCardMenu(game, e as MouseEvent);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('.game-card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.editGameIdx!, 10);
      const game = list[idx];
      if (game) openEditArt({ kind: 'game', game });
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

// ── Duplicate Detection UI ─────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderDuplicateGroupsHTML(groups: DuplicateGroup[]): string {
  if (groups.length === 0) return '<p class="setting-hint">No duplicates found.</p>';
  return groups.map(g => `
    <div class="dupe-group">
      <div class="dupe-group-header">
        <span>Hash: <code>${esc(g.hash)}</code></span>
        <span>${formatBytes(g.size)}</span>
        <span>${g.games.length} copies</span>
      </div>
      <div class="dupe-games">
        ${g.games.map(game => `
          <div class="dupe-row">
            <span class="dupe-system">${esc(game.system)}</span>
            <span class="dupe-file" title="${esc(game.file)}">${esc(game.name)}</span>
            <button class="action-btn sm dupe-hide-btn" data-id="${esc(game.id)}">Hide</button>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function wireDuplicateRemoveButtons(container: HTMLElement) {
  container.querySelectorAll('.dupe-hide-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      hiddenGameIds.add(id);
      await saveHiddenGames(Array.from(hiddenGameIds));
      (btn as HTMLButtonElement).disabled = true;
      btn.textContent = 'Hidden';
    });
  });
}

// ── Game card context menu ─────────────────────────────────────────

let openMenu: HTMLElement | null = null;

function closeGameCardMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

function openGameCardMenu(game: GameInfo, ev: MouseEvent) {
  closeGameCardMenu();
  const menu = document.createElement('div');
  menu.className = 'game-card-menu';
  menu.style.left = `${ev.clientX}px`;
  menu.style.top = `${ev.clientY}px`;

  const hidden = hiddenGameIds.has(game.id);
  const inCollections = collectionsCache.filter(c => c.game_ids.includes(game.id));

  let html = `<div class="menu-section">${esc(game.name)}</div>`;
  html += `<button class="menu-item" data-action="play">&#9654; Play</button>`;
  html += `<button class="menu-item" data-action="detail">&#9432; View Details</button>`;
  html += `<button class="menu-item" data-action="edit-art">&#9999;&#65039; Edit Art</button>`;
  html += `<div class="menu-divider"></div>`;
  html += `<div class="menu-section">Collections</div>`;
  if (collectionsCache.length === 0) {
    html += `<button class="menu-item" data-action="no-collections" disabled style="color:var(--text-dim);">No collections yet</button>`;
  } else {
    collectionsCache.forEach(c => {
      const inIt = c.game_ids.includes(game.id);
      html += `<button class="menu-item" data-action="toggle-collection" data-col="${esc(c.id)}">
        ${inIt ? '&#10003; ' : ''}${esc(c.icon || '📁')} ${esc(c.name)}
      </button>`;
    });
  }
  html += `<div class="menu-divider"></div>`;
  html += `<button class="menu-item" data-action="toggle-hide">${hidden ? '&#128065; Unhide' : '&#128276; Hide from library'}</button>`;
  if (inCollections.length > 0) {
    html += `<button class="menu-item" data-action="remove-from-all">&#10005; Remove from all collections</button>`;
  }

  menu.innerHTML = html;
  document.body.appendChild(menu);
  openMenu = menu;

  // Keep menu in viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  menu.querySelectorAll('.menu-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'play') playGame(game);
      else if (action === 'detail') openGameDetail(game);
      else if (action === 'edit-art') openEditArt({ kind: 'game', game });
      else if (action === 'toggle-collection') {
        const colId = (btn as HTMLElement).dataset.col!;
        const col = collectionsCache.find(c => c.id === colId);
        if (col?.game_ids.includes(game.id)) {
          await collectionRemoveGame(colId, game.id);
        } else {
          await collectionAddGame(colId, game.id);
        }
        await refreshCollections();
        if (activeMainTab === 'collections') renderCollectionsTab();
      } else if (action === 'toggle-hide') {
        if (hidden) hiddenGameIds.delete(game.id);
        else hiddenGameIds.add(game.id);
        await saveHiddenGames(Array.from(hiddenGameIds));
        if (activeMainTab === 'all-games') renderAllGamesTab();
        if (activeMainTab === 'systems' && currentSystem) {
          currentGames = await fetchGames(currentSystem.id);
          renderGames(currentGames);
        }
      } else if (action === 'remove-from-all') {
        for (const c of inCollections) await collectionRemoveGame(c.id, game.id);
        await refreshCollections();
        if (activeMainTab === 'collections') renderCollectionsTab();
      }
      closeGameCardMenu();
    });
  });
}

// Close menu on outside click / escape
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeGameCardMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGameCardMenu();
});

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
    case 'playtime': {
      const ptMap = new Map(recentPlaytimeCache.map(s => [s.game_id, s.total_seconds]));
      sorted.sort((a, b) => (ptMap.get(b.id) || 0) - (ptMap.get(a.id) || 0) || a.name.localeCompare(b.name));
      break;
    }
    case 'last-played': {
      const lpMap = new Map(recentPlaytimeCache.map(s => [s.game_id, s.last_played_at]));
      sorted.sort((a, b) => (lpMap.get(b.id) || 0) - (lpMap.get(a.id) || 0) || a.name.localeCompare(b.name));
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
  if (tabId === 'recent') renderRecentTab();
  if (tabId === 'collections') renderCollectionsTab();
}

// ── Recently Played tab ─────────────────────────────────────────────

let recentSearchQuery = '';

async function renderRecentTab() {
  const $grid = document.getElementById('recent-games-grid')!;
  const $count = document.getElementById('recent-games-count')!;
  const $empty = document.getElementById('recent-empty')!;
  await refreshPlaytimeCaches();

  let entries = recentPlaytimeCache;
  if (recentSearchQuery) {
    const q = recentSearchQuery.toLowerCase();
    entries = entries.filter(e => e.name.toLowerCase().includes(q));
  }

  $count.textContent = `${entries.length} games`;
  $empty.classList.toggle('hidden', entries.length > 0);
  $grid.classList.toggle('hidden', entries.length === 0);

  $grid.innerHTML = entries.map((stat, i) => {
    const game = findGameById(stat.game_id);
    const sysName = systems.find(s => s.id === stat.system)?.name || stat.system;
    const img = game?.image_path
      ? `<img src="${game.image_path}" alt="${esc(stat.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>🎮</div>'" />`
      : `<div class="placeholder">🎮</div>`;
    return `
      <div class="game-card recent-card" data-game-id="${esc(stat.game_id)}" data-idx="${i}">
        <div class="game-image">${img}</div>
        <div class="game-info">
          <div class="game-title">${esc(stat.name)}</div>
          <div class="game-system-tag">${esc(sysName)}</div>
          <div class="recent-meta">
            <span>${formatPlaytime(stat.total_seconds)}</span>
            <span class="recent-sep">·</span>
            <span>${formatTimeAgo(stat.last_played_at)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  $grid.querySelectorAll('.recent-card').forEach(card => {
    card.addEventListener('click', () => {
      const gameId = (card as HTMLElement).dataset.gameId!;
      const game = findGameById(gameId);
      if (game) openGameDetail(game);
    });
  });
}

function findGameById(gameId: string): GameInfo | null {
  const found = allGamesCache.find(g => g.id === gameId);
  if (found) return found;
  // Fallback: derive a minimal GameInfo
  const [system, file] = gameId.split(':');
  if (!system || !file) return null;
  return { id: gameId, name: file.replace(/\.[^.]+$/, ''), file, system, has_image: false, image_path: null };
}

// ── Collections tab ────────────────────────────────────────────────

async function renderCollectionsTab() {
  const $list = document.getElementById('collections-list')!;
  const $empty = document.getElementById('collections-empty')!;
  const $count = document.getElementById('collections-count')!;
  await refreshCollections();

  $count.textContent = `${collectionsCache.length} collections`;
  $empty.classList.toggle('hidden', collectionsCache.length > 0);

  $list.innerHTML = collectionsCache.map(col => `
    <div class="collection-section" data-collection-id="${esc(col.id)}">
      <div class="collection-header">
        <span class="collection-icon">${esc(col.icon || '📁')}</span>
        <span class="collection-name">${esc(col.name)}</span>
        <span class="collection-count">${col.game_ids.length} games</span>
        <button class="action-btn sm collection-rename-btn" data-id="${esc(col.id)}">Rename</button>
        <button class="action-btn sm danger collection-delete-btn" data-id="${esc(col.id)}">Delete</button>
      </div>
      <div class="games-grid collection-games" data-id="${esc(col.id)}"></div>
    </div>
  `).join('');

  // Render games per collection
  collectionsCache.forEach(col => {
    const container = $list.querySelector(`.collection-games[data-id="${col.id}"]`) as HTMLElement | null;
    if (!container) return;
    const games = col.game_ids.map(id => findGameById(id)).filter((g): g is GameInfo => g !== null);
    if (games.length === 0) {
      container.innerHTML = '<div class="collection-empty">Empty. Right-click a game card to add it.</div>';
      return;
    }
    container.innerHTML = games.map((g, i) => buildGameCardHTML(g, i, true)).join('');
    attachGameCardEvents(container, games);
  });

  $list.querySelectorAll('.collection-rename-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      const col = collectionsCache.find(c => c.id === id);
      const newName = prompt('Rename collection', col?.name || '');
      if (newName && newName.trim()) {
        await updateCollection(id, { name: newName.trim() });
        renderCollectionsTab();
      }
    });
  });
  $list.querySelectorAll('.collection-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      const col = collectionsCache.find(c => c.id === id);
      if (confirm(`Delete collection "${col?.name}"?`)) {
        await deleteCollection(id);
        renderCollectionsTab();
      }
    });
  });
}

// ── Resume bar (Continue last game) ───────────────────────────────

async function renderResumeBar() {
  const $bar = document.getElementById('resume-bar')!;
  const $cover = document.getElementById('resume-bar-cover')!;
  const $title = document.getElementById('resume-bar-title')!;
  const $meta = document.getElementById('resume-bar-meta')!;
  const $play = document.getElementById('resume-bar-play')!;
  if (!lastPlayedCache) {
    $bar.classList.add('hidden');
    return;
  }
  const stat = lastPlayedCache;
  const game = findGameById(stat.game_id);
  const sysName = systems.find(s => s.id === stat.system)?.name || stat.system;
  $cover.innerHTML = game?.image_path
    ? `<img src="${game.image_path}" alt="${esc(stat.name)}" />`
    : `<div class="placeholder">🎮</div>`;
  $title.textContent = stat.name;
  $meta.textContent = `${sysName} · Played ${formatPlaytime(stat.total_seconds)} · ${formatTimeAgo(stat.last_played_at)}`;
  $bar.classList.remove('hidden');
  $play.onclick = () => {
    if (!game) return;
    playGame(game);
  };
}

let allGamesSearchQuery = '';
type ViewMode = 'grid' | 'list';
let allGamesViewMode: ViewMode = (localStorage.getItem('allGamesViewMode') as ViewMode) || 'grid';

function buildGameRowHTML(game: GameInfo, idx: number): string {
  const fav = isFavourite(game.id);
  const sysName = systems.find(s => s.id === game.system)?.name || game.system;
  const pt = recentPlaytimeCache.find(s => s.game_id === game.id);
  const ptStr = pt ? formatPlaytime(pt.total_seconds) : '';
  const lpStr = pt?.last_played_at ? formatTimeAgo(pt.last_played_at) : '';
  return `
    <div class="game-row" data-game-idx="${idx}">
      <div class="game-row-thumb">
        ${game.image_path
          ? `<img src="${game.image_path}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>🎮</div>'" />`
          : `<div class="placeholder">🎮</div>`}
      </div>
      <div class="game-row-name" title="${esc(game.name)}">${esc(game.name)}</div>
      <div class="game-row-system">${esc(sysName)}</div>
      <div class="game-row-playtime">${ptStr}</div>
      <div class="game-row-last">${lpStr}</div>
      <div class="game-row-actions">
        <button class="row-fav-btn${fav ? ' active' : ''}" data-game-id="${esc(game.id)}" title="${fav ? 'Remove favourite' : 'Add favourite'}">${fav ? '&#9829;' : '&#9825;'}</button>
        <button class="row-edit-btn" data-edit-game-idx="${idx}" title="Edit art">&#9999;&#65039;</button>
        <button class="row-play-btn" data-play-game-idx="${idx}" title="Play">&#9654;</button>
      </div>
    </div>`;
}

function attachGameRowEvents(container: HTMLElement, list: GameInfo[]) {
  container.querySelectorAll('.game-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.row-fav-btn') || t.closest('.row-edit-btn') || t.closest('.row-play-btn')) return;
      const idx = parseInt((row as HTMLElement).dataset.gameIdx!, 10);
      const game = list[idx];
      if (game) openGameDetail(game);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt((row as HTMLElement).dataset.gameIdx!, 10);
      const game = list[idx];
      if (game) openGameCardMenu(game, e as MouseEvent);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('.row-fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gameId = btn.dataset.gameId!;
      const nowFav = toggleFavourite(gameId);
      btn.classList.toggle('active', nowFav);
      btn.innerHTML = nowFav ? '&#9829;' : '&#9825;';
      btn.title = nowFav ? 'Remove favourite' : 'Add favourite';
      if (activeMainTab === 'favourites') renderFavouritesTab();
    });
  });
  container.querySelectorAll<HTMLButtonElement>('.row-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.editGameIdx!, 10);
      const game = list[idx];
      if (game) openEditArt({ kind: 'game', game });
    });
  });
  container.querySelectorAll<HTMLButtonElement>('.row-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.playGameIdx!, 10);
      const game = list[idx];
      if (game) playGame(game);
    });
  });
}

async function renderAllGamesTab() {
  const $grid = document.getElementById('all-games-grid')!;
  const $count = document.getElementById('all-games-count')!;
  const $sort = document.getElementById('all-games-sort') as HTMLSelectElement;
  const $filter = document.getElementById('all-games-system-filter') as HTMLSelectElement;
  const $showHidden = document.getElementById('show-hidden-toggle') as HTMLInputElement | null;

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

  // Hidden filtering (server already filters by default; toggle re-fetches with include_hidden)
  if ($showHidden?.checked) {
    // Backend filters hidden by default. To show hidden, ask for them inline:
    // simpler approach — locally include the hidden ids by re-fetching with include_hidden flag.
    // We don't re-fetch here; allGamesCache might already exclude hidden.
    // If hidden games not present in cache, refetch including hidden:
    if (hiddenGameIds.size > 0 && !filtered.some(g => hiddenGameIds.has(g.id))) {
      try {
        const full = await fetch(`/api/games?include_hidden=true`).then(r => r.json());
        allGamesCache = full;
        filtered = systemFilter ? full.filter((g: GameInfo) => g.system === systemFilter) : full;
      } catch { /* keep current */ }
    }
  } else if (hiddenGameIds.size > 0) {
    filtered = filtered.filter(g => !hiddenGameIds.has(g.id));
  }

  // Smart search (fuzzy)
  if (allGamesSearchQuery) {
    filtered = fuzzyFilterGames(filtered, allGamesSearchQuery);
  }

  const sorted = allGamesSearchQuery ? filtered : sortGames(filtered, $sort.value);
  $count.textContent = allGamesSearchQuery
    ? `${sorted.length} match`
    : `${sorted.length} games`;

  if (allGamesViewMode === 'list') {
    unmountVirtualGameGrid($grid);
    $grid.classList.remove('games-grid');
    $grid.classList.add('games-list');
    $grid.innerHTML = `
      <div class="game-list-header">
        <div></div>
        <div>Name</div>
        <div>System</div>
        <div>Playtime</div>
        <div>Last Played</div>
        <div></div>
      </div>
    ` + sorted.map((game, i) => buildGameRowHTML(game, i)).join('');
    attachGameRowEvents($grid, sorted);
    return;
  }

  $grid.classList.remove('games-list');
  $grid.classList.add('games-grid');
  // Virtualized for large libraries (>200 cards), simple render otherwise
  if (sorted.length > 200) {
    mountVirtualGameGrid($grid, sorted, true);
  } else {
    unmountVirtualGameGrid($grid);
    $grid.innerHTML = sorted.map((game, i) => buildGameCardHTML(game, i, true)).join('');
    attachGameCardEvents($grid, sorted);
  }
}

// ── Virtualized Game Grid ───────────────────────────────────────────────
//
// For libraries with thousands of games. Renders only the rows currently in view
// plus a buffer above/below. Reads card dimensions from the live grid CSS so the
// layout exactly matches the non-virtualized case.

interface VirtualGridState {
  scrollHandler: () => void;
  resizeObserver: ResizeObserver;
  games: GameInfo[];
  showSystem: boolean;
  rowHeight: number;
  cols: number;
  rafId: number | null;
  scrollTargets: EventTarget[];
  lastWidth: number;
}

const virtualGridState: WeakMap<HTMLElement, VirtualGridState> = new WeakMap();

function measureGridCols(container: HTMLElement): { cols: number; rowHeight: number; cardWidth: number } {
  // Probe with TWO dummy cards in a fresh grid so column flow is correct and
  // existing children (e.g. a tall virtual spacer) can't inflate row height via stretch.
  // We use a sibling sandbox that mirrors the games-grid CSS but is isolated from
  // any prior virtualization state.
  const sandbox = document.createElement('div');
  sandbox.className = 'games-grid';
  sandbox.style.cssText = 'visibility:hidden;position:absolute;top:0;left:0;width:' + container.clientWidth + 'px;pointer-events:none;';
  const probe = document.createElement('div');
  probe.className = 'game-card';
  probe.innerHTML = '<div class="game-image"><div class="placeholder">x</div></div><div class="game-info"><div class="game-title">x</div></div>';
  sandbox.appendChild(probe);
  // Insert sandbox adjacent to container so it inherits parent context (fonts, etc.)
  container.parentElement!.appendChild(sandbox);
  const cardRect = probe.getBoundingClientRect();
  const cardWidth = cardRect.width || 160;
  const cardHeight = cardRect.height || 220;
  const sandboxStyle = getComputedStyle(sandbox);
  const gap = parseFloat(sandboxStyle.gap) || 14;
  sandbox.remove();

  const containerWidth = container.clientWidth;
  const cols = Math.max(1, Math.floor((containerWidth + gap) / (cardWidth + gap)));
  const rowHeight = cardHeight + gap;
  return { cols, rowHeight, cardWidth };
}

function mountVirtualGameGrid(container: HTMLElement, games: GameInfo[], showSystem: boolean) {
  // Tear down previous state if any (also clears innerHTML so leftover spacer can't bias measurement)
  unmountVirtualGameGrid(container);
  container.innerHTML = '';

  const initialWidth = container.clientWidth;
  const { cols, rowHeight } = measureGridCols(container);
  container.classList.add('virtual-grid');

  const totalRows = Math.ceil(games.length / cols);
  const totalHeight = totalRows * rowHeight;

  // Spacer creates scroll height
  const spacer = document.createElement('div');
  spacer.className = 'virtual-grid-spacer';
  spacer.style.height = `${totalHeight}px`;
  container.appendChild(spacer);

  // Window holds visible cards (absolutely positioned within container)
  const win = document.createElement('div');
  win.className = 'virtual-grid-window';
  container.appendChild(win);

  // Scroll container is the nearest scrollable parent. For document-level scroll
  // it can be documentElement, body, or both — we listen on every plausible target.
  const scroller = findScroller(container);
  const isDocLevel = scroller === document.scrollingElement
    || scroller === document.documentElement
    || scroller === document.body;
  // Bundle all event targets that might fire scroll for the document scroller.
  const scrollTargets: EventTarget[] = isDocLevel
    ? [window, document, document.documentElement, document.body]
    : [scroller];
  const state: VirtualGridState = {
    scrollHandler: () => scheduleRender(),
    resizeObserver: new ResizeObserver((entries) => {
      // Only re-mount when WIDTH changes (cols depend on width).
      // Height changes from adding the spacer would otherwise create an infinite remount loop.
      const w = entries[0]?.contentRect.width ?? container.clientWidth;
      if (Math.abs(w - state.lastWidth) > 1) {
        state.lastWidth = w;
        mountVirtualGameGrid(container, games, showSystem);
      }
    }),
    games, showSystem, rowHeight, cols, rafId: null,
    scrollTargets,
    lastWidth: initialWidth,
  };
  virtualGridState.set(container, state);

  function scheduleRender() {
    if (state.rafId !== null) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      render();
    });
  }

  function render() {
    const containerRect = container.getBoundingClientRect();
    // Position of the visible window within container coords
    let visibleTop: number;
    let visibleHeight: number;
    if (isDocLevel) {
      // Page-level scroll: container's top moves negative as user scrolls past it.
      // visibleHeight is always the viewport height regardless of which element is the actual scroller.
      visibleTop = Math.max(0, -containerRect.top);
      visibleHeight = window.innerHeight;
    } else {
      const scrollerRect = scroller.getBoundingClientRect();
      visibleTop = Math.max(0, scrollerRect.top - containerRect.top);
      visibleHeight = scroller.clientHeight;
    }
    const visibleBottom = visibleTop + visibleHeight;
    const startRow = Math.max(0, Math.floor(visibleTop / rowHeight) - 2);
    const endRow = Math.min(totalRows, Math.ceil(visibleBottom / rowHeight) + 2);
    const startIdx = startRow * cols;
    const endIdx = Math.min(games.length, endRow * cols);

    win.style.position = 'absolute';
    win.style.left = '0';
    win.style.right = '0';
    win.style.top = `${startRow * rowHeight}px`;
    win.style.display = 'grid';
    win.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    win.style.gap = getComputedStyle(container).gap;

    const slice = games.slice(startIdx, endIdx);
    win.innerHTML = slice.map((g, i) => buildGameCardHTML(g, startIdx + i, showSystem)).join('');
    attachGameCardEvents(win, games);
  }

  scrollTargets.forEach(t => t.addEventListener('scroll', state.scrollHandler, { passive: true }));
  window.addEventListener('resize', state.scrollHandler);
  state.resizeObserver.observe(container);
  render();
}

function unmountVirtualGameGrid(container: HTMLElement) {
  const state = virtualGridState.get(container);
  if (!state) return;
  state.scrollTargets.forEach(t => t.removeEventListener('scroll', state.scrollHandler));
  window.removeEventListener('resize', state.scrollHandler);
  state.resizeObserver.disconnect();
  if (state.rafId !== null) cancelAnimationFrame(state.rafId);
  virtualGridState.delete(container);
  container.classList.remove('virtual-grid');
}

function findScroller(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const oy = style.overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement || document.documentElement;
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
  void beginPlaytimeSession(game);
  void launchGameWithConfig(game, sys, 'emulator-container');
}

async function launchGameWithConfig(game: GameInfo, sys: SystemInfo, containerId: string) {
  let override: GameLaunchConfig = {};
  try { override = await fetchGameConfig(game.system, game.file); }
  catch { /* ignore */ }
  const sysToUse: SystemInfo = override.core ? { ...sys, core: override.core } : sys;
  launchGame(game, sysToUse, containerId);
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

// ── Edit Art Modal ──────────────────────────────────────────────────

type EditArtTarget =
  | { kind: 'game'; game: GameInfo }
  | { kind: 'system'; system: SystemInfo };

let editArtTarget: EditArtTarget | null = null;
let editArtSearched = false;

function setEditArtStatus(elId: string, msg: string, kind: '' | 'success' | 'error' = '') {
  const $el = document.getElementById(elId)!;
  $el.textContent = msg;
  $el.classList.remove('success', 'error');
  if (kind) $el.classList.add(kind);
}

function setEditArtCurrentPreview(url: string | null) {
  const $preview = document.getElementById('edit-art-current-preview')!;
  if (url) {
    $preview.innerHTML = `<img src="${url}" alt="" onerror="this.parentElement.innerHTML='<div class=\\'placeholder\\'>&#127918;</div>'" />`;
  } else {
    $preview.innerHTML = '<div class="placeholder">&#127918;</div>';
  }
}

function defaultEditArtQuery(): string {
  if (!editArtTarget) return '';
  if (editArtTarget.kind === 'game') {
    return `${editArtTarget.game.name} ${editArtTarget.game.system} box art`;
  }
  return `${editArtTarget.system.name} console logo`;
}

function openEditArt(target: EditArtTarget) {
  editArtTarget = target;
  editArtSearched = false;

  const $modal = document.getElementById('edit-art-modal')!;
  const $title = document.getElementById('edit-art-title')!;
  const $searchInput = document.getElementById('edit-art-search-input') as HTMLInputElement;
  const $urlInput = document.getElementById('edit-art-url-input') as HTMLInputElement;
  const $googleLink = document.getElementById('edit-art-google-link') as HTMLAnchorElement;
  const $results = document.getElementById('edit-art-search-results')!;
  const $resetTab = document.getElementById('edit-art-tab-reset')!;
  const $resetHint = document.getElementById('edit-art-reset-hint')!;

  // Title + current preview
  if (target.kind === 'game') {
    $title.textContent = `Edit Art: ${target.game.name}`;
    setEditArtCurrentPreview(target.game.image_path);
    // Reset tab only makes sense for system (remove override). Hide for games.
    $resetTab.classList.add('hidden');
    $resetHint.textContent = '';
  } else {
    $title.textContent = `Edit Art: ${target.system.name}`;
    setEditArtCurrentPreview(target.system.cover_image);
    $resetTab.classList.remove('hidden');
    $resetHint.textContent = 'Remove the custom system art override and revert to the auto-picked cover.';
  }

  // Reset inputs/state
  $searchInput.value = defaultEditArtQuery();
  $urlInput.value = '';
  $results.innerHTML = '';
  setEditArtStatus('edit-art-search-status', '');
  setEditArtStatus('edit-art-upload-status', '');
  setEditArtStatus('edit-art-url-status', '');
  setEditArtStatus('edit-art-reset-status', '');

  // Default to search tab
  document.querySelectorAll('.edit-art-tab').forEach(t => {
    t.classList.toggle('active', (t as HTMLElement).dataset.editArtTab === 'search');
  });
  document.querySelectorAll('.edit-art-tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'edit-art-tab-search');
  });

  // Google fallback link
  $googleLink.href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(defaultEditArtQuery())}`;

  $modal.classList.remove('hidden');
  setTimeout(() => $searchInput.focus(), 50);
}

function closeEditArt() {
  document.getElementById('edit-art-modal')!.classList.add('hidden');
  editArtTarget = null;
}

async function runEditArtSearch() {
  if (!editArtTarget) return;
  const $input = document.getElementById('edit-art-search-input') as HTMLInputElement;
  const $results = document.getElementById('edit-art-search-results')!;
  const $googleLink = document.getElementById('edit-art-google-link') as HTMLAnchorElement;
  const query = $input.value.trim();
  if (!query) {
    setEditArtStatus('edit-art-search-status', 'Enter a search query.', 'error');
    return;
  }
  $googleLink.href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
  setEditArtStatus('edit-art-search-status', 'Searching...');
  $results.innerHTML = '';
  try {
    const res = await searchImages(query);
    editArtSearched = true;
    if (!res.ok || res.image_urls.length === 0) {
      setEditArtStatus('edit-art-search-status', 'No results. Try a different query or use the URL tab.', 'error');
      return;
    }
    setEditArtStatus('edit-art-search-status', `${res.image_urls.length} results — click one to apply.`, 'success');
    $results.innerHTML = res.image_urls.map((r, i) => `
      <div class="img-result" data-idx="${i}" title="${esc(r.title || r.source || '')}">
        <img src="${esc(r.thumbnail || r.image)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.style.opacity='0.2'" />
        <div class="img-result-title">${esc(r.title || r.source || '')}</div>
      </div>
    `).join('');
    $results.querySelectorAll('.img-result').forEach(el => {
      el.addEventListener('click', async () => {
        const idx = parseInt((el as HTMLElement).dataset.idx!, 10);
        const hit = res.image_urls[idx];
        if (!hit) return;
        await applyEditArtFromUrl(hit.image, el as HTMLElement);
      });
    });
  } catch (e: any) {
    setEditArtStatus('edit-art-search-status', `Search failed: ${e?.message || e}`, 'error');
  }
}

async function applyEditArtFromUrl(url: string, sourceEl?: HTMLElement) {
  if (!editArtTarget) return;
  if (sourceEl) sourceEl.classList.add('applying');
  const target = editArtTarget;
  const statusEl = sourceEl ? 'edit-art-search-status' : 'edit-art-url-status';
  setEditArtStatus(statusEl, 'Applying...');
  try {
    if (target.kind === 'game') {
      const res = await applyArtUrl(target.game.system, target.game.file, url);
      if (res.ok && res.image_path) {
        const cacheBust = `${res.image_path}?t=${Date.now()}`;
        target.game.image_path = res.image_path;
        target.game.has_image = true;
        setEditArtCurrentPreview(cacheBust);
        setEditArtStatus(statusEl, 'Applied!', 'success');
        afterArtChanged(target);
      } else {
        setEditArtStatus(statusEl, `Failed: ${res.message || 'unknown'}`, 'error');
      }
    } else {
      const res = await applySystemArtUrl(target.system.id, url);
      if (res.ok && res.cover_image) {
        const cacheBust = `${res.cover_image}?t=${Date.now()}`;
        target.system.cover_image = res.cover_image;
        setEditArtCurrentPreview(cacheBust);
        setEditArtStatus(statusEl, 'Applied!', 'success');
        afterArtChanged(target);
      } else {
        setEditArtStatus(statusEl, `Failed: ${res.message || 'unknown'}`, 'error');
      }
    }
  } catch (e: any) {
    setEditArtStatus(statusEl, `Failed: ${e?.message || e}`, 'error');
  }
  if (sourceEl) sourceEl.classList.remove('applying');
}

async function applyEditArtFromBlob(blob: Blob) {
  if (!editArtTarget) return;
  const target = editArtTarget;
  setEditArtStatus('edit-art-upload-status', 'Uploading...');
  try {
    if (target.kind === 'game') {
      const res = await uploadArt(target.game.system, target.game.file, blob);
      if (res.ok && res.image_path) {
        const cacheBust = `${res.image_path}?t=${Date.now()}`;
        target.game.image_path = res.image_path;
        target.game.has_image = true;
        setEditArtCurrentPreview(cacheBust);
        setEditArtStatus('edit-art-upload-status', 'Uploaded!', 'success');
        afterArtChanged(target);
      } else {
        setEditArtStatus('edit-art-upload-status', `Failed: ${res.message || 'unknown'}`, 'error');
      }
    } else {
      const res = await uploadSystemArt(target.system.id, blob);
      if (res.ok && res.cover_image) {
        const cacheBust = `${res.cover_image}?t=${Date.now()}`;
        target.system.cover_image = res.cover_image;
        setEditArtCurrentPreview(cacheBust);
        setEditArtStatus('edit-art-upload-status', 'Uploaded!', 'success');
        afterArtChanged(target);
      } else {
        setEditArtStatus('edit-art-upload-status', `Failed: ${res.message || 'unknown'}`, 'error');
      }
    }
  } catch (e: any) {
    setEditArtStatus('edit-art-upload-status', `Failed: ${e?.message || e}`, 'error');
  }
}

async function resetSystemArt() {
  if (!editArtTarget || editArtTarget.kind !== 'system') return;
  const target = editArtTarget;
  setEditArtStatus('edit-art-reset-status', 'Removing...');
  try {
    const res = await clearSystemArt(target.system.id);
    if (res.ok) {
      // Refresh systems and update preview to the new auto-picked cover
      try {
        systems = await fetchSystems();
        const updated = systems.find(s => s.id === target.system.id);
        if (updated) {
          target.system.cover_image = updated.cover_image;
          setEditArtCurrentPreview(updated.cover_image);
        }
      } catch { /* ignore */ }
      setEditArtStatus('edit-art-reset-status', res.removed ? 'Removed.' : 'No custom art was set.', 'success');
      afterArtChanged(target);
    } else {
      setEditArtStatus('edit-art-reset-status', 'Failed to remove.', 'error');
    }
  } catch (e: any) {
    setEditArtStatus('edit-art-reset-status', `Failed: ${e?.message || e}`, 'error');
  }
}

function afterArtChanged(target: EditArtTarget) {
  // Refresh visible views so the new art shows up immediately.
  if (target.kind === 'game') {
    // If detail view is showing this game, update cover + backdrop
    if (currentDetailGame && currentDetailGame.id === target.game.id) {
      const $cover = document.getElementById('detail-cover');
      const $backdropImg = document.getElementById('detail-backdrop-img') as HTMLImageElement | null;
      if ($cover && target.game.image_path) {
        const bust = `${target.game.image_path}?t=${Date.now()}`;
        $cover.innerHTML = `<img src="${bust}" alt="${esc(target.game.name)}" />`;
        if ($backdropImg) {
          $backdropImg.src = bust;
          $backdropImg.onload = () => $backdropImg.classList.add('loaded');
        }
      }
    }
    // Refresh visible game grids
    const cards = document.querySelectorAll<HTMLImageElement>('.game-card img');
    cards.forEach(img => {
      if (img.alt === target.game.name && target.game.image_path) {
        img.src = `${target.game.image_path}?t=${Date.now()}`;
      }
    });
  } else {
    // System: re-render systems grid if it's mounted
    try { renderSystems(systems); } catch { /* ignore */ }
  }
}

function initEditArtModal() {
  const $modal = document.getElementById('edit-art-modal')!;
  const $close = document.getElementById('edit-art-close-btn')!;
  $close.addEventListener('click', closeEditArt);
  $modal.addEventListener('click', (e) => { if (e.target === $modal) closeEditArt(); });

  // Tabs
  document.querySelectorAll('.edit-art-tab').forEach(t => {
    t.addEventListener('click', () => {
      const tab = (t as HTMLElement).dataset.editArtTab!;
      document.querySelectorAll('.edit-art-tab').forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.editArtTab === tab));
      document.querySelectorAll('.edit-art-tab-content').forEach(c => c.classList.toggle('active', c.id === `edit-art-tab-${tab}`));
      // Auto-run first search when switching into search tab if not searched yet
      if (tab === 'search' && !editArtSearched) {
        runEditArtSearch();
      }
    });
  });

  // Search
  document.getElementById('edit-art-search-btn')!.addEventListener('click', runEditArtSearch);
  const $searchInput = document.getElementById('edit-art-search-input') as HTMLInputElement;
  $searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runEditArtSearch(); });

  // URL apply
  document.getElementById('edit-art-url-btn')!.addEventListener('click', () => {
    const $input = document.getElementById('edit-art-url-input') as HTMLInputElement;
    const url = $input.value.trim();
    if (!url) { setEditArtStatus('edit-art-url-status', 'Paste an image URL first.', 'error'); return; }
    applyEditArtFromUrl(url);
  });
  const $urlInput = document.getElementById('edit-art-url-input') as HTMLInputElement;
  $urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('edit-art-url-btn')!.click();
  });

  // Upload (file input + drag/drop)
  const $drop = document.getElementById('edit-art-drop')!;
  const $file = document.getElementById('edit-art-file') as HTMLInputElement;
  $drop.addEventListener('click', () => $file.click());
  $file.addEventListener('change', () => {
    const f = $file.files?.[0];
    if (f) applyEditArtFromBlob(f);
    $file.value = '';
  });
  $drop.addEventListener('dragover', (e) => { e.preventDefault(); $drop.classList.add('dragover'); });
  $drop.addEventListener('dragleave', () => $drop.classList.remove('dragover'));
  $drop.addEventListener('drop', (e) => {
    e.preventDefault();
    $drop.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) applyEditArtFromBlob(f);
    else setEditArtStatus('edit-art-upload-status', 'Drop an image file.', 'error');
  });

  // Reset (system only)
  document.getElementById('edit-art-reset-btn')!.addEventListener('click', resetSystemArt);

  // Escape closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$modal.classList.contains('hidden')) closeEditArt();
  });
}

// ── Launch Config tab ─────────────────────────────────────────────

async function renderLaunchConfigTab(game: GameInfo) {
  const $launch = document.getElementById('detail-launch')!;
  $launch.innerHTML = '<div class="detail-meta-loading">Loading...</div>';
  try {
    const [cfg, alternates] = await Promise.all([
      fetchGameConfig(game.system, game.file),
      fetchAlternateCores(game.system),
    ]);
    const defaultCore = systems.find(s => s.id === game.system)?.core || alternates[0] || '';
    const selected = cfg.core || defaultCore;
    const opts = alternates.length === 0 ? [defaultCore] : alternates;

    $launch.innerHTML = `
      <div class="launch-config">
        <div class="launch-config-row">
          <label class="launch-config-label">Emulator Core</label>
          <select id="launch-core-select" class="setting-input compact-select">
            ${opts.map(c => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}${c === defaultCore ? ' (default)' : ''}</option>`).join('')}
          </select>
        </div>
        <p class="setting-hint">Different cores have different trade-offs (speed vs. accuracy). Changes apply on next launch.</p>
        <div class="launch-config-row">
          <button id="launch-config-save" class="action-btn">Save</button>
          <button id="launch-config-reset" class="action-btn sm danger">Reset to default</button>
          <span id="launch-config-status" class="setting-hint" style="margin:0;"></span>
        </div>
        <div class="launch-config-info">
          <strong>Current playtime:</strong> ${formatPlaytime((recentPlaytimeCache.find(s => s.game_id === game.id)?.total_seconds) || 0)}
          <br><strong>Play count:</strong> ${(recentPlaytimeCache.find(s => s.game_id === game.id)?.play_count) || 0}
        </div>
      </div>
    `;
    const $sel = document.getElementById('launch-core-select') as HTMLSelectElement;
    const $save = document.getElementById('launch-config-save')!;
    const $reset = document.getElementById('launch-config-reset')!;
    const $status = document.getElementById('launch-config-status')!;
    $save.addEventListener('click', async () => {
      const core = $sel.value === defaultCore ? undefined : $sel.value;
      await saveGameConfig(game.system, game.file, { core });
      $status.textContent = '✓ Saved';
      setTimeout(() => { $status.textContent = ''; }, 2000);
    });
    $reset.addEventListener('click', async () => {
      await saveGameConfig(game.system, game.file, {});
      $sel.value = defaultCore;
      $status.textContent = '✓ Reset';
      setTimeout(() => { $status.textContent = ''; }, 2000);
    });
  } catch {
    $launch.innerHTML = '<p class="setting-hint">Failed to load launch config.</p>';
  }
}

// ── Save State Browser ────────────────────────────────────────────

interface SaveStateEntry {
  slot: number;
  screenshot: string | null;
  timestamp: number;
}

const SAVE_STATES_KEY_PREFIX = 'retroweb-savestates-';

function loadSaveStates(gameId: string): SaveStateEntry[] {
  try {
    const raw = localStorage.getItem(SAVE_STATES_KEY_PREFIX + gameId);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveSaveStates(gameId: string, states: SaveStateEntry[]): void {
  localStorage.setItem(SAVE_STATES_KEY_PREFIX + gameId, JSON.stringify(states));
}

function captureEmulatorScreenshot(iframe: HTMLIFrameElement | null): string | null {
  if (!iframe?.contentDocument) return null;
  try {
    const canvas = iframe.contentDocument.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    // Downscale to 320 wide for storage efficiency
    const scale = Math.min(1, 320 / canvas.width);
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    off.getContext('2d')?.drawImage(canvas, 0, 0, w, h);
    return off.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}

function recordSaveStateSlot(gameId: string, slot: number, screenshot: string | null) {
  const states = loadSaveStates(gameId);
  const existing = states.findIndex(s => s.slot === slot);
  const entry: SaveStateEntry = { slot, screenshot, timestamp: Date.now() };
  if (existing >= 0) states[existing] = entry;
  else states.push(entry);
  saveSaveStates(gameId, states);
}

function renderSaveStatesTab(game: GameInfo) {
  const $saves = document.getElementById('detail-saves')!;
  const states = loadSaveStates(game.id).sort((a, b) => a.slot - b.slot);

  if (states.length === 0) {
    $saves.innerHTML = `
      <p class="setting-hint">No save states yet. Use <code>Select + R1</code> while playing to quick-save.</p>
      <p class="setting-hint">Save states are stored by EmulatorJS in your browser. RetroWeb tracks slot metadata here.</p>
    `;
    return;
  }

  $saves.innerHTML = `
    <div class="save-states-grid">
      ${states.map(s => `
        <div class="save-state-card" data-slot="${s.slot}">
          <div class="save-state-img">
            ${s.screenshot
              ? `<img src="${esc(s.screenshot)}" alt="Slot ${s.slot}" />`
              : `<div class="placeholder">💾</div>`}
            <div class="save-state-slot">Slot ${s.slot}</div>
          </div>
          <div class="save-state-info">
            <div class="save-state-time">${formatTimeAgo(Math.floor(s.timestamp / 1000))}</div>
            <button class="action-btn sm save-state-load" data-slot="${s.slot}">Load</button>
            <button class="action-btn sm danger save-state-delete" data-slot="${s.slot}">Delete</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  $saves.querySelectorAll('.save-state-load').forEach(btn => {
    btn.addEventListener('click', () => {
      // Launch game; EmulatorJS will load slot on next play
      const slot = parseInt((btn as HTMLElement).dataset.slot!, 10);
      sessionStorage.setItem('retroweb-load-slot', String(slot));
      playGame(game);
    });
  });
  $saves.querySelectorAll('.save-state-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = parseInt((btn as HTMLElement).dataset.slot!, 10);
      const states = loadSaveStates(game.id).filter(s => s.slot !== slot);
      saveSaveStates(game.id, states);
      renderSaveStatesTab(game);
    });
  });
}

async function openGameDetail(game: GameInfo) {
  currentDetailGame = game;
  const $title = document.getElementById('detail-title')!;
  const $cover = document.getElementById('detail-cover')!;
  const $meta = document.getElementById('detail-meta')!;
  const $playBtn = document.getElementById('detail-play-btn')!;
  const $scrapeArtBtn = document.getElementById('detail-scrape-art-btn')!;
  const $editArtBtn = document.getElementById('detail-edit-art-btn')!;
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

  // Hero banner + logo (probe; if 404 hide)
  const $banner = document.getElementById('detail-hero-banner') as HTMLImageElement;
  const $logo = document.getElementById('detail-hero-logo') as HTMLImageElement;
  $banner.classList.remove('loaded'); $logo.classList.remove('loaded');
  $banner.src = bannerUrl(game.system, game.file);
  $banner.onload = () => $banner.classList.add('loaded');
  $banner.onerror = () => $banner.classList.remove('loaded');
  $logo.src = logoUrl(game.system, game.file);
  $logo.onload = () => $logo.classList.add('loaded');
  $logo.onerror = () => $logo.classList.remove('loaded');

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

  const newEditArtBtn = $editArtBtn.cloneNode(true) as HTMLButtonElement;
  $editArtBtn.parentNode!.replaceChild(newEditArtBtn, $editArtBtn);
  newEditArtBtn.addEventListener('click', () => openEditArt({ kind: 'game', game }));

  // Click the cover to open the Edit Art modal — most useful when art is missing
  $cover.style.cursor = 'pointer';
  $cover.title = 'Click to edit art';
  $cover.onclick = () => openEditArt({ kind: 'game', game });

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

  // Scrape Banner / Logo handlers (SteamGridDB)
  const $bannerBtn = document.getElementById('detail-scrape-banner-btn');
  const $logoBtn = document.getElementById('detail-scrape-logo-btn');
  if ($bannerBtn) {
    const newBannerBtn = $bannerBtn.cloneNode(true) as HTMLButtonElement;
    $bannerBtn.parentNode!.replaceChild(newBannerBtn, $bannerBtn);
    newBannerBtn.addEventListener('click', async () => {
      newBannerBtn.disabled = true;
      const orig = newBannerBtn.innerHTML;
      newBannerBtn.textContent = '...';
      try {
        const res = await scrapeBanner(game.system, game.file);
        if (res.ok && res.url) {
          newBannerBtn.classList.add('success');
          newBannerBtn.textContent = '✓ Banner';
          $banner.src = res.url + '?t=' + Date.now();
        } else {
          newBannerBtn.classList.add('error');
          newBannerBtn.textContent = '✗ ' + (res.error || 'Failed');
        }
      } catch {
        newBannerBtn.classList.add('error');
        newBannerBtn.textContent = '✗ Failed';
      }
      setTimeout(() => {
        newBannerBtn.disabled = false;
        newBannerBtn.className = 'detail-action-btn';
        newBannerBtn.innerHTML = orig;
      }, 3000);
    });
  }
  if ($logoBtn) {
    const newLogoBtn = $logoBtn.cloneNode(true) as HTMLButtonElement;
    $logoBtn.parentNode!.replaceChild(newLogoBtn, $logoBtn);
    newLogoBtn.addEventListener('click', async () => {
      newLogoBtn.disabled = true;
      const orig = newLogoBtn.innerHTML;
      newLogoBtn.textContent = '...';
      try {
        const res = await scrapeLogo(game.system, game.file);
        if (res.ok && res.url) {
          newLogoBtn.classList.add('success');
          newLogoBtn.textContent = '✓ Logo';
          $logo.src = res.url + '?t=' + Date.now();
        } else {
          newLogoBtn.classList.add('error');
          newLogoBtn.textContent = '✗ ' + (res.error || 'Failed');
        }
      } catch {
        newLogoBtn.classList.add('error');
        newLogoBtn.textContent = '✗ Failed';
      }
      setTimeout(() => {
        newLogoBtn.disabled = false;
        newLogoBtn.className = 'detail-action-btn';
        newLogoBtn.innerHTML = orig;
      }, 3000);
    });
  }

  // Fetch metadata
  const cleanName = game.file.replace(/\.[^.]+$/, '').replace(/ \(.*/, '').replace(/ \[.*/, '').replace(/ # .*/, '');
  const meta = await fetchMetadata(game.system, cleanName);
  renderDetailMeta(meta, $meta);
  renderDetailDescription(meta);
  renderDetailGameplay(meta);
  renderDetailScreenshots(game);
}

// ── Search ──────────────────────────────────────────────────────────────

/**
 * Fuzzy match: returns a positive score if every character in `query` appears in `target`
 * in order (not necessarily contiguous). Higher score = better match.
 * Returns 0 if no match.
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Exact substring match — best score
  const idx = t.indexOf(q);
  if (idx >= 0) {
    // Prefix bonus; earlier match scores higher
    return 1000 - idx + (idx === 0 ? 500 : 0);
  }
  // Subsequence match
  let ti = 0, qi = 0, score = 0, streak = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      streak++;
      score += 10 + streak * 2;
      qi++;
    } else {
      streak = 0;
    }
    ti++;
  }
  return qi === q.length ? score : 0;
}

function fuzzyFilterGames(games: GameInfo[], query: string): GameInfo[] {
  if (!query.trim()) return games;
  const scored = games
    .map(g => ({ g, score: fuzzyScore(query, g.name) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map(x => x.g);
}

function handleSearch(query: string) {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const q = query.trim();
    if (!q) {
      if ($gamesView.classList.contains('active') && currentSystem) {
        renderGames(currentGames);
        $gameCount.textContent = `${currentGames.length} games`;
      } else { renderSystems(systems); showView('systems'); }
      return;
    }
    // If we have allGamesCache or currentGames, do local fuzzy match (fast).
    const haystack = currentSystem && $gamesView.classList.contains('active')
      ? currentGames
      : allGamesCache;
    const results = fuzzyFilterGames(haystack, q);

    if (!$gamesView.classList.contains('active')) {
      $systemTitle.textContent = `Search: "${q}"`;
      showView('games');
    }
    $gameCount.textContent = `${results.length} of ${haystack.length} match`;
    if (currentSystem && $gamesView.classList.contains('active')) {
      // Per-system view: render filtered list but don't overwrite currentGames
      renderGames(results);
    } else {
      // Cross-system search: render with system tag
      $gamesGrid.innerHTML = results.map((g, i) => buildGameCardHTML(g, i, true)).join('');
      attachGameCardEvents($gamesGrid, results);
    }
  }, 180);
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
    if ($sgdbKeyInput) $sgdbKeyInput.value = settings.steamgriddb_api_key ?? '';
    const $autoplayChk = document.getElementById('autoplay-previews-input') as HTMLInputElement | null;
    if ($autoplayChk) $autoplayChk.checked = settings.autoplay_previews ?? false;
    const $cloudUrl = document.getElementById('cloud-sync-url') as HTMLInputElement | null;
    const $cloudUser = document.getElementById('cloud-sync-user') as HTMLInputElement | null;
    const $cloudPass = document.getElementById('cloud-sync-pass') as HTMLInputElement | null;
    const $autoBackup = document.getElementById('auto-backup-input') as HTMLInputElement | null;
    if ($cloudUrl) $cloudUrl.value = settings.cloud_sync_url ?? '';
    if ($cloudUser) $cloudUser.value = settings.cloud_sync_user ?? '';
    if ($cloudPass) $cloudPass.value = settings.cloud_sync_pass ?? '';
    if ($autoBackup) $autoBackup.checked = settings.auto_backup_saves ?? false;
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
      try {
        (iframe?.contentWindow as any)?.EJS_emulator?.quickSave?.();
        // Record metadata: snapshot canvas as screenshot
        if (currentPlaytimeSession) {
          const shot = captureEmulatorScreenshot(iframe);
          recordSaveStateSlot(currentPlaytimeSession.gameId, 0, shot);
        }
        toast('State saved');
      } catch { toast('Save not supported'); }
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

  // Autoplay previews toggle (immediate save)
  const $autoplayChk = document.getElementById('autoplay-previews-input') as HTMLInputElement | null;
  if ($autoplayChk) {
    $autoplayChk.addEventListener('change', async () => {
      if (!settings) return;
      settings.autoplay_previews = $autoplayChk.checked;
      try { await updateSettings(settings); toast('Autoplay setting saved'); }
      catch { toast('Failed to save'); }
    });
  }
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
  clearVideoPreview();
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

// ── Video preview autoplay (FullView) ─────────────────────────────

let previewVideoCache: Map<string, string | null> = new Map();
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let lastPreviewGameId = '';

async function fetchVideoIdForGame(game: GameInfo): Promise<string | null> {
  const key = game.id;
  if (previewVideoCache.has(key)) return previewVideoCache.get(key) || null;
  try {
    const media = await searchMedia(game.system, game.file);
    const id = media.youtube_ids[0] || null;
    previewVideoCache.set(key, id);
    return id;
  } catch {
    previewVideoCache.set(key, null);
    return null;
  }
}

function clearVideoPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  const $preview = document.getElementById('kiosk-video-preview');
  if ($preview) {
    $preview.classList.add('hidden');
    $preview.innerHTML = '';
  }
  lastPreviewGameId = '';
}

function scheduleVideoPreview() {
  if (!settings?.autoplay_previews) { clearVideoPreview(); return; }
  if (previewTimer) clearTimeout(previewTimer);
  const game = kioskGames[kioskGameIndex];
  if (!game) { clearVideoPreview(); return; }
  if (game.id === lastPreviewGameId) return; // already showing
  // Hide current preview while delay runs
  const $preview = document.getElementById('kiosk-video-preview');
  if ($preview) { $preview.classList.add('hidden'); $preview.innerHTML = ''; }
  previewTimer = setTimeout(async () => {
    if (kioskGames[kioskGameIndex]?.id !== game.id) return;
    const videoId = await fetchVideoIdForGame(game);
    if (!videoId) return;
    if (kioskGames[kioskGameIndex]?.id !== game.id) return;
    const $p = document.getElementById('kiosk-video-preview');
    if (!$p) return;
    lastPreviewGameId = game.id;
    $p.innerHTML = `<iframe
      src="https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&loop=1&playlist=${encodeURIComponent(videoId)}&modestbranding=1&playsinline=1"
      frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    $p.classList.remove('hidden');
  }, 900);
}

function renderKioskGames() {
  if (kioskGames.length > 0) {
    $kioskGameCounter.textContent = `${kioskGameIndex + 1} / ${kioskGames.length}`;
  } else {
    $kioskGameCounter.textContent = 'No games';
  }
  scheduleVideoPreview();

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
  void beginPlaytimeSession(game);
  void launchGameWithConfig(game, sys, 'emulator-container');
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

// ── Management tab ────────────────────────────────────────────

const SAVES_BACKUP_KEY = 'retroweb-saves-backup-index';

interface BackupEntry { gameId: string; timestamp: number; slotCount: number; }

function loadBackupIndex(): BackupEntry[] {
  try { return JSON.parse(localStorage.getItem(SAVES_BACKUP_KEY) || '[]'); }
  catch { return []; }
}

function saveBackupIndex(entries: BackupEntry[]) {
  localStorage.setItem(SAVES_BACKUP_KEY, JSON.stringify(entries));
}

function rollingBackupAllSaves() {
  const now = Date.now();
  const sevenDays = 7 * 86400 * 1000;
  const index = loadBackupIndex().filter(e => now - e.timestamp < sevenDays);
  // Snapshot current save state metadata for the current game
  if (currentPlaytimeSession) {
    const states = loadSaveStates(currentPlaytimeSession.gameId);
    if (states.length > 0) {
      index.push({ gameId: currentPlaytimeSession.gameId, timestamp: now, slotCount: states.length });
      localStorage.setItem(`retroweb-saves-backup-${currentPlaytimeSession.gameId}-${now}`, JSON.stringify(states));
    }
  }
  // Trim entries older than 7 days
  saveBackupIndex(index);
}

function wireManagementTab() {
  const $export = document.getElementById('export-config-btn');
  const $import = document.getElementById('import-config-btn');
  const $importFile = document.getElementById('import-config-file') as HTMLInputElement | null;
  const $status = document.getElementById('config-io-status');

  $export?.addEventListener('click', async () => {
    try {
      const data = await exportConfig();
      // Add localStorage dump
      const ls: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith('retroweb-')) ls[k] = localStorage.getItem(k) || '';
      }
      data.localstorage = ls;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `retroweb-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      if ($status) $status.textContent = '✓ Exported.';
    } catch {
      if ($status) $status.textContent = '✗ Export failed.';
    }
  });

  $import?.addEventListener('click', () => $importFile?.click());
  $importFile?.addEventListener('change', async () => {
    if (!$importFile.files?.[0]) return;
    try {
      const text = await $importFile.files[0].text();
      const data = JSON.parse(text);
      await importConfig(data);
      // Restore localStorage
      if (data.localstorage) {
        Object.entries(data.localstorage).forEach(([k, v]) => localStorage.setItem(k, v as string));
      }
      if ($status) $status.textContent = '✓ Imported. Reloading...';
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      if ($status) $status.textContent = `✗ Import failed: ${e}`;
    }
  });

  // Auto backup toggle
  const $autoBackup = document.getElementById('auto-backup-input') as HTMLInputElement | null;
  $autoBackup?.addEventListener('change', async () => {
    if (!settings) return;
    settings.auto_backup_saves = $autoBackup.checked;
    try { await updateSettings(settings); toast('Auto-backup setting saved'); }
    catch { toast('Failed to save'); }
  });

  document.getElementById('backup-now-btn')?.addEventListener('click', () => {
    rollingBackupAllSaves();
    toast('Backup snapshot saved');
  });

  document.getElementById('show-backups-btn')?.addEventListener('click', () => {
    const $list = document.getElementById('backup-list');
    if (!$list) return;
    const entries = loadBackupIndex().sort((a, b) => b.timestamp - a.timestamp);
    if (entries.length === 0) {
      $list.innerHTML = '<p class="setting-hint">No backups yet.</p>';
      return;
    }
    $list.innerHTML = entries.map(e => `
      <div class="backup-row">
        <span>${esc(e.gameId)}</span>
        <span>${e.slotCount} slot(s)</span>
        <span>${formatTimeAgo(Math.floor(e.timestamp / 1000))}</span>
      </div>
    `).join('');
  });

  // Cloud sync
  document.getElementById('save-cloud-sync-btn')?.addEventListener('click', async () => {
    if (!settings) return;
    const $url = document.getElementById('cloud-sync-url') as HTMLInputElement;
    const $user = document.getElementById('cloud-sync-user') as HTMLInputElement;
    const $pass = document.getElementById('cloud-sync-pass') as HTMLInputElement;
    settings.cloud_sync_url = $url.value.trim() || undefined;
    settings.cloud_sync_user = $user.value.trim() || undefined;
    settings.cloud_sync_pass = $pass.value || undefined;
    try { await updateSettings(settings); toast('Cloud sync settings saved'); }
    catch { toast('Failed to save'); }
  });

  document.getElementById('test-cloud-sync-btn')?.addEventListener('click', async () => {
    const $url = document.getElementById('cloud-sync-url') as HTMLInputElement;
    const $user = document.getElementById('cloud-sync-user') as HTMLInputElement;
    const $pass = document.getElementById('cloud-sync-pass') as HTMLInputElement;
    const $status = document.getElementById('cloud-sync-status');
    if (!$status) return;
    if (!$url.value.trim()) { $status.textContent = 'Set a URL first'; return; }
    $status.textContent = 'Testing...';
    try {
      const auth = $user.value && $pass.value ? 'Basic ' + btoa(`${$user.value}:${$pass.value}`) : undefined;
      const res = await fetch($url.value, { method: 'PROPFIND', headers: auth ? { Authorization: auth, Depth: '0' } : { Depth: '0' } });
      $status.textContent = res.ok || res.status === 207 ? '✓ Connection OK' : `✗ ${res.status}`;
    } catch (e) {
      $status.textContent = `✗ ${e}`;
    }
  });

  // Version check
  const $versionInfo = document.getElementById('version-info');
  document.getElementById('check-update-btn')?.addEventListener('click', async () => {
    if (!$versionInfo) return;
    $versionInfo.textContent = 'Checking...';
    try {
      const v = await fetchVersion();
      $versionInfo.innerHTML = `Current: <strong>v${v.current}</strong>${v.latest ? ` &middot; Latest: <strong>${v.latest}</strong>` : ''}${v.update_available ? ' <span style="color:var(--accent);">(update available)</span>' : ''}`;
    } catch {
      $versionInfo.textContent = 'Failed to check.';
    }
  });
  // Initial version load
  fetchVersion().then(v => {
    if ($versionInfo) {
      $versionInfo.innerHTML = `Current: <strong>v${v.current}</strong>${v.latest ? ` &middot; Latest: <strong>${v.latest}</strong>` : ''}`;
    }
  }).catch(() => {});
}

// ── Diagnostics tab ──────────────────────────────────────────

function wireDiagnosticsTab() {
  const $viewer = document.getElementById('log-viewer');
  async function refresh() {
    if (!$viewer) return;
    try {
      const logs = await fetchLogs();
      $viewer.textContent = logs.length === 0
        ? 'No logs.'
        : logs.map(l => `[${new Date(l.timestamp * 1000).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.message}`).join('\n');
    } catch {
      $viewer.textContent = 'Failed to load logs.';
    }
  }
  document.getElementById('refresh-logs-btn')?.addEventListener('click', refresh);
  document.getElementById('copy-logs-btn')?.addEventListener('click', () => {
    if (!$viewer) return;
    navigator.clipboard?.writeText($viewer.textContent || '').then(() => toast('Logs copied'));
  });
  document.getElementById('clear-logs-btn')?.addEventListener('click', async () => {
    await clearLogs();
    refresh();
    toast('Logs cleared');
  });
  // Initial render when settings page is opened (deferred)
}

// ── Plugins tab ──────────────────────────────────────────

interface PluginManifest {
  name: string;
  version?: string;
  enabled: boolean;
  source?: string;
}

const PLUGINS_KEY = 'retroweb-plugins';

function loadPluginManifests(): PluginManifest[] {
  try { return JSON.parse(localStorage.getItem(PLUGINS_KEY) || '[]'); }
  catch { return []; }
}

function savePluginManifests(plugins: PluginManifest[]) {
  localStorage.setItem(PLUGINS_KEY, JSON.stringify(plugins));
}

interface RetroWebPluginAPI {
  registerScraper(name: string, fn: (game: GameInfo) => Promise<any>): void;
  registerCommand(id: string, label: string, fn: (game: GameInfo) => void): void;
  registerWidget(slot: string, html: string): void;
  fetchGames(): Promise<GameInfo[]>;
  fetchSystems(): Promise<SystemInfo[]>;
  toast(msg: string): void;
}

const pluginScrapers = new Map<string, (game: GameInfo) => Promise<any>>();
const pluginCommands: Array<{ id: string; label: string; fn: (g: GameInfo) => void }> = [];
const pluginWidgets: Map<string, string[]> = new Map();

function makePluginAPI(): RetroWebPluginAPI {
  return {
    registerScraper(name, fn) { pluginScrapers.set(name, fn); },
    registerCommand(id, label, fn) { pluginCommands.push({ id, label, fn }); },
    registerWidget(slot, html) {
      const arr = pluginWidgets.get(slot) || [];
      arr.push(html);
      pluginWidgets.set(slot, arr);
      const $slot = document.querySelector(`[data-plugin-slot="${slot}"]`);
      if ($slot) $slot.insertAdjacentHTML('beforeend', html);
    },
    fetchGames: () => fetchGames(),
    fetchSystems: () => fetchSystems(),
    toast,
  };
}

async function loadPlugin(p: PluginManifest) {
  if (!p.enabled || !p.source) return;
  try {
    const blob = new Blob([p.source], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const mod = await import(/* @vite-ignore */ url);
    URL.revokeObjectURL(url);
    if (mod.default?.onLoad) {
      mod.default.onLoad(makePluginAPI());
    }
  } catch (e) {
    console.error(`Plugin ${p.name} failed:`, e);
  }
}

function renderPluginsList() {
  const $list = document.getElementById('plugins-list');
  if (!$list) return;
  const plugins = loadPluginManifests();
  if (plugins.length === 0) {
    $list.innerHTML = '<p class="setting-hint">No plugins installed.</p>';
    return;
  }
  $list.innerHTML = plugins.map((p, i) => `
    <div class="plugin-row">
      <label class="setting-toggle" style="flex:1;">
        <input type="checkbox" data-plugin-idx="${i}" ${p.enabled ? 'checked' : ''} />
        <span><strong>${esc(p.name)}</strong> ${p.version ? `<span class="setting-hint">v${esc(p.version)}</span>` : ''}</span>
      </label>
      <button class="action-btn sm danger" data-remove-plugin="${i}">Remove</button>
    </div>
  `).join('');

  $list.querySelectorAll('input[type=checkbox][data-plugin-idx]').forEach(chk => {
    chk.addEventListener('change', () => {
      const idx = parseInt((chk as HTMLElement).dataset.pluginIdx!, 10);
      const list = loadPluginManifests();
      list[idx].enabled = (chk as HTMLInputElement).checked;
      savePluginManifests(list);
      toast('Reload page for plugin changes to take effect.');
    });
  });
  $list.querySelectorAll('[data-remove-plugin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.removePlugin!, 10);
      const list = loadPluginManifests();
      list.splice(idx, 1);
      savePluginManifests(list);
      renderPluginsList();
    });
  });
}

function wirePluginsTab() {
  document.getElementById('install-plugin-btn')?.addEventListener('click', async () => {
    const $name = document.getElementById('plugin-name-input') as HTMLInputElement;
    const $url = document.getElementById('plugin-url-input') as HTMLInputElement;
    const name = $name.value.trim();
    const url = $url.value.trim();
    if (!name || !url) { toast('Enter name and URL'); return; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const source = await res.text();
      const list = loadPluginManifests();
      list.push({ name, version: '1.0.0', enabled: true, source });
      savePluginManifests(list);
      $name.value = ''; $url.value = '';
      renderPluginsList();
      toast(`Installed ${name}. Reload to activate.`);
    } catch (e) {
      toast(`Install failed: ${e}`);
    }
  });
  renderPluginsList();
}

async function loadAllPlugins() {
  const plugins = loadPluginManifests();
  for (const p of plugins) {
    await loadPlugin(p);
  }
}

// ── Init ────────────────────────────────────────────────────────────────

async function init() {
  initEditArtModal();
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
  // Prime playtime/collection/hidden caches concurrently
  await Promise.all([refreshPlaytimeCaches(), refreshCollections(), refreshHiddenGames()]);
  renderResumeBar();

  // ── Event listeners ──────────────────────────────────────────────────

  // Main tabs (Systems / All Games / Recently / Favourites / Collections)
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMainTab((tab as HTMLElement).dataset.mainTab!));
  });

  // Sort/filter controls for All Games tab
  document.getElementById('all-games-sort')!.addEventListener('change', () => renderAllGamesTab());
  document.getElementById('all-games-system-filter')!.addEventListener('change', () => renderAllGamesTab());
  const $showHidden = document.getElementById('show-hidden-toggle');
  if ($showHidden) $showHidden.addEventListener('change', () => renderAllGamesTab());

  // View mode toggle (Grid / List) for All Games
  const $viewToggle = document.getElementById('all-games-view-toggle');
  if ($viewToggle) {
    $viewToggle.querySelectorAll<HTMLButtonElement>('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.viewMode === allGamesViewMode);
      btn.addEventListener('click', () => {
        const mode = btn.dataset.viewMode as ViewMode;
        if (mode === allGamesViewMode) return;
        allGamesViewMode = mode;
        localStorage.setItem('allGamesViewMode', mode);
        $viewToggle.querySelectorAll<HTMLButtonElement>('.view-mode-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.viewMode === mode));
        renderAllGamesTab();
      });
    });
  }

  // Smart search input (All Games tab)
  const $allGamesSearch = document.getElementById('all-games-search') as HTMLInputElement | null;
  if ($allGamesSearch) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    $allGamesSearch.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        allGamesSearchQuery = $allGamesSearch.value.trim();
        renderAllGamesTab();
      }, 180);
    });
  }

  // Sort control for Favourites tab
  document.getElementById('fav-games-sort')!.addEventListener('change', () => renderFavouritesTab());

  // Recent search input
  const $recentSearch = document.getElementById('recent-search') as HTMLInputElement | null;
  if ($recentSearch) {
    let recentTimer: ReturnType<typeof setTimeout> | null = null;
    $recentSearch.addEventListener('input', () => {
      if (recentTimer) clearTimeout(recentTimer);
      recentTimer = setTimeout(() => {
        recentSearchQuery = $recentSearch.value.trim();
        renderRecentTab();
      }, 180);
    });
  }

  // Create collection button
  const $createColBtn = document.getElementById('create-collection-btn');
  if ($createColBtn) {
    $createColBtn.addEventListener('click', async () => {
      const $name = document.getElementById('new-collection-name') as HTMLInputElement;
      const $icon = document.getElementById('new-collection-icon') as HTMLInputElement;
      const name = $name.value.trim();
      if (!name) { toast('Enter a collection name'); return; }
      await createCollection(name, $icon.value.trim() || undefined);
      $name.value = ''; $icon.value = '';
      await renderCollectionsTab();
    });
  }

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
    void endPlaytimeSession();
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

  // ── Management tab wiring ───────────────────────────────────────────
  wireManagementTab();
  wireDiagnosticsTab();
  wirePluginsTab();

  // Duplicates scanner
  const $dupesBtn = document.getElementById('dupes-scan-btn');
  const $dupesStatus = document.getElementById('dupes-status');
  const $dupesResults = document.getElementById('dupes-results');
  if ($dupesBtn && $dupesStatus && $dupesResults) {
    $dupesBtn.addEventListener('click', async () => {
      ($dupesBtn as HTMLButtonElement).disabled = true;
      $dupesStatus.textContent = 'Scanning... (hashing first 64KB of each ROM)';
      $dupesResults.innerHTML = '';
      try {
        const groups = await scanDuplicates();
        $dupesStatus.textContent = `${groups.length} duplicate group${groups.length === 1 ? '' : 's'} found`;
        $dupesResults.innerHTML = renderDuplicateGroupsHTML(groups);
        wireDuplicateRemoveButtons($dupesResults);
      } catch {
        $dupesStatus.textContent = 'Scan failed';
      } finally {
        ($dupesBtn as HTMLButtonElement).disabled = false;
      }
    });
  }

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
    if ($sgdbKeyInput) settings.steamgriddb_api_key = $sgdbKeyInput.value.trim() || undefined;
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
      if (currentDetailGame) {
        if (tabName === 'launch') renderLaunchConfigTab(currentDetailGame);
        else if (tabName === 'saves') renderSaveStatesTab(currentDetailGame);
      }
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
loadAllPlugins();
