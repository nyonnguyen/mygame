import { romUrl, type GameInfo, type SystemInfo } from './api';

// EmulatorJS uses libretro core names directly.
const SUPPORTED_CORES = new Set([
  'fceumm', 'nestopia', 'snes9x', 'bsnes', 'gambatte', 'mgba',
  'genesis_plus_gx', 'genesis_plus_gx_wide',
  'mupen64plus_next', 'parallel-n64',
  'pcsx_rearmed', 'mednafen_psx_hw', 'ppsspp',
  'fbneo', 'fbalpha2012_cps1', 'fbalpha2012_cps2',
  'mame2003', 'mame2003_plus', 'mednafen_pce_fast',
  'stella2014', 'prosystem', 'gearcoleco',
  'mednafen_wswan', 'mednafen_ngp', 'mednafen_vb',
  'handy', 'picodrive', 'melonds', 'yabause', 'flycast',
  'opera', 'virtualjaguar', 'pokemini', 'vecx',
]);

const CORE_ALIAS: Record<string, string> = {
  mednafen_pce: 'mednafen_pce_fast',
};

let currentIframe: HTMLIFrameElement | null = null;

/**
 * Launch game in an isolated iframe.
 * EmulatorJS cannot be re-initialized in the same page context,
 * so each game session gets a fresh iframe with its own player.html.
 *
 * Gamepad input: player.html overrides navigator.getGamepads() to call
 * window.parent.navigator.getGamepads(), getting real live Gamepad objects
 * from the parent window where the Gamepad API is already activated.
 */
export function launchGame(game: GameInfo, system: SystemInfo, containerId: string): void {
  cleanup();

  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const ejsCore = CORE_ALIAS[system.core] || system.core;

  if (!SUPPORTED_CORES.has(ejsCore)) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#e4e4ef;font-size:1.1rem;text-align:center;padding:20px;">
      Core <strong style="color:#6c5ce7;margin:0 6px;">${ejsCore}</strong> is not supported in browser.<br>
      System: ${system.name}
    </div>`;
    return;
  }

  const gameUrl = romUrl(game.system, game.file);

  const playerParams = new URLSearchParams({
    core: ejsCore,
    url: encodeURIComponent(gameUrl),
    name: encodeURIComponent(game.name),
  });

  const iframe = document.createElement('iframe');
  iframe.src = `/player.html?${playerParams}`;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.display = 'block';
  iframe.setAttribute('allow', 'gamepad; autoplay; fullscreen');
  iframe.allowFullscreen = true;

  container.appendChild(iframe);
  currentIframe = iframe;

  iframe.addEventListener('load', () => {
    iframe.focus();
  });
}

export function cleanup(): void {
  if (currentIframe) {
    try { currentIframe.contentWindow?.location.replace('about:blank'); } catch { /* cross-origin ok */ }
    currentIframe.remove();
    currentIframe = null;
  }
}

export function enterFullscreen(containerId: string): void {
  const target: Element | null = currentIframe ?? document.getElementById(containerId);
  target?.requestFullscreen?.().catch(() => { /* user activation may be absent */ });
}
