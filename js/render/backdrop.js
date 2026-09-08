/**
 * backdrop.js — parallax skies for the three zones.
 *
 * Each zone has a gradient sky plus three tiling layers (far / mid / near)
 * drawn once into 480×240 canvases. Layers scroll at different fractions of
 * the camera position, which sells depth on a 2D plane. Zones crossfade at
 * their borders so walking from the Market into the Chapel feels like the
 * light changing rather than a scene cut.
 *
 * Reference mood: sunlit market square → violet-and-rose chapel at dusk →
 * crimson keep under a blood moon.
 */
import { makeCanvas, ZONE_PAL } from './sprites.js';
import { mulberry32 } from '../core/util.js';

const LW = 480, LH = 240;
const R = (g, x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

function tower(g, x, base, w, h, col, roof) {
  R(g, x, base - h, w, h, col);
  for (let i = 0; i < w / 2; i++) R(g, x + i, base - h - i, w - i * 2, 1, roof || col);
  for (let i = 0; i < w; i += 3) R(g, x + i, base - h - 1, 1, 2, col);   // crenellation
}

function windows(g, x, y, w, h, rng, lit, dark) {
  for (let wy = y + 3; wy < y + h - 4; wy += 6)
    for (let wx = x + 2; wx < x + w - 3; wx += 5)
      if (rng() < 0.7) R(g, wx, wy, 2, 3, rng() < 0.6 ? lit : dark);
}

function cloud(g, x, y, w, col) {
  R(g, x, y + 2, w, 3, col); R(g, x + 3, y, w - 6, 2, col); R(g, x + w * 0.3, y - 2, w * 0.3, 2, col);
}

const BUILDERS = {
  market(p, rng) {
    const far = makeCanvas(LW, LH), mid = makeCanvas(LW, LH), near = makeCanvas(LW, LH);
    // far: pale hill line with distant towers
    for (let x = 0; x < LW; x++) { const h = 60 + Math.sin(x / 70) * 10 + Math.sin(x / 23) * 4; R(far.g, x, LH - h, 1, h, p.far); }
    for (let i = 0; i < 7; i++) { const x = (i * 71 + 20) % LW; tower(far.g, x, LH - 60, 10 + (i % 3) * 4, 40 + (i % 4) * 12, '#8ea8cf', '#7f95bd'); }
    // mid: colourful town houses
    const walls = ['#e8d5b5', '#d7b58f', '#c8a2c8', '#a9c8d7', '#e6b8a2', '#cfd9a8'];
    const roofs = ['#c0392b', '#2a9d8f', '#8e5ea2', '#e07a3f', '#4d7ea8'];
    let x = 0;
    while (x < LW) {
      const w = 24 + ((rng() * 30) | 0), h = 70 + ((rng() * 60) | 0);
      const wall = walls[(rng() * walls.length) | 0], roof = roofs[(rng() * roofs.length) | 0];
      R(mid.g, x, LH - h, w, h, wall);
      R(mid.g, x, LH - h, 1, h, '#00000022');
      for (let i = 0; i < 6; i++) R(mid.g, x - 2 + i, LH - h - 6 + i, w + 4 - i * 2, 1, roof);
      windows(mid.g, x, LH - h, w, h, rng, '#ffe08a', '#3e5a8a');
      if (rng() < 0.5) { const aw = rng() < 0.5 ? p.accent : p.accent2; for (let s = 0; s < w - 4; s += 4) R(mid.g, x + 2 + s, LH - 30, 4, 4, (s / 4) % 2 ? aw : '#fff'); }
      x += w + 2 + ((rng() * 8) | 0);
    }
    R(mid.g, 0, LH - 4, LW, 4, '#b9a98b');
    // near: bunting line + lamp posts
    for (let bx = 0; bx < LW; bx += 8) { const c = ['#e0453a', '#3e7fd6', '#f2c94c', '#63b04e'][(bx / 8) % 4]; const y = 40 + Math.sin(bx / 60) * 6; R(near.g, bx, y, 5, 4, c); R(near.g, bx + 1, y + 4, 3, 2, c); R(near.g, bx, y - 1, 8, 1, '#3a2a1a'); }
    for (let lx = 60; lx < LW; lx += 160) { R(near.g, lx, LH - 60, 2, 60, '#2b2340'); R(near.g, lx - 3, LH - 66, 8, 7, '#2b2340'); R(near.g, lx - 2, LH - 65, 6, 5, '#ffd166'); }
    return { far: far.c, mid: mid.c, near: near.c, factors: [0.12, 0.3, 0.55], sun: { x: 380, y: 34, r: 16, col: '#fff3c4' }, clouds: ['#ffffff', '#eaf4ff'] };
  },

  chapel(p, rng) {
    const far = makeCanvas(LW, LH), mid = makeCanvas(LW, LH), near = makeCanvas(LW, LH);
    // far: colossal cathedral silhouette in soft violet
    tower(far.g, 150, LH, 60, 200, '#8f9be0', '#a5b0ea'); tower(far.g, 120, LH, 24, 140, '#8f9be0'); tower(far.g, 216, LH, 24, 160, '#8f9be0');
    tower(far.g, 176, LH, 8, 230, '#a5b0ea'); R(far.g, 0, LH - 70, LW, 70, '#8f9be0');
    for (let i = 0; i < 5; i++) tower(far.g, 300 + i * 34, LH - 60, 14, 50 + (i % 2) * 30, '#8f9be0', '#a5b0ea');
    for (let wy = LH - 190; wy < LH - 40; wy += 14) for (let wx = 158; wx < 205; wx += 12) R(far.g, wx, wy, 3, 6, '#f6d5ff');
    // mid: arched bridge in deep blue with rose light on the tops
    for (let ax = 0; ax < LW; ax += 96) {
      R(mid.g, ax, LH - 110, 96, 110, p.mid);
      for (let i = 0; i < 40; i++) { const w = Math.round(Math.sqrt(1600 - (40 - i) * (40 - i))); R(mid.g, ax + 48 - w, LH - 100 + i, w * 2, 1, '#00000000'); }
      const g = mid.g; g.save(); g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 40; i++) { const w = Math.round(Math.sqrt(1600 - (40 - i) * (40 - i))); g.fillStyle = '#000'; g.fillRect(ax + 48 - w, LH - 96 + i, w * 2, 1); }
      g.fillRect(ax + 8, LH - 56, 80, 60); g.restore();
      R(mid.g, ax, LH - 110, 96, 3, p.midLight); R(mid.g, ax + 2, LH - 114, 92, 4, p.midLight);
      for (let c = 0; c < 96; c += 12) R(mid.g, ax + c, LH - 118, 6, 4, p.midLight);
    }
    // hanging ivy from the bridge
    for (let i = 0; i < 60; i++) { const x = (rng() * LW) | 0, h = 6 + ((rng() * 20) | 0); R(mid.g, x, LH - 110, 1, h, '#8fd46b'); if (rng() < 0.4) R(mid.g, x, LH - 110 + h, 1, 1, '#ffc6ea'); }
    // near: crimson foliage & pink blossoms
    for (let i = 0; i < 26; i++) {
      const x = (rng() * LW) | 0, w = 24 + ((rng() * 40) | 0), h = 20 + ((rng() * 30) | 0);
      for (let k = 0; k < 6; k++) { const bx = x + ((rng() * w) | 0), by = LH - ((rng() * h) | 0); R(near.g, bx - 6, by - 4, 12, 8, '#c93a52'); R(near.g, bx - 4, by - 6, 8, 4, '#ff6f85'); if (rng() < 0.5) R(near.g, bx, by - 7, 2, 2, '#ffd1ec'); }
    }
    return { far: far.c, mid: mid.c, near: near.c, factors: [0.1, 0.28, 0.6], sun: { x: 90, y: 40, r: 20, col: '#fff6fb' }, clouds: ['#ffd6ef', '#f7b8dc'] };
  },

  keep(p, rng) {
    const far = makeCanvas(LW, LH), mid = makeCanvas(LW, LH), near = makeCanvas(LW, LH);
    // far: black fortress on a hill
    for (let x = 0; x < LW; x++) { const h = 50 + Math.max(0, 60 - Math.abs(x - 300) / 2); R(far.g, x, LH - h, 1, h, '#1a0610'); }
    tower(far.g, 270, LH - 100, 60, 90, '#1a0610', '#2a0a18'); tower(far.g, 290, LH - 170, 22, 70, '#1a0610', '#2a0a18'); tower(far.g, 250, LH - 90, 14, 60, '#1a0610');
    tower(far.g, 336, LH - 96, 14, 70, '#1a0610');
    for (let wy = LH - 180; wy < LH - 60; wy += 10) for (let wx = 276; wx < 326; wx += 9) if (rng() < 0.5) R(far.g, wx, wy, 2, 4, '#ff5a3c');
    R(far.g, 296, LH - 240, 6, 70, '#ff8a2a');            // beacon fire on the tallest spire
    // mid: the Bone King — crowned skull and arm bones half-buried
    const ivory = '#e9e2cc', shade = '#b8b096', gold = '#e0b34a';
    const kx = 200, ky = LH - 80;
    R(mid.g, kx - 22, ky - 30, 44, 34, ivory); R(mid.g, kx - 18, ky + 4, 36, 8, ivory);
    R(mid.g, kx - 14, ky - 14, 10, 10, '#1a0610'); R(mid.g, kx + 4, ky - 14, 10, 10, '#1a0610');
    R(mid.g, kx - 11, ky - 11, 4, 4, '#ff5a3c'); R(mid.g, kx + 7, ky - 11, 4, 4, '#ff5a3c');
    R(mid.g, kx - 3, ky - 2, 6, 5, '#1a0610');
    for (let t = 0; t < 7; t++) R(mid.g, kx - 15 + t * 5, ky + 6, 3, 6, t % 2 ? shade : ivory);
    R(mid.g, kx - 24, ky - 36, 48, 8, gold); for (let i = 0; i < 5; i++) R(mid.g, kx - 22 + i * 11, ky - 44, 6, 8, gold); R(mid.g, kx - 2, ky - 46, 4, 4, '#ff2e4c');
    // arm bones sprawling left & right
    for (let i = 0; i < 90; i += 6) { R(mid.g, kx - 30 - i, ky + 10 + Math.round(i / 6), 6, 5, ivory); R(mid.g, kx + 24 + i, ky + 12 - Math.round(i / 9), 6, 5, ivory); }
    for (let f = 0; f < 4; f++) { R(mid.g, kx - 124 - f * 3, ky + 26 + f * 4, 12, 3, ivory); R(mid.g, kx + 114 + f * 3, ky + 2 + f * 4, 12, 3, ivory); }
    R(mid.g, 0, LH - 40, LW, 40, '#2a0a18');
    // lava glow strip at the bottom of mid
    for (let x = 0; x < LW; x += 3) if (rng() < 0.7) R(mid.g, x, LH - 6 + ((rng() * 4) | 0), 2, 2, '#ff8a2a');
    // near: dead trees
    for (let i = 0; i < 9; i++) {
      const x = (rng() * LW) | 0, h = 60 + ((rng() * 60) | 0);
      R(near.g, x, LH - h, 4, h, '#0d0308');
      for (let b = 0; b < 5; b++) { const by = LH - h + b * 12, dir = b % 2 ? 1 : -1; for (let k = 0; k < 14; k++) R(near.g, x + 2 + dir * k, by - k / 2, 2, 1, '#0d0308'); }
    }
    return { far: far.c, mid: mid.c, near: near.c, factors: [0.1, 0.3, 0.6], sun: { x: 300, y: 36, r: 24, col: '#ffe08a' }, clouds: ['#ff5a3c', '#b8253a'] };
  },
};

export class Backdrop {
  constructor() { this.zones = {}; }

  build() {
    for (const id of Object.keys(BUILDERS)) {
      this.zones[id] = BUILDERS[id](ZONE_PAL[id], mulberry32(0xBADC0DE ^ id.length));
    }
    return this;
  }

  /**
   * @param {CanvasRenderingContext2D} g
   * @param {string} id zone id
   * @param {number} camX
   * @param {number} camY
   * @param {number} vw
   * @param {number} vh
   * @param {number} alpha 0..1 crossfade
   * @param {number} time frames, for cloud drift
   */
  draw(g, id, camX, camY, vw, vh, alpha, time) {
    const z = this.zones[id], p = ZONE_PAL[id];
    if (!z) return;
    g.save();
    g.globalAlpha = alpha;
    const sky = g.createLinearGradient(0, 0, 0, vh);
    sky.addColorStop(0, p.sky[0]); sky.addColorStop(0.55, p.skyMid); sky.addColorStop(1, p.sky[1]);
    g.fillStyle = sky; g.fillRect(0, 0, vw, vh);

    // celestial body drifts very slowly with the camera
    const sx = ((z.sun.x - camX * 0.04) % (vw + 80) + vw + 80) % (vw + 80) - 40;
    g.fillStyle = z.sun.col;
    g.beginPath(); g.arc(sx, z.sun.y - camY * 0.05, z.sun.r, 0, Math.PI * 2); g.fill();
    if (id === 'keep') { g.fillStyle = '#ffd16688'; g.beginPath(); g.arc(sx, z.sun.y - camY * 0.05, z.sun.r + 6, 0, Math.PI * 2); g.fill(); }

    // clouds (procedural, deterministic per index)
    for (let i = 0; i < 7; i++) {
      const w = 30 + (i * 13) % 40;
      const cx = (((i * 97 + time * (0.08 + i * 0.01) - camX * 0.06) % (vw + w)) + vw + w) % (vw + w) - w;
      cloud(g, cx, 20 + (i * 29) % 70 - camY * 0.05, w, z.clouds[i % 2]);
    }

    const yBase = vh - LH;
    const layers = [z.far, z.mid, z.near];
    for (let i = 0; i < 3; i++) {
      const f = z.factors[i];
      const ox = -((camX * f) % LW);
      const oy = yBase - camY * (f * 0.5) + (i === 2 ? 0 : 0);
      for (let x = ox - LW; x < vw + LW; x += LW) g.drawImage(layers[i], Math.round(x), Math.round(oy));
    }
    g.restore();
  }
}
