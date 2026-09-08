/**
 * Test helpers: a stub fx sink, an input snapshot factory and a tiny level.
 * The simulation modules are DOM-free, so they run under `node --test` as-is.
 */
import { LevelBuilder } from '../js/world/level.js';
import { Player } from '../js/entities/player.js';
import { Enemy } from '../js/entities/enemy.js';
import { resolveCombat } from '../js/combat.js';
import { ACTIONS } from '../js/core/input.js';

export function fxStub() {
  const log = [];
  const rec = (name) => (...args) => log.push([name, ...args]);
  return {
    log,
    sfx: rec('sfx'), shake: rec('shake'), hitstop: rec('hitstop'), burst: rec('burst'),
    text: rec('text'), afterimage: rec('afterimage'), flash: rec('flash'), haptic: rec('haptic'),
    has: (name, arg) => log.some((e) => e[0] === name && (arg === undefined || e[1] === arg)),
  };
}

/** Build an input snapshot. `held` and `pressed` are arrays of action names. */
export function snap({ held = [], pressed = [], released = [] } = {}) {
  const s = { held: {}, pressed: {}, released: {} };
  for (const a of ACTIONS) { s.held[a] = held.includes(a); s.pressed[a] = pressed.includes(a); s.released[a] = released.includes(a); }
  s.axisX = (s.held.right ? 1 : 0) - (s.held.left ? 1 : 0);
  return s;
}

/** 40×20 room: floor at row 15, a wall at x=30, a platform at row 11 (x 10–14), spikes at x 20–21. */
export function makeLevel() {
  return new LevelBuilder(40, 20)
    .ground(0, 39, 15)
    .fill(30, 5, 31, 14)
    .platform(10, 14, 11)
    .fill(20, 15, 21, 19, 0)      // pit
    .spikes(20, 21, 17).ground(20, 21, 18)
    .build();
}

export class Sim {
  constructor({ level = makeLevel(), x = 5 * 16 + 8, y = 15 * 16 } = {}) {
    this.level = level;
    this.fx = fxStub();
    this.player = new Player(x, y);
    this.enemies = [];
    this.frame = 0;
  }
  addEnemy(type, tx, minX = 0, maxX = 39) {
    const e = new Enemy(type, tx * 16 + 8, 15 * 16, minX * 16, (maxX + 1) * 16);
    this.enemies.push(e);
    return e;
  }
  ctx(input) { return { input, level: this.level, fx: this.fx, player: this.player }; }
  /** Advance one fixed step with the given input. */
  step(input = snap()) {
    const ctx = this.ctx(input);
    this.player.update(ctx);
    for (const e of this.enemies) e.update(ctx);
    resolveCombat(ctx, this.player, this.enemies);
    this.frame++;
    return this.player;
  }
  run(n, input) { for (let i = 0; i < n; i++) this.step(input); return this.player; }
  /** Let the player settle on the ground. */
  settle() { return this.run(30); }
}
