/**
 * title.js — animated pixel-art backdrop for the title screen.
 *
 * A castle on a forested ridge at dusk, a low sun on the horizon, drifting
 * clouds, light rays, and leaves blowing across the foreground. Everything is
 * drawn once into a 320×180 backbuffer and upscaled with nearest-neighbour
 * so it stays crisp on any screen and cheap on any phone.
 *
 * Respects prefers-reduced-motion: the scene still renders, the leaves and
 * clouds simply hold still.
 */
import { makeCanvas } from './sprites.js';
import { mulberry32 } from '../core/util.js';

const R = (g, x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

function tower(g, x, base, w, h, col, roofCol) {
  R(g, x, base - h, w, h, col);
  for (let i = 0; i < w; i += 3) R(g, x + i, base - h - 2, 2, 2, col);          // battlements
  if (roofCol) for (let i = 0; i < w / 2 + 1; i++) R(g, x + i, base - h - 3 - i, w - i * 2, 1, roofCol);
}

/** Static layers: sky is drawn live (it animates), everything else is baked. */
function bakeScene(W, H) {
  const rng = mulberry32(0xCA571E);
  const far = makeCanvas(W, H), near = makeCanvas(W, H);

  // ---- far: mountains, ridge, castle ----
  for (let x = 0; x < W; x++) {
    const m = 38 + Math.sin(x / 41) * 9 + Math.sin(x / 13) * 3 + Math.cos(x / 67) * 6;
    R(far.g, x, H - 70 - m, 1, 70 + m, '#4a3f7a');
  }
  for (let x = 0; x < W; x++) {
    const r = 18 + Math.sin(x / 29 + 1) * 6 + Math.sin(x / 9) * 2;
    R(far.g, x, H - 62 - r, 1, 62 + r, '#33306a');
  }
  // castle on the ridge
  const cx = Math.round(W * 0.2), base = H - 88;
  R(far.g, cx - 34, base - 10, 68, 10, '#2a2452');                                // curtain wall
  for (let i = 0; i < 68; i += 4) R(far.g, cx - 34 + i, base - 12, 2, 2, '#2a2452');
  tower(far.g, cx - 40, base, 10, 26, '#2a2452', '#4a3f7a');
  tower(far.g, cx + 30, base, 10, 26, '#2a2452', '#4a3f7a');
  tower(far.g, cx - 14, base, 12, 40, '#231e48', '#4a3f7a');
  tower(far.g, cx + 4, base, 12, 40, '#231e48', '#4a3f7a');
  tower(far.g, cx - 5, base, 10, 66, '#1e1a40', '#5a4f9a');                        // keep spire
  R(far.g, cx - 1, base - 74, 2, 8, '#ffe08a'); R(far.g, cx - 3, base - 76, 6, 2, '#ffe08a');   // beacon
  for (let wy = base - 60; wy < base - 8; wy += 8) for (const wx of [cx - 11, cx + 7, cx - 3]) if (rng() < 0.7) R(far.g, wx, wy, 2, 3, '#ffb347');
  // forest on the ridge (triangle pines)
  for (let i = 0; i < 90; i++) {
    const x = (rng() * W) | 0, h = 8 + ((rng() * 12) | 0), y = H - 56 - Math.sin(x / 29 + 1) * 6;
    const col = rng() < 0.5 ? '#1e3a3a' : '#25473f';
    for (let k = 0; k < h; k++) R(far.g, x - (k >> 1), y - h + k, k | 1, 1, col);
  }

  // ---- near: foreground trees framing the view, ground, grass ----
  for (let x = 0; x < W; x++) R(near.g, x, H - 34 + Math.round(Math.sin(x / 17) * 2), 1, 40, '#0f2a22');
  for (let x = 0; x < W; x += 2) if (rng() < 0.6) R(near.g, x, H - 36 + ((rng() * 3) | 0), 1, 3, '#1f5a3a');
  const bigTree = (x, dir) => {
    R(near.g, x, 20, 8, H - 20, '#08120f');
    for (let b = 0; b < 7; b++) {
      const by = 26 + b * 18, len = 40 + b * 8;
      for (let k = 0; k < len; k++) {
        const px = x + 4 + dir * k, py = by + (k * k) / (len * 3) - k / 5;
        R(near.g, px, py, 2, 2, '#08120f');
        if (k % 5 === 0) for (let l = 0; l < 6; l++) R(near.g, px + (rng() * 10 - 5) | 0, py + (rng() * 8 - 6) | 0, 3, 2, l % 2 ? '#123a2a' : '#1a4d36');
      }
    }
  };
  bigTree(-4, 1); bigTree(W - 4, -1);
  // pond glint at the bottom
  for (let x = W * 0.28; x < W * 0.72; x += 3) if (rng() < 0.5) R(near.g, x, H - 12 + ((rng() * 6) | 0), 2, 1, '#7fb0c8');

  return { far: far.c, near: near.c };
}

export class TitleScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.out = canvas.getContext('2d', { alpha: false });
    this.W = 0; this.H = 0;
    this.t = 0;
    this.raf = 0;
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._tick = this._tick.bind(this);
    this.setDims(320, 180);
  }

  /** (Re)build the scene for a given aspect: 320×180 landscape, 200×320 portrait. */
  setDims(W, H) {
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    const buf = makeCanvas(W, H);
    this.buf = buf.c; this.g = buf.g;
    this.layers = bakeScene(W, H);
    this.sunX = Math.round(W * 0.78);
    const rng = mulberry32(0x1EAF);
    this.leaves = Array.from({ length: 28 }, () => ({
      x: rng() * W, y: rng() * H, vx: 0.6 + rng() * 0.9, vy: 0.1 + rng() * 0.25,
      ph: rng() * Math.PI * 2, col: ['#e0453a', '#ff8a2a', '#f2c94c', '#c93a52'][(rng() * 4) | 0], s: 1 + ((rng() * 2) | 0),
    }));
    this.rays = Array.from({ length: 5 }, (_, i) => ({ x: Math.round(W * 0.45) + i * Math.round(W * 0.13), w: 8 + i * 3 }));
  }

  start() { if (!this.raf) this.raf = requestAnimationFrame(this._tick); }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  fit() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.out.imageSmoothingEnabled = false;
    if (r.height > r.width) this.setDims(200, 320); else this.setDims(320, 180);
  }

  _tick() {
    this.raf = requestAnimationFrame(this._tick);
    if (!this.reduce) this.t++;
    this.draw();
  }

  draw() {
    const g = this.g, t = this.t, W = this.W, H = this.H, SUN_X = this.sunX;
    // sky
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1b1440'); sky.addColorStop(0.45, '#6a3f8f'); sky.addColorStop(0.72, '#f08a5d'); sky.addColorStop(1, '#ffd166');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // stars
    for (let i = 0; i < 40; i++) { const x = (i * 53) % W, y = (i * 29) % 70; if ((i + (t >> 4)) % 7) R(g, x, y, 1, 1, i % 3 ? '#ffffffaa' : '#ffe08a'); }
    // sun on the horizon
    g.fillStyle = '#fff3c4'; g.beginPath(); g.arc(SUN_X, H - 92, 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,220,140,0.25)'; g.beginPath(); g.arc(SUN_X, H - 92, 22, 0, Math.PI * 2); g.fill();
    // clouds
    for (let i = 0; i < 6; i++) {
      const w = 30 + (i * 17) % 30, x = ((i * 71 + t * (0.15 + i * 0.03)) % (W + w)) - w, y = 22 + (i * 23) % 60;
      const col = i % 2 ? '#c88ab3' : '#e6a0b8';
      R(g, x, y + 2, w, 3, col); R(g, x + 4, y, w - 8, 2, col); R(g, x + w * 0.3, y - 2, w * 0.3, 2, col);
    }
    g.drawImage(this.layers.far, 0, 0);
    // light rays from the sun through the far layer
    g.save(); g.globalAlpha = 0.10 + Math.sin(t / 60) * 0.03;
    for (const r of this.rays) {
      g.fillStyle = '#ffe9a8';
      g.beginPath(); g.moveTo(SUN_X, H - 92); g.lineTo(r.x - r.w, H); g.lineTo(r.x + r.w, H); g.closePath(); g.fill();
    }
    g.restore();
    g.drawImage(this.layers.near, 0, 0);
    // mist band
    g.fillStyle = 'rgba(255,200,180,0.12)'; g.fillRect(0, H - 60, W, 26);
    // leaves
    for (const l of this.leaves) {
      if (!this.reduce) {
        l.x += l.vx + Math.sin(t / 20 + l.ph) * 0.4;
        l.y += l.vy + Math.cos(t / 15 + l.ph) * 0.5;
        if (l.x > W + 4) { l.x = -4; l.y = Math.random() * H; }
        if (l.y > H + 4) { l.y = -4; }
        if (l.y < -6) { l.y = H + 2; }
      }
      const flip = Math.sin(t / 8 + l.ph) > 0;
      R(g, l.x | 0, l.y | 0, flip ? l.s : l.s + 1, flip ? l.s + 1 : l.s, l.col);
    }
    // vignette
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.9);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(8,4,20,0.55)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);

    // Cover the display canvas (the scene is baked for the current orientation,
    // so only a thin sliver is ever cropped).
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.max(cw / W, ch / H);
    const dw = W * scale, dh = H * scale;
    this.out.drawImage(this.buf, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }
}
