// ── Game System Profiles ─────────────────────────────────────────────────
// Defines which buttons each game system uses and their labels

import type { CanonicalButtonName } from './gamepad-manager';

export interface GameSystemProfile {
  id: string;
  name: string;
  buttons: CanonicalButtonName[];
  labels: Partial<Record<CanonicalButtonName, string>>;
}

export const GAME_PROFILES: GameSystemProfile[] = [
  {
    id: 'nes', name: 'NES / Famicom',
    buttons: ['a', 'b', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', select: 'Select', start: 'Start' },
  },
  {
    id: 'snes', name: 'SNES / SFC',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', x: 'X', y: 'Y', l1: 'L', r1: 'R', select: 'Select', start: 'Start' },
  },
  {
    id: 'gb', name: 'Game Boy / GBC',
    buttons: ['a', 'b', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', select: 'Select', start: 'Start' },
  },
  {
    id: 'gba', name: 'Game Boy Advance',
    buttons: ['a', 'b', 'l1', 'r1', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', l1: 'L', r1: 'R', select: 'Select', start: 'Start' },
  },
  {
    id: 'n64', name: 'Nintendo 64',
    buttons: ['a', 'b', 'l1', 'r1', 'l2', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', l1: 'L', r1: 'R', l2: 'Z', select: 'C-Btn' },
  },
  {
    id: 'nds', name: 'Nintendo DS',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', x: 'X', y: 'Y', l1: 'L', r1: 'R', select: 'Select', start: 'Start' },
  },
  {
    id: 'psx', name: 'PlayStation',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: '\u2715', b: '\u25CB', x: '\u25A1', y: '\u25B3', select: 'Select', start: 'Start' },
  },
  {
    id: 'psp', name: 'PSP',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: '\u2715', b: '\u25CB', x: '\u25A1', y: '\u25B3', select: 'Select', start: 'Start' },
  },
  {
    id: 'genesis', name: 'Sega Genesis',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', x: 'C', y: 'X', l1: 'Y', r1: 'Z', start: 'Start' },
  },
  {
    id: 'dreamcast', name: 'Dreamcast',
    buttons: ['a', 'b', 'x', 'y', 'l2', 'r2', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: 'A', b: 'B', x: 'X', y: 'Y', l2: 'L', r2: 'R', start: 'Start' },
  },
  {
    id: 'arcade', name: 'Arcade / Neo Geo',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'select', 'start', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'],
    labels: { a: '1', b: '2', x: '3', y: '4', l1: '5', r1: '6', select: 'Coin', start: 'Start' },
  },
  {
    id: 'full', name: 'All Buttons',
    buttons: ['a', 'b', 'x', 'y', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight', 'home', 'touchpad'],
    labels: {},
  },
];

/** Map system IDs to game profile IDs */
const SYSTEM_TO_PROFILE: Record<string, string> = {
  nes: 'nes', famicom: 'nes',
  snes: 'snes', sfc: 'snes',
  gb: 'gb', gbc: 'gb',
  gba: 'gba',
  n64: 'n64',
  nds: 'nds',
  psx: 'psx',
  psp: 'psp',
  genesis: 'genesis', megadrive: 'genesis', mastersystem: 'genesis', gamegear: 'genesis',
  saturn: 'genesis',
  dreamcast: 'dreamcast',
  neogeo: 'arcade', arcade: 'arcade', cps1: 'arcade', cps2: 'arcade', cps3: 'arcade', fbneo: 'arcade', mame: 'arcade',
  pcengine: 'snes',
  atari2600: 'nes', atari7800: 'nes', atarilynx: 'nes',
};

export function getGameProfileForSystem(systemId: string): GameSystemProfile {
  const profileId = SYSTEM_TO_PROFILE[systemId] || 'full';
  return GAME_PROFILES.find(p => p.id === profileId) || GAME_PROFILES[GAME_PROFILES.length - 1];
}

export function getDefaultGameProfile(): GameSystemProfile {
  return GAME_PROFILES.find(p => p.id === 'snes')!;
}

// ── Controller SVG Visualizations ────────────────────────────────────────
// Each returns an SVG string with data-ctrl-btn attributes on interactive buttons.
// Buttons highlight via CSS classes (.ctrl-svg-btn-active, .ctrl-svg-btn-pressed).

type ControllerSVGType = 'playstation' | 'xbox' | 'switch' | '8bitdo' | 'generic';

export function getControllerSVG(profile: ControllerSVGType): string {
  switch (profile) {
    case 'playstation': return playstationSVG();
    case 'xbox': return xboxSVG();
    case 'switch': return switchSVG();
    case '8bitdo': return eightBitDoSVG();
    default: return genericSVG();
  }
}

function playstationSVG(): string {
  return `<svg viewBox="0 0 420 280" class="controller-svg" data-controller="playstation">
  <!-- Body -->
  <path class="ctrl-svg-body" d="M115,60 Q115,30 150,18 L270,18 Q305,30 305,60
    L318,60 Q348,60 358,85 L372,165 Q382,218 348,245 L328,255 Q308,262 290,240 L265,205 L155,205
    L130,240 Q112,262 92,255 L72,245 Q38,218 48,165 L62,85 Q72,60 102,60 Z"/>
  <!-- Touchpad -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="touchpad" x="163" y="48" width="94" height="48" rx="8"/>
  <text class="ctrl-svg-lbl" x="210" y="76">Touchpad</text>
  <!-- L1/R1 -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l1" x="68" y="34" width="54" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="95" y="46">L1</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r1" x="298" y="34" width="54" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="325" y="46">R1</text>
  <!-- L2/R2 -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l2" x="63" y="12" width="58" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="92" y="24">L2</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r2" x="299" y="12" width="58" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="328" y="24">R2</text>
  <!-- D-pad -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadUp" x="93" y="100" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadDown" x="93" y="140" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadLeft" x="73" y="120" width="20" height="22" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadRight" x="115" y="120" width="20" height="22" rx="3"/>
  <!-- Face buttons -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="y" cx="318" cy="102" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="107">\u25B3</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="x" cx="292" cy="128" r="14"/>
  <text class="ctrl-svg-lbl" x="292" y="133">\u25A1</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="b" cx="344" cy="128" r="14"/>
  <text class="ctrl-svg-lbl" x="344" y="133">\u25CB</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="a" cx="318" cy="154" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="159">\u2715</text>
  <!-- Share/Options -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="select" cx="172" cy="108" r="8"/>
  <text class="ctrl-svg-lbl" x="172" y="111" style="font-size:6px">Share</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="start" cx="248" cy="108" r="8"/>
  <text class="ctrl-svg-lbl" x="248" y="111" style="font-size:6px">Opt</text>
  <!-- PS button -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="home" cx="210" cy="138" r="10"/>
  <text class="ctrl-svg-lbl" x="210" y="142">PS</text>
  <!-- Sticks -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="l3" cx="152" cy="172" r="20"/>
  <text class="ctrl-svg-lbl" x="152" y="176">L3</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="r3" cx="268" cy="172" r="20"/>
  <text class="ctrl-svg-lbl" x="268" y="176">R3</text>
</svg>`;
}

function xboxSVG(): string {
  return `<svg viewBox="0 0 420 280" class="controller-svg" data-controller="xbox">
  <!-- Body -->
  <path class="ctrl-svg-body" d="M108,65 Q108,32 148,18 L272,18 Q312,32 312,65
    L328,65 Q355,65 365,92 L375,168 Q382,222 348,248 L325,258 Q305,265 288,242 L262,205 L158,205
    L132,242 Q115,265 95,258 L72,248 Q38,222 45,168 L55,92 Q65,65 92,65 Z"/>
  <!-- LB/RB -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l1" x="65" y="35" width="55" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="92" y="47">LB</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r1" x="300" y="35" width="55" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="327" y="47">RB</text>
  <!-- LT/RT -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l2" x="62" y="12" width="58" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="91" y="24">LT</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r2" x="300" y="12" width="58" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="329" y="24">RT</text>
  <!-- Left stick (higher - asymmetric) -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="l3" cx="142" cy="110" r="22"/>
  <text class="ctrl-svg-lbl" x="142" y="114">LS</text>
  <!-- D-pad (lower left) -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadUp" x="131" y="152" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadDown" x="131" y="192" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadLeft" x="111" y="172" width="20" height="22" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadRight" x="153" y="172" width="20" height="22" rx="3"/>
  <!-- Right stick (lower right) -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="r3" cx="278" cy="172" r="22"/>
  <text class="ctrl-svg-lbl" x="278" y="176">RS</text>
  <!-- Face buttons -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="y" cx="318" cy="90" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="95">Y</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="x" cx="292" cy="116" r="14"/>
  <text class="ctrl-svg-lbl" x="292" y="121">X</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="b" cx="344" cy="116" r="14"/>
  <text class="ctrl-svg-lbl" x="344" y="121">B</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="a" cx="318" cy="142" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="147">A</text>
  <!-- View/Menu -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="select" x="188" y="100" width="18" height="14" rx="3"/>
  <text class="ctrl-svg-lbl" x="197" y="111" style="font-size:6px">View</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="start" x="228" y="100" width="18" height="14" rx="3"/>
  <text class="ctrl-svg-lbl" x="237" y="111" style="font-size:6px">Menu</text>
  <!-- Xbox button -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="home" cx="210" cy="72" r="12"/>
  <text class="ctrl-svg-lbl" x="210" y="76">X</text>
  <!-- Share -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="touchpad" cx="210" cy="130" r="7"/>
  <text class="ctrl-svg-lbl" x="210" y="133" style="font-size:5px">Share</text>
</svg>`;
}

function switchSVG(): string {
  return `<svg viewBox="0 0 420 280" class="controller-svg" data-controller="switch">
  <!-- Body -->
  <path class="ctrl-svg-body" d="M108,60 Q108,28 148,16 L272,16 Q312,28 312,60
    L325,60 Q352,60 362,88 L374,170 Q382,225 348,250 L325,260 Q305,266 288,245 L262,208 L158,208
    L132,245 Q115,266 95,260 L72,250 Q38,225 46,170 L58,88 Q68,60 95,60 Z"/>
  <!-- L/R -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l1" x="65" y="34" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="91" y="46">L</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r1" x="303" y="34" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="329" y="46">R</text>
  <!-- ZL/ZR -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l2" x="62" y="12" width="55" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="89" y="24">ZL</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r2" x="303" y="12" width="55" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="330" y="24">ZR</text>
  <!-- Left stick -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="l3" cx="142" cy="105" r="22"/>
  <text class="ctrl-svg-lbl" x="142" y="109">LS</text>
  <!-- D-pad -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadUp" x="131" y="150" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadDown" x="131" y="190" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadLeft" x="111" y="170" width="20" height="22" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadRight" x="153" y="170" width="20" height="22" rx="3"/>
  <!-- Face buttons (Switch layout: A=right, B=down, X=up, Y=left) -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="x" cx="318" cy="90" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="95">X</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="y" cx="292" cy="116" r="14"/>
  <text class="ctrl-svg-lbl" x="292" y="121">Y</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="a" cx="344" cy="116" r="14"/>
  <text class="ctrl-svg-lbl" x="344" y="121">A</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="b" cx="318" cy="142" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="147">B</text>
  <!-- Right stick -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="r3" cx="278" cy="172" r="22"/>
  <text class="ctrl-svg-lbl" x="278" y="176">RS</text>
  <!-- Minus/Plus -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="select" x="186" y="92" width="20" height="12" rx="3"/>
  <text class="ctrl-svg-lbl" x="196" y="101" style="font-size:7px">\u2212</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="start" x="228" y="92" width="20" height="12" rx="3"/>
  <text class="ctrl-svg-lbl" x="238" y="101" style="font-size:7px">+</text>
  <!-- Home -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="home" cx="238" cy="135" r="9"/>
  <text class="ctrl-svg-lbl" x="238" y="139" style="font-size:6px">Home</text>
  <!-- Capture -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="touchpad" x="180" y="128" width="16" height="16" rx="3"/>
  <text class="ctrl-svg-lbl" x="188" y="140" style="font-size:5px">Cap</text>
</svg>`;
}

function eightBitDoSVG(): string {
  return `<svg viewBox="0 0 420 240" class="controller-svg" data-controller="8bitdo">
  <!-- Body (compact SNES-like) -->
  <path class="ctrl-svg-body" d="M80,55 Q80,25 130,15 L290,15 Q340,25 340,55
    L350,55 Q370,55 378,75 L385,145 Q390,190 358,210 L340,218 Q325,222 315,205 L295,175 L125,175
    L105,205 Q95,222 80,218 L62,210 Q30,190 35,145 L42,75 Q50,55 70,55 Z"/>
  <!-- L/R -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l1" x="48" y="28" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="74" y="40">L</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r1" x="320" y="28" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="346" y="40">R</text>
  <!-- L2/R2 -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l2" x="45" y="8" width="55" height="14" rx="5"/>
  <text class="ctrl-svg-lbl" x="72" y="19">L2</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r2" x="320" y="8" width="55" height="14" rx="5"/>
  <text class="ctrl-svg-lbl" x="347" y="19">R2</text>
  <!-- D-pad -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadUp" x="103" y="68" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadDown" x="103" y="108" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadLeft" x="83" y="88" width="20" height="22" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadRight" x="125" y="88" width="20" height="22" rx="3"/>
  <!-- Face buttons -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="y" cx="310" cy="72" r="14"/>
  <text class="ctrl-svg-lbl" x="310" y="77">Y</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="x" cx="284" cy="98" r="14"/>
  <text class="ctrl-svg-lbl" x="284" y="103">X</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="b" cx="336" cy="98" r="14"/>
  <text class="ctrl-svg-lbl" x="336" y="103">B</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="a" cx="310" cy="124" r="14"/>
  <text class="ctrl-svg-lbl" x="310" y="129">A</text>
  <!-- Select/Start -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="select" x="180" y="86" width="22" height="12" rx="4"/>
  <text class="ctrl-svg-lbl" x="191" y="95" style="font-size:6px">Sel</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="start" x="218" y="86" width="22" height="12" rx="4"/>
  <text class="ctrl-svg-lbl" x="229" y="95" style="font-size:6px">Start</text>
  <!-- Home -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="home" cx="210" cy="65" r="8"/>
  <text class="ctrl-svg-lbl" x="210" y="68" style="font-size:5px">Home</text>
  <!-- Sticks -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="l3" cx="152" cy="148" r="16"/>
  <text class="ctrl-svg-lbl" x="152" y="152">L3</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="r3" cx="268" cy="148" r="16"/>
  <text class="ctrl-svg-lbl" x="268" y="152">R3</text>
</svg>`;
}

function genericSVG(): string {
  return `<svg viewBox="0 0 420 260" class="controller-svg" data-controller="generic">
  <!-- Body -->
  <path class="ctrl-svg-body" d="M110,58 Q110,28 150,16 L270,16 Q310,28 310,58
    L322,58 Q350,58 360,84 L372,165 Q380,218 348,244 L326,254 Q308,260 292,240 L266,205 L154,205
    L128,240 Q112,260 94,254 L72,244 Q40,218 48,165 L60,84 Q70,58 98,58 Z"/>
  <!-- L1/R1 -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l1" x="66" y="34" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="92" y="46">L1</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r1" x="302" y="34" width="52" height="16" rx="5"/>
  <text class="ctrl-svg-lbl" x="328" y="46">R1</text>
  <!-- L2/R2 -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="l2" x="62" y="12" width="56" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="90" y="24">L2</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="r2" x="302" y="12" width="56" height="16" rx="6"/>
  <text class="ctrl-svg-lbl" x="330" y="24">R2</text>
  <!-- D-pad -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadUp" x="99" y="100" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadDown" x="99" y="140" width="22" height="20" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadLeft" x="79" y="120" width="20" height="22" rx="3"/>
  <rect class="ctrl-svg-btn" data-ctrl-btn="dpadRight" x="121" y="120" width="20" height="22" rx="3"/>
  <!-- Face buttons -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="y" cx="318" cy="102" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="107">Y</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="x" cx="292" cy="128" r="14"/>
  <text class="ctrl-svg-lbl" x="292" y="133">X</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="b" cx="344" cy="128" r="14"/>
  <text class="ctrl-svg-lbl" x="344" y="133">B</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="a" cx="318" cy="154" r="14"/>
  <text class="ctrl-svg-lbl" x="318" y="159">A</text>
  <!-- Select/Start -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="select" x="186" y="100" width="20" height="14" rx="4"/>
  <text class="ctrl-svg-lbl" x="196" y="111" style="font-size:6px">Sel</text>
  <rect class="ctrl-svg-btn" data-ctrl-btn="start" x="220" y="100" width="20" height="14" rx="4"/>
  <text class="ctrl-svg-lbl" x="230" y="111" style="font-size:6px">Start</text>
  <!-- Home -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="home" cx="210" cy="76" r="10"/>
  <text class="ctrl-svg-lbl" x="210" y="80">H</text>
  <!-- Sticks -->
  <circle class="ctrl-svg-btn" data-ctrl-btn="l3" cx="148" cy="178" r="20"/>
  <text class="ctrl-svg-lbl" x="148" y="182">L3</text>
  <circle class="ctrl-svg-btn" data-ctrl-btn="r3" cx="272" cy="178" r="20"/>
  <text class="ctrl-svg-lbl" x="272" y="182">R3</text>
  <!-- Touchpad/Misc -->
  <rect class="ctrl-svg-btn" data-ctrl-btn="touchpad" x="190" y="132" width="40" height="18" rx="5"/>
  <text class="ctrl-svg-lbl" x="210" y="145" style="font-size:6px">Misc</text>
</svg>`;
}
