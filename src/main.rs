use axum::{
    Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, sse::{Event, KeepAlive, Sse}},
    routing::{get, post},
    Json,
};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, convert::Infallible, path::PathBuf, sync::{Arc, LazyLock}};
use tokio::{fs, sync::RwLock};
use tokio_stream::{wrappers::ReceiverStream, StreamExt as _};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing::{info, warn};
use walkdir::WalkDir;

// ── State ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    inner: Arc<AppInner>,
}

struct AppInner {
    rom_dir: RwLock<PathBuf>,
    library: RwLock<GameLibrary>,
    data_dir: PathBuf,
    settings: RwLock<AppSettings>,
    playtime: RwLock<HashMap<String, PlaytimeStats>>,
    collections: RwLock<Vec<Collection>>,
    game_configs: RwLock<HashMap<String, GameLaunchConfig>>,
    hidden_games: RwLock<HashSet<String>>,
    duplicates: RwLock<Vec<DuplicateGroup>>,
    log_buffer: RwLock<std::collections::VecDeque<LogEntry>>,
}

// ── Playtime ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PlaytimeStats {
    game_id: String,
    system: String,
    file: String,
    name: String,
    total_seconds: u64,
    last_played_at: u64,
    play_count: u32,
}

#[derive(Deserialize)]
struct PlaytimeStartBody {
    game_id: String,
    system: String,
    file: String,
    name: String,
}

#[derive(Deserialize)]
struct PlaytimeEndBody {
    game_id: String,
    duration_seconds: u64,
}

// ── Collections ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Collection {
    id: String,
    name: String,
    icon: Option<String>,
    game_ids: Vec<String>,
    created_at: u64,
}

#[derive(Deserialize)]
struct CollectionCreateBody {
    name: String,
    icon: Option<String>,
}

#[derive(Deserialize)]
struct CollectionUpdateBody {
    name: Option<String>,
    icon: Option<String>,
    game_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CollectionGameBody {
    game_id: String,
}

// ── Game Launch Config ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct GameLaunchConfig {
    core: Option<String>,
    shader: Option<String>,
    options: Option<HashMap<String, String>>,
}

// ── Duplicates ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DuplicateGroup {
    hash: String,
    size: u64,
    games: Vec<GameInfo>,
}

// ── Logging ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct LogEntry {
    timestamp: u64,
    level: String,
    message: String,
}

// ── Settings ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    rom_dir: String,
    kiosk_mode: bool,
    kiosk_system_filter: Vec<String>,
    controller_mappings: HashMap<String, ControllerMapping>,
    #[serde(default = "default_scrape_sources")]
    scrape_sources: Vec<String>,
    /// Legacy field — kept for backward-compatible deserialization only.
    #[serde(default, skip_serializing)]
    scrape_source: Option<String>,
    #[serde(default)]
    scrape_delay_ms: Option<u64>,
    #[serde(default)]
    ddg_fallback: bool,
    #[serde(default)]
    scrape_metadata: bool,
    #[serde(default)]
    screenscraper_user: Option<String>,
    #[serde(default)]
    screenscraper_pass: Option<String>,
    #[serde(default)]
    rawg_api_key: Option<String>,
    #[serde(default)]
    steamgriddb_api_key: Option<String>,
    #[serde(default)]
    autoplay_previews: bool,
    #[serde(default)]
    cloud_sync_url: Option<String>,
    #[serde(default)]
    cloud_sync_user: Option<String>,
    #[serde(default)]
    cloud_sync_pass: Option<String>,
    #[serde(default)]
    auto_backup_saves: bool,
}

fn default_scrape_sources() -> Vec<String> {
    vec!["https://thumbnails.libretro.com".to_string()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ControllerMapping {
    name: String,
    profile: String,
    mappings: HashMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            rom_dir: String::new(),
            kiosk_mode: false,
            kiosk_system_filter: Vec::new(),
            controller_mappings: HashMap::new(),
            scrape_sources: default_scrape_sources(),
            scrape_source: None,
            scrape_delay_ms: Some(100),
            ddg_fallback: false,
            scrape_metadata: false,
            screenscraper_user: None,
            screenscraper_pass: None,
            rawg_api_key: None,
            steamgriddb_api_key: None,
            autoplay_previews: false,
            cloud_sync_url: None,
            cloud_sync_user: None,
            cloud_sync_pass: None,
            auto_backup_saves: false,
        }
    }
}

// ── Models ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct SystemInfo {
    id: String,
    name: String,
    game_count: usize,
    core: &'static str,
    cover_image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GameInfo {
    id: String,
    name: String,
    file: String,
    system: String,
    has_image: bool,
    image_path: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct GameLibrary {
    systems: Vec<SystemInfo>,
    games: HashMap<String, Vec<GameInfo>>,
}

#[derive(Deserialize)]
struct GamesQuery {
    system: Option<String>,
    search: Option<String>,
    #[serde(default)]
    include_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct GameMetadata {
    description: Option<String>,
    developer: Option<String>,
    publisher: Option<String>,
    genre: Option<String>,
    release_year: Option<String>,
    players: Option<String>,
    rating: Option<f32>,
}

#[derive(Debug, Serialize)]
struct BiosStatus {
    system: String,
    system_name: String,
    required: Vec<BiosFile>,
}

#[derive(Debug, Serialize)]
struct BiosFile {
    file: String,
    found: bool,
    description: String,
}

#[derive(Debug, Serialize)]
struct ScrapeResult {
    system: String,
    total: usize,
    scraped: usize,
    skipped: usize,
    already_have: usize,
    not_found: usize,
    errors: usize,
    messages: Vec<String>,
}

// ── Browse ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct BrowseRequest {
    path: String,
}

#[derive(Serialize)]
struct BrowseResponse {
    path: String,
    parent: Option<String>,
    dirs: Vec<String>,
    is_valid: bool,
}

// ── System mapping ──────────────────────────────────────────────────────────

struct SystemMeta {
    name: &'static str,
    extensions: &'static [&'static str],
    core: &'static str,
}

fn system_metadata() -> HashMap<&'static str, SystemMeta> {
    let mut m = HashMap::new();
    m.insert("nes", SystemMeta { name: "Nintendo Entertainment System", extensions: &["nes", "zip", "7z"], core: "fceumm" });
    m.insert("famicom", SystemMeta { name: "Famicom", extensions: &["nes", "zip", "7z"], core: "fceumm" });
    m.insert("snes", SystemMeta { name: "Super Nintendo", extensions: &["sfc", "smc", "zip", "7z"], core: "snes9x" });
    m.insert("sfc", SystemMeta { name: "Super Famicom", extensions: &["sfc", "smc", "zip", "7z"], core: "snes9x" });
    m.insert("gb", SystemMeta { name: "Game Boy", extensions: &["gb", "zip", "7z"], core: "gambatte" });
    m.insert("gbc", SystemMeta { name: "Game Boy Color", extensions: &["gbc", "gb", "zip", "7z"], core: "gambatte" });
    m.insert("gba", SystemMeta { name: "Game Boy Advance", extensions: &["gba", "zip", "7z"], core: "mgba" });
    m.insert("genesis", SystemMeta { name: "Sega Genesis", extensions: &["md", "bin", "gen", "zip", "7z"], core: "genesis_plus_gx" });
    m.insert("megadrive", SystemMeta { name: "Sega Mega Drive", extensions: &["md", "bin", "gen", "zip", "7z"], core: "genesis_plus_gx" });
    m.insert("n64", SystemMeta { name: "Nintendo 64", extensions: &["n64", "z64", "v64", "zip", "7z"], core: "mupen64plus_next" });
    m.insert("psx", SystemMeta { name: "PlayStation", extensions: &["chd", "bin", "cue", "iso", "pbp", "zip"], core: "pcsx_rearmed" });
    m.insert("psp", SystemMeta { name: "PlayStation Portable", extensions: &["iso", "cso", "pbp", "zip"], core: "ppsspp" });
    m.insert("mastersystem", SystemMeta { name: "Sega Master System", extensions: &["sms", "zip", "7z"], core: "genesis_plus_gx" });
    m.insert("gamegear", SystemMeta { name: "Sega Game Gear", extensions: &["gg", "zip", "7z"], core: "genesis_plus_gx" });
    m.insert("neogeo", SystemMeta { name: "Neo Geo", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("arcade", SystemMeta { name: "Arcade", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("pcengine", SystemMeta { name: "PC Engine / TurboGrafx-16", extensions: &["pce", "zip", "7z"], core: "mednafen_pce" });
    m.insert("pcenginecd", SystemMeta { name: "PC Engine CD", extensions: &["chd", "cue", "zip"], core: "mednafen_pce" });
    m.insert("atari2600", SystemMeta { name: "Atari 2600", extensions: &["a26", "bin", "zip", "7z"], core: "stella2014" });
    m.insert("atari7800", SystemMeta { name: "Atari 7800", extensions: &["a78", "bin", "zip", "7z"], core: "prosystem" });
    m.insert("coleco", SystemMeta { name: "ColecoVision", extensions: &["col", "rom", "zip", "7z"], core: "gearcoleco" });
    m.insert("wonderswan", SystemMeta { name: "WonderSwan", extensions: &["ws", "zip", "7z"], core: "mednafen_wswan" });
    m.insert("wonderswancolor", SystemMeta { name: "WonderSwan Color", extensions: &["wsc", "zip", "7z"], core: "mednafen_wswan" });
    m.insert("ngp", SystemMeta { name: "Neo Geo Pocket", extensions: &["ngp", "zip", "7z"], core: "mednafen_ngp" });
    m.insert("ngpc", SystemMeta { name: "Neo Geo Pocket Color", extensions: &["ngc", "zip", "7z"], core: "mednafen_ngp" });
    m.insert("virtualboy", SystemMeta { name: "Virtual Boy", extensions: &["vb", "zip", "7z"], core: "mednafen_vb" });
    m.insert("pokemonmini", SystemMeta { name: "Pokemon Mini", extensions: &["min", "zip", "7z"], core: "pokemini" });
    m.insert("vectrex", SystemMeta { name: "Vectrex", extensions: &["vec", "zip", "7z"], core: "vecx" });
    m.insert("nds", SystemMeta { name: "Nintendo DS", extensions: &["nds", "zip", "7z"], core: "melonds" });
    m.insert("fds", SystemMeta { name: "Famicom Disk System", extensions: &["fds", "zip", "7z"], core: "fceumm" });
    m.insert("segacd", SystemMeta { name: "Sega CD", extensions: &["chd", "cue", "iso", "zip"], core: "genesis_plus_gx" });
    m.insert("sega32x", SystemMeta { name: "Sega 32X", extensions: &["32x", "zip", "7z"], core: "picodrive" });
    m.insert("atarilynx", SystemMeta { name: "Atari Lynx", extensions: &["lnx", "zip", "7z"], core: "handy" });
    m.insert("cps1", SystemMeta { name: "Capcom Play System 1", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("cps2", SystemMeta { name: "Capcom Play System 2", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("cps3", SystemMeta { name: "Capcom Play System 3", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("fbneo", SystemMeta { name: "FinalBurn Neo", extensions: &["zip", "7z"], core: "fbneo" });
    m.insert("mame", SystemMeta { name: "MAME", extensions: &["zip", "7z"], core: "mame2003" });
    m.insert("saturn", SystemMeta { name: "Sega Saturn", extensions: &["chd", "cue", "iso", "zip"], core: "yabause" });
    m.insert("dreamcast", SystemMeta { name: "Dreamcast", extensions: &["chd", "cdi", "gdi", "zip"], core: "flycast" });
    m
}

/// Alternate cores per system — for per-game launch config / multi-emulator support.
/// First entry is always the default core.
fn alternate_cores(system_id: &str) -> Vec<&'static str> {
    match system_id {
        "nes" | "famicom" | "fds" => vec!["fceumm", "nestopia"],
        "snes" | "sfc" => vec!["snes9x", "bsnes"],
        "n64" => vec!["mupen64plus_next", "parallel_n64"],
        "psx" => vec!["pcsx_rearmed", "mednafen_psx_hw"],
        "genesis" | "megadrive" => vec!["genesis_plus_gx", "genesis_plus_gx_wide", "picodrive"],
        "mastersystem" | "gamegear" => vec!["genesis_plus_gx", "picodrive"],
        "arcade" | "neogeo" | "cps1" | "cps2" | "cps3" | "fbneo" => vec!["fbneo", "mame2003", "mame2003_plus"],
        "mame" => vec!["mame2003", "mame2003_plus", "fbneo"],
        _ => {
            let meta = system_metadata();
            meta.get(system_id).map(|m| vec![m.core]).unwrap_or_default()
        }
    }
}

// ── BIOS definitions ────────────────────────────────────────────────────────

fn bios_definitions() -> Vec<(&'static str, &'static str, Vec<(&'static str, &'static str)>)> {
    vec![
        ("gba", "Game Boy Advance", vec![("gba_bios.bin", "GBA BIOS (optional, HLE available)")]),
        ("psx", "PlayStation", vec![
            ("scph1001.bin", "PS1 BIOS (NTSC-U)"),
            ("scph5500.bin", "PS1 BIOS (NTSC-J, optional)"),
            ("scph5502.bin", "PS1 BIOS (PAL, optional)"),
        ]),
        ("nds", "Nintendo DS", vec![
            ("bios7.bin", "NDS ARM7 BIOS"),
            ("bios9.bin", "NDS ARM9 BIOS"),
            ("firmware.bin", "NDS Firmware"),
        ]),
        ("segacd", "Sega CD", vec![
            ("bios_CD_U.bin", "Sega CD BIOS (US)"),
            ("bios_CD_J.bin", "Sega CD BIOS (JP, optional)"),
            ("bios_CD_E.bin", "Sega CD BIOS (EU, optional)"),
        ]),
        ("pcenginecd", "PC Engine CD", vec![("syscard3.pce", "System Card 3.0")]),
        ("atarilynx", "Atari Lynx", vec![("lynxboot.img", "Lynx Boot ROM")]),
        ("dreamcast", "Dreamcast", vec![("dc_boot.bin", "Dreamcast BIOS")]),
        ("saturn", "Sega Saturn", vec![("saturn_bios.bin", "Saturn BIOS")]),
        ("neogeo", "Neo Geo", vec![("neogeo.zip", "Neo Geo BIOS (MAME format)")]),
        ("fbneo", "FinalBurn Neo", vec![("neogeo.zip", "Neo Geo BIOS (MAME format)")]),
    ]
}

// ── Libretro thumbnail system name mapping ──────────────────────────────────

fn libretro_system_name(system_id: &str) -> Option<&'static str> {
    match system_id {
        "nes" | "famicom" => Some("Nintendo - Nintendo Entertainment System"),
        "snes" | "sfc" => Some("Nintendo - Super Nintendo Entertainment System"),
        "gb" => Some("Nintendo - Game Boy"),
        "gbc" => Some("Nintendo - Game Boy Color"),
        "gba" => Some("Nintendo - Game Boy Advance"),
        "n64" => Some("Nintendo - Nintendo 64"),
        "nds" => Some("Nintendo - Nintendo DS"),
        "genesis" | "megadrive" => Some("Sega - Mega Drive - Genesis"),
        "mastersystem" => Some("Sega - Master System - Mark III"),
        "gamegear" => Some("Sega - Game Gear"),
        "segacd" => Some("Sega - Mega-CD - Sega CD"),
        "sega32x" => Some("Sega - 32X"),
        "saturn" => Some("Sega - Saturn"),
        "dreamcast" => Some("Sega - Dreamcast"),
        "psx" => Some("Sony - PlayStation"),
        "psp" => Some("Sony - PlayStation Portable"),
        "pcengine" => Some("NEC - PC Engine - TurboGrafx 16"),
        "neogeo" => Some("SNK - Neo Geo"),
        "atari2600" => Some("Atari - 2600"),
        "atari7800" => Some("Atari - 7800"),
        "atarilynx" => Some("Atari - Lynx"),
        "coleco" => Some("Coleco - ColecoVision"),
        "wonderswan" => Some("Bandai - WonderSwan"),
        "wonderswancolor" => Some("Bandai - WonderSwan Color"),
        "ngp" => Some("SNK - Neo Geo Pocket"),
        "ngpc" => Some("SNK - Neo Geo Pocket Color"),
        "vectrex" => Some("GCE - Vectrex"),
        "virtualboy" => Some("Nintendo - Virtual Boy"),
        "fds" => Some("Nintendo - Famicom Disk System"),
        "pokemonmini" => Some("Nintendo - Pokemon Mini"),
        _ => None,
    }
}

// ── ROM scanning ────────────────────────────────────────────────────────────

fn scan_rom_directory(rom_dir: &std::path::Path, data_dir: &std::path::Path) -> GameLibrary {
    let meta = system_metadata();
    let mut systems = Vec::new();
    let mut games: HashMap<String, Vec<GameInfo>> = HashMap::new();
    let skip_dirs = [
        "bios", "themes", "images", "tools", "backup", "ports", "videos",
        "movies", "launchimages", "bgmusic", "music", "EUMONBMP.SYS",
    ];

    let entries_result = std::fs::read_dir(rom_dir);
    let mut entries: Vec<_> = match entries_result {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect(),
        Err(e) => {
            warn!("Failed to read ROM directory {}: {}", rom_dir.display(), e);
            return GameLibrary::default();
        }
    };
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if skip_dirs.contains(&dir_name.as_str()) { continue; }

        let system_meta = meta.get(dir_name.as_str());
        let system_name = system_meta.map(|m| m.name.to_string()).unwrap_or_else(|| dir_name.clone());
        let core = system_meta.map(|m| m.core).unwrap_or("auto");
        let extensions: Vec<&str> = system_meta.map(|m| m.extensions.to_vec()).unwrap_or_else(|| vec!["zip", "7z"]);

        let mut system_games = Vec::new();
        let dir_path = entry.path();

        for file_entry in WalkDir::new(&dir_path).max_depth(1).into_iter().filter_map(|e| e.ok()) {
            let path = file_entry.path();
            if !path.is_file() { continue; }

            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if file_name.starts_with('.') { continue; }

            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let skip_ext = ["txt", "cfg", "xml", "ini", "sav", "srm", "png", "jpg", "svg", "nv", "hi", "wav", "mp3", "mp4"];
            if skip_ext.contains(&ext.as_str()) { continue; }
            if !extensions.contains(&ext.as_str()) { continue; }

            let game_name = clean_game_name(&file_name);
            let image_dir = dir_path.join("images");
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let has_image = image_dir.join(format!("{}.png", &stem)).exists()
                || image_dir.join(format!("{}.jpg", &stem)).exists();
            let image_path = if has_image {
                Some(format!("/api/images/{}/{}", &dir_name, &stem))
            } else { None };

            system_games.push(GameInfo {
                id: format!("{}:{}", &dir_name, &file_name),
                name: game_name, file: file_name,
                system: dir_name.clone(), has_image, image_path,
            });
        }

        system_games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        if !system_games.is_empty() {
            let count = system_games.len();
            let cover_image = pick_system_cover(&system_games, data_dir, &dir_name);
            systems.push(SystemInfo { id: dir_name.clone(), name: system_name, game_count: count, core, cover_image });
            games.insert(dir_name, system_games);
        }
    }

    systems.sort_by(|a, b| b.game_count.cmp(&a.game_count));
    info!("Scanned {} systems with {} total games", systems.len(), games.values().map(|g| g.len()).sum::<usize>());
    GameLibrary { systems, games }
}

fn system_art_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("system-art")
}

fn system_art_path(data_dir: &std::path::Path, system: &str) -> Option<PathBuf> {
    let dir = system_art_dir(data_dir);
    let png = dir.join(format!("{}.png", system));
    if png.exists() { return Some(png); }
    let jpg = dir.join(format!("{}.jpg", system));
    if jpg.exists() { return Some(jpg); }
    None
}

fn pick_system_cover(games: &[GameInfo], data_dir: &std::path::Path, system_id: &str) -> Option<String> {
    if system_art_path(data_dir, system_id).is_some() {
        return Some(format!("/api/system-art/{}", system_id));
    }
    let with_images: Vec<&GameInfo> = games.iter().filter(|g| g.has_image).collect();
    if with_images.is_empty() { return None; }
    with_images[with_images.len() / 2].image_path.clone()
}

fn clean_game_name(filename: &str) -> String {
    let name = std::path::Path::new(filename).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let mut cleaned = name;
    // Remove parenthesized tags like (USA), (Rev 1), (En,Fr), etc.
    if let Some(idx) = cleaned.find(" (") { cleaned = cleaned[..idx].to_string(); }
    if let Some(idx) = cleaned.find(" [") { cleaned = cleaned[..idx].to_string(); }
    if let Some(idx) = cleaned.find(" # ") { cleaned = cleaned[..idx].to_string(); }
    if cleaned.starts_with("Vi-") { cleaned = cleaned[3..].to_string(); }
    // Remove leading article numbers like "0001 - " common in No-Intro sets
    let re_num_prefix = Regex::new(r"^\d{3,4}\s*-\s*").unwrap();
    cleaned = re_num_prefix.replace(&cleaned, "").to_string();
    // Remove trailing ", The" and prepend "The " for better search
    if cleaned.ends_with(", The") {
        cleaned = format!("The {}", &cleaned[..cleaned.len() - 5]);
    }
    // Replace underscores and multiple spaces
    cleaned = cleaned.replace('_', " ");
    let re_multi_space = Regex::new(r"\s{2,}").unwrap();
    cleaned = re_multi_space.replace_all(&cleaned, " ").to_string();
    cleaned.trim().to_string()
}

// ── Settings persistence ────────────────────────────────────────────────────

fn settings_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn load_settings(data_dir: &std::path::Path, default_rom_dir: &str) -> AppSettings {
    let path = settings_path(data_dir);
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_else(|_| {
            let mut s = AppSettings::default();
            s.rom_dir = default_rom_dir.to_string();
            s
        }),
        Err(_) => {
            let mut s = AppSettings::default();
            s.rom_dir = default_rom_dir.to_string();
            s
        }
    };
    // Migrate legacy single scrape_source → scrape_sources
    if settings.scrape_sources.is_empty() {
        if let Some(old) = settings.scrape_source.take() {
            if !old.is_empty() {
                settings.scrape_sources = vec![old];
            } else {
                settings.scrape_sources = default_scrape_sources();
            }
        } else {
            settings.scrape_sources = default_scrape_sources();
        }
    }
    settings
}

fn save_settings(data_dir: &std::path::Path, settings: &AppSettings) {
    let path = settings_path(data_dir);
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

// ── Metadata persistence ────────────────────────────────────────────────────

fn metadata_dir(data_dir: &std::path::Path, system: &str) -> PathBuf {
    data_dir.join("metadata").join(system)
}

fn load_metadata(data_dir: &std::path::Path, system: &str, game_name: &str) -> Option<GameMetadata> {
    let path = metadata_dir(data_dir, system).join(format!("{}.json", sanitize_filename(game_name)));
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_metadata(data_dir: &std::path::Path, system: &str, game_name: &str, meta: &GameMetadata) {
    let dir = metadata_dir(data_dir, system);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", sanitize_filename(game_name)));
    if let Ok(json) = serde_json::to_string_pretty(meta) {
        let _ = std::fs::write(path, json);
    }
}

fn sanitize_filename(name: &str) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect()
}

// ── Playtime persistence ────────────────────────────────────────────────────

fn playtime_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("playtime.json")
}

fn load_playtime(data_dir: &std::path::Path) -> HashMap<String, PlaytimeStats> {
    let path = playtime_path(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_playtime(data_dir: &std::path::Path, playtime: &HashMap<String, PlaytimeStats>) {
    let path = playtime_path(data_dir);
    if let Ok(json) = serde_json::to_string_pretty(playtime) {
        let _ = std::fs::write(path, json);
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Collections persistence ────────────────────────────────────────────────

fn collections_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("collections.json")
}

fn load_collections(data_dir: &std::path::Path) -> Vec<Collection> {
    let path = collections_path(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_collections(data_dir: &std::path::Path, collections: &[Collection]) {
    let path = collections_path(data_dir);
    if let Ok(json) = serde_json::to_string_pretty(collections) {
        let _ = std::fs::write(path, json);
    }
}

// ── Game launch config persistence ─────────────────────────────────────────

fn game_config_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("game-configs.json")
}

fn load_game_configs(data_dir: &std::path::Path) -> HashMap<String, GameLaunchConfig> {
    let path = game_config_path(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_game_configs(data_dir: &std::path::Path, configs: &HashMap<String, GameLaunchConfig>) {
    let path = game_config_path(data_dir);
    if let Ok(json) = serde_json::to_string_pretty(configs) {
        let _ = std::fs::write(path, json);
    }
}

// ── Hidden games persistence ───────────────────────────────────────────────

fn hidden_games_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("hidden-games.json")
}

fn load_hidden_games(data_dir: &std::path::Path) -> HashSet<String> {
    let path = hidden_games_path(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_hidden_games(data_dir: &std::path::Path, hidden: &HashSet<String>) {
    let path = hidden_games_path(data_dir);
    if let Ok(json) = serde_json::to_string_pretty(hidden) {
        let _ = std::fs::write(path, json);
    }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn get_systems(State(state): State<AppState>) -> Json<Vec<SystemInfo>> {
    Json(state.inner.library.read().await.systems.clone())
}

async fn get_games(State(state): State<AppState>, Query(params): Query<GamesQuery>) -> Json<Vec<GameInfo>> {
    let lib = state.inner.library.read().await;
    let mut results: Vec<GameInfo> = if let Some(system) = &params.system {
        lib.games.get(system).cloned().unwrap_or_default()
    } else {
        lib.games.values().flatten().cloned().collect()
    };
    if !params.include_hidden {
        let hidden = state.inner.hidden_games.read().await;
        if !hidden.is_empty() {
            results.retain(|g| !hidden.contains(&g.id));
        }
    }
    if let Some(search) = &params.search {
        let s = search.to_lowercase();
        results.retain(|g| g.name.to_lowercase().contains(&s));
    }
    Json(results)
}

async fn serve_rom(State(state): State<AppState>, Path((system, file)): Path<(String, String)>, headers: HeaderMap) -> impl IntoResponse {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let decoded_file = percent_decode_str(&file).decode_utf8_lossy().to_string();
    let file_path = rom_dir.join(&system).join(&decoded_file);

    if !file_path.exists() || !file_path.starts_with(&rom_dir) {
        return Err((StatusCode::NOT_FOUND, "ROM not found"));
    }

    let metadata = fs::metadata(&file_path).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"))?;
    let file_size = metadata.len();

    if let Some(range_header) = headers.get(header::RANGE) {
        let range_str = range_header.to_str().unwrap_or("");
        if let Some(range) = parse_range(range_str, file_size) {
            let bytes = read_file_range(&file_path, range.0, range.1).await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file range"))?;
            let content_range = format!("bytes {}-{}/{}", range.0, range.1, file_size);
            return Ok((StatusCode::PARTIAL_CONTENT, [
                (header::CONTENT_TYPE, content_type_for_file(&decoded_file)),
                (header::CONTENT_RANGE, content_range),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_LENGTH, bytes.len().to_string()),
            ], bytes));
        }
    }

    let bytes = fs::read(&file_path).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"))?;
    Ok((StatusCode::OK, [
        (header::CONTENT_TYPE, content_type_for_file(&decoded_file)),
        (header::CONTENT_RANGE, String::new()),
        (header::ACCEPT_RANGES, "bytes".to_string()),
        (header::CONTENT_LENGTH, bytes.len().to_string()),
    ], bytes))
}

async fn serve_bios(State(state): State<AppState>, Path(file): Path<String>) -> impl IntoResponse {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let decoded_file = percent_decode_str(&file).decode_utf8_lossy().to_string();
    let file_path = rom_dir.join("bios").join(&decoded_file);
    if !file_path.exists() || !file_path.starts_with(&rom_dir) {
        return Err((StatusCode::NOT_FOUND, "BIOS not found"));
    }
    let bytes = fs::read(&file_path).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read BIOS"))?;
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, "application/octet-stream".to_string())], bytes))
}

async fn serve_image(State(state): State<AppState>, Path((system, name)): Path<(String, String)>) -> impl IntoResponse {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let decoded_name = percent_decode_str(&name).decode_utf8_lossy().to_string();
    let image_dir = rom_dir.join(&system).join("images");
    let png_path = image_dir.join(format!("{}.png", &decoded_name));
    let jpg_path = image_dir.join(format!("{}.jpg", &decoded_name));
    let (file_path, content_type) = if png_path.exists() { (png_path, "image/png") }
        else if jpg_path.exists() { (jpg_path, "image/jpeg") }
        else { return Err((StatusCode::NOT_FOUND, "Image not found")); };
    if !file_path.starts_with(&rom_dir) { return Err((StatusCode::FORBIDDEN, "Access denied")); }
    let bytes = fs::read(&file_path).await.map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read image"))?;
    Ok((StatusCode::OK, [
        (header::CONTENT_TYPE, content_type.to_string()),
        (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
    ], bytes))
}

// ── Settings endpoints ──────────────────────────────────────────────────────

async fn get_settings(State(state): State<AppState>) -> Json<AppSettings> {
    Json(state.inner.settings.read().await.clone())
}

async fn update_settings(State(state): State<AppState>, Json(new_settings): Json<AppSettings>) -> impl IntoResponse {
    let rom_dir_changed = {
        let current = state.inner.settings.read().await;
        current.rom_dir != new_settings.rom_dir
    };

    {
        let mut settings = state.inner.settings.write().await;
        *settings = new_settings.clone();
        save_settings(&state.inner.data_dir, &settings);
    }

    if rom_dir_changed {
        let new_path = PathBuf::from(&new_settings.rom_dir);
        if new_path.exists() {
            let library = scan_rom_directory(&new_path, &state.inner.data_dir);
            *state.inner.rom_dir.write().await = new_path;
            *state.inner.library.write().await = library;
            info!("ROM directory changed to: {}", new_settings.rom_dir);
        } else {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ROM directory not found"}))).into_response();
        }
    }

    (StatusCode::OK, Json(serde_json::json!({"status": "ok"}))).into_response()
}

async fn rescan_roms(State(state): State<AppState>) -> Json<serde_json::Value> {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    let system_count = library.systems.len();
    let game_count: usize = library.games.values().map(|g| g.len()).sum();
    *state.inner.library.write().await = library;
    Json(serde_json::json!({
        "status": "ok",
        "systems": system_count,
        "games": game_count
    }))
}

// ── BIOS status ─────────────────────────────────────────────────────────────

async fn get_bios_status(State(state): State<AppState>) -> Json<Vec<BiosStatus>> {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let bios_dir = rom_dir.join("bios");
    let defs = bios_definitions();

    let statuses: Vec<BiosStatus> = defs.into_iter().map(|(system, name, files)| {
        BiosStatus {
            system: system.to_string(),
            system_name: name.to_string(),
            required: files.into_iter().map(|(file, desc)| {
                BiosFile {
                    file: file.to_string(),
                    found: bios_dir.join(file).exists(),
                    description: desc.to_string(),
                }
            }).collect(),
        }
    }).collect();

    Json(statuses)
}

// ── Metadata endpoints ──────────────────────────────────────────────────────

async fn get_metadata(State(state): State<AppState>, Path((system, game)): Path<(String, String)>) -> Json<serde_json::Value> {
    let decoded = percent_decode_str(&game).decode_utf8_lossy().to_string();
    match load_metadata(&state.inner.data_dir, &system, &decoded) {
        Some(meta) => Json(serde_json::to_value(meta).unwrap_or_default()),
        None => Json(serde_json::json!(null)),
    }
}

// ── Metadata scrapers ────────────────────────────────────────────────────────

/// Map system_id to a RAWG platform slug for search filtering.
fn rawg_platform_id(system_id: &str) -> Option<u32> {
    match system_id {
        "nes" | "famicom" => Some(49),
        "snes" | "sfc" => Some(79),
        "gb" => Some(26),
        "gbc" => Some(43),
        "gba" => Some(24),
        "n64" => Some(83),
        "nds" => Some(9),
        "genesis" | "megadrive" => Some(167),
        "mastersystem" => Some(11),
        "gamegear" => Some(77),
        "segacd" => Some(119),
        "sega32x" => Some(117),
        "saturn" => Some(107),
        "dreamcast" => Some(106),
        "psx" => Some(27),
        "psp" => Some(17),
        "neogeo" => Some(12),
        "arcade" | "cps1" | "cps2" | "cps3" | "fbneo" | "mame" => Some(166),
        "atari2600" => Some(31),
        "atari7800" => Some(28),
        "atarilynx" => Some(46),
        "pcengine" | "pcenginecd" => Some(105),
        "wonderswan" | "wonderswancolor" => Some(57),
        "ngp" | "ngpc" => Some(12),
        "virtualboy" => Some(48),
        _ => None,
    }
}

/// Fetch metadata from RAWG.io (free, no API key required for low volume).
async fn try_rawg_metadata(
    client: &reqwest::Client,
    game_name: &str,
    system_id: &str,
    api_key: Option<&str>,
) -> Result<GameMetadata, String> {
    let key = api_key.filter(|k| !k.is_empty()).ok_or("No RAWG API key configured")?;
    let platform_filter = rawg_platform_id(system_id)
        .map(|id| format!("&platforms={}", id))
        .unwrap_or_default();
    let url = format!(
        "https://api.rawg.io/api/games?key={}&search={}&page_size=1{}",
        urlenc(key),
        urlenc(game_name),
        platform_filter
    );

    let resp: serde_json::Value = client
        .get(&url)
        .header("User-Agent", "RetroWeb/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("RAWG request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("RAWG JSON failed: {}", e))?;

    let game = resp["results"]
        .as_array()
        .and_then(|a| a.first())
        .ok_or("No RAWG results")?;

    let description = game["description_raw"].as_str().or(game["description"].as_str()).map(|s| {
        // Strip HTML tags if present
        let re = Regex::new(r"<[^>]+>").unwrap();
        let cleaned = re.replace_all(s, "").to_string();
        if cleaned.len() > 500 { format!("{}...", &cleaned[..500]) } else { cleaned }
    });

    let genres = game["genres"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|g| g["name"].as_str()).collect::<Vec<_>>().join(", "));

    let publishers = game["publishers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|p| p["name"].as_str()).collect::<Vec<_>>().join(", "));

    let developers = game["developers"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|d| d["name"].as_str()).collect::<Vec<_>>().join(", "));

    let release_year = game["released"].as_str().map(|s| s[..4].to_string());

    let rating = game["rating"].as_f64().map(|r| r as f32);

    // If we got basically nothing useful, treat as failure
    if description.is_none() && genres.is_none() && release_year.is_none() {
        return Err("RAWG result has no useful data".to_string());
    }

    // RAWG basic search doesn't return publishers/developers — fetch detail if we have a slug
    let (detail_publishers, detail_developers, detail_description) = if let Some(slug) = game["slug"].as_str() {
        let detail_url = format!("https://api.rawg.io/api/games/{}?key={}", urlenc(slug), urlenc(key));
        if let Ok(detail) = client
            .get(&detail_url)
            .header("User-Agent", "RetroWeb/1.0")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .and_then(|r| Ok(r))
        {
            if let Ok(d) = detail.json::<serde_json::Value>().await {
                let dp = d["publishers"].as_array().map(|arr| arr.iter().filter_map(|p| p["name"].as_str()).collect::<Vec<_>>().join(", "));
                let dd = d["developers"].as_array().map(|arr| arr.iter().filter_map(|p| p["name"].as_str()).collect::<Vec<_>>().join(", "));
                let desc = d["description_raw"].as_str().map(|s| {
                    if s.len() > 500 { format!("{}...", &s[..500]) } else { s.to_string() }
                });
                (dp, dd, desc)
            } else { (None, None, None) }
        } else { (None, None, None) }
    } else { (None, None, None) };

    Ok(GameMetadata {
        description: detail_description.or(description),
        developer: detail_developers.or(developers),
        publisher: detail_publishers.or(publishers),
        genre: genres,
        release_year,
        players: None,
        rating,
    })
}

/// Map system_id to ScreenScraper systemeid.
fn screenscraper_system_id(system_id: &str) -> Option<u32> {
    match system_id {
        "nes" | "famicom" => Some(3),
        "snes" | "sfc" => Some(4),
        "gb" => Some(9),
        "gbc" => Some(10),
        "gba" => Some(12),
        "n64" => Some(14),
        "nds" => Some(15),
        "genesis" | "megadrive" => Some(1),
        "mastersystem" => Some(2),
        "gamegear" => Some(21),
        "segacd" => Some(20),
        "sega32x" => Some(19),
        "saturn" => Some(22),
        "dreamcast" => Some(23),
        "psx" => Some(57),
        "psp" => Some(61),
        "neogeo" => Some(142),
        "arcade" | "cps1" | "cps2" | "cps3" | "fbneo" | "mame" => Some(75),
        "atari2600" => Some(26),
        "atari7800" => Some(41),
        "atarilynx" => Some(28),
        "pcengine" => Some(31),
        "pcenginecd" => Some(114),
        "wonderswan" => Some(45),
        "wonderswancolor" => Some(46),
        "ngp" => Some(25),
        "ngpc" => Some(82),
        "virtualboy" => Some(11),
        "vectrex" => Some(102),
        "coleco" => Some(48),
        "pokemonmini" => Some(211),
        "fds" => Some(106),
        _ => None,
    }
}

/// Fetch metadata from ScreenScraper.fr (requires username/password).
async fn try_screenscraper_metadata(
    client: &reqwest::Client,
    game_name: &str,
    system_id: &str,
    username: &str,
    password: &str,
) -> Result<GameMetadata, String> {
    let ss_system = screenscraper_system_id(system_id)
        .ok_or_else(|| format!("No ScreenScraper mapping for system '{}'", system_id))?;

    let url = format!(
        "https://www.screenscraper.fr/api2/jeuInfos.php?devid=retroweb&devpassword=retroweb&softname=retroweb&output=json&ssid={}&sspassword={}&systemeid={}&romnom={}.zip",
        urlenc(username),
        urlenc(password),
        ss_system,
        urlenc(game_name)
    );

    let resp: serde_json::Value = client
        .get(&url)
        .header("User-Agent", "RetroWeb/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("ScreenScraper request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("ScreenScraper JSON failed: {}", e))?;

    let jeu = resp.get("response").and_then(|r| r.get("jeu"))
        .ok_or("No game data in ScreenScraper response")?;

    // Extract localized text (prefer English, fallback to first available)
    let extract_text = |obj: &serde_json::Value| -> Option<String> {
        if let Some(arr) = obj.as_array() {
            // Try English first
            for item in arr {
                if item["langue"].as_str() == Some("en") {
                    return item["text"].as_str().map(|s| s.to_string());
                }
            }
            // Fallback to first
            arr.first().and_then(|item| item["text"].as_str().map(|s| s.to_string()))
        } else {
            obj.as_str().map(|s| s.to_string())
        }
    };

    let description = jeu.get("synopsis").and_then(|s| extract_text(s)).map(|s| {
        if s.len() > 500 { format!("{}...", &s[..500]) } else { s }
    });

    let developer = jeu.get("developpeur").and_then(|d| d["text"].as_str().map(|s| s.to_string()));
    let publisher = jeu.get("editeur").and_then(|e| e["text"].as_str().map(|s| s.to_string()));

    let genre = jeu.get("genres").and_then(|g| {
        g["genres_en"].as_array().map(|arr| {
            arr.iter().filter_map(|item| item["nomgenre"].as_str()).collect::<Vec<_>>().join(", ")
        })
    }).or_else(|| jeu.get("genres").and_then(|g| extract_text(g)));

    let release_year = jeu.get("dates").and_then(|d| {
        if let Some(arr) = d.as_array() {
            arr.iter()
                .find(|item| item["region"].as_str() == Some("wor") || item["region"].as_str() == Some("us"))
                .or(arr.first())
                .and_then(|item| item["text"].as_str())
                .map(|s| s[..4.min(s.len())].to_string())
        } else { None }
    });

    let players = jeu.get("joueurs").and_then(|j| j["text"].as_str().map(|s| s.to_string()));

    let rating = jeu.get("note").and_then(|n| n["text"].as_str())
        .and_then(|s| s.parse::<f32>().ok())
        .map(|r| r / 20.0); // ScreenScraper uses 0-20 scale, normalize to 0-5

    if description.is_none() && genre.is_none() && release_year.is_none() {
        return Err("ScreenScraper result has no useful data".to_string());
    }

    Ok(GameMetadata {
        description,
        developer,
        publisher,
        genre,
        release_year,
        players,
        rating,
    })
}

/// Try fetching metadata: RAWG first (free), then ScreenScraper (if credentials provided).
async fn try_fetch_game_metadata(
    client: &reqwest::Client,
    game_name: &str,
    system_id: &str,
    ss_user: Option<&str>,
    ss_pass: Option<&str>,
    rawg_key: Option<&str>,
) -> Result<(GameMetadata, &'static str), String> {
    let mut errors = Vec::new();

    // Try ScreenScraper first (better for retro games, more accurate matching)
    if let (Some(user), Some(pass)) = (ss_user, ss_pass) {
        if !user.is_empty() && !pass.is_empty() {
            match try_screenscraper_metadata(client, game_name, system_id, user, pass).await {
                Ok(meta) => return Ok((meta, "ScreenScraper")),
                Err(e) => errors.push(format!("ScreenScraper: {}", e)),
            }
        }
    }

    // Fallback: RAWG.io (needs API key)
    match try_rawg_metadata(client, game_name, system_id, rawg_key).await {
        Ok(meta) => return Ok((meta, "RAWG")),
        Err(e) => errors.push(format!("RAWG: {}", e)),
    }

    Err(format!("No metadata found: {}", errors.join("; ")))
}

// ── SSE Metadata scrape with progress ────────────────────────────────────────

async fn scrape_info_stream(State(state): State<AppState>, Path(system): Path<String>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);
    let state_clone = state.clone();

    tokio::spawn(async move {
        let lib = state_clone.inner.library.read().await;
        let games = match lib.games.get(&system) {
            Some(g) => g.clone(),
            None => {
                let _ = tx.send(serde_json::json!({"type":"error","message":"System not found"}).to_string()).await;
                return;
            }
        };
        drop(lib);

        let settings = state_clone.inner.settings.read().await.clone();
        let delay_ms = settings.scrape_delay_ms.unwrap_or(100);
        let ss_user = settings.screenscraper_user.clone();
        let ss_pass = settings.screenscraper_pass.clone();
        let rawg_key = settings.rawg_api_key.clone();

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        let total = games.len();
        let mut scraped = 0usize;
        let mut already_have = 0usize;
        let mut not_found = 0usize;
        let errors = 0usize;
        let data_dir = state_clone.inner.data_dir.clone();

        let _ = tx.send(serde_json::json!({"type":"start","total":total,"system":&system}).to_string()).await;

        for (idx, game) in games.iter().enumerate() {
            let clean_name = clean_game_name(&game.file);

            // Check if we already have metadata
            if let Some(_existing) = load_metadata(&data_dir, &system, &clean_name) {
                already_have += 1;
                let _ = tx.send(serde_json::json!({
                    "type":"progress","index":idx+1,"total":total,
                    "game":&game.name,"status":"already_have",
                    "message": format!("Already have: {}", game.name)
                }).to_string()).await;
                continue;
            }

            match try_fetch_game_metadata(
                &client,
                &clean_name,
                &system,
                ss_user.as_deref(),
                ss_pass.as_deref(),
                rawg_key.as_deref(),
            ).await {
                Ok((meta, source)) => {
                    save_metadata(&data_dir, &system, &clean_name, &meta);
                    scraped += 1;
                    let _ = tx.send(serde_json::json!({
                        "type":"progress","index":idx+1,"total":total,
                        "game":&game.name,"status":"downloaded",
                        "message": format!("Fetched: {} ({})", game.name, source)
                    }).to_string()).await;
                }
                Err(_) => {
                    not_found += 1;
                    let _ = tx.send(serde_json::json!({
                        "type":"progress","index":idx+1,"total":total,
                        "game":&game.name,"status":"not_found",
                        "message": format!("Not found: {}", game.name)
                    }).to_string()).await;
                }
            }

            // Respect rate limits — RAWG is generous but ScreenScraper is strict
            let effective_delay = delay_ms.max(200);
            tokio::time::sleep(std::time::Duration::from_millis(effective_delay)).await;
        }

        let _ = tx.send(serde_json::json!({
            "type":"done",
            "total":total,"scraped":scraped,
            "not_found":not_found,"errors":errors,
            "already_have":already_have
        }).to_string()).await;
    });

    let stream = ReceiverStream::new(rx).map(|msg| Ok(Event::default().data(msg)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── Thumbnail scraper ───────────────────────────────────────────────────────

static RE_VERSION_PAREN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\s*\((?:VN|vn|v|V)\s*[\d.]+[^)]*\)\s*$").unwrap()
});
static RE_VERSION_BARE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\s+v?\d+\.\d+\s*$").unwrap()
});

/// Clean ROM filename stem for libretro thumbnail lookup.
/// Strips site watermark suffixes like " - NamRetro.com" while keeping region tags like "(USA)".
fn clean_thumb_name(stem: &str) -> String {
    let mut name = stem.to_string();
    // Strip site watermark suffix (e.g., " - NamRetro.com")
    if let Some(pos) = name.rfind(" - ") {
        let after = &name[pos + 3..];
        if after.contains('.') || !after.contains('(') {
            let before = &name[..pos];
            if before.contains('(') {
                name = before.to_string();
            }
        }
    }
    // Strip GoodTools flags like [!], [b], [h], [o1], [T+Eng], etc.
    let re_brackets = Regex::new(r"\s*\[[^\]]*\]").unwrap();
    name = re_brackets.replace_all(&name, "").trim().to_string();
    // Expand region shorthands to full names for libretro matching
    name = name.replace("(U)", "(USA)")
               .replace("(J)", "(Japan)")
               .replace("(E)", "(Europe)")
               .replace("(W)", "(World)")
               .replace("(UE)", "(USA, Europe)")
               .replace("(JU)", "(Japan, USA)");
    name.replace('&', "_")
}

/// Extract just the core game name (no region, flags, or suffixes).
fn bare_game_name(stem: &str) -> String {
    let cleaned = clean_thumb_name(stem);
    let mut name = cleaned;
    if let Some(idx) = name.find(" (") { name = name[..idx].to_string(); }
    name.trim().to_string()
}

/// Generate multiple name variants for smart thumbnail matching.
fn generate_thumb_variants(stem: &str) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();

    // Step A: cleaned name (strips site suffix, GoodTools flags, expands regions)
    let base = clean_thumb_name(stem);
    variants.push(base.clone());

    // Step B: strip Vietnamese prefixes
    let vn_prefixes = ["-Viet Hoa ", "-Viet hoa ", "Viet Hoa ", "-VietHoa ", "Vi-"];
    let mut stripped = base.clone();
    for prefix in &vn_prefixes {
        if let Some(rest) = stripped.strip_prefix(prefix) {
            stripped = rest.to_string();
            break;
        }
    }

    // Step C: strip Vietnamese suffixes
    let vn_suffixes = ["_Vietnamese", " Vietnamese", "_VN", " VN", "_vn", " vn", " -Vietnamese"];
    for suffix in &vn_suffixes {
        if let Some(rest) = stripped.strip_suffix(suffix) {
            stripped = rest.to_string();
            break;
        }
    }

    // Step D: replace underscores with spaces
    let with_spaces = stripped.replace('_', " ");
    if with_spaces != base { variants.push(with_spaces.clone()); }
    if stripped != base && stripped != with_spaces { variants.push(stripped.clone()); }

    // Step E: strip version parentheticals like (VN 1.02)
    let current = variants.clone();
    for v in &current {
        let v2 = RE_VERSION_PAREN.replace(v, "").trim().to_string();
        if !v2.is_empty() && v2 != *v { variants.push(v2); }
        let v3 = RE_VERSION_BARE.replace(v, "").trim().to_string();
        if !v3.is_empty() && v3 != *v { variants.push(v3); }
    }

    // Step F: bare name only (e.g., "Jackal") as a high-priority fallback
    let bare = bare_game_name(stem);
    if !bare.is_empty() && !variants.contains(&bare) {
        variants.push(bare.clone());
    }

    // Step G: for variants without region tag, try common regions
    let regions = ["(USA)", "(Japan)", "(Europe)", "(World)"];
    let current = variants.clone();
    for v in &current {
        if !v.contains('(') {
            for region in &regions {
                variants.push(format!("{} {}", v.trim(), region));
            }
        }
    }

    // Deduplicate preserving order
    let mut seen = HashSet::new();
    variants.retain(|v| {
        let t = v.trim().to_string();
        if t.is_empty() { return false; }
        seen.insert(t)
    });
    variants
}

/// Try downloading a thumbnail from multiple sources, trying each name variant.
/// Returns (bytes, source_index, matched_variant) on success.
async fn try_download_thumbnail(
    client: &reqwest::Client,
    sources: &[String],
    lr_system: &str,
    variants: &[String],
) -> Result<(Vec<u8>, usize, String), String> {
    for variant in variants {
        for (idx, source) in sources.iter().enumerate() {
            let base = source.trim_end_matches('/');
            let url = format!("{}/{}/Named_Boxarts/{}.png", base, urlenc(lr_system), urlenc(variant));
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.bytes().await {
                        Ok(bytes) if bytes.len() > 100 => return Ok((bytes.to_vec(), idx, variant.clone())),
                        _ => continue,
                    }
                }
                _ => continue,
            }
        }
    }
    Err(format!("Not found: {} variants x {} sources", variants.len(), sources.len()))
}

/// Extract DuckDuckGo vqd token from HTML page.
fn extract_vqd(html: &str) -> Option<String> {
    for pattern in &["vqd='", "vqd=\"", "vqd="] {
        if let Some(start) = html.find(pattern) {
            let after = &html[start + pattern.len()..];
            if let Some(end) = after.find(|c: char| c == '\'' || c == '"' || c == '&' || c == ';') {
                let token = &after[..end];
                if !token.is_empty() { return Some(token.to_string()); }
            }
        }
    }
    None
}

/// Fallback: search DuckDuckGo images for game box art.
async fn try_ddg_image_fallback(
    client: &reqwest::Client,
    game_name: &str,
    system_name: &str,
) -> Result<Vec<u8>, String> {
    let query = format!("{} {} box art", game_name, system_name);
    let encoded = urlenc(&query);

    // Step 1: get vqd token
    let html_url = format!("https://duckduckgo.com/?q={}&iax=images&ia=images", encoded);
    let html = client.get(&html_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .send().await.map_err(|e| format!("DDG request failed: {}", e))?
        .text().await.map_err(|e| format!("DDG read failed: {}", e))?;

    let vqd = extract_vqd(&html).ok_or_else(|| "Could not extract DDG vqd token".to_string())?;

    // Step 2: query image API
    let api_url = format!(
        "https://duckduckgo.com/i.js?l=us-en&o=json&q={}&vqd={}&f=,,,,,&p=1",
        encoded, urlenc(&vqd)
    );
    let json: serde_json::Value = client.get(&api_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .header("Referer", "https://duckduckgo.com/")
        .send().await.map_err(|e| format!("DDG API failed: {}", e))?
        .json().await.map_err(|e| format!("DDG JSON parse failed: {}", e))?;

    // Step 3: try first few image results
    let results = json["results"].as_array().ok_or("No DDG results")?;
    for result in results.iter().take(5) {
        if let Some(image_url) = result["image"].as_str() {
            match client.get(image_url)
                .timeout(std::time::Duration::from_secs(8))
                .send().await
            {
                Ok(resp) if resp.status().is_success() => {
                    let is_image = resp.headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|ct| ct.starts_with("image/"));
                    if !is_image { continue; }
                    match resp.bytes().await {
                        Ok(bytes) if bytes.len() > 100 => return Ok(bytes.to_vec()),
                        _ => continue,
                    }
                }
                _ => continue,
            }
        }
    }
    Err("No suitable image from DuckDuckGo".to_string())
}

async fn scrape_system(State(state): State<AppState>, Path(system): Path<String>) -> Json<ScrapeResult> {
    let lib = state.inner.library.read().await;
    let games = match lib.games.get(&system) {
        Some(g) => g.clone(),
        None => return Json(ScrapeResult { system, total: 0, scraped: 0, skipped: 0, already_have: 0, not_found: 0, errors: 0, messages: vec!["System not found".into()] }),
    };
    drop(lib);

    let lr_system = match libretro_system_name(&system) {
        Some(s) => s,
        None => return Json(ScrapeResult {
            system: system.clone(), total: games.len(), scraped: 0, skipped: games.len(),
            already_have: 0, not_found: 0, errors: 0,
            messages: vec![format!("No libretro thumbnail mapping for system '{}'. This system is not supported for scraping.", system)],
        }),
    };

    let settings = state.inner.settings.read().await.clone();
    let sources = if settings.scrape_sources.is_empty() { default_scrape_sources() } else { settings.scrape_sources.clone() };
    let delay_ms = settings.scrape_delay_ms.unwrap_or(100);
    let ddg_enabled = settings.ddg_fallback;

    let rom_dir = state.inner.rom_dir.read().await.clone();
    let image_dir = rom_dir.join(&system).join("images");
    let _ = std::fs::create_dir_all(&image_dir);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let total = games.len();
    let mut scraped = 0usize;
    let mut skipped = 0usize;
    let mut already_have = 0usize;
    let mut not_found = 0usize;
    let mut errors = 0usize;
    let mut messages: Vec<String> = Vec::new();
    let max_messages = 50;

    for game in &games {
        let stem = std::path::Path::new(&game.file).file_stem().unwrap_or_default().to_string_lossy().to_string();

        if image_dir.join(format!("{}.png", &stem)).exists() || image_dir.join(format!("{}.jpg", &stem)).exists() {
            already_have += 1;
            skipped += 1;
            continue;
        }

        let variants = generate_thumb_variants(&stem);
        match try_download_thumbnail(&client, &sources, lr_system, &variants).await {
            Ok((bytes, _src_idx, _matched)) => {
                let save_path = image_dir.join(format!("{}.png", &stem));
                if fs::write(&save_path, &bytes).await.is_ok() {
                    scraped += 1;
                } else {
                    errors += 1;
                    if messages.len() < max_messages { messages.push(format!("Write failed: {}", stem)); }
                }
            }
            Err(_) => {
                // DDG fallback
                if ddg_enabled {
                    let search_name = variants.iter().find(|v| !v.contains('(')).unwrap_or(&variants[0]).clone();
                    if let Ok(bytes) = try_ddg_image_fallback(&client, &search_name, lr_system).await {
                        let save_path = image_dir.join(format!("{}.png", &stem));
                        if fs::write(&save_path, &bytes).await.is_ok() {
                            scraped += 1;
                        } else {
                            errors += 1;
                        }
                    } else {
                        not_found += 1;
                        skipped += 1;
                    }
                } else {
                    not_found += 1;
                    skipped += 1;
                    if messages.len() < max_messages { messages.push(format!("Not found: {}", game.name)); }
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    if messages.len() == max_messages { messages.push("... (truncated)".into()); }

    // Rescan library to pick up new images
    let rom_dir2 = state.inner.rom_dir.read().await.clone();
    let library = scan_rom_directory(&rom_dir2, &state.inner.data_dir);
    *state.inner.library.write().await = library;

    Json(ScrapeResult { system, total, scraped, skipped, already_have, not_found, errors, messages })
}

fn urlenc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

// ── Browse directories ───────────────────────────────────────────────────────

async fn browse_dirs(Json(req): Json<BrowseRequest>) -> Json<BrowseResponse> {
    let path = PathBuf::from(&req.path);
    let mut dirs = Vec::new();
    let is_valid = path.is_dir();
    if is_valid {
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') {
                        dirs.push(name);
                    }
                }
            }
        }
    }
    dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    let parent = path.parent().map(|p| p.to_string_lossy().to_string());
    Json(BrowseResponse { path: req.path, parent, dirs, is_valid })
}

// ── SSE Rescan with progress ─────────────────────────────────────────────────

fn scan_rom_directory_with_progress(rom_dir: &std::path::Path, data_dir: &std::path::Path, tx: tokio::sync::mpsc::Sender<String>) -> GameLibrary {
    let meta = system_metadata();
    let mut systems = Vec::new();
    let mut games: HashMap<String, Vec<GameInfo>> = HashMap::new();
    let skip_dirs = [
        "bios", "themes", "images", "tools", "backup", "ports", "videos",
        "movies", "launchimages", "bgmusic", "music", "EUMONBMP.SYS",
    ];

    let entries_result = std::fs::read_dir(rom_dir);
    let mut entries: Vec<_> = match entries_result {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect(),
        Err(e) => {
            let _ = tx.blocking_send(serde_json::json!({"type":"error","message":format!("Failed to read ROM directory: {}", e)}).to_string());
            return GameLibrary::default();
        }
    };
    entries.sort_by_key(|e| e.file_name());

    // Filter out skip_dirs to get accurate count
    let scan_entries: Vec<_> = entries.into_iter()
        .filter(|e| !skip_dirs.contains(&e.file_name().to_string_lossy().as_ref()))
        .collect();
    let total_dirs = scan_entries.len();
    let _ = tx.blocking_send(serde_json::json!({"type":"start","total":total_dirs}).to_string());

    for (idx, entry) in scan_entries.iter().enumerate() {
        let dir_name = entry.file_name().to_string_lossy().to_string();

        let system_meta = meta.get(dir_name.as_str());
        let system_name = system_meta.map(|m| m.name.to_string()).unwrap_or_else(|| dir_name.clone());
        let core = system_meta.map(|m| m.core).unwrap_or("auto");
        let extensions: Vec<&str> = system_meta.map(|m| m.extensions.to_vec()).unwrap_or_else(|| vec!["zip", "7z"]);

        let _ = tx.blocking_send(serde_json::json!({
            "type":"scanning",
            "system": &dir_name,
            "name": &system_name,
            "index": idx,
            "total": total_dirs
        }).to_string());

        let mut system_games = Vec::new();
        let dir_path = entry.path();

        for file_entry in WalkDir::new(&dir_path).max_depth(1).into_iter().filter_map(|e| e.ok()) {
            let path = file_entry.path();
            if !path.is_file() { continue; }

            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if file_name.starts_with('.') { continue; }

            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let skip_ext = ["txt", "cfg", "xml", "ini", "sav", "srm", "png", "jpg", "svg", "nv", "hi", "wav", "mp3", "mp4"];
            if skip_ext.contains(&ext.as_str()) { continue; }
            if !extensions.contains(&ext.as_str()) { continue; }

            let game_name = clean_game_name(&file_name);
            let image_dir = dir_path.join("images");
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let has_image = image_dir.join(format!("{}.png", &stem)).exists()
                || image_dir.join(format!("{}.jpg", &stem)).exists();
            let image_path = if has_image {
                Some(format!("/api/images/{}/{}", &dir_name, &stem))
            } else { None };

            system_games.push(GameInfo {
                id: format!("{}:{}", &dir_name, &file_name),
                name: game_name, file: file_name,
                system: dir_name.clone(), has_image, image_path,
            });
        }

        system_games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let count = system_games.len();
        if !system_games.is_empty() {
            let cover_image = pick_system_cover(&system_games, data_dir, &dir_name);
            systems.push(SystemInfo { id: dir_name.clone(), name: system_name.clone(), game_count: count, core, cover_image });
            games.insert(dir_name.clone(), system_games);
        }

        let _ = tx.blocking_send(serde_json::json!({
            "type":"system_done",
            "system": &dir_name,
            "name": &system_name,
            "game_count": count,
            "index": idx + 1,
            "total": total_dirs
        }).to_string());
    }

    systems.sort_by(|a, b| b.game_count.cmp(&a.game_count));
    info!("Scanned {} systems with {} total games", systems.len(), games.values().map(|g| g.len()).sum::<usize>());
    GameLibrary { systems, games }
}

async fn rescan_stream(State(state): State<AppState>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let data_dir = state.inner.data_dir.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);
    let state_clone = state.clone();

    tokio::spawn(async move {
        let tx_clone = tx.clone();
        let library = tokio::task::spawn_blocking(move || {
            scan_rom_directory_with_progress(&rom_dir, &data_dir, tx_clone)
        }).await.unwrap_or_default();

        let system_count = library.systems.len();
        let game_count: usize = library.games.values().map(|g| g.len()).sum();
        *state_clone.inner.library.write().await = library;
        let _ = tx.send(serde_json::json!({
            "type":"done",
            "systems": system_count,
            "games": game_count
        }).to_string()).await;
    });

    let stream = ReceiverStream::new(rx).map(|msg| Ok(Event::default().data(msg)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── SSE Scrape with progress ─────────────────────────────────────────────────

async fn scrape_stream(State(state): State<AppState>, Path(system): Path<String>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);
    let state_clone = state.clone();

    tokio::spawn(async move {
        let lib = state_clone.inner.library.read().await;
        let games = match lib.games.get(&system) {
            Some(g) => g.clone(),
            None => {
                let _ = tx.send(serde_json::json!({"type":"error","message":"System not found"}).to_string()).await;
                return;
            }
        };
        drop(lib);

        let lr_system = match libretro_system_name(&system) {
            Some(s) => s,
            None => {
                let _ = tx.send(serde_json::json!({
                    "type":"error",
                    "message": format!("No libretro thumbnail mapping for '{}'. Scraping not supported.", system)
                }).to_string()).await;
                return;
            }
        };

        let settings = state_clone.inner.settings.read().await.clone();
        let sources = if settings.scrape_sources.is_empty() { default_scrape_sources() } else { settings.scrape_sources.clone() };
        let delay_ms = settings.scrape_delay_ms.unwrap_or(100);
        let ddg_enabled = settings.ddg_fallback;
        let auto_metadata = settings.scrape_metadata;
        let ss_user = settings.screenscraper_user.clone();
        let ss_pass = settings.screenscraper_pass.clone();
        let rawg_key = settings.rawg_api_key.clone();
        let data_dir = state_clone.inner.data_dir.clone();

        let rom_dir = state_clone.inner.rom_dir.read().await.clone();
        let image_dir = rom_dir.join(&system).join("images");
        let _ = std::fs::create_dir_all(&image_dir);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        let total = games.len();
        let mut scraped = 0usize;
        let mut already_have = 0usize;
        let mut not_found = 0usize;
        let mut errors = 0usize;

        let _ = tx.send(serde_json::json!({"type":"start","total":total,"system":&system}).to_string()).await;

        for (idx, game) in games.iter().enumerate() {
            let stem = std::path::Path::new(&game.file).file_stem().unwrap_or_default().to_string_lossy().to_string();
            let clean_name = clean_game_name(&game.file);

            if image_dir.join(format!("{}.png", &stem)).exists() || image_dir.join(format!("{}.jpg", &stem)).exists() {
                already_have += 1;
                // Still try metadata if auto-scrape is on and we don't have it yet
                if auto_metadata && load_metadata(&data_dir, &system, &clean_name).is_none() {
                    if let Ok((meta, _src)) = try_fetch_game_metadata(&client, &clean_name, &system, ss_user.as_deref(), ss_pass.as_deref(), rawg_key.as_deref()).await {
                        save_metadata(&data_dir, &system, &clean_name, &meta);
                    }
                }
                let _ = tx.send(serde_json::json!({
                    "type":"progress","index":idx+1,"total":total,
                    "game":&game.name,"status":"already_have",
                    "message": format!("Already have: {}", game.name)
                }).to_string()).await;
                continue;
            }

            let variants = generate_thumb_variants(&stem);
            match try_download_thumbnail(&client, &sources, lr_system, &variants).await {
                Ok((bytes, src_idx, matched)) => {
                    let save_path = image_dir.join(format!("{}.png", &stem));
                    if fs::write(&save_path, &bytes).await.is_ok() {
                        scraped += 1;
                        let src_label = if sources.len() > 1 { format!(" [source {}]", src_idx + 1) } else { String::new() };
                        let variant_label = if matched != variants[0] { format!(" (as \"{}\")", matched) } else { String::new() };
                        // Auto-scrape metadata if enabled
                        let mut meta_label = String::new();
                        if auto_metadata && load_metadata(&data_dir, &system, &clean_name).is_none() {
                            if let Ok((meta, meta_src)) = try_fetch_game_metadata(&client, &clean_name, &system, ss_user.as_deref(), ss_pass.as_deref(), rawg_key.as_deref()).await {
                                save_metadata(&data_dir, &system, &clean_name, &meta);
                                meta_label = format!(" +info({})", meta_src);
                            }
                        }
                        let _ = tx.send(serde_json::json!({
                            "type":"progress","index":idx+1,"total":total,
                            "game":&game.name,"status":"downloaded",
                            "message": format!("Downloaded: {}{}{}{}", game.name, src_label, variant_label, meta_label)
                        }).to_string()).await;
                    } else {
                        errors += 1;
                        let _ = tx.send(serde_json::json!({
                            "type":"progress","index":idx+1,"total":total,
                            "game":&game.name,"status":"error",
                            "message": format!("Write failed: {}", game.name)
                        }).to_string()).await;
                    }
                }
                Err(_) => {
                    // DDG fallback
                    if ddg_enabled {
                        let search_name = variants.iter().find(|v| !v.contains('(')).unwrap_or(&variants[0]).clone();
                        match try_ddg_image_fallback(&client, &search_name, lr_system).await {
                            Ok(bytes) => {
                                let save_path = image_dir.join(format!("{}.png", &stem));
                                if fs::write(&save_path, &bytes).await.is_ok() {
                                    scraped += 1;
                                    let _ = tx.send(serde_json::json!({
                                        "type":"progress","index":idx+1,"total":total,
                                        "game":&game.name,"status":"downloaded",
                                        "message": format!("Downloaded: {} (DuckDuckGo)", game.name)
                                    }).to_string()).await;
                                } else {
                                    errors += 1;
                                    let _ = tx.send(serde_json::json!({
                                        "type":"progress","index":idx+1,"total":total,
                                        "game":&game.name,"status":"error",
                                        "message": format!("Write failed: {}", game.name)
                                    }).to_string()).await;
                                }
                            }
                            Err(_) => {
                                not_found += 1;
                                let _ = tx.send(serde_json::json!({
                                    "type":"progress","index":idx+1,"total":total,
                                    "game":&game.name,"status":"not_found",
                                    "message": format!("Not found: {} (tried {} variants + DDG)", game.name, variants.len())
                                }).to_string()).await;
                            }
                        }
                    } else {
                        not_found += 1;
                        let _ = tx.send(serde_json::json!({
                            "type":"progress","index":idx+1,"total":total,
                            "game":&game.name,"status":"not_found",
                            "message": format!("Not found: {} ({} variants)", game.name, variants.len())
                        }).to_string()).await;
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        // Rescan library
        let rom_dir2 = state_clone.inner.rom_dir.read().await.clone();
        let library = scan_rom_directory(&rom_dir2, &state_clone.inner.data_dir);
        *state_clone.inner.library.write().await = library;

        let _ = tx.send(serde_json::json!({
            "type":"done",
            "total":total,"scraped":scraped,
            "not_found":not_found,"errors":errors,
            "already_have":already_have
        }).to_string()).await;
    });

    let stream = ReceiverStream::new(rx).map(|msg| Ok(Event::default().data(msg)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ── Single-game scrape endpoints ─────────────────────────────────────────────

#[derive(Deserialize)]
struct SingleGameQuery {
    file: String,
}

/// Scrape art (thumbnail) for a single game
async fn scrape_art_single(
    State(state): State<AppState>,
    Path(system): Path<String>,
    Query(query): Query<SingleGameQuery>,
) -> Json<serde_json::Value> {
    let file = query.file;
    let stem = std::path::Path::new(&file).file_stem().unwrap_or_default().to_string_lossy().to_string();

    let lr_system = match libretro_system_name(&system) {
        Some(s) => s,
        None => return Json(serde_json::json!({"ok":false,"message":"No libretro thumbnail mapping for this system"})),
    };

    let settings = state.inner.settings.read().await.clone();
    let sources = if settings.scrape_sources.is_empty() { default_scrape_sources() } else { settings.scrape_sources.clone() };
    let ddg_enabled = settings.ddg_fallback;

    let rom_dir = state.inner.rom_dir.read().await.clone();
    let image_dir = rom_dir.join(&system).join("images");
    let _ = std::fs::create_dir_all(&image_dir);

    // Check if already exists
    if image_dir.join(format!("{}.png", &stem)).exists() || image_dir.join(format!("{}.jpg", &stem)).exists() {
        return Json(serde_json::json!({"ok":true,"status":"already_have","message":"Art already exists"}));
    }

    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().unwrap_or_default();
    let variants = generate_thumb_variants(&stem);

    match try_download_thumbnail(&client, &sources, lr_system, &variants).await {
        Ok((bytes, _src_idx, matched)) => {
            let save_path = image_dir.join(format!("{}.png", &stem));
            if fs::write(&save_path, &bytes).await.is_ok() {
                // Rescan library to update image_path
                let rom_dir2 = state.inner.rom_dir.read().await.clone();
                let library = scan_rom_directory(&rom_dir2, &state.inner.data_dir);
                *state.inner.library.write().await = library;
                let variant_label = if matched != variants[0] { format!(" (as \"{}\")", matched) } else { String::new() };
                Json(serde_json::json!({"ok":true,"status":"downloaded","message":format!("Downloaded{}",variant_label),"image_path":format!("/api/images/{}/{}",&system,&stem)}))
            } else {
                Json(serde_json::json!({"ok":false,"status":"error","message":"Failed to save image"}))
            }
        }
        Err(_) => {
            if ddg_enabled {
                let search_name = variants.iter().find(|v| !v.contains('(')).unwrap_or(&variants[0]).clone();
                match try_ddg_image_fallback(&client, &search_name, lr_system).await {
                    Ok(bytes) => {
                        let save_path = image_dir.join(format!("{}.png", &stem));
                        if fs::write(&save_path, &bytes).await.is_ok() {
                            let rom_dir2 = state.inner.rom_dir.read().await.clone();
                            let library = scan_rom_directory(&rom_dir2, &state.inner.data_dir);
                            *state.inner.library.write().await = library;
                            Json(serde_json::json!({"ok":true,"status":"downloaded","message":"Downloaded (DuckDuckGo)","image_path":format!("/api/images/{}/{}",&system,&stem)}))
                        } else {
                            Json(serde_json::json!({"ok":false,"status":"error","message":"Failed to save image"}))
                        }
                    }
                    Err(_) => Json(serde_json::json!({"ok":false,"status":"not_found","message":format!("Not found ({} variants + DDG)", variants.len())})),
                }
            } else {
                Json(serde_json::json!({"ok":false,"status":"not_found","message":format!("Not found ({} variants)", variants.len())}))
            }
        }
    }
}

/// Scrape metadata (info) for a single game
async fn scrape_info_single(
    State(state): State<AppState>,
    Path(system): Path<String>,
    Query(query): Query<SingleGameQuery>,
) -> Json<serde_json::Value> {
    let file = query.file;
    let clean_name = clean_game_name(&file);
    let data_dir = state.inner.data_dir.clone();

    // Check if already have metadata
    if let Some(existing) = load_metadata(&data_dir, &system, &clean_name) {
        return Json(serde_json::json!({"ok":true,"status":"already_have","message":"Metadata already exists","metadata":existing}));
    }

    let settings = state.inner.settings.read().await.clone();
    let ss_user = settings.screenscraper_user.clone();
    let ss_pass = settings.screenscraper_pass.clone();
    let rawg_key = settings.rawg_api_key.clone();

    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().unwrap_or_default();

    match try_fetch_game_metadata(&client, &clean_name, &system, ss_user.as_deref(), ss_pass.as_deref(), rawg_key.as_deref()).await {
        Ok((meta, source)) => {
            save_metadata(&data_dir, &system, &clean_name, &meta);
            Json(serde_json::json!({"ok":true,"status":"scraped","message":format!("Scraped from {}",source),"metadata":meta}))
        }
        Err(e) => Json(serde_json::json!({"ok":false,"status":"not_found","message":e})),
    }
}

/// Search YouTube for gameplay videos and return video IDs
async fn search_media(
    Path(system): Path<String>,
    Query(query): Query<SingleGameQuery>,
) -> Json<serde_json::Value> {
    let clean_name = clean_game_name(&query.file);
    let system_label = match system.as_str() {
        "nes" | "famicom" => "NES",
        "snes" | "sfc" => "SNES",
        "gb" => "Game Boy",
        "gbc" => "Game Boy Color",
        "gba" => "Game Boy Advance",
        "nds" => "Nintendo DS",
        "n64" => "Nintendo 64",
        "genesis" | "megadrive" => "Sega Genesis",
        "mastersystem" => "Sega Master System",
        "gamegear" => "Game Gear",
        "psx" => "PlayStation",
        "psp" => "PSP",
        "saturn" => "Sega Saturn",
        "dreamcast" => "Dreamcast",
        "neogeo" => "Neo Geo",
        "arcade" | "cps1" | "cps2" | "cps3" | "fbneo" | "mame" => "Arcade",
        "pcengine" => "PC Engine",
        "atari2600" => "Atari 2600",
        "atari7800" => "Atari 7800",
        other => other,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    // Search YouTube for gameplay
    let yt_query = format!("{} {} gameplay", clean_name, system_label);
    let yt_url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
        urlenc(&yt_query)
    );

    let mut youtube_ids: Vec<String> = Vec::new();

    if let Ok(resp) = client
        .get(&yt_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
    {
        if let Ok(body) = resp.text().await {
            // Extract video IDs from YouTube search page
            let re = Regex::new(r#""videoId"\s*:\s*"([a-zA-Z0-9_-]{11})""#).unwrap();
            let mut seen = HashSet::new();
            for cap in re.captures_iter(&body) {
                let vid = cap[1].to_string();
                if seen.insert(vid.clone()) {
                    youtube_ids.push(vid);
                }
                if youtube_ids.len() >= 4 { break; }
            }
        }
    }

    // Search for screenshot images via DuckDuckGo
    let img_query = format!("{} {} screenshot gameplay", clean_name, system_label);
    let ddg_url = format!(
        "https://duckduckgo.com/?q={}&iax=images&ia=images",
        urlenc(&img_query)
    );

    let mut image_urls: Vec<String> = Vec::new();

    // Try DuckDuckGo vqd token + image API
    if let Ok(resp) = client
        .get(&format!("https://duckduckgo.com/?q={}", urlenc(&img_query)))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await
    {
        if let Ok(body) = resp.text().await {
            // Extract vqd token
            let vqd_re = Regex::new(r#"vqd=["']?([^"'&]+)"#).unwrap();
            if let Some(vqd_cap) = vqd_re.captures(&body) {
                let vqd = &vqd_cap[1];
                let img_api_url = format!(
                    "https://duckduckgo.com/i.js?l=us-en&o=json&q={}&vqd={}&f=,,,,,&p=1",
                    urlenc(&img_query), urlenc(vqd)
                );
                if let Ok(img_resp) = client
                    .get(&img_api_url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    .header("Referer", "https://duckduckgo.com/")
                    .send()
                    .await
                {
                    if let Ok(img_json) = img_resp.json::<serde_json::Value>().await {
                        if let Some(results) = img_json["results"].as_array() {
                            for r in results.iter().take(8) {
                                if let Some(img) = r["image"].as_str() {
                                    if img.starts_with("http") {
                                        image_urls.push(img.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Json(serde_json::json!({
        "ok": true,
        "youtube_ids": youtube_ids,
        "image_urls": image_urls,
        "search_query": format!("{} {}", clean_name, system_label),
        "ddg_images_url": ddg_url,
    }))
}

// ── Image search / Custom art editor endpoints ──────────────────────────────

#[derive(Deserialize)]
struct ImageSearchQuery {
    q: String,
}

/// Free-form image search via DuckDuckGo. Returns up to 20 image URLs.
async fn search_images(Query(q): Query<ImageSearchQuery>) -> Json<serde_json::Value> {
    let query = q.q.trim();
    if query.is_empty() {
        return Json(serde_json::json!({"ok": false, "image_urls": [], "search_query": "", "error": "empty query"}));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let mut image_urls: Vec<serde_json::Value> = Vec::new();
    let ddg_url = format!("https://duckduckgo.com/?q={}&iax=images&ia=images", urlenc(query));

    if let Ok(resp) = client
        .get(&format!("https://duckduckgo.com/?q={}", urlenc(query)))
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send().await
    {
        if let Ok(body) = resp.text().await {
            if let Some(vqd) = extract_vqd(&body) {
                let api_url = format!(
                    "https://duckduckgo.com/i.js?l=us-en&o=json&q={}&vqd={}&f=,,,,,&p=1",
                    urlenc(query), urlenc(&vqd)
                );
                if let Ok(api_resp) = client.get(&api_url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    .header("Referer", "https://duckduckgo.com/")
                    .send().await
                {
                    if let Ok(json) = api_resp.json::<serde_json::Value>().await {
                        if let Some(results) = json["results"].as_array() {
                            for r in results.iter().take(20) {
                                let img = r["image"].as_str().unwrap_or("");
                                if !img.starts_with("http") { continue; }
                                let thumb = r["thumbnail"].as_str().unwrap_or(img);
                                let title = r["title"].as_str().unwrap_or("");
                                let source = r["source"].as_str().unwrap_or("");
                                image_urls.push(serde_json::json!({
                                    "image": img,
                                    "thumbnail": thumb,
                                    "title": title,
                                    "source": source,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    Json(serde_json::json!({
        "ok": true,
        "image_urls": image_urls,
        "search_query": query,
        "ddg_images_url": ddg_url,
    }))
}

#[derive(Deserialize)]
struct ApplyArtBody {
    url: String,
}

/// Sniff image MIME from the first bytes. Returns ("png" | "jpg" | "webp" | "gif") or "png" fallback.
fn detect_image_ext(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" { return "png"; }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF { return "jpg"; }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return "webp"; }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") { return "gif"; }
    "png"
}

/// Remove any pre-existing image variants for a given stem in a directory.
fn remove_existing_images(dir: &std::path::Path, stem: &str) {
    for ext in &["png", "jpg", "jpeg", "webp", "gif"] {
        let p = dir.join(format!("{}.{}", stem, ext));
        if p.exists() { let _ = std::fs::remove_file(&p); }
    }
}

/// Upload raw image bytes for a single game's art.
/// POST /api/upload-art/{system}?file=X    body: raw image bytes
async fn upload_art(
    State(state): State<AppState>,
    Path(system): Path<String>,
    Query(query): Query<SingleGameQuery>,
    body: Bytes,
) -> Json<serde_json::Value> {
    if body.len() < 32 {
        return Json(serde_json::json!({"ok": false, "message": "Empty or invalid image"}));
    }
    if body.len() > 20 * 1024 * 1024 {
        return Json(serde_json::json!({"ok": false, "message": "Image too large (max 20 MB)"}));
    }

    let stem = std::path::Path::new(&query.file)
        .file_stem().unwrap_or_default().to_string_lossy().to_string();
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let image_dir = rom_dir.join(&system).join("images");
    let _ = std::fs::create_dir_all(&image_dir);

    let ext = detect_image_ext(&body);
    remove_existing_images(&image_dir, &stem);
    let save_path = image_dir.join(format!("{}.{}", &stem, ext));
    if let Err(e) = fs::write(&save_path, &body).await {
        return Json(serde_json::json!({"ok": false, "message": format!("Failed to save: {}", e)}));
    }

    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    *state.inner.library.write().await = library;
    Json(serde_json::json!({
        "ok": true, "status": "uploaded", "message": "Art uploaded",
        "image_path": format!("/api/images/{}/{}", &system, &stem),
    }))
}

/// Download an image URL and save as a single game's art.
/// POST /api/apply-art/{system}?file=X    body: { url }
async fn apply_art_url(
    State(state): State<AppState>,
    Path(system): Path<String>,
    Query(query): Query<SingleGameQuery>,
    Json(body): Json<ApplyArtBody>,
) -> Json<serde_json::Value> {
    let url = body.url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Json(serde_json::json!({"ok": false, "message": "Invalid URL"}));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let bytes = match client.get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .header("Referer", "https://duckduckgo.com/")
        .send().await
    {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => return Json(serde_json::json!({"ok": false, "message": format!("Read failed: {}", e)})),
        },
        Ok(r) => return Json(serde_json::json!({"ok": false, "message": format!("HTTP {}", r.status())})),
        Err(e) => return Json(serde_json::json!({"ok": false, "message": format!("Download failed: {}", e)})),
    };

    if bytes.len() < 32 {
        return Json(serde_json::json!({"ok": false, "message": "Downloaded image too small"}));
    }

    let stem = std::path::Path::new(&query.file)
        .file_stem().unwrap_or_default().to_string_lossy().to_string();
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let image_dir = rom_dir.join(&system).join("images");
    let _ = std::fs::create_dir_all(&image_dir);

    let ext = detect_image_ext(&bytes);
    remove_existing_images(&image_dir, &stem);
    let save_path = image_dir.join(format!("{}.{}", &stem, ext));
    if let Err(e) = fs::write(&save_path, &bytes).await {
        return Json(serde_json::json!({"ok": false, "message": format!("Save failed: {}", e)}));
    }

    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    *state.inner.library.write().await = library;
    Json(serde_json::json!({
        "ok": true, "status": "applied", "message": "Art applied from URL",
        "image_path": format!("/api/images/{}/{}", &system, &stem),
    }))
}

/// Serve the system art override file.
/// GET /api/system-art/{system}
async fn serve_system_art(
    State(state): State<AppState>,
    Path(system): Path<String>,
) -> impl IntoResponse {
    let dir = system_art_dir(&state.inner.data_dir);
    let png = dir.join(format!("{}.png", system));
    let jpg = dir.join(format!("{}.jpg", system));
    let (file_path, ct) = if png.exists() { (png, "image/png") }
        else if jpg.exists() { (jpg, "image/jpeg") }
        else { return (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain".to_string())], Vec::new()); };
    match fs::read(&file_path).await {
        Ok(bytes) => (StatusCode::OK, [(header::CONTENT_TYPE, ct.to_string())], bytes),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, [(header::CONTENT_TYPE, "text/plain".to_string())], Vec::new()),
    }
}

/// Upload raw image bytes as a system's cover art override.
/// POST /api/upload-system-art/{system}    body: raw image bytes
async fn upload_system_art(
    State(state): State<AppState>,
    Path(system): Path<String>,
    body: Bytes,
) -> Json<serde_json::Value> {
    if body.len() < 32 {
        return Json(serde_json::json!({"ok": false, "message": "Empty or invalid image"}));
    }
    if body.len() > 20 * 1024 * 1024 {
        return Json(serde_json::json!({"ok": false, "message": "Image too large (max 20 MB)"}));
    }

    let dir = system_art_dir(&state.inner.data_dir);
    let _ = std::fs::create_dir_all(&dir);
    // Remove old variants
    for ext in &["png", "jpg", "jpeg", "webp", "gif"] {
        let p = dir.join(format!("{}.{}", system, ext));
        if p.exists() { let _ = std::fs::remove_file(&p); }
    }
    let ext = detect_image_ext(&body);
    let save_path = dir.join(format!("{}.{}", system, ext));
    if let Err(e) = fs::write(&save_path, &body).await {
        return Json(serde_json::json!({"ok": false, "message": format!("Failed to save: {}", e)}));
    }
    // Rescan so SystemInfo.cover_image picks up the override
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    *state.inner.library.write().await = library;

    Json(serde_json::json!({
        "ok": true, "status": "uploaded", "message": "System art uploaded",
        "cover_image": format!("/api/system-art/{}", system),
    }))
}

/// Apply an image URL as a system's cover art override.
/// POST /api/apply-system-art/{system}    body: { url }
async fn apply_system_art_url(
    State(state): State<AppState>,
    Path(system): Path<String>,
    Json(body): Json<ApplyArtBody>,
) -> Json<serde_json::Value> {
    let url = body.url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Json(serde_json::json!({"ok": false, "message": "Invalid URL"}));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let bytes = match client.get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .header("Referer", "https://duckduckgo.com/")
        .send().await
    {
        Ok(r) if r.status().is_success() => match r.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => return Json(serde_json::json!({"ok": false, "message": format!("Read failed: {}", e)})),
        },
        Ok(r) => return Json(serde_json::json!({"ok": false, "message": format!("HTTP {}", r.status())})),
        Err(e) => return Json(serde_json::json!({"ok": false, "message": format!("Download failed: {}", e)})),
    };
    if bytes.len() < 32 {
        return Json(serde_json::json!({"ok": false, "message": "Downloaded image too small"}));
    }

    let dir = system_art_dir(&state.inner.data_dir);
    let _ = std::fs::create_dir_all(&dir);
    for ext in &["png", "jpg", "jpeg", "webp", "gif"] {
        let p = dir.join(format!("{}.{}", system, ext));
        if p.exists() { let _ = std::fs::remove_file(&p); }
    }
    let ext = detect_image_ext(&bytes);
    let save_path = dir.join(format!("{}.{}", system, ext));
    if let Err(e) = fs::write(&save_path, &bytes).await {
        return Json(serde_json::json!({"ok": false, "message": format!("Save failed: {}", e)}));
    }
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    *state.inner.library.write().await = library;

    Json(serde_json::json!({
        "ok": true, "status": "applied", "message": "System art applied from URL",
        "cover_image": format!("/api/system-art/{}", system),
    }))
}

/// Remove the system art override (revert to game-picked cover).
/// DELETE /api/system-art/{system}
async fn delete_system_art(
    State(state): State<AppState>,
    Path(system): Path<String>,
) -> Json<serde_json::Value> {
    let dir = system_art_dir(&state.inner.data_dir);
    let mut removed = false;
    for ext in &["png", "jpg", "jpeg", "webp", "gif"] {
        let p = dir.join(format!("{}.{}", system, ext));
        if p.exists() { let _ = std::fs::remove_file(&p); removed = true; }
    }
    if removed {
        let rom_dir = state.inner.rom_dir.read().await.clone();
        let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
        *state.inner.library.write().await = library;
    }
    Json(serde_json::json!({"ok": true, "removed": removed}))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async fn health() -> &'static str { "OK" }

// ── SteamGridDB scraper (hero banner + transparent logo) ─────────────────

fn banner_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("banners")
}

fn logo_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("logos")
}

fn art_filename(system: &str, file: &str) -> String {
    let stem = std::path::Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file);
    format!("{}_{}.png", system, sanitize_filename(stem))
}

async fn serve_banner(State(state): State<AppState>, Path((system, file)): Path<(String, String)>) -> impl IntoResponse {
    let path = banner_dir(&state.inner.data_dir).join(art_filename(&system, &file));
    if path.exists() {
        if let Ok(data) = fs::read(&path).await {
            return ([(header::CONTENT_TYPE, "image/png")], data).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn serve_logo(State(state): State<AppState>, Path((system, file)): Path<(String, String)>) -> impl IntoResponse {
    let path = logo_dir(&state.inner.data_dir).join(art_filename(&system, &file));
    if path.exists() {
        if let Ok(data) = fs::read(&path).await {
            return ([(header::CONTENT_TYPE, "image/png")], data).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn scrape_banner(
    State(state): State<AppState>,
    Path((system, file)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    scrape_steamgrid(&state, &system, &file, "heroes").await
}

async fn scrape_logo(
    State(state): State<AppState>,
    Path((system, file)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    scrape_steamgrid(&state, &system, &file, "logos").await
}

async fn scrape_steamgrid(state: &AppState, system: &str, file: &str, kind: &str) -> Json<serde_json::Value> {
    let settings = state.inner.settings.read().await.clone();
    let key = match settings.steamgriddb_api_key.as_deref() {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => return Json(serde_json::json!({"ok": false, "error": "SteamGridDB API key not configured"})),
    };
    let game_stem = std::path::Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file).to_string();
    let query = bare_game_name(&game_stem);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("retroweb")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Json(serde_json::json!({"ok": false, "error": "client build failed"})),
    };

    // 1) Search game by name
    let search_url = format!("https://www.steamgriddb.com/api/v2/search/autocomplete/{}", urlenc(&query));
    let auth = format!("Bearer {}", key);
    let search_resp = client.get(&search_url).header("Authorization", &auth).send().await;
    let games_json: serde_json::Value = match search_resp {
        Ok(r) if r.status().is_success() => match r.json().await { Ok(j) => j, Err(_) => return Json(serde_json::json!({"ok": false, "error": "json parse"})) },
        _ => return Json(serde_json::json!({"ok": false, "error": "search failed"})),
    };
    let game_id = games_json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|g| g.get("id"))
        .and_then(|v| v.as_i64());
    let game_id = match game_id {
        Some(id) => id,
        None => return Json(serde_json::json!({"ok": false, "error": "game not found in SteamGridDB"})),
    };

    // 2) Fetch heroes or logos for that game
    let assets_url = format!("https://www.steamgriddb.com/api/v2/{}/game/{}", kind, game_id);
    let assets_resp = client.get(&assets_url).header("Authorization", &auth).send().await;
    let assets_json: serde_json::Value = match assets_resp {
        Ok(r) if r.status().is_success() => match r.json().await { Ok(j) => j, Err(_) => return Json(serde_json::json!({"ok": false, "error": "assets json parse"})) },
        _ => return Json(serde_json::json!({"ok": false, "error": "assets fetch failed"})),
    };
    let url = assets_json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|g| g.get("url"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let url = match url {
        Some(u) => u,
        None => return Json(serde_json::json!({"ok": false, "error": "no assets for this game"})),
    };

    // 3) Download to local cache
    let dir = if kind == "heroes" { banner_dir(&state.inner.data_dir) } else { logo_dir(&state.inner.data_dir) };
    if fs::create_dir_all(&dir).await.is_err() {
        return Json(serde_json::json!({"ok": false, "error": "create dir failed"}));
    }
    let bytes = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => match r.bytes().await { Ok(b) => b, Err(_) => return Json(serde_json::json!({"ok": false, "error": "download bytes"})) },
        _ => return Json(serde_json::json!({"ok": false, "error": "download failed"})),
    };
    let path = dir.join(art_filename(system, file));
    if fs::write(&path, &bytes).await.is_err() {
        return Json(serde_json::json!({"ok": false, "error": "write failed"}));
    }
    let serve_path = if kind == "heroes" {
        format!("/api/banner/{}/{}", system, file)
    } else {
        format!("/api/logo/{}/{}", system, file)
    };
    Json(serde_json::json!({"ok": true, "url": serve_path}))
}

// ── Playtime handlers ────────────────────────────────────────────────────

async fn get_all_playtime(State(state): State<AppState>) -> Json<Vec<PlaytimeStats>> {
    let playtime = state.inner.playtime.read().await;
    let mut list: Vec<PlaytimeStats> = playtime.values().cloned().collect();
    list.sort_by(|a, b| b.last_played_at.cmp(&a.last_played_at));
    Json(list)
}

async fn get_recent_playtime(State(state): State<AppState>) -> Json<Vec<PlaytimeStats>> {
    let playtime = state.inner.playtime.read().await;
    let mut list: Vec<PlaytimeStats> = playtime
        .values()
        .filter(|s| s.last_played_at > 0)
        .cloned()
        .collect();
    list.sort_by(|a, b| b.last_played_at.cmp(&a.last_played_at));
    list.truncate(50);
    Json(list)
}

async fn get_last_played(State(state): State<AppState>) -> Json<Option<PlaytimeStats>> {
    let playtime = state.inner.playtime.read().await;
    let last = playtime
        .values()
        .filter(|s| s.last_played_at > 0)
        .max_by_key(|s| s.last_played_at)
        .cloned();
    Json(last)
}

async fn get_playtime(State(state): State<AppState>, Path(game_id): Path<String>) -> Json<Option<PlaytimeStats>> {
    let playtime = state.inner.playtime.read().await;
    Json(playtime.get(&game_id).cloned())
}

async fn playtime_start(State(state): State<AppState>, Json(body): Json<PlaytimeStartBody>) -> Json<PlaytimeStats> {
    let mut playtime = state.inner.playtime.write().await;
    let entry = playtime.entry(body.game_id.clone()).or_insert_with(|| PlaytimeStats {
        game_id: body.game_id.clone(),
        system: body.system.clone(),
        file: body.file.clone(),
        name: body.name.clone(),
        total_seconds: 0,
        last_played_at: 0,
        play_count: 0,
    });
    entry.system = body.system;
    entry.file = body.file;
    entry.name = body.name;
    entry.last_played_at = now_unix();
    entry.play_count += 1;
    let snap = entry.clone();
    save_playtime(&state.inner.data_dir, &playtime);
    Json(snap)
}

async fn playtime_end(State(state): State<AppState>, Json(body): Json<PlaytimeEndBody>) -> Json<serde_json::Value> {
    let mut playtime = state.inner.playtime.write().await;
    let total = if let Some(entry) = playtime.get_mut(&body.game_id) {
        entry.total_seconds += body.duration_seconds;
        entry.last_played_at = now_unix();
        Some(entry.total_seconds)
    } else {
        None
    };
    match total {
        Some(t) => {
            save_playtime(&state.inner.data_dir, &playtime);
            Json(serde_json::json!({"ok": true, "total_seconds": t}))
        }
        None => Json(serde_json::json!({"ok": false, "error": "game not started"})),
    }
}

// ── Collections handlers ────────────────────────────────────────────────

async fn list_collections(State(state): State<AppState>) -> Json<Vec<Collection>> {
    Json(state.inner.collections.read().await.clone())
}

async fn create_collection(State(state): State<AppState>, Json(body): Json<CollectionCreateBody>) -> Json<Collection> {
    let mut collections = state.inner.collections.write().await;
    let id = format!("col-{}", now_unix());
    let collection = Collection {
        id: id.clone(),
        name: body.name,
        icon: body.icon,
        game_ids: Vec::new(),
        created_at: now_unix(),
    };
    collections.push(collection.clone());
    save_collections(&state.inner.data_dir, &collections);
    Json(collection)
}

async fn update_collection(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CollectionUpdateBody>,
) -> Json<serde_json::Value> {
    let mut collections = state.inner.collections.write().await;
    if let Some(col) = collections.iter_mut().find(|c| c.id == id) {
        if let Some(n) = body.name { col.name = n; }
        if let Some(icon) = body.icon { col.icon = Some(icon); }
        if let Some(ids) = body.game_ids { col.game_ids = ids; }
        save_collections(&state.inner.data_dir, &collections);
        return Json(serde_json::json!({"ok": true}));
    }
    Json(serde_json::json!({"ok": false, "error": "not found"}))
}

async fn delete_collection(State(state): State<AppState>, Path(id): Path<String>) -> Json<serde_json::Value> {
    let mut collections = state.inner.collections.write().await;
    let before = collections.len();
    collections.retain(|c| c.id != id);
    if collections.len() != before {
        save_collections(&state.inner.data_dir, &collections);
        return Json(serde_json::json!({"ok": true}));
    }
    Json(serde_json::json!({"ok": false}))
}

async fn collection_add_game(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CollectionGameBody>,
) -> Json<serde_json::Value> {
    let mut collections = state.inner.collections.write().await;
    if let Some(col) = collections.iter_mut().find(|c| c.id == id) {
        if !col.game_ids.contains(&body.game_id) {
            col.game_ids.push(body.game_id);
            save_collections(&state.inner.data_dir, &collections);
        }
        return Json(serde_json::json!({"ok": true}));
    }
    Json(serde_json::json!({"ok": false}))
}

async fn collection_remove_game(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CollectionGameBody>,
) -> Json<serde_json::Value> {
    let mut collections = state.inner.collections.write().await;
    if let Some(col) = collections.iter_mut().find(|c| c.id == id) {
        col.game_ids.retain(|g| g != &body.game_id);
        save_collections(&state.inner.data_dir, &collections);
        return Json(serde_json::json!({"ok": true}));
    }
    Json(serde_json::json!({"ok": false}))
}

// ── Game Launch Config handlers ────────────────────────────────────────

async fn get_game_config(
    State(state): State<AppState>,
    Path((system, file)): Path<(String, String)>,
) -> Json<GameLaunchConfig> {
    let configs = state.inner.game_configs.read().await;
    let key = format!("{}:{}", system, file);
    Json(configs.get(&key).cloned().unwrap_or_default())
}

async fn set_game_config(
    State(state): State<AppState>,
    Path((system, file)): Path<(String, String)>,
    Json(cfg): Json<GameLaunchConfig>,
) -> Json<serde_json::Value> {
    let mut configs = state.inner.game_configs.write().await;
    let key = format!("{}:{}", system, file);
    if cfg.core.is_none() && cfg.shader.is_none() && cfg.options.is_none() {
        configs.remove(&key);
    } else {
        configs.insert(key, cfg);
    }
    save_game_configs(&state.inner.data_dir, &configs);
    Json(serde_json::json!({"ok": true}))
}

async fn list_alternate_cores(Path(system): Path<String>) -> Json<Vec<&'static str>> {
    Json(alternate_cores(&system))
}

// ── Hidden games handlers ────────────────────────────────────────────

async fn list_hidden_games(State(state): State<AppState>) -> Json<Vec<String>> {
    let hidden = state.inner.hidden_games.read().await;
    Json(hidden.iter().cloned().collect())
}

async fn set_hidden_games(
    State(state): State<AppState>,
    Json(ids): Json<Vec<String>>,
) -> Json<serde_json::Value> {
    let mut hidden = state.inner.hidden_games.write().await;
    *hidden = ids.into_iter().collect();
    save_hidden_games(&state.inner.data_dir, &hidden);
    Json(serde_json::json!({"ok": true}))
}

// ── Duplicates ────────────────────────────────────────────────────────

async fn scan_duplicates(State(state): State<AppState>) -> Json<Vec<DuplicateGroup>> {
    let rom_dir = state.inner.rom_dir.read().await.clone();
    let lib = state.inner.library.read().await.clone();

    let mut by_size: HashMap<u64, Vec<(GameInfo, PathBuf)>> = HashMap::new();
    for (_, games) in lib.games.iter() {
        for g in games {
            let path = rom_dir.join(&g.system).join(&g.file);
            if let Ok(meta) = std::fs::metadata(&path) {
                let sz = meta.len();
                if sz > 0 {
                    by_size.entry(sz).or_default().push((g.clone(), path));
                }
            }
        }
    }

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (sz, candidates) in by_size {
        if candidates.len() < 2 { continue; }
        let mut by_hash: HashMap<String, Vec<GameInfo>> = HashMap::new();
        for (g, p) in candidates {
            if let Some(h) = hash_file_head(&p) {
                by_hash.entry(h).or_default().push(g);
            }
        }
        for (h, games) in by_hash {
            if games.len() >= 2 {
                groups.push(DuplicateGroup { hash: h, size: sz, games });
            }
        }
    }
    groups.sort_by(|a, b| b.games.len().cmp(&a.games.len()));

    *state.inner.duplicates.write().await = groups.clone();
    Json(groups)
}

fn hash_file_head(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let n = f.read(&mut buf).ok()?;
    // FNV-1a 64-bit hash on first 64KB — fast and stable for dupe detection
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in &buf[..n] {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("{:016x}", hash))
}

#[derive(Deserialize)]
struct DeleteDuplicateBody {
    game_id: String,
}

/// Delete a single ROM file (and its sidecar artwork) to reclaim storage.
/// POST /api/duplicates/delete   body: { game_id: "system:file_name" }
async fn delete_duplicate(
    State(state): State<AppState>,
    Json(body): Json<DeleteDuplicateBody>,
) -> Json<serde_json::Value> {
    let Some((system, file_name)) = body.game_id.split_once(':') else {
        return Json(serde_json::json!({"ok": false, "message": "Invalid game id"}));
    };
    if system.is_empty() || file_name.is_empty()
        || system.contains('/') || system.contains("..")
        || file_name.contains('/') || file_name.contains("..") {
        return Json(serde_json::json!({"ok": false, "message": "Invalid game id"}));
    }

    let rom_dir = state.inner.rom_dir.read().await.clone();
    let rom_path = rom_dir.join(system).join(file_name);

    // Ensure the resolved path is still inside the ROM directory.
    let canonical_rom_dir = std::fs::canonicalize(&rom_dir).ok();
    let canonical_target = std::fs::canonicalize(&rom_path).ok();
    match (canonical_rom_dir, canonical_target) {
        (Some(root), Some(target)) if target.starts_with(&root) => {}
        _ => return Json(serde_json::json!({"ok": false, "message": "Path outside ROM directory"})),
    }

    let bytes_freed = std::fs::metadata(&rom_path).map(|m| m.len()).unwrap_or(0);
    if let Err(e) = std::fs::remove_file(&rom_path) {
        return Json(serde_json::json!({"ok": false, "message": format!("Delete failed: {}", e)}));
    }

    // Best-effort: remove sidecar art (image with the same stem).
    let stem = std::path::Path::new(file_name)
        .file_stem().unwrap_or_default().to_string_lossy().to_string();
    let image_dir = rom_dir.join(system).join("images");
    remove_existing_images(&image_dir, &stem);

    push_log(&state, "info", &format!("Deleted duplicate: {}/{} ({} bytes)", system, file_name, bytes_freed)).await;

    // Refresh library so the UI no longer shows the removed file.
    let library = scan_rom_directory(&rom_dir, &state.inner.data_dir);
    *state.inner.library.write().await = library;

    // Also strip it from cached duplicate groups.
    let mut dupes = state.inner.duplicates.write().await;
    for group in dupes.iter_mut() {
        group.games.retain(|g| g.id != body.game_id);
    }
    dupes.retain(|g| g.games.len() >= 2);

    Json(serde_json::json!({
        "ok": true,
        "bytes_freed": bytes_freed,
    }))
}

// ── Logs ─────────────────────────────────────────────────────────────

async fn get_logs(State(state): State<AppState>) -> Json<Vec<LogEntry>> {
    let buf = state.inner.log_buffer.read().await;
    Json(buf.iter().cloned().collect())
}

async fn clear_logs(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.inner.log_buffer.write().await.clear();
    Json(serde_json::json!({"ok": true}))
}

async fn push_log(state: &AppState, level: &str, msg: &str) {
    let entry = LogEntry { timestamp: now_unix(), level: level.to_string(), message: msg.to_string() };
    let mut buf = state.inner.log_buffer.write().await;
    buf.push_back(entry);
    while buf.len() > 500 { buf.pop_front(); }
}

// ── Version / Update check ───────────────────────────────────────────

#[derive(Serialize)]
struct VersionInfo {
    current: &'static str,
    latest: Option<String>,
    update_available: bool,
}

async fn get_version() -> Json<VersionInfo> {
    let current = env!("CARGO_PKG_VERSION");
    let latest = check_latest_version().await;
    let update_available = match &latest {
        Some(l) => l.trim_start_matches('v') != current,
        None => false,
    };
    Json(VersionInfo { current, latest, update_available })
}

async fn check_latest_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("retroweb")
        .build()
        .ok()?;
    let res = client
        .get("https://api.github.com/repos/anthropics/retroweb/releases/latest")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() { return None; }
    let json: serde_json::Value = res.json().await.ok()?;
    json.get("tag_name").and_then(|v| v.as_str()).map(String::from)
}

// ── Config export/import ─────────────────────────────────────────────

async fn export_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let settings = state.inner.settings.read().await.clone();
    let playtime = state.inner.playtime.read().await.clone();
    let collections = state.inner.collections.read().await.clone();
    let game_configs = state.inner.game_configs.read().await.clone();
    let hidden = state.inner.hidden_games.read().await.iter().cloned().collect::<Vec<_>>();
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exported_at": now_unix(),
        "settings": settings,
        "playtime": playtime,
        "collections": collections,
        "game_configs": game_configs,
        "hidden_games": hidden,
    }))
}

#[derive(Deserialize)]
struct ImportBody {
    settings: Option<AppSettings>,
    playtime: Option<HashMap<String, PlaytimeStats>>,
    collections: Option<Vec<Collection>>,
    game_configs: Option<HashMap<String, GameLaunchConfig>>,
    hidden_games: Option<Vec<String>>,
}

async fn import_config(
    State(state): State<AppState>,
    Json(body): Json<ImportBody>,
) -> Json<serde_json::Value> {
    if let Some(s) = body.settings {
        *state.inner.settings.write().await = s.clone();
        save_settings(&state.inner.data_dir, &s);
    }
    if let Some(p) = body.playtime {
        *state.inner.playtime.write().await = p.clone();
        save_playtime(&state.inner.data_dir, &p);
    }
    if let Some(c) = body.collections {
        *state.inner.collections.write().await = c.clone();
        save_collections(&state.inner.data_dir, &c);
    }
    if let Some(g) = body.game_configs {
        *state.inner.game_configs.write().await = g.clone();
        save_game_configs(&state.inner.data_dir, &g);
    }
    if let Some(h) = body.hidden_games {
        let set: HashSet<String> = h.into_iter().collect();
        *state.inner.hidden_games.write().await = set.clone();
        save_hidden_games(&state.inner.data_dir, &set);
    }
    Json(serde_json::json!({"ok": true}))
}

fn parse_range(range: &str, file_size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 { return None; }
    let start: u64 = parts[0].parse().ok()?;
    let end: u64 = if parts[1].is_empty() { file_size - 1 } else { parts[1].parse().ok()? };
    if start <= end && end < file_size { Some((start, end)) } else { None }
}

async fn read_file_range(path: &std::path::Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let len = (end - start + 1) as usize;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

fn content_type_for_file(filename: &str) -> String {
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "zip" => "application/zip", "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }.to_string()
}

// ── Main ────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let rom_dir_str = std::env::var("ROM_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{}/Documents/room-r36-plus", home)
    });

    // Data dir for settings, metadata, etc.
    let data_dir = std::env::var("DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}/.retroweb", home))
    });
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::create_dir_all(data_dir.join("metadata"));

    let settings = load_settings(&data_dir, &rom_dir_str);
    let effective_rom_dir = if !settings.rom_dir.is_empty() { settings.rom_dir.clone() } else { rom_dir_str };
    let rom_path = PathBuf::from(&effective_rom_dir);

    if !rom_path.exists() {
        panic!("ROM directory not found: {}", effective_rom_dir);
    }

    info!("Scanning ROM directory: {}", effective_rom_dir);
    let library = scan_rom_directory(&rom_path, &data_dir);
    info!("Found {} systems", library.systems.len());
    info!("Data directory: {}", data_dir.display());

    let playtime = load_playtime(&data_dir);
    let collections = load_collections(&data_dir);
    let game_configs = load_game_configs(&data_dir);
    let hidden_games = load_hidden_games(&data_dir);

    let state = AppState {
        inner: Arc::new(AppInner {
            rom_dir: RwLock::new(rom_path),
            library: RwLock::new(library),
            data_dir,
            settings: RwLock::new(settings),
            playtime: RwLock::new(playtime),
            collections: RwLock::new(collections),
            game_configs: RwLock::new(game_configs),
            hidden_games: RwLock::new(hidden_games),
            duplicates: RwLock::new(Vec::new()),
            log_buffer: RwLock::new(std::collections::VecDeque::with_capacity(500)),
        }),
    };

    let cors = CorsLayer::permissive();

    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| {
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));
        for candidate in [
            exe_dir.as_ref().map(|d| d.join("frontend/dist")),
            exe_dir.as_ref().map(|d| d.join("../../frontend/dist")),
            exe_dir.as_ref().map(|d| d.join("../frontend/dist")),
            Some(PathBuf::from("frontend/dist")),
            Some(PathBuf::from("/app/frontend/dist")),
        ].into_iter().flatten() {
            if candidate.exists() { return candidate.to_string_lossy().to_string(); }
        }
        "frontend/dist".to_string()
    });
    info!("Serving frontend from: {}", frontend_dir);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/systems", get(get_systems))
        .route("/api/games", get(get_games))
        .route("/api/roms/{system}/{file}", get(serve_rom))
        .route("/api/bios/{file}", get(serve_bios))
        .route("/api/images/{system}/{name}", get(serve_image))
        .route("/api/settings", get(get_settings).post(update_settings))
        .route("/api/rescan", post(rescan_roms))
        .route("/api/bios/status", get(get_bios_status))
        .route("/api/metadata/{system}/{game}", get(get_metadata))
        .route("/api/scrape/{system}", post(scrape_system))
        .route("/api/browse", post(browse_dirs))
        .route("/api/rescan-stream", get(rescan_stream))
        .route("/api/scrape-stream/{system}", get(scrape_stream))
        .route("/api/scrape-info-stream/{system}", get(scrape_info_stream))
        .route("/api/scrape-art-single/{system}", get(scrape_art_single))
        .route("/api/scrape-info-single/{system}", get(scrape_info_single))
        .route("/api/search-media/{system}", get(search_media))
        // Custom art editor (manual upload + URL apply + image search)
        .route("/api/search-images", get(search_images))
        .route("/api/upload-art/{system}", post(upload_art))
        .route("/api/apply-art/{system}", post(apply_art_url))
        .route("/api/system-art/{system}", get(serve_system_art).delete(delete_system_art))
        .route("/api/upload-system-art/{system}", post(upload_system_art))
        .route("/api/apply-system-art/{system}", post(apply_system_art_url))
        // Playtime
        .route("/api/playtime", get(get_all_playtime))
        .route("/api/playtime/recent", get(get_recent_playtime))
        .route("/api/playtime/last", get(get_last_played))
        .route("/api/playtime/{game_id}", get(get_playtime))
        .route("/api/playtime/start", post(playtime_start))
        .route("/api/playtime/end", post(playtime_end))
        // Collections
        .route("/api/collections", get(list_collections).post(create_collection))
        .route("/api/collections/{id}", post(update_collection).delete(delete_collection))
        .route("/api/collections/{id}/add", post(collection_add_game))
        .route("/api/collections/{id}/remove", post(collection_remove_game))
        // Game launch config + alternate cores
        .route("/api/game-config/{system}/{file}", get(get_game_config).post(set_game_config))
        .route("/api/alternate-cores/{system}", get(list_alternate_cores))
        // Hidden games
        .route("/api/hidden-games", get(list_hidden_games).post(set_hidden_games))
        // Duplicate detection
        .route("/api/duplicates/scan", post(scan_duplicates))
        .route("/api/duplicates/delete", post(delete_duplicate))
        // Logs + version
        .route("/api/logs", get(get_logs).delete(clear_logs))
        .route("/api/version", get(get_version))
        // Config export/import
        .route("/api/config/export", get(export_config))
        .route("/api/config/import", post(import_config))
        // SteamGridDB hero banner + logo
        .route("/api/banner/{system}/{file}", get(serve_banner))
        .route("/api/logo/{system}/{file}", get(serve_logo))
        .route("/api/scrape-banner/{system}/{file}", post(scrape_banner))
        .route("/api/scrape-logo/{system}/{file}", post(scrape_logo))
        .fallback_service(ServeDir::new(&frontend_dir))
        .layer(cors)
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let addr = format!("0.0.0.0:{}", port);
    info!("RetroWeb server starting on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
