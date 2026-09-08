/**
 * entity.js — base class for anything with a body in the world.
 *
 * An entity is an AABB (x, y = top-left; w, h) with velocity, a facing
 * direction and a handful of feel timers (flash, invulnerability). Subclasses
 * own a StateMachine and implement update(ctx).
 *
 * `ctx` (built by game.js each fixed step) exposes:
 *   ctx.input   input snapshot (player only)
 *   ctx.level   Level for collision queries
 *   ctx.fx      side-effect sink: sfx(), shake(), hitstop(), burst(), text()
 *   ctx.player  the player (enemies only)
 */
export class Entity {
  constructor(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.onGround = false;
    this.wasOnGround = false;
    this.hp = 1;
    this.maxHp = 1;
    this.flash = 0;          // frames of white flash after a hit
    this.invuln = 0;         // frames of i-frames
    this.alive = true;
    this.remove = false;     // set when the entity should be dropped from the world
    this.fsm = null;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get bottom() { return this.y + this.h; }
  get box() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }

  /** Rect `w`×`h` placed in front of the entity (for attacks). */
  frontBox(w, h, offY = 0) {
    const x = this.facing > 0 ? this.x + this.w - 2 : this.x + 2 - w;
    return { x, y: this.cy - h / 2 + offY, w, h };
  }

  tickTimers() {
    if (this.flash > 0) this.flash--;
    if (this.invuln > 0) this.invuln--;
  }

  get state() { return this.fsm ? this.fsm.name : ''; }
  get stateFrame() { return this.fsm ? this.fsm.frame : 0; }
}
