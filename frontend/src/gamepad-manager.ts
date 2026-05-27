// ── Controller Profile Detection ────────────────────────────────────────

export type ProfileName = 'xbox' | 'playstation' | 'switch' | '8bitdo' | 'generic';

// All 18 standard Gamepad API buttons
export const CANONICAL_BUTTON_NAMES = [
  'a', 'b', 'x', 'y',
  'l1', 'r1', 'l2', 'r2',
  'select', 'start',
  'l3', 'r3',
  'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
  'home', 'touchpad',
] as const;

export type CanonicalButtonName = typeof CANONICAL_BUTTON_NAMES[number];

// Display labels per profile type
const PS_LABELS: Record<CanonicalButtonName, string> = {
  a: 'Cross', b: 'Circle', x: 'Square', y: 'Triangle',
  l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
  select: 'Share', start: 'Options', l3: 'L3', r3: 'R3',
  dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
  home: 'PS', touchpad: 'Touchpad',
};

const XBOX_LABELS: Record<CanonicalButtonName, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y',
  l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT',
  select: 'View', start: 'Menu', l3: 'LS', r3: 'RS',
  dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
  home: 'Xbox', touchpad: 'Share',
};

const SWITCH_LABELS: Record<CanonicalButtonName, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y',
  l1: 'L', r1: 'R', l2: 'ZL', r2: 'ZR',
  select: 'Minus', start: 'Plus', l3: 'LS', r3: 'RS',
  dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
  home: 'Home', touchpad: 'Capture',
};

const GENERIC_LABELS: Record<CanonicalButtonName, string> = {
  a: 'A', b: 'B', x: 'X', y: 'Y',
  l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
  select: 'Select', start: 'Start', l3: 'L3', r3: 'R3',
  dpadUp: 'D-Up', dpadDown: 'D-Down', dpadLeft: 'D-Left', dpadRight: 'D-Right',
  home: 'Home', touchpad: 'Misc',
};

export function getButtonLabels(profile: ProfileName): Record<CanonicalButtonName, string> {
  switch (profile) {
    case 'playstation': return PS_LABELS;
    case 'xbox': return XBOX_LABELS;
    case 'switch': return SWITCH_LABELS;
    default: return GENERIC_LABELS;
  }
}

// Default profile mappings (button index -> canonical name)
// Standard Gamepad API: https://w3c.github.io/gamepad/#remapping
export const PROFILE_DEFAULTS: Record<ProfileName, Record<number, CanonicalButtonName>> = {
  xbox: {
    0: 'a', 1: 'b', 2: 'x', 3: 'y',
    4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
    8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
    12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
    16: 'home',
  },
  playstation: {
    0: 'a', 1: 'b', 2: 'x', 3: 'y',
    4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
    8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
    12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
    16: 'home', 17: 'touchpad',
  },
  switch: {
    0: 'b', 1: 'a', 2: 'y', 3: 'x',
    4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
    8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
    12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
    16: 'home',
  },
  '8bitdo': {
    0: 'a', 1: 'b', 2: 'x', 3: 'y',
    4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
    8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
    12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
    16: 'home',
  },
  generic: {
    0: 'a', 1: 'b', 2: 'x', 3: 'y',
    4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2',
    8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
    12: 'dpadUp', 13: 'dpadDown', 14: 'dpadLeft', 15: 'dpadRight',
    16: 'home', 17: 'touchpad',
  },
};

// Analog trigger buttons (reported as value 0-1 instead of boolean)
const ANALOG_BUTTONS = new Set<CanonicalButtonName>(['l2', 'r2']);
// Trigger threshold for treating analog as "pressed"
const TRIGGER_THRESHOLD = 0.1;

export interface CanonicalButtons {
  a: boolean; b: boolean; x: boolean; y: boolean;
  l1: boolean; r1: boolean; l2: number; r2: number;
  select: boolean; start: boolean;
  l3: boolean; r3: boolean;
  dpadUp: boolean; dpadDown: boolean;
  dpadLeft: boolean; dpadRight: boolean;
  home: boolean; touchpad: boolean;
}

export interface MappedGamepad {
  index: number;
  id: string;
  profile: ProfileName;
  buttons: CanonicalButtons;
  axes: number[];
  connected: boolean;
  rawButtonCount: number;
}

// ── Named Profiles (user-saved) ─────────────────────────────────────────

export interface SavedProfile {
  name: string;
  baseProfile: ProfileName;
  mapping: Record<number, CanonicalButtonName>;
}

const PROFILES_STORAGE_KEY = 'retroweb-controller-profiles';
const MAPPINGS_STORAGE_KEY = 'retroweb-controller-mappings';
const ACTIVE_PROFILE_KEY = 'retroweb-active-profiles'; // gamepadId -> profileName

type GamepadEventCallback = (gamepad: MappedGamepad) => void;

export function detectProfile(id: string): ProfileName {
  const lower = id.toLowerCase();
  if (lower.includes('xbox') || lower.includes('microsoft') || lower.includes('045e')) return 'xbox';
  if (lower.includes('054c') || lower.includes('dualshock') || lower.includes('dualsense') || lower.includes('playstation') || lower.includes('wireless controller')) return 'playstation';
  if (lower.includes('057e') || lower.includes('pro controller') || lower.includes('joy-con') || lower.includes('nintendo')) return 'switch';
  if (lower.includes('2dc8') || lower.includes('8bitdo')) return '8bitdo';
  return 'generic';
}

function btn(gp: Gamepad, index: number): boolean {
  return gp.buttons[index]?.pressed ?? false;
}

function trigger(gp: Gamepad, index: number): number {
  return gp.buttons[index]?.value ?? 0;
}

export class GamepadManager {
  private callbacks: { connected: GamepadEventCallback[]; disconnected: GamepadEventCallback[] } = {
    connected: [],
    disconnected: [],
  };
  private knownGamepads: Set<number> = new Set();
  private animationFrameId: number | null = null;
  private customMappings: Map<string, Record<string, string>> = new Map();
  private savedProfiles: Map<string, SavedProfile> = new Map();
  private activeProfiles: Map<string, string> = new Map(); // gamepadId -> profile name

  constructor() {
    this.loadCustomMappings();
    this.loadSavedProfiles();
    this.loadActiveProfiles();

    window.addEventListener('gamepadconnected', (e) => {
      const gp = (e as GamepadEvent).gamepad;
      this.knownGamepads.add(gp.index);
      const mapped = this.mapGamepad(gp);
      this.callbacks.connected.forEach((cb) => cb(mapped));
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      const gp = (e as GamepadEvent).gamepad;
      this.knownGamepads.delete(gp.index);
      const mapped = this.mapGamepad(gp);
      this.callbacks.disconnected.forEach((cb) => cb(mapped));
    });
  }

  on(event: 'connected' | 'disconnected', callback: GamepadEventCallback): void {
    this.callbacks[event].push(callback);
  }

  getGamepads(): MappedGamepad[] {
    const gamepads = navigator.getGamepads();
    const result: MappedGamepad[] = [];
    for (const gp of gamepads) {
      if (gp && gp.connected) {
        result.push(this.mapGamepad(gp));
      }
    }
    return result;
  }

  startPolling(callback: (gamepads: MappedGamepad[]) => void): void {
    this.stopPolling();
    const poll = () => {
      callback(this.getGamepads());
      this.animationFrameId = requestAnimationFrame(poll);
    };
    this.animationFrameId = requestAnimationFrame(poll);
  }

  stopPolling(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // ── Custom mappings per gamepad ID ──

  setCustomMapping(gamepadId: string, mapping: Record<string, string>): void {
    this.customMappings.set(gamepadId, mapping);
    this.saveCustomMappings();
  }

  getCustomMapping(gamepadId: string): Record<string, string> | null {
    return this.customMappings.get(gamepadId) ?? null;
  }

  resetMapping(gamepadId: string): void {
    this.customMappings.delete(gamepadId);
    this.saveCustomMappings();
  }

  // ── Named profiles (save/load/delete) ──

  saveProfile(profile: SavedProfile): void {
    this.savedProfiles.set(profile.name, profile);
    this.persistProfiles();
  }

  deleteProfile(name: string): void {
    this.savedProfiles.delete(name);
    // Remove from active if any gamepad was using it
    for (const [gpId, pName] of this.activeProfiles) {
      if (pName === name) this.activeProfiles.delete(gpId);
    }
    this.persistProfiles();
    this.persistActiveProfiles();
  }

  getProfile(name: string): SavedProfile | null {
    return this.savedProfiles.get(name) ?? null;
  }

  getAllProfiles(): SavedProfile[] {
    return Array.from(this.savedProfiles.values());
  }

  setActiveProfile(gamepadId: string, profileName: string | null): void {
    if (profileName) {
      this.activeProfiles.set(gamepadId, profileName);
    } else {
      this.activeProfiles.delete(gamepadId);
    }
    this.persistActiveProfiles();
  }

  getActiveProfileName(gamepadId: string): string | null {
    return this.activeProfiles.get(gamepadId) ?? null;
  }

  // ── Raw button access for mapping UI ──

  getRawButtonStates(gamepadIndex: number): boolean[] {
    const gp = navigator.getGamepads()[gamepadIndex];
    if (!gp) return [];
    return Array.from(gp.buttons).map(b => b.pressed || b.value > TRIGGER_THRESHOLD);
  }

  getRawButtonValues(gamepadIndex: number): number[] {
    const gp = navigator.getGamepads()[gamepadIndex];
    if (!gp) return [];
    return Array.from(gp.buttons).map(b => b.value);
  }

  /**
   * Get the active button index -> canonical name mapping for a gamepad.
   * Priority: active named profile > custom mapping > profile default.
   */
  getActiveMapping(gamepadId: string, profile: ProfileName): Record<number, CanonicalButtonName> {
    // Check for active named profile
    const activeProfileName = this.activeProfiles.get(gamepadId);
    if (activeProfileName) {
      const saved = this.savedProfiles.get(activeProfileName);
      if (saved) return { ...saved.mapping };
    }

    // Check for custom per-gamepad mapping
    const custom = this.customMappings.get(gamepadId);
    if (custom) {
      const result: Record<number, CanonicalButtonName> = {};
      for (const [idx, name] of Object.entries(custom)) {
        result[Number(idx)] = name as CanonicalButtonName;
      }
      return result;
    }

    return { ...PROFILE_DEFAULTS[profile] };
  }

  private mapGamepad(gp: Gamepad): MappedGamepad {
    const profile = detectProfile(gp.id);
    const mapping = this.getActiveMapping(gp.id, profile);

    const buttons: CanonicalButtons = {
      a: false, b: false, x: false, y: false,
      l1: false, r1: false, l2: 0, r2: 0,
      select: false, start: false, l3: false, r3: false,
      dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
      home: false, touchpad: false,
    };

    for (const [rawIdx, canonicalName] of Object.entries(mapping)) {
      const idx = Number(rawIdx);
      if (ANALOG_BUTTONS.has(canonicalName)) {
        (buttons as any)[canonicalName] = trigger(gp, idx);
      } else {
        (buttons as any)[canonicalName] = btn(gp, idx) || trigger(gp, idx) > TRIGGER_THRESHOLD;
      }
    }

    return {
      index: gp.index, id: gp.id, profile, buttons,
      axes: Array.from(gp.axes), connected: gp.connected,
      rawButtonCount: gp.buttons.length,
    };
  }

  // ── Persistence ──

  private loadCustomMappings(): void {
    try {
      const saved = localStorage.getItem(MAPPINGS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const [key, val] of Object.entries(parsed)) {
          this.customMappings.set(key, val as Record<string, string>);
        }
      }
    } catch { /* ignore */ }
  }

  private saveCustomMappings(): void {
    const obj: Record<string, Record<string, string>> = {};
    for (const [key, val] of this.customMappings) { obj[key] = val; }
    localStorage.setItem(MAPPINGS_STORAGE_KEY, JSON.stringify(obj));
  }

  private loadSavedProfiles(): void {
    try {
      const saved = localStorage.getItem(PROFILES_STORAGE_KEY);
      if (saved) {
        const arr: SavedProfile[] = JSON.parse(saved);
        for (const p of arr) this.savedProfiles.set(p.name, p);
      }
    } catch { /* ignore */ }
  }

  private persistProfiles(): void {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(Array.from(this.savedProfiles.values())));
  }

  private loadActiveProfiles(): void {
    try {
      const saved = localStorage.getItem(ACTIVE_PROFILE_KEY);
      if (saved) {
        const obj = JSON.parse(saved);
        for (const [key, val] of Object.entries(obj)) {
          this.activeProfiles.set(key, val as string);
        }
      }
    } catch { /* ignore */ }
  }

  private persistActiveProfiles(): void {
    const obj: Record<string, string> = {};
    for (const [key, val] of this.activeProfiles) { obj[key] = val; }
    localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(obj));
  }
}
