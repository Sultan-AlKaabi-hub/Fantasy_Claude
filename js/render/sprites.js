/**
 * sprites.js — every sprite and tile is drawn procedurally at boot.
 *
 * Nothing is fetched: the whole art set is generated from parametric pixel
 * drawing routines and cached in offscreen canvases. This keeps the precache
 * tiny, guarantees offline play, and lets the three character variants share
 * one drawing routine with a different palette.
 *
 * Conventions
 *   • All entity sprites face RIGHT; the renderer mirrors for facing < 0.
 *   • Player frames are 32×32 with the feet at y = 30 and the centre at x = 16.
 *   • Tiles are 16×16; each zone has its own palette and 4 variants of the
 *     main solid tile so large walls do not repeat visibly.
 */
import { TILE, CHARACTERS } from '../core/constants.js';
import { mulberry32 } from '../core/util.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return { c, g };
}

/** Pixel-line helper (Bresenham) used for swords and spears. */
function line(g, x0, y0, x1, y1, col) {
  g.fillStyle = col;
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
  for (;;) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
const R = (g, x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

/* ================================================================== */
/* Zone palettes                                                       */
/* ================================================================== */
export const ZONE_PAL = {
  market: {
    sky: ['#79c2ff', '#cfe9ff'], skyMid: '#a9d8ff',
    far: '#9fb9d9', mid: '#6f7fa6', midLight: '#8b9bc4', near: '#4c5573',
    stone: '#c9a97a', stoneDark: '#a3855b', stoneLight: '#e6cb9c', stoneLine: '#8c6f48',
    top: '#63b04e', topLight: '#8fd46b', topDark: '#3f7f34',
    plat: '#8a5a33', platLight: '#b8804b', platDark: '#5c3a1f',
    spike: '#d6d0c2', spikeDark: '#8f8a7d',
    liquid: ['#3d78c7', '#5b9ae6', '#8cc3ff'],
    accent: '#e0453a', accent2: '#3e7fd6', accent3: '#f2c94c',
  },
  chapel: {
    sky: ['#5d7dd9', '#f3a4c8'], skyMid: '#9c8fe0',
    far: '#7f8fd6', mid: '#5566b3', midLight: '#7d8ccf', near: '#3b447f',
    stone: '#7f8fb8', stoneDark: '#5b6a92', stoneLight: '#aab8dd', stoneLine: '#41507a',
    top: '#e59ad0', topLight: '#ffc6ea', topDark: '#b26aa0',
    plat: '#c8d2ea', platLight: '#eef2ff', platDark: '#8d98bb',
    spike: '#d7dcf0', spikeDark: '#8790b2',
    liquid: ['#26437f', '#3a63b5', '#6f9be6'],
    accent: '#ff5f7e', accent2: '#7ce0ff', accent3: '#ffe08a',
  },
  keep: {
    sky: ['#3a0d1f', '#ff5a3c'], skyMid: '#a8253a',
    far: '#2a0a14', mid: '#4a1424', midLight: '#6b1f33', near: '#1a060d',
    stone: '#7a2e35', stoneDark: '#521c23', stoneLight: '#a54350', stoneLine: '#33101a',
    top: '#4c4a52', topLight: '#6e6b74', topDark: '#2d2b32',
    plat: '#5a3a3f', platLight: '#7c5158', platDark: '#3b2226',
    spike: '#c9b7a8', spikeDark: '#7a6a60',
    liquid: ['#ff3d1a', '#ff8a2a', '#ffd166'],
    accent: '#ffb347', accent2: '#ff2e4c', accent3: '#ffe08a',
  },
};

/* ================================================================== */
/* Player                                                              */
/* ================================================================== */
const STEEL = { k: '#2a2d3e', s: '#5b6078', l: '#9aa2bd', b: '#e6eef8', h: '#14121c', e: '#ffe08a', skin: '#e8c39e' };

/**
 * Draw the Pilgrim in a given pose.
 * @param {CanvasRenderingContext2D} g
 * @param {{cape:string, capeDark:string, trim:string}} v  character variant colours
 * @param {object} pose
 */
function drawPilgrim(g, v, pose) {
  const {
    legs = 'stand', arm = 'rest', bob = 0, lean = 0, crouch = 0, capeFlow = 0, tuck = false, kneel = false,
  } = pose;
  const fy = 30;                                  // feet y
  const cx = 16 + lean;
  const ty = 13 + bob + crouch;                   // torso top

  // ---- cape (behind everything). Flows opposite to facing. ----
  const capePts = [
    [cx - 6, ty + 1], [cx - 8 - capeFlow, ty + 6], [cx - 9 - capeFlow * 2, ty + 11], [cx - 8 - capeFlow, ty + 14],
  ];
  for (let i = 0; i < capePts.length - 1; i++) {
    const [x0, y0] = capePts[i], [x1, y1] = capePts[i + 1];
    for (let t = 0; t <= 1; t += 0.2) {
      const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
      R(g, x, y, 5 + (i > 0 ? 1 : 0), 2, v.cape);
      R(g, x, y + 1, 2, 1, v.capeDark);
    }
  }
  R(g, cx - 5, ty + 1, 6, 2, v.capeDark);        // cape collar

  // ---- legs ----
  const legCol = STEEL.k, bootCol = STEEL.s;
  const drawLeg = (x, y, h, boot = true) => { R(g, x, y, 3, h, legCol); if (boot) R(g, x, y + h - 2, 3, 2, bootCol); };
  if (kneel) {
    drawLeg(cx - 4, fy - 5, 5); R(g, cx + 1, fy - 3, 6, 3, legCol);
  } else if (legs === 'stand') {
    drawLeg(cx - 4, fy - 7 + crouch, 7 - crouch); drawLeg(cx + 1, fy - 7 + crouch, 7 - crouch);
  } else if (legs.startsWith('run')) {
    const f = +legs.slice(3);
    const sp = [[-6, 0, 2, -2], [-3, -2, 3, 0], [1, 0, -5, -2], [3, -2, -3, 0]][f];
    drawLeg(cx + sp[0], fy - 7 + sp[1], 7 + sp[1]); drawLeg(cx + sp[2], fy - 7 + sp[3], 7 + sp[3]);
  } else if (legs === 'air') {
    drawLeg(cx - 5, fy - 8, 6); drawLeg(cx + 2, fy - 6, 6);
  } else if (legs === 'fall') {
    drawLeg(cx - 5, fy - 6, 6); drawLeg(cx + 2, fy - 7, 7);
  } else if (legs === 'wall') {
    drawLeg(cx - 2, fy - 7, 5); drawLeg(cx + 2, fy - 5, 5);
  } else if (legs === 'tuck') {
    R(g, cx - 6, fy - 5, 5, 3, legCol); R(g, cx + 3, fy - 4, 5, 3, legCol);
  }

  // ---- torso & armour ----
  const tw = tuck ? 13 : 11;
  R(g, cx - 5, ty, tw, 10, STEEL.s);
  R(g, cx - 5, ty, tw, 1, STEEL.l);              // shoulder plate
  R(g, cx - 3, ty + 3, 7, 5, STEEL.k);            // chest shadow
  R(g, cx - 2, ty + 4, 4, 3, STEEL.l);            // chest plate glint
  R(g, cx - 5, ty + 7, tw, 2, v.trim);            // belt
  R(g, cx + 5, ty + 2, 2, 5, STEEL.l);            // pauldron front

  // ---- hood & face ----
  const hy = ty - 8;
  R(g, cx - 4, hy + 1, 9, 8, STEEL.k);            // hood block
  R(g, cx - 3, hy, 6, 2, STEEL.k);                // hood peak
  R(g, cx - 4, hy + 3, 2, 6, STEEL.s);            // hood highlight (back)
  R(g, cx - 1, hy + 4, 6, 4, STEEL.h);            // face shadow
  R(g, cx + 2, hy + 5, 2, 1, STEEL.e);            // eye glint
  R(g, cx + 5, hy + 3, 1, 5, STEEL.k);            // hood edge

  // ---- arm & sword ----
  const armCol = STEEL.s, hand = STEEL.skin, blade = STEEL.b, hilt = v.trim;
  const sword = (hx, hy2, ang, len = 11) => {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const tx = Math.round(hx + dx * len), tyy = Math.round(hy2 + dy * len);
    line(g, Math.round(hx - dx * 2), Math.round(hy2 - dy * 2), Math.round(hx + dx), Math.round(hy2 + dy), hilt);   // grip
    line(g, Math.round(hx + dx * 2), Math.round(hy2 + dy * 2), tx, tyy, blade);
    // cross-guard perpendicular
    line(g, Math.round(hx - dy * 2), Math.round(hy2 + dx * 2), Math.round(hx + dy * 2), Math.round(hy2 - dx * 2), hilt);
    R(g, Math.round(hx), Math.round(hy2), 2, 2, hand);
  };
  const sx = cx + 4, sy = ty + 2;                 // shoulder
  switch (arm) {
    case 'rest': line(g, sx, sy, cx + 6, ty + 7, armCol); sword(cx + 6, ty + 8, Math.PI * 0.35); break;
    case 'wind': line(g, sx, sy, cx - 2, ty - 2, armCol); sword(cx - 3, ty - 3, -Math.PI * 0.8, 10); break;
    case 'swing': line(g, sx, sy, cx + 8, ty + 3, armCol); sword(cx + 9, ty + 3, 0.05, 12); break;
    case 'swing2': line(g, sx, sy, cx + 8, ty + 6, armCol); sword(cx + 9, ty + 6, -0.25, 12); break;
    case 'heavy': line(g, sx, sy, cx + 9, ty + 4, armCol); sword(cx + 10, ty + 4, 0.15, 14); break;
    case 'up': line(g, sx, sy, cx + 3, ty - 4, armCol); sword(cx + 3, ty - 5, -Math.PI / 2, 12); break;
    case 'down': line(g, sx, sy, cx + 5, ty + 9, armCol); sword(cx + 5, ty + 10, Math.PI / 2, 11); break;
    case 'guard': line(g, sx, sy, cx + 7, ty + 2, armCol); sword(cx + 7, ty + 2, -Math.PI / 2 + 0.2, 11); break;
    case 'guardOk': line(g, sx, sy, cx + 8, ty + 1, armCol); sword(cx + 8, ty + 1, -Math.PI / 2 - 0.5, 12); break;
    case 'hurt': line(g, sx, sy, cx - 4, ty + 5, armCol); sword(cx - 5, ty + 6, Math.PI * 0.6, 9); break;
    case 'none': break;
    default: break;
  }
}

export const PLAYER_POSES = {
  idle0: { legs: 'stand', arm: 'rest', capeFlow: 0 },
  idle1: { legs: 'stand', arm: 'rest', bob: 1, capeFlow: 1 },
  run0: { legs: 'run0', arm: 'rest', capeFlow: 2, lean: 1 },
  run1: { legs: 'run1', arm: 'rest', capeFlow: 3, lean: 1, bob: 1 },
  run2: { legs: 'run2', arm: 'rest', capeFlow: 2, lean: 1 },
  run3: { legs: 'run3', arm: 'rest', capeFlow: 3, lean: 1, bob: 1 },
  jump: { legs: 'air', arm: 'rest', capeFlow: 1, bob: -1 },
  fall: { legs: 'fall', arm: 'rest', capeFlow: -1, bob: 0 },
  dash: { legs: 'tuck', arm: 'none', capeFlow: 4, lean: 3, crouch: 4, tuck: true },
  wall: { legs: 'wall', arm: 'rest', capeFlow: 0, lean: -1 },
  atk0a: { legs: 'stand', arm: 'wind', capeFlow: 1 },
  atk0b: { legs: 'run2', arm: 'swing', capeFlow: 3, lean: 2 },
  atk1a: { legs: 'stand', arm: 'swing', capeFlow: 1 },
  atk1b: { legs: 'run0', arm: 'swing2', capeFlow: 3, lean: 2 },
  atk2a: { legs: 'stand', arm: 'wind', capeFlow: 2, crouch: 1 },
  atk2b: { legs: 'run2', arm: 'heavy', capeFlow: 4, lean: 3 },
  atkUp: { legs: 'air', arm: 'up', capeFlow: 1 },
  atkDown: { legs: 'air', arm: 'down', capeFlow: -1 },
  parry: { legs: 'stand', arm: 'guard', capeFlow: 0, crouch: 1 },
  parryOk: { legs: 'stand', arm: 'guardOk', capeFlow: 2, lean: 1 },
  hurt: { legs: 'air', arm: 'hurt', capeFlow: 3, lean: -2 },
  dead: { legs: 'stand', arm: 'none', kneel: true, capeFlow: 1, crouch: 4 },
};

/* ================================================================== */
/* Enemies                                                             */
/* ================================================================== */
function drawHusk(g, pose) {
  const { legs = 0, lunge = 0, wind = 0, dead = false, hurt = false } = pose;
  const fy = 19, cx = 10 + lunge * 2;
  const body = '#7a8a66', bodyDark = '#4f5c43', belly = '#b9c39a', eye = '#ff8a2a', claw = '#d8d2b8';
  if (dead) {
    R(g, cx - 8, fy - 4, 16, 4, bodyDark); R(g, cx - 6, fy - 6, 12, 3, body); R(g, cx + 2, fy - 5, 2, 1, '#3a3a3a');
    return;
  }
  // legs
  const l = legs === 1 ? 2 : 0;
  R(g, cx - 5 + l, fy - 4, 3, 4, bodyDark); R(g, cx + 2 - l, fy - 4, 3, 4, bodyDark);
  // hunched body
  R(g, cx - 7, fy - 12 + wind, 14, 9 - wind, body);
  R(g, cx - 5, fy - 8 + wind, 8, 4, belly);
  R(g, cx - 7, fy - 12 + wind, 14, 2, bodyDark);
  // head
  R(g, cx + 2, fy - 15 + wind + (hurt ? 1 : 0), 7, 5, body);
  R(g, cx + 4, fy - 14 + wind, 2, 2, eye); R(g, cx + 7, fy - 14 + wind, 2, 2, eye);
  // arms / claws
  const ax = cx + 6 + lunge * 3;
  line(g, cx + 5, fy - 9 + wind, ax, fy - 6 + wind, bodyDark);
  R(g, ax, fy - 7 + wind, 3, 1, claw); R(g, ax + 1, fy - 6 + wind, 2, 1, claw);
  line(g, cx - 4, fy - 9, cx - 7, fy - 5, bodyDark);
}

function drawZealot(g, pose) {
  const { legs = 0, spear = 'rest', crouch = 0, dead = false, stagger = false, hurt = false, flash = false } = pose;
  const fy = 27, cx = 12;
  const robe = '#a3212f', robeDark = '#6a1220', hood = '#3a0f19', mask = '#e0b34a', maskDark = '#8f6a1e', wood = '#8a5a33', tip = '#e6eef8';
  if (dead) {
    R(g, cx - 10, fy - 5, 20, 5, robeDark); R(g, cx - 8, fy - 7, 14, 3, robe); R(g, cx + 5, fy - 6, 5, 3, mask);
    line(g, cx - 9, fy - 2, cx + 9, fy - 2, wood);
    return;
  }
  const ty = 8 + crouch;
  // robe (trapezoid), hem sways with legs
  for (let y = 0; y < 15; y++) {
    const w = 8 + Math.floor(y / 2.2), sway = legs === 1 && y > 10 ? 1 : 0;
    R(g, cx - w / 2 + sway, ty + 4 + y, w, 1, y % 4 === 3 ? robeDark : robe);
  }
  R(g, cx - 6, fy - 1, 5, 1, robeDark); R(g, cx + 1, fy - 1, 5, 1, robeDark);
  // sash
  R(g, cx - 5, ty + 9, 10, 2, mask); R(g, cx - 5, ty + 10, 10, 1, maskDark);
  // hood (pointed)
  R(g, cx - 4, ty, 9, 5, hood); R(g, cx - 3, ty - 3, 7, 3, hood); R(g, cx - 2, ty - 6, 5, 3, hood); R(g, cx - 1, ty - 8, 3, 2, hood);
  // gold mask
  R(g, cx, ty + 1, 5, 4, mask); R(g, cx + 1, ty + 2, 1, 1, maskDark); R(g, cx + 3, ty + 2, 1, 1, maskDark);
  if (stagger) { R(g, cx - 1, ty + 5, 8, 1, '#ffffff'); }
  // spear
  const sy = ty + 8;
  switch (spear) {
    case 'rest': line(g, cx + 4, sy + 10, cx + 4, sy - 12, wood); R(g, cx + 3, sy - 14, 3, 3, tip); break;
    case 'walk': line(g, cx + 5, sy + 9, cx + 5, sy - 11, wood); R(g, cx + 4, sy - 13, 3, 3, tip); break;
    case 'charge': line(g, cx - 8, sy + 3, cx + 2, sy + 1, wood); R(g, cx + 2, sy, 3, 2, flash ? '#ffffff' : tip); break;
    case 'thrust': line(g, cx - 2, sy + 1, cx + 22, sy + 1, wood); R(g, cx + 20, sy, 5, 3, tip); R(g, cx + 12, sy, 8, 1, '#ffffff'); break;
    case 'recover': line(g, cx - 1, sy + 4, cx + 12, sy + 2, wood); R(g, cx + 11, sy + 1, 3, 3, tip); break;
    case 'stagger': line(g, cx - 9, fy - 2, cx + 7, fy - 4, wood); R(g, cx + 7, fy - 5, 3, 2, tip); break;
    case 'hurt': line(g, cx - 6, sy + 6, cx + 6, sy - 6, wood); R(g, cx + 6, sy - 8, 3, 3, tip); break;
    default: break;
  }
  if (hurt) R(g, cx - 3, ty + 1, 3, 3, '#ffffff');
}

export const HUSK_POSES = {
  walk0: { legs: 0 }, walk1: { legs: 1 }, wind: { wind: 2 }, lunge: { lunge: 2 }, hurt: { hurt: true }, dead: { dead: true },
};
export const ZEALOT_POSES = {
  walk0: { legs: 0, spear: 'walk' }, walk1: { legs: 1, spear: 'walk' }, idle: { spear: 'rest' },
  charge0: { spear: 'charge', crouch: 2 }, charge1: { spear: 'charge', crouch: 2, flash: true },
  thrust: { spear: 'thrust', crouch: 1 }, recover: { spear: 'recover' },
  stagger: { spear: 'stagger', crouch: 3, stagger: true }, hurt: { spear: 'hurt' }, dead: { dead: true },
};

/* ================================================================== */
/* Tiles & decor                                                       */
/* ================================================================== */
function drawSolidTile(g, p, rng, zone, variant, topEdge) {
  R(g, 0, 0, TILE, TILE, p.stone);
  // brick courses
  for (let y = 0; y < TILE; y += 4) {
    const off = ((y / 4) | 0) % 2 === 0 ? 0 : 4;
    R(g, 0, y + 3, TILE, 1, p.stoneLine);
    for (let x = off; x < TILE; x += 8) R(g, x, y, 1, 3, p.stoneLine);
    if (zone === 'keep' || rng() < 0.4) R(g, off + 2, y + 1, 3, 1, p.stoneLight);
  }
  // wear & tear
  for (let i = 0; i < 3 + variant; i++) R(g, (rng() * TILE) | 0, (rng() * TILE) | 0, 1 + ((rng() * 2) | 0), 1, p.stoneDark);
  if (topEdge) {
    // grass / moss / ash cap
    R(g, 0, 0, TILE, 3, p.top);
    R(g, 0, 0, TILE, 1, p.topLight);
    for (let x = 0; x < TILE; x += 2) if (rng() < 0.5) R(g, x, 3, 1, 1 + ((rng() * 2) | 0), p.topDark);
    for (let x = 0; x < TILE; x += 3) if (rng() < 0.6) R(g, x, -1 + ((rng() * 2) | 0), 1, 2, p.topLight);
    if (zone === 'chapel' && rng() < 0.6) R(g, (rng() * 14) | 0, 1, 2, 1, '#fff0fa');
    if (zone === 'market' && rng() < 0.5) R(g, (rng() * 14) | 0, 0, 1, 1, '#ffe08a');
  }
}

function drawPlatformTile(g, p, zone) {
  R(g, 0, 0, TILE, 5, p.plat);
  R(g, 0, 0, TILE, 1, p.platLight);
  R(g, 0, 4, TILE, 1, p.platDark);
  if (zone === 'market') { R(g, 3, 1, 1, 3, p.platDark); R(g, 11, 1, 1, 3, p.platDark); }
  else { R(g, 7, 1, 2, 3, p.platDark); R(g, 0, 5, 3, 2, p.platDark); R(g, 13, 5, 3, 2, p.platDark); }
}

function drawSpikeTile(g, p) {
  for (let i = 0; i < 4; i++) {
    const x = i * 4;
    line(g, x, TILE - 1, x + 2, 5, p.spike); line(g, x + 3, TILE - 1, x + 2, 5, p.spikeDark);
    R(g, x + 2, 4, 1, 1, '#ffffff');
  }
  R(g, 0, TILE - 2, TILE, 2, p.stoneDark);
}

function drawLiquidTile(g, p, frame, top) {
  R(g, 0, 0, TILE, TILE, p.liquid[0]);
  for (let y = 0; y < TILE; y += 3) {
    const off = (frame * 2 + y * 2) % TILE;
    R(g, off, y, 5, 1, p.liquid[1]);
    R(g, (off + 9) % TILE, y + 1, 3, 1, p.liquid[1]);
  }
  if (top) {
    R(g, 0, 0, TILE, 2, p.liquid[2]);
    R(g, (frame * 3) % TILE, 0, 4, 1, '#ffffff');
  }
}

function drawDecor(g, type, p, zone, frame) {
  switch (type) {
    case 'stall': {
      // 32×32: striped awning + counter + goods (market colour)
      const stripes = zone === 'market' ? [p.accent, '#ffffff'] : [p.accent2, '#ffffff'];
      for (let x = 0; x < 32; x += 4) R(g, x, 6, 4, 5, stripes[(x / 4) % 2]);
      R(g, 0, 11, 32, 1, '#8c6f48'); R(g, 2, 4, 28, 2, '#8c6f48');
      R(g, 2, 11, 2, 15, '#8a5a33'); R(g, 28, 11, 2, 15, '#8a5a33');
      R(g, 3, 20, 26, 12, '#a06a3c'); R(g, 3, 20, 26, 1, '#c98a52');
      R(g, 6, 15, 5, 5, '#f2c94c'); R(g, 13, 16, 4, 4, '#e0453a'); R(g, 19, 14, 6, 6, '#63b04e'); R(g, 7, 22, 3, 3, '#ff8a2a'); R(g, 20, 23, 5, 3, '#3e7fd6');
      break;
    }
    case 'lantern': {
      // 16×48 iron lamp post: base on the ground, lantern head at the top, warm glow
      R(g, 7, 12, 2, 36, '#3a2a1a'); R(g, 8, 12, 1, 36, '#5a4a3a');
      R(g, 4, 45, 8, 3, '#3a2a1a'); R(g, 5, 43, 6, 2, '#5a4a3a');
      R(g, 7, 0, 2, 4, '#5a4a3a'); R(g, 3, 3, 10, 1, '#3a2a1a');
      R(g, 4, 4, 8, 10, '#3a2a1a'); R(g, 5, 5, 6, 8, frame % 2 ? '#ffd166' : '#ffb347'); R(g, 6, 7, 4, 4, '#fff3c4');
      R(g, 5, 14, 6, 2, '#3a2a1a');
      break;
    }
    case 'banner': {
      // 16×32 vertical banner with zone emblem
      R(g, 7, 0, 2, 32, '#5a4a3a'); R(g, 2, 2, 12, 22, p.accent); R(g, 2, 2, 12, 1, p.accent3);
      R(g, 5, 8, 6, 6, p.accent3); R(g, 7, 10, 2, 2, p.accent);
      line(g, 2, 24, 8, 28, p.accent); line(g, 14, 24, 8, 28, p.accent);
      break;
    }
    case 'crates': {
      R(g, 2, 16, 14, 14, '#a06a3c'); R(g, 2, 16, 14, 1, '#c98a52'); line(g, 2, 16, 15, 29, '#7a4a22'); line(g, 15, 16, 2, 29, '#7a4a22');
      R(g, 18, 20, 12, 10, '#8a5a33'); R(g, 18, 20, 12, 1, '#b8804b'); R(g, 22, 12, 6, 8, '#8fd46b'); R(g, 24, 10, 2, 2, '#ff5f7e');
      break;
    }
    case 'arch': {
      // 48×64 gothic arch (background prop)
      const s = zone === 'keep' ? p.stoneDark : p.stoneLight, d = p.stoneLine;
      R(g, 4, 20, 8, 44, s); R(g, 36, 20, 8, 44, s);
      for (let i = 0; i < 20; i++) { const w = Math.round(Math.sqrt(400 - (20 - i) * (20 - i))); R(g, 24 - w, i + 2, w * 2, 1, s); }
      R(g, 8, 20, 32, 2, d); R(g, 4, 62, 8, 2, d); R(g, 36, 62, 8, 2, d);
      R(g, 20, 8, 8, 12, zone === 'keep' ? '#ff5a3c' : '#ffe9a8'); R(g, 22, 10, 4, 8, zone === 'keep' ? '#ffd166' : '#ffffff');
      break;
    }
    case 'statue': {
      // 16×32 robed figure
      R(g, 3, 24, 10, 8, p.stoneDark); R(g, 5, 8, 6, 16, p.stoneLight); R(g, 6, 3, 4, 6, p.stoneLight); R(g, 4, 10, 2, 10, p.stone); R(g, 10, 10, 2, 10, p.stone);
      R(g, 6, 6, 4, 1, p.stoneLine);
      break;
    }
    case 'skull': {
      // 16×16 skull pile (keep)
      R(g, 2, 8, 12, 8, '#d9d2b8'); R(g, 4, 4, 8, 6, '#efe9d2'); R(g, 5, 6, 2, 2, '#3a1010'); R(g, 9, 6, 2, 2, '#3a1010'); R(g, 6, 9, 4, 1, '#8f8768');
      R(g, 0, 12, 4, 4, '#bfb69a'); R(g, 12, 13, 4, 3, '#bfb69a');
      break;
    }
    case 'shrine': {
      // 24×32 checkpoint shrine; frame 0 = dormant, 1 = lit
      R(g, 4, 26, 16, 6, p.stoneDark); R(g, 6, 8, 12, 18, p.stoneLight); R(g, 8, 4, 8, 4, p.stoneLight); R(g, 10, 1, 4, 3, p.stoneLight);
      R(g, 9, 12, 6, 8, frame ? '#ffe08a' : '#3a3040'); R(g, 11, 14, 2, 4, frame ? '#ffffff' : '#241e2c');
      if (frame) { R(g, 7, 10, 1, 1, '#fff3c4'); R(g, 16, 12, 1, 1, '#fff3c4'); }
      break;
    }
    case 'gate': {
      // 32×48 ornate exit gate
      R(g, 0, 8, 32, 40, p.stoneDark); R(g, 2, 10, 28, 38, p.stone);
      for (let i = 0; i < 14; i++) { const w = Math.round(Math.sqrt(196 - (14 - i) * (14 - i))); R(g, 16 - w, i + 14, w * 2, 1, '#1a0a12'); }
      R(g, 2, 28, 28, 20, '#1a0a12'); R(g, 6, 30, 20, 18, frame % 2 ? '#ffb347' : '#ff8a2a'); R(g, 10, 34, 12, 14, '#ffe08a');
      R(g, 14, 0, 4, 8, p.accent3); R(g, 10, 4, 12, 4, p.accent3);
      break;
    }
    case 'shard': {
      // 12×12 floating crystal
      const c = frame % 2 ? '#9fe8ff' : '#4fd3ff';
      line(g, 6, 0, 1, 6, c); line(g, 6, 0, 10, 6, c); line(g, 1, 6, 6, 11, c); line(g, 10, 6, 6, 11, c);
      R(g, 4, 4, 4, 4, '#ffffff'); R(g, 5, 2, 2, 2, c);
      break;
    }
    default: break;
  }
}

/* ================================================================== */
/* Sprite bank                                                         */
/* ================================================================== */
export class SpriteBank {
  constructor() {
    this.player = {};     // charId → pose → canvas
    this.husk = {};
    this.zealot = {};
    this.tiles = {};      // zone → { solid[], solidTop[], platform, spike, liquid[3], liquidTop[3] }
    this.decor = {};      // zone → type → frames[]
  }

  build() {
    for (const ch of CHARACTERS) {
      this.player[ch.id] = {};
      for (const [name, pose] of Object.entries(PLAYER_POSES)) {
        const { c, g } = makeCanvas(32, 32);
        drawPilgrim(g, ch, pose);
        this.player[ch.id][name] = c;
      }
      // Flash variant (white silhouette) for hit feedback.
      this.player[ch.id].__flash = Object.fromEntries(Object.entries(this.player[ch.id]).map(([k, c]) => [k, silhouette(c)]));
    }
    for (const [name, pose] of Object.entries(HUSK_POSES)) {
      const { c, g } = makeCanvas(24, 20); drawHusk(g, pose); this.husk[name] = c;
    }
    for (const [name, pose] of Object.entries(ZEALOT_POSES)) {
      const { c, g } = makeCanvas(40, 28); drawZealot(g, pose); this.zealot[name] = c;
    }
    this.huskFlash = Object.fromEntries(Object.entries(this.husk).map(([k, c]) => [k, silhouette(c)]));
    this.zealotFlash = Object.fromEntries(Object.entries(this.zealot).map(([k, c]) => [k, silhouette(c)]));

    for (const zone of Object.keys(ZONE_PAL)) {
      const p = ZONE_PAL[zone];
      const rng = mulberry32(0x5EED ^ zone.length * 7919);
      const t = { solid: [], solidTop: [], liquid: [], liquidTop: [] };
      for (let v = 0; v < 4; v++) {
        let mk = makeCanvas(TILE, TILE); drawSolidTile(mk.g, p, rng, zone, v, false); t.solid.push(mk.c);
        mk = makeCanvas(TILE, TILE); drawSolidTile(mk.g, p, rng, zone, v, true); t.solidTop.push(mk.c);
      }
      let mk = makeCanvas(TILE, TILE); drawPlatformTile(mk.g, p, zone); t.platform = mk.c;
      mk = makeCanvas(TILE, TILE); drawSpikeTile(mk.g, p); t.spike = mk.c;
      for (let f = 0; f < 3; f++) {
        mk = makeCanvas(TILE, TILE); drawLiquidTile(mk.g, p, f, false); t.liquid.push(mk.c);
        mk = makeCanvas(TILE, TILE); drawLiquidTile(mk.g, p, f, true); t.liquidTop.push(mk.c);
      }
      this.tiles[zone] = t;

      const sizes = { stall: [32, 32], lantern: [16, 48], banner: [16, 32], crates: [32, 32], arch: [48, 64], statue: [16, 32], skull: [16, 16], shrine: [24, 32], gate: [32, 48], shard: [12, 12] };
      this.decor[zone] = {};
      for (const [type, [w, h]] of Object.entries(sizes)) {
        const frames = [];
        for (let f = 0; f < 2; f++) { const m = makeCanvas(w, h); drawDecor(m.g, type, p, zone, f); frames.push(m.c); }
        this.decor[zone][type] = frames;
      }
    }
    return this;
  }
}

/** White silhouette of a sprite (for hit flashes). */
function silhouette(src) {
  const { c, g } = makeCanvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  return c;
}
