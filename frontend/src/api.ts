export interface SystemInfo {
  id: string;
  name: string;
  game_count: number;
  core: string;
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
