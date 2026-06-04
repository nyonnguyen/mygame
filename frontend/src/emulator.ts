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
  // Clear iframe / leftover content but keep the floating controls overlay,
  // which is the only way to exit fullscreen on mobile.
  clearContainerKeepControls(container);

  const ejsCore = CORE_ALIAS[system.core] || system.core;

  if (!SUPPORTED_CORES.has(ejsCore)) {
    const msg = document.createElement('div');
    msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#e4e4ef;font-size:1.1rem;text-align:center;padding:20px;';
    msg.innerHTML = `Core <strong style="color:#6c5ce7;margin:0 6px;">${ejsCore}</strong> is not supported in browser.<br>System: ${system.name}`;
    container.insertBefore(msg, container.firstChild);
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
  // Always exit pseudo-fullscreen on cleanup so the body's overflow:hidden
  // and the fixed container don't leak into other views.
  document.querySelectorAll('.pseudo-fullscreen').forEach((el) =>
    el.classList.remove('pseudo-fullscreen'),
  );
  document.body.classList.remove('pseudo-fullscreen-active');
}

function clearContainerKeepControls(container: HTMLElement): void {
  Array.from(container.children).forEach((child) => {
    if (!(child as HTMLElement).classList.contains('player-floating-controls')) {
      child.remove();
    }
  });
}

export function enterFullscreen(containerId: string): void {
  // Target the container (not the iframe) so sibling overlays — like the
  // floating exit/fullscreen controls — remain visible while in fullscreen.
  const target = (document.getElementById(containerId) ?? currentIframe) as HTMLElement | null;
  if (!target) return;

  // Toggle behaviour — needed especially on iOS where there's no system
  // chrome to exit pseudo-fullscreen.
  if (target.classList.contains('pseudo-fullscreen')) {
    exitPseudoFullscreen(target);
    return;
  }
  if (document.fullscreenElement === target) {
    document.exitFullscreen?.();
    return;
  }

  // iOS Safari / Chrome on iPhone don't support Fullscreen API on non-video
  // elements (requestFullscreen is undefined). Fall back to CSS pseudo-fs.
  const req = target.requestFullscreen
    ?? (target as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
  if (typeof req === 'function') {
    Promise.resolve(req.call(target)).catch(() => enterPseudoFullscreen(target));
  } else {
    enterPseudoFullscreen(target);
  }
}

function enterPseudoFullscreen(el: HTMLElement): void {
  el.classList.add('pseudo-fullscreen');
  document.body.classList.add('pseudo-fullscreen-active');
}

function exitPseudoFullscreen(el: HTMLElement): void {
  el.classList.remove('pseudo-fullscreen');
  document.body.classList.remove('pseudo-fullscreen-active');
}
