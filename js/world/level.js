/**
 * level.js — tile grid, collision resolution and the authoring builder.
 *
 * The world is a Uint8Array of tile ids. Entities are axis-aligned boxes that
 * move one axis at a time (X then Y) and snap to tile edges on contact. Because
 * every velocity in constants.js is below TILE px/frame, a single-tile snap can
 * never tunnel.
 *
 * Pure module: no DOM, no rendering. Rendering lives in js/render.
 */
import { TILE } from '../core/constants.js';

export const T = Object.freeze({
  EMPTY: 0,
  SOLID: 1,
  PLATFORM: 2,   // one-way: solid only from above
  SPIKE: 3,      // damage + respawn at last safe spot
  HAZARD: 4,     // lava / deep water: same as spike but drawn as liquid
});

export const ZONES = Object.freeze([
  { id: 'market', name: 'Vesper Market', from: 0, to: 79 },
  { id: 'chapel', name: 'Sunken Chapel', from: 80, to: 151 },
  { id: 'keep', name: 'Crimson Keep', from: 152, to: 999 },
]);

export class Level {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h);
    this.pixelW = w * TILE;
    this.pixelH = h * TILE;
    this.playerStart = { x: TILE * 3, y: TILE * 10 };
    this.enemies = [];      // { type, x, y, minX, maxX }
    this.checkpoints = [];  // { id, x, y }
    this.pickups = [];      // { id, x, y }
    this.decor = [];        // { type, x, y, zone }
    this.goal = null;       // { x, y, w, h }
  }

  get(tx, ty) {
    if (tx < 0 || tx >= this.w) return T.SOLID;           // side walls are implicit
    if (ty < 0) return T.EMPTY;                           // open sky
    if (ty >= this.h) return T.SOLID;                     // floor of the world
    return this.tiles[ty * this.w + tx];
  }
  set(tx, ty, id) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.tiles[ty * this.w + tx] = id;
  }
  isSolid(tx, ty) { return this.get(tx, ty) === T.SOLID; }

  zoneAtPixel(px) {
    const tx = Math.floor(px / TILE);
    return ZONES.find((z) => tx >= z.from && tx <= z.to) || ZONES[ZONES.length - 1];
  }

  /** Does the box overlap any SOLID tile? */
  overlapsSolid(box) {
    const x0 = Math.floor(box.x / TILE), x1 = Math.floor((box.x + box.w - 0.001) / TILE);
    const y0 = Math.floor(box.y / TILE), y1 = Math.floor((box.y + box.h - 0.001) / TILE);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (this.isSolid(tx, ty)) return true;
    return false;
  }

  /** First hazard tile id the box touches (SPIKE / HAZARD), or 0. */
  hazardIn(box) {
    const x0 = Math.floor(box.x / TILE), x1 = Math.floor((box.x + box.w - 0.001) / TILE);
    const y0 = Math.floor(box.y / TILE), y1 = Math.floor((box.y + box.h - 0.001) / TILE);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const t = this.get(tx, ty);
        if (t === T.SPIKE || t === T.HAZARD) return t;
      }
    return 0;
  }

  /** Is there standable ground directly below the box (solid or platform)? */
  groundBelow(box) {
    const probe = { x: box.x, y: box.y + box.h, w: box.w, h: 1 };
    if (this.overlapsSolid(probe)) return true;
    const ty = Math.floor((box.y + box.h) / TILE);
    if ((box.y + box.h) % TILE !== 0) return false;      // platforms only count at their exact top
    const x0 = Math.floor(box.x / TILE), x1 = Math.floor((box.x + box.w - 0.001) / TILE);
    for (let tx = x0; tx <= x1; tx++) if (this.get(tx, ty) === T.PLATFORM) return true;
    return false;
  }

  /** Is the box pressed against a solid wall on the given side? */
  wallAt(box, dir) {
    const probe = { x: dir > 0 ? box.x + box.w : box.x - 1, y: box.y + 2, w: 1, h: box.h - 4 };
    return this.overlapsSolid(probe);
  }

  /**
   * Move a body by its velocity with tile collision.
   * @param {{x:number,y:number,w:number,h:number,vx:number,vy:number}} b
   * @param {{dropThrough?:boolean}} [opt]
   * @returns {{ground:boolean, ceil:boolean, left:boolean, right:boolean}}
   */
  moveBody(b, opt = {}) {
    const out = { ground: false, ceil: false, left: false, right: false };

    // ---- X axis ----
    if (b.vx !== 0) {
      const nx = b.x + b.vx;
      const box = { x: nx, y: b.y, w: b.w, h: b.h };
      if (this.overlapsSolid(box)) {
        if (b.vx > 0) {
          const edge = Math.floor((nx + b.w - 0.001) / TILE) * TILE;
          b.x = edge - b.w;
          out.right = true;
        } else {
          const edge = Math.floor(nx / TILE) * TILE + TILE;
          b.x = edge;
          out.left = true;
        }
        b.vx = 0;
      } else {
        b.x = nx;
      }
    }

    // ---- Y axis ----
    if (b.vy !== 0) {
      const prevBottom = b.y + b.h;
      const ny = b.y + b.vy;
      if (this.overlapsSolid({ x: b.x, y: ny, w: b.w, h: b.h })) {
        if (b.vy > 0) {
          b.y = Math.floor((ny + b.h - 0.001) / TILE) * TILE - b.h;
          out.ground = true;
        } else {
          b.y = Math.floor(ny / TILE) * TILE + TILE;
          out.ceil = true;
        }
        b.vy = 0;
      } else {
        b.y = ny;
        if (b.vy > 0 && !opt.dropThrough) {
          // One-way platforms: land only if the previous bottom was at/above the row top.
          const newBottom = ny + b.h;
          const tyTop = Math.floor(prevBottom / TILE);
          const tyBot = Math.floor((newBottom - 0.001) / TILE);
          const x0 = Math.floor(b.x / TILE), x1 = Math.floor((b.x + b.w - 0.001) / TILE);
          outer: for (let ty = tyTop; ty <= tyBot; ty++) {
            const top = ty * TILE;
            if (prevBottom > top + 0.001) continue;
            for (let tx = x0; tx <= x1; tx++) {
              if (this.get(tx, ty) === T.PLATFORM) {
                b.y = top - b.h; b.vy = 0; out.ground = true; break outer;
              }
            }
          }
        }
      }
    }
    if (b.y < 0) { b.y = 0; if (b.vy < 0) b.vy = 0; out.ceil = true; }
    return out;
  }
}

/**
 * LevelBuilder — a compact, readable way to author a level in code.
 * All coordinates are in *tiles*. Rectangles are inclusive on both ends.
 * Entity positions use the tile the entity's feet stand on.
 */
export class LevelBuilder {
  constructor(w, h) { this.level = new Level(w, h); }

  fill(x0, y0, x1, y1, id = T.SOLID) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.level.set(x, y, id);
    return this;
  }
  /** Solid ground from row `top` down to the bottom of the world. */
  ground(x0, x1, top) { return this.fill(x0, top, x1, this.level.h - 1, T.SOLID); }
  platform(x0, x1, y) { return this.fill(x0, y, x1, y, T.PLATFORM); }
  spikes(x0, x1, y) { return this.fill(x0, y, x1, y, T.SPIKE); }
  /** Liquid hazard from row `top` down to the bottom. */
  hazard(x0, x1, top) { return this.fill(x0, top, x1, this.level.h - 1, T.HAZARD); }

  player(tx, feetRow) {
    this.level.playerStart = { x: tx * TILE + TILE / 2, y: (feetRow + 1) * TILE };
    return this;
  }
  enemy(type, tx, feetRow, minX, maxX) {
    this.level.enemies.push({ type, x: tx * TILE + TILE / 2, y: (feetRow + 1) * TILE, minX: minX * TILE, maxX: (maxX + 1) * TILE });
    return this;
  }
  husk(tx, row, minX, maxX) { return this.enemy('husk', tx, row, minX, maxX); }
  zealot(tx, row, minX, maxX) { return this.enemy('zealot', tx, row, minX, maxX); }
  checkpoint(id, tx, feetRow) {
    this.level.checkpoints.push({ id, x: tx * TILE + TILE / 2, y: (feetRow + 1) * TILE });
    return this;
  }
  shard(id, tx, row) {
    this.level.pickups.push({ id, x: tx * TILE + TILE / 2, y: row * TILE + TILE / 2 });
    return this;
  }
  decor(type, tx, feetRow, extra = {}) {
    this.level.decor.push({ type, x: tx * TILE, y: (feetRow + 1) * TILE, ...extra });
    return this;
  }
  goal(tx, feetRow) {
    this.level.goal = { x: tx * TILE, y: (feetRow - 1) * TILE, w: TILE * 2, h: TILE * 2 };
    return this;
  }
  build() { return this.level; }
}
