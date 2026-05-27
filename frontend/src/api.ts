export interface SystemInfo {
  id: string;
  name: string;
  game_count: number;
  core: string;
  cover_image: string | null;
}

export interface GameInfo {
  id: string;
  name: string;
  file: string;
  system: string;
  has_image: boolean;
  image_path: string | null;
}

export interface AppSettings {
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

export interface ControllerMappingConfig {
  name: string;
  profile: string;
  mappings: Record<string, string>;
}

export interface BiosStatus {
  system: string;
  system_name: string;
  required: BiosFile[];
}

export interface BiosFile {
  file: string;
  found: boolean;
  description: string;
}

export interface GameMetadata {
  description?: string;
  developer?: string;
  publisher?: string;
  genre?: string;
  release_year?: string;
  players?: string;
  rating?: number;
}

export interface ScrapeResult {
  system: string;
  total: number;
  scraped: number;
  skipped: number;
  already_have: number;
  not_found: number;
  errors: number;
  messages: string[];
}

const API_BASE = '/api';

export async function fetchSystems(): Promise<SystemInfo[]> {
  const res = await fetch(`${API_BASE}/systems`);
  if (!res.ok) throw new Error(`Failed to fetch systems: ${res.status}`);
  return res.json();
}

export async function fetchGames(system?: string, search?: string): Promise<GameInfo[]> {
  const params = new URLSearchParams();
  if (system) params.set('system', system);
  if (search) params.set('search', search);
  const res = await fetch(`${API_BASE}/games?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch games: ${res.status}`);
  return res.json();
}

export function romUrl(system: string, file: string): string {
  return `${API_BASE}/roms/${encodeURIComponent(system)}/${encodeURIComponent(file)}`;
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) throw new Error(`Failed to fetch settings`);
  return res.json();
}

export async function updateSettings(settings: AppSettings): Promise<void> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update settings');
  }
}

export async function rescanRoms(): Promise<{ systems: number; games: number }> {
  const res = await fetch(`${API_BASE}/rescan`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to rescan');
  return res.json();
}

export async function fetchBiosStatus(): Promise<BiosStatus[]> {
  const res = await fetch(`${API_BASE}/bios/status`);
  if (!res.ok) throw new Error('Failed to fetch BIOS status');
  return res.json();
}

export async function fetchMetadata(system: string, game: string): Promise<GameMetadata | null> {
  const res = await fetch(`${API_BASE}/metadata/${encodeURIComponent(system)}/${encodeURIComponent(game)}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data || null;
}

export async function scrapeSystem(system: string): Promise<ScrapeResult> {
  const res = await fetch(`${API_BASE}/scrape/${encodeURIComponent(system)}`, { method: 'POST' });
  if (!res.ok) throw new Error('Scrape failed');
  return res.json();
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: string[];
  is_valid: boolean;
}

export async function scrapeArtSingle(system: string, file: string): Promise<{ ok: boolean; status: string; message: string; image_path?: string }> {
  const res = await fetch(`${API_BASE}/scrape-art-single/${encodeURIComponent(system)}?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error('Scrape art failed');
  return res.json();
}

export async function scrapeInfoSingle(system: string, file: string): Promise<{ ok: boolean; status: string; message: string; metadata?: GameMetadata }> {
  const res = await fetch(`${API_BASE}/scrape-info-single/${encodeURIComponent(system)}?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error('Scrape info failed');
  return res.json();
}

export interface MediaSearchResult {
  ok: boolean;
  youtube_ids: string[];
  image_urls: string[];
  search_query: string;
  ddg_images_url: string;
}

export async function searchMedia(system: string, file: string): Promise<MediaSearchResult> {
  const res = await fetch(`${API_BASE}/search-media/${encodeURIComponent(system)}?file=${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error('Media search failed');
  return res.json();
}

export async function browseDirs(path: string): Promise<BrowseResult> {
  const res = await fetch(`${API_BASE}/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error('Browse failed');
  return res.json();
}

// ── Playtime ────────────────────────────────────────────────────────────

export interface PlaytimeStats {
  game_id: string;
  system: string;
  file: string;
  name: string;
  total_seconds: number;
  last_played_at: number;
  play_count: number;
}

export async function fetchAllPlaytime(): Promise<PlaytimeStats[]> {
  const res = await fetch(`${API_BASE}/playtime`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchRecentPlaytime(): Promise<PlaytimeStats[]> {
  const res = await fetch(`${API_BASE}/playtime/recent`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchLastPlayed(): Promise<PlaytimeStats | null> {
  const res = await fetch(`${API_BASE}/playtime/last`);
  if (!res.ok) return null;
  return res.json();
}

export async function playtimeStart(game: GameInfo): Promise<void> {
  await fetch(`${API_BASE}/playtime/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_id: game.id, system: game.system, file: game.file, name: game.name }),
  }).catch(() => { /* offline ok */ });
}

export async function playtimeEnd(gameId: string, durationSeconds: number): Promise<void> {
  await fetch(`${API_BASE}/playtime/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_id: gameId, duration_seconds: durationSeconds }),
  }).catch(() => { /* offline ok */ });
}

// ── Collections ─────────────────────────────────────────────────────────

export interface Collection {
  id: string;
  name: string;
  icon: string | null;
  game_ids: string[];
  created_at: number;
}

export async function listCollections(): Promise<Collection[]> {
  const res = await fetch(`${API_BASE}/collections`);
  if (!res.ok) return [];
  return res.json();
}

export async function createCollection(name: string, icon?: string): Promise<Collection> {
  const res = await fetch(`${API_BASE}/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon }),
  });
  if (!res.ok) throw new Error('create collection failed');
  return res.json();
}

export async function updateCollection(id: string, body: { name?: string; icon?: string; game_ids?: string[] }): Promise<void> {
  await fetch(`${API_BASE}/collections/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteCollection(id: string): Promise<void> {
  await fetch(`${API_BASE}/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function collectionAddGame(id: string, gameId: string): Promise<void> {
  await fetch(`${API_BASE}/collections/${encodeURIComponent(id)}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_id: gameId }),
  });
}

export async function collectionRemoveGame(id: string, gameId: string): Promise<void> {
  await fetch(`${API_BASE}/collections/${encodeURIComponent(id)}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_id: gameId }),
  });
}

// ── Game launch config ──────────────────────────────────────────────────

export interface GameLaunchConfig {
  core?: string;
  shader?: string;
  options?: Record<string, string>;
}

export async function fetchGameConfig(system: string, file: string): Promise<GameLaunchConfig> {
  const res = await fetch(`${API_BASE}/game-config/${encodeURIComponent(system)}/${encodeURIComponent(file)}`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveGameConfig(system: string, file: string, cfg: GameLaunchConfig): Promise<void> {
  await fetch(`${API_BASE}/game-config/${encodeURIComponent(system)}/${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

export async function fetchAlternateCores(system: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/alternate-cores/${encodeURIComponent(system)}`);
  if (!res.ok) return [];
  return res.json();
}

// ── Hidden games ────────────────────────────────────────────────────────

export async function fetchHiddenGames(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/hidden-games`);
  if (!res.ok) return [];
  return res.json();
}

export async function saveHiddenGames(ids: string[]): Promise<void> {
  await fetch(`${API_BASE}/hidden-games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids),
  });
}

// ── Duplicates ──────────────────────────────────────────────────────────

export interface DuplicateGroup {
  hash: string;
  size: number;
  games: GameInfo[];
}

export async function scanDuplicates(): Promise<DuplicateGroup[]> {
  const res = await fetch(`${API_BASE}/duplicates/scan`, { method: 'POST' });
  if (!res.ok) return [];
  return res.json();
}

// ── Version / Logs / Config Export ─────────────────────────────────────

export interface VersionInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
}

export async function fetchVersion(): Promise<VersionInfo> {
  const res = await fetch(`${API_BASE}/version`);
  if (!res.ok) return { current: '?', latest: null, update_available: false };
  return res.json();
}

export interface LogEntry { timestamp: number; level: string; message: string; }

export async function fetchLogs(): Promise<LogEntry[]> {
  const res = await fetch(`${API_BASE}/logs`);
  if (!res.ok) return [];
  return res.json();
}

export async function clearLogs(): Promise<void> {
  await fetch(`${API_BASE}/logs`, { method: 'DELETE' });
}

export async function exportConfig(): Promise<any> {
  const res = await fetch(`${API_BASE}/config/export`);
  if (!res.ok) throw new Error('export failed');
  return res.json();
}

export async function importConfig(payload: any): Promise<void> {
  const res = await fetch(`${API_BASE}/config/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('import failed');
}

// ── Hero banner + logo ────────────────────────────────────────────────

export function bannerUrl(system: string, file: string): string {
  return `${API_BASE}/banner/${encodeURIComponent(system)}/${encodeURIComponent(file)}`;
}
export function logoUrl(system: string, file: string): string {
  return `${API_BASE}/logo/${encodeURIComponent(system)}/${encodeURIComponent(file)}`;
}
export async function scrapeBanner(system: string, file: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/scrape-banner/${encodeURIComponent(system)}/${encodeURIComponent(file)}`, { method: 'POST' });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return res.json();
}
export async function scrapeLogo(system: string, file: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/scrape-logo/${encodeURIComponent(system)}/${encodeURIComponent(file)}`, { method: 'POST' });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return res.json();
}

// ── Custom art editor: upload, apply URL, search images ─────────────────

export interface ImageSearchResult {
  image: string;
  thumbnail: string;
  title: string;
  source: string;
}

export async function searchImages(query: string): Promise<{ ok: boolean; image_urls: ImageSearchResult[]; search_query: string; ddg_images_url?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/search-images?q=${encodeURIComponent(query)}`);
  if (!res.ok) return { ok: false, image_urls: [], search_query: query, error: `HTTP ${res.status}` };
  return res.json();
}

export async function uploadArt(system: string, file: string, blob: Blob): Promise<{ ok: boolean; message?: string; image_path?: string }> {
  const res = await fetch(`${API_BASE}/upload-art/${encodeURIComponent(system)}?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  return res.json();
}

export async function applyArtUrl(system: string, file: string, url: string): Promise<{ ok: boolean; message?: string; image_path?: string }> {
  const res = await fetch(`${API_BASE}/apply-art/${encodeURIComponent(system)}?file=${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  return res.json();
}

export function systemArtUrl(system: string): string {
  return `${API_BASE}/system-art/${encodeURIComponent(system)}`;
}

export async function uploadSystemArt(system: string, blob: Blob): Promise<{ ok: boolean; message?: string; cover_image?: string }> {
  const res = await fetch(`${API_BASE}/upload-system-art/${encodeURIComponent(system)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  return res.json();
}

export async function applySystemArtUrl(system: string, url: string): Promise<{ ok: boolean; message?: string; cover_image?: string }> {
  const res = await fetch(`${API_BASE}/apply-system-art/${encodeURIComponent(system)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  return res.json();
}

export async function clearSystemArt(system: string): Promise<{ ok: boolean; removed?: boolean }> {
  const res = await fetch(`${API_BASE}/system-art/${encodeURIComponent(system)}`, { method: 'DELETE' });
  if (!res.ok) return { ok: false };
  return res.json();
}
