# Controller & Gamepad Support

> See [RETROWEB.md](RETROWEB.md) for full project documentation.
> This file focuses on controller-specific technical details.

## Overview

RetroWeb supports physical gamepads via the **Web Gamepad API** (18 buttons + 4 axes) and virtual touch controls for mobile (provided by EmulatorJS). Controllers are auto-detected, mapped to a canonical button layout, and fully customizable.

## Supported Controllers

### Tier 1 — Full Support (auto-detected by vendor ID)

| Controller | Vendor ID | Profile | Buttons | Detection Pattern |
|-----------|-----------|---------|---------|-------------------|
| Xbox One/Series | 045e | xbox | 17 | `xbox`, `microsoft`, `045e` |
| Xbox 360 | 045e | xbox | 17 | Same as above |
| PS4 DualShock 4 | 054c | playstation | 18 | `054c`, `dualshock`, `wireless controller` |
| PS5 DualSense | 054c | playstation | 18 | `054c`, `dualsense` |
| Switch Pro | 057e | switch | 17 | `057e`, `pro controller`, `nintendo` |
| Joy-Con | 057e | switch | 17 | `057e`, `joy-con` |
| 8BitDo | 2dc8 | 8bitdo | 17 | `2dc8`, `8bitdo` |

### Tier 2 — Generic USB HID

Any gamepad that exposes standard HID reports. Uses index-based fallback mapping.

### Tier 3 — Mobile Touch

EmulatorJS provides virtual gamepad overlay automatically on touch devices.

## Standard Gamepad API Button Indices

All controllers that report `mapping: "standard"` follow the W3C standard:

| Index | Canonical Name | Xbox | PlayStation | Switch |
|-------|---------------|------|------------|--------|
| 0 | a | A | Cross (X) | B |
| 1 | b | B | Circle (O) | A |
| 2 | x | X | Square | Y |
| 3 | y | Y | Triangle | X |
| 4 | l1 | LB | L1 | L |
| 5 | r1 | RB | R1 | R |
| 6 | l2 | LT (analog 0-1) | L2 (analog 0-1) | ZL |
| 7 | r2 | RT (analog 0-1) | R2 (analog 0-1) | ZR |
| 8 | select | View | Share / Create | Minus |
| 9 | start | Menu | Options | Plus |
| 10 | l3 | LS (left stick click) | L3 | LS |
| 11 | r3 | RS (right stick click) | R3 | RS |
| 12 | dpadUp | D-pad Up | D-pad Up | D-pad Up |
| 13 | dpadDown | D-pad Down | D-pad Down | D-pad Down |
| 14 | dpadLeft | D-pad Left | D-pad Left | D-pad Left |
| 15 | dpadRight | D-pad Right | D-pad Right | D-pad Right |
| 16 | home | Xbox button | PS button | Home |
| 17 | touchpad | Share* | Touchpad click | Capture* |

*Button 16-17 availability depends on OS/browser. Not all controllers expose these.

### Axes

| Index | Description |
|-------|-------------|
| 0 | Left stick X (-1 = left, +1 = right) |
| 1 | Left stick Y (-1 = up, +1 = down) |
| 2 | Right stick X |
| 3 | Right stick Y |

## Analog Triggers

Buttons 6 (L2) and 7 (R2) report analog values 0.0-1.0:
- **Threshold**: 0.1 — values above this are treated as "pressed" for boolean checks
- **Raw value** available for trigger-sensitive use
- **PS5 DualSense**: Both `pressed` and `value` properties work correctly in Chrome/Edge. Firefox may have issues with trigger reporting.

## Profile Detection

Controllers are identified by matching `Gamepad.id` against known patterns:

```typescript
function detectProfile(id: string): ProfileName {
  const lower = id.toLowerCase();
  if (lower.includes('xbox') || lower.includes('microsoft') || lower.includes('045e')) return 'xbox';
  if (lower.includes('054c') || lower.includes('dualshock') || lower.includes('dualsense')
      || lower.includes('playstation') || lower.includes('wireless controller')) return 'playstation';
  if (lower.includes('057e') || lower.includes('pro controller')
      || lower.includes('joy-con') || lower.includes('nintendo')) return 'switch';
  if (lower.includes('2dc8') || lower.includes('8bitdo')) return '8bitdo';
  return 'generic';
}
```

## Mapping Priority

When reading a gamepad, the mapping system checks (highest priority first):

1. **Active named profile** — user assigned a saved profile to this controller
2. **Custom per-gamepad mapping** — user remapped buttons for this specific `Gamepad.id`
3. **Profile default** — based on auto-detected profile

## Switch Controller A/B X/Y Swap

The Switch uses a different physical layout than Xbox/PlayStation:
- Xbox A position = Switch B
- Xbox B position = Switch A
- Xbox X position = Switch Y
- Xbox Y position = Switch X

The `switch` profile default handles this by mapping: `0→b, 1→a, 2→y, 3→x`.

## Architecture

```
gamepadconnected / gamepaddisconnected events
              │
              ▼
  ┌─────────────────────────┐
  │     GamepadManager       │
  │                          │
  │  Poll: rAF loop          │
  │  Detect: vendor ID match │
  │  Map: profile → canonical│
  │  Custom: localStorage    │
  │  Profiles: named presets │
  │                          │
  │  Outputs: MappedGamepad  │
  └──────────┬──────────────┘
             │
      ┌──────┼──────────┐
      │      │          │
      ▼      ▼          ▼
   Kiosk   Settings   Gameplay
   Input   Indicator  (EmulatorJS
   Handler Update     handles its
                      own gamepad)
```

## GamepadManager API

```typescript
class GamepadManager {
  // Core
  getGamepads(): MappedGamepad[];
  on(event: 'connected' | 'disconnected', cb): void;
  startPolling(callback): void;
  stopPolling(): void;

  // Per-gamepad custom mapping
  setCustomMapping(gamepadId: string, mapping: Record<string, string>): void;
  getCustomMapping(gamepadId: string): Record<string, string> | null;
  resetMapping(gamepadId: string): void;
  getActiveMapping(gamepadId: string, profile: ProfileName): Record<number, CanonicalButtonName>;

  // Named profiles
  saveProfile(profile: SavedProfile): void;
  deleteProfile(name: string): void;
  getProfile(name: string): SavedProfile | null;
  getAllProfiles(): SavedProfile[];
  setActiveProfile(gamepadId: string, profileName: string | null): void;
  getActiveProfileName(gamepadId: string): string | null;

  // Raw access (for mapping UI)
  getRawButtonStates(gamepadIndex: number): boolean[];
  getRawButtonValues(gamepadIndex: number): number[];
}

interface MappedGamepad {
  index: number;
  id: string;
  profile: ProfileName;  // 'xbox' | 'playstation' | 'switch' | '8bitdo' | 'generic'
  buttons: CanonicalButtons;
  axes: number[];
  connected: boolean;
  rawButtonCount: number;
}

interface CanonicalButtons {
  a: boolean; b: boolean; x: boolean; y: boolean;
  l1: boolean; r1: boolean;
  l2: number; r2: number;      // 0.0-1.0 analog
  select: boolean; start: boolean;
  l3: boolean; r3: boolean;
  dpadUp: boolean; dpadDown: boolean;
  dpadLeft: boolean; dpadRight: boolean;
  home: boolean; touchpad: boolean;
}

interface SavedProfile {
  name: string;
  baseProfile: ProfileName;
  mapping: Record<number, CanonicalButtonName>;
}
```

## Storage Keys

| Key | Type | Description |
|-----|------|-------------|
| `retroweb-controller-mappings` | JSON object | `{ "gamepadId": { "0": "a", "1": "b", ... } }` |
| `retroweb-controller-profiles` | JSON array | `[{ name, baseProfile, mapping }]` |
| `retroweb-active-profiles` | JSON object | `{ "gamepadId": "profileName" }` |

## Testing Checklist

- [ ] Xbox controller: all 17 buttons detected and mapped
- [ ] PS5 DualSense: all 18 buttons including touchpad and PS button
- [ ] PS5 L2/R2 triggers: analog values 0-1 (not just boolean)
- [ ] Switch Pro: A/B X/Y correctly swapped
- [ ] Generic USB gamepad: fallback mapping
- [ ] Visual mapping editor: click button → press physical → assigned
- [ ] Save/load/delete named profiles
- [ ] Custom mapping persists across page reload
- [ ] Hot-plug: connect/disconnect during gameplay
- [ ] Multiple controllers simultaneously
- [ ] Hotkey combos during gameplay (Select+Start = exit, etc.)
- [ ] Kiosk mode: all navigation buttons work
