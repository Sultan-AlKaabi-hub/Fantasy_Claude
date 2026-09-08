/**
 * particles.js — lightweight pooled particles, floating text and dash afterimages.
 *
 * Particles are simulated in fixed steps like everything else, but they keep
 * ticking (at quarter speed) during hitstop so the world never looks frozen
 * for the wrong reason. Rendering is a plain rect per particle — cheap enough
 * for hundreds on a phone.
 */
import { mulberry32 } from '../core/util.js';

const MAX = 400;
const rng = mulberry32(0xC0FFEE);

const BURSTS = {
  dust:  { n: 6,  col: ['#d8c9a8', '#b9a98b', '#f3e7c8'], spd: 1.2, up: 0.8, g: 0.04, life: [14, 26], size: [1, 2] },
  step:  { n: 2,  col: ['#c9b892', '#a89877'], spd: 0.4, up: 0.5, g: 0.03, life: [10, 16], size: [1, 1] },
  blood: { n: 10, col: ['#d9203c', '#8e0f26', '#ff4d6d'], spd: 2.4, up: 1.6, g: 0.16, life: [18, 34], size: [1, 2] },
  gore:  { n: 22, col: ['#d9203c', '#5e0a18', '#ff4d6d', '#f1d3c2'], spd: 3.4, up: 2.6, g: 0.18, life: [24, 48], size: [1, 3] },
  spark: { n: 14, col: ['#ffe08a', '#ffffff', '#ffb347', '#9fe8ff'], spd: 3.2, up: 1.4, g: 0.02, life: [10, 20], size: [1, 2] },
  ember: { n: 1,  col: ['#ff8a2a', '#ffc34d', '#ff4d1a'], spd: 0.3, up: 0.6, g: -0.01, life: [60, 120], size: [1, 1] },
  petal: { n: 1,  col: ['#ff9ad5', '#ffd1ec', '#c68cff'], spd: 0.4, up: -0.2, g: 0.008, life: [90, 160], size: [1, 2] },
  mote:  { n: 1,  col: ['#fff3c4', '#ffe9a8'], spd: 0.2, up: 0.1, g: -0.002, life: [90, 180], size: [1, 1] },
  shard: { n: 12, col: ['#9fe8ff', '#ffffff', '#4fd3ff'], spd: 2.2, up: 2.0, g: 0.05, life: [20, 40], size: [1, 2] },
};

export class Particles {
  constructor() {
    this.items = [];
    this.texts = [];
    this.ghosts = [];
  }

  burst(type, x, y, dir = 0) {
    const d = BURSTS[type] || BURSTS.dust;
    for (let i = 0; i < d.n; i++) {
      if (this.items.length >= MAX) this.items.shift();
      const ang = rng() * Math.PI * 2;
      const sp = d.spd * (0.4 + rng() * 0.8);
      this.items.push({
        x, y,
        vx: Math.cos(ang) * sp + dir * sp * 0.6,
        vy: Math.sin(ang) * sp - d.up * rng(),
        g: d.g,
        life: d.life[0] + ((rng() * (d.life[1] - d.life[0])) | 0),
        max: 0,
        size: d.size[0] + ((rng() * (d.size[1] - d.size[0] + 1)) | 0),
        col: d.col[(rng() * d.col.length) | 0],
        type,
      });
      const p = this.items[this.items.length - 1];
      p.max = p.life;
    }
  }

  text(str, x, y, col = '#ffffff') {
    this.texts.push({ str, x, y, col, life: 40, max: 40 });
  }

  /** Snapshot an entity's pose for a fading dash trail. */
  ghost(entity, sprite) {
    this.ghosts.push({ x: entity.x, y: entity.y, facing: entity.facing, sprite, life: 12, max: 12 });
    if (this.ghosts.length > 10) this.ghosts.shift();
  }

  update(hitstop) {
    const step = hitstop ? 0.25 : 1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= step;
      if (p.life <= 0) { this.items.splice(i, 1); continue; }
      p.vy += p.g * step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      if (p.type === 'dust' || p.type === 'step') { p.vx *= 0.9; }
      if (p.type === 'ember' || p.type === 'petal' || p.type === 'mote') { p.vx += (rng() - 0.5) * 0.08; }
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= step; t.y -= 0.35 * step;
      if (t.life <= 0) this.texts.splice(i, 1);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      if (--this.ghosts[i].life <= 0) this.ghosts.splice(i, 1);
    }
  }

  clear() { this.items.length = 0; this.texts.length = 0; this.ghosts.length = 0; }
}
