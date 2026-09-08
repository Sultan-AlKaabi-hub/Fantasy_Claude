/**
 * player.js — the Pilgrim. Hollow-Knight movement, Blasphemous combat.
 *
 * States: idle, run, jump, fall, dash, wallslide, attack, parry, hitstun, dead
 *
 * Design rules enforced by the transition guard (see canTransition):
 *   • dead is terminal — nothing leaves it except Game.respawn() → reset()
 *   • hitstun can only end in idle / fall / dead
 *   • dash requires an available dash AND a cold cooldown (no infinite dashing)
 *   • parry is ground-only; attack is allowed anywhere except dash/parry/hitstun
 *
 * Every state does: read input → set velocity → stepPhysics() → decide the
 * next state. Physics happens *inside* the state so dash can freeze gravity
 * and wallslide can apply friction without special-casing a shared integrator.
 */
import { Entity } from './entity.js';
import { StateMachine } from '../core/fsm.js';
import { PLAYER as P, SHAKE, TILE } from '../core/constants.js';
import { approach, sign } from '../core/util.js';
import { T } from '../world/level.js';

function canTransition(from, to) {
  if (from === 'dead') return false;
  if (from === 'hitstun') return to === 'idle' || to === 'fall' || to === 'dead';
  return true;
}

export class Player extends Entity {
  constructor(x, y) {
    super(x - P.W / 2, y - P.H, P.W, P.H);
    this.maxHp = P.MAX_HP;
    this.hp = P.MAX_HP;
    this.reset(x, y);
    this.fsm = new StateMachine(this, STATES, canTransition);
    this.fsm.set('idle');
  }

  /** Full reset used on spawn / respawn. `x,y` = feet position. */
  reset(x, y) {
    this.x = x - P.W / 2; this.y = y - P.H;
    this.vx = 0; this.vy = 0;
    this.hp = this.maxHp;
    this.facing = 1;
    this.onGround = false; this.wasOnGround = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpHolding = false;
    this.jumpHoldFrames = 0;
    this.wallJumpLock = 0;
    this.wallStick = 0;        // grace frames to wall-jump after leaving a wall
    this.wallDir = 0;
    this.dashCooldown = 0;
    this.dashAvailable = true;
    this.dashDir = 1;
    this.attackIndex = 0;      // which swing of the combo is next
    this.attackDir = 'side';
    this.attackHits = new Set();
    this.attackQueued = false;
    this.comboWindow = 0;
    this.attackCooldown = 0;
    this.comboCount = 0;       // for the HUD
    this.parrySucceeded = false;
    this.riposte = 0;          // frames left in which the next swing is a lunging riposte
    this.riposteSwing = false;
    this.invuln = 0;
    this.flash = 0;
    this.alive = true;
    this.safeTimer = 0;
    this.lastSafe = { x: this.x, y: this.y };
    this.landedThisFrame = false;
    this.dropTimer = 0;
    if (this.fsm) { this.fsm.current = null; this.fsm.set('idle'); }
  }

  /* ------------------------------------------------------------ */
  /* Queries used by combat.js and the renderer                    */
  /* ------------------------------------------------------------ */
  get isDashing() { return this.fsm.is('dash'); }
  get isDead() { return this.fsm.is('dead'); }
  get isInvulnerable() { return this.invuln > 0 || this.isDashing || this.isDead; }

  /** True during the parry's active frames. */
  get parryActive() {
    if (!this.fsm.is('parry') || this.parrySucceeded) return false;
    const f = this.fsm.frame;
    return f >= P.PARRY_STARTUP && f < P.PARRY_STARTUP + P.PARRY_ACTIVE;
  }

  /** Current attack hitbox (world rect) or null when not in active frames. */
  get attackHitbox() {
    if (!this.fsm.is('attack')) return null;
    const swing = P.COMBO[this.attackIndex];
    const f = this.fsm.frame;
    if (f < swing.startup || f >= swing.startup + swing.active) return null;
    if (this.attackDir === 'up') {
      const b = P.ATTACK_BOX_UP;
      return { x: this.cx - b.w / 2, y: this.y - b.h + 4, w: b.w, h: b.h };
    }
    if (this.attackDir === 'down') {
      const b = P.ATTACK_BOX_DOWN;
      return { x: this.cx - b.w / 2, y: this.bottom - 4, w: b.w, h: b.h };
    }
    const b = this.riposteSwing ? P.RIPOSTE_BOX : P.ATTACK_BOX;
    return this.frontBox(b.w, b.h, -2);
  }
  get attackDamage() { return P.COMBO[this.attackIndex].dmg; }
  get attackHitstop() { return P.COMBO[this.attackIndex].hitstop; }

  /* ------------------------------------------------------------ */
  /* Shared mechanics                                              */
  /* ------------------------------------------------------------ */
  tick(input) {
    this.tickTimers();
    if (this.coyote > 0) this.coyote--;
    if (this.jumpBuffer > 0) this.jumpBuffer--;
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (this.wallJumpLock > 0) this.wallJumpLock--;
    if (this.wallStick > 0) this.wallStick--;
    if (this.comboWindow > 0) this.comboWindow--; else if (!this.fsm.is('attack')) { this.attackIndex = 0; }
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.dropTimer > 0) this.dropTimer--;
    if (this.riposte > 0) this.riposte--;
    if (input.pressed.jump) this.jumpBuffer = P.JUMP_BUFFER_FRAMES;
    this.landedThisFrame = false;
  }

  applyGravity(scale = 1) {
    this.vy = Math.min(this.vy + P.GRAVITY * scale, P.MAX_FALL);
  }

  /** Horizontal control with different accel on ground vs air. */
  steer(input, air) {
    if (this.wallJumpLock > 0) return;
    const ax = input.axisX;
    const target = ax * P.RUN_SPEED;
    const accel = air ? P.AIR_ACCEL : ax === 0 ? P.RUN_DECEL : P.RUN_ACCEL;
    this.vx = approach(this.vx, target, accel);
    if (ax !== 0) this.facing = ax;
  }

  stepPhysics(ctx, opt = {}) {
    this.wasOnGround = this.onGround;
    const flags = ctx.level.moveBody(this, { dropThrough: this.dropTimer > 0 });
    this.onGround = flags.ground;
    this.touchLeft = flags.left; this.touchRight = flags.right;
    if (this.onGround) {
      this.coyote = P.COYOTE_FRAMES;
      this.dashAvailable = true;
      if (!this.wasOnGround) this.onLand(ctx);
      // Remember a safe respawn spot only after a few frames fully supported, away from hazards.
      if (this.fullySupported(ctx.level)) {
        if (++this.safeTimer >= 6) this.lastSafe = { x: this.x, y: this.y };
      } else this.safeTimer = 0;
    } else this.safeTimer = 0;
    return flags;
  }

  /** Every column under the body (plus a 2px margin) is ground, and no hazard is within a tile. */
  fullySupported(level) {
    const row = Math.floor(this.bottom / TILE);
    const tx0 = Math.floor((this.x - 2) / TILE), tx1 = Math.floor((this.x + this.w + 2 - 0.001) / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = level.get(tx, row);
      if (t !== T.SOLID && t !== T.PLATFORM) return false;
    }
    return level.hazardIn({ x: this.x - TILE, y: this.y - 4, w: this.w + TILE * 2, h: this.h + TILE + 4 }) === 0;
  }

  onLand(ctx) {
    this.landedThisFrame = true;
    ctx.fx.burst('dust', this.cx, this.bottom, 0);
    ctx.fx.sfx('land');
    if (this.vyBefore > 5) ctx.fx.shake(SHAKE.LAND);
  }

  /** Is the player pushing into a wall while airborne and moving down? */
  wallSlideCheck(ctx, input) {
    if (this.onGround || this.vy < 0) return false;
    const ax = input.axisX;
    if (ax === 0) return false;
    if (!ctx.level.wallAt(this.box, ax)) return false;
    this.wallDir = ax;
    this.fsm.set('wallslide');
    return true;
  }

  tryJump(ctx, input) {
    if (this.jumpBuffer <= 0) return false;
    // Drop through a one-way platform: down + jump.
    if (input.held.down && this.onGround && !ctx.level.overlapsSolid({ x: this.x, y: this.bottom, w: this.w, h: 1 })) {
      this.dropTimer = 8; this.jumpBuffer = 0; this.onGround = false; this.coyote = 0;
      this.fsm.set('fall');
      return true;
    }
    if (this.wallStick > 0 && !this.onGround && this.coyote <= 0) {
      this.jumpBuffer = 0;
      this.fsm.set('jump', { wall: this.wallDir });
      return true;
    }
    if (this.coyote > 0) {
      this.jumpBuffer = 0;
      this.fsm.set('jump');
      return true;
    }
    return false;
  }

  tryDash(ctx, input) {
    if (!input.pressed.dash) return false;
    if (!this.dashAvailable || this.dashCooldown > 0) { ctx.fx.sfx('deny'); return false; }
    this.dashDir = input.axisX || this.facing;
    return this.fsm.set('dash');
  }

  tryAttack(ctx, input) {
    if (!input.pressed.attack || this.attackCooldown > 0) return false;
    let dir = 'side';
    if (input.held.up) dir = 'up';
    else if (input.held.down && !this.onGround) dir = 'down';
    if (input.axisX !== 0 && dir === 'side') this.facing = input.axisX;
    return this.fsm.set('attack', { dir });
  }

  tryParry(ctx, input) {
    if (!input.pressed.parry || !this.onGround) return false;
    return this.fsm.set('parry');
  }

  /** Common grounded decision list. Returns true if a transition happened. */
  groundedActions(ctx, input) {
    if (this.tryAttack(ctx, input)) return true;
    if (this.tryParry(ctx, input)) return true;
    if (this.tryDash(ctx, input)) return true;
    if (this.tryJump(ctx, input)) return true;
    if (!this.onGround) { this.fsm.set('fall'); return true; }
    return false;
  }

  /** Common airborne decision list. */
  airActions(ctx, input) {
    if (this.tryAttack(ctx, input)) return true;
    if (this.tryDash(ctx, input)) return true;
    if (this.tryJump(ctx, input)) return true;
    // Landing wins over wall-sliding when both happen on the same frame.
    if (this.onGround) { this.fsm.set(input.axisX ? 'run' : 'idle'); return true; }
    if (this.wallSlideCheck(ctx, input)) return true;
    return false;
  }

  /* ------------------------------------------------------------ */
  /* Damage                                                        */
  /* ------------------------------------------------------------ */
  /**
   * @returns {boolean} true if damage was applied
   */
  takeDamage(ctx, amount, fromX, opts = {}) {
    if (this.isInvulnerable) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.flash = 8;
    ctx.fx.hitstop(P.HURT_HITSTOP);
    ctx.fx.shake(SHAKE.PLAYER_HURT);
    ctx.fx.burst('blood', this.cx, this.cy, sign(this.cx - fromX) || this.facing);
    ctx.fx.sfx('hurt');
    ctx.fx.haptic(40);
    if (this.hp <= 0) {
      this.fsm.set('dead');
      return true;
    }
    const dir = opts.noKnockback ? 0 : (sign(this.cx - fromX) || -this.facing);
    this.fsm.set('hitstun', { dir, respawn: opts.respawn });
    return true;
  }

  /** Spikes / lava: damage then pull back to the last safe ground. */
  hazardHit(ctx) {
    if (this.isInvulnerable) return;
    this.takeDamage(ctx, 1, this.cx, { noKnockback: true, respawn: true });
  }

  onParrySuccess(ctx) {
    this.parrySucceeded = true;
    this.riposte = P.RIPOSTE_FRAMES;
    this.flash = 6;
    this.invuln = Math.max(this.invuln, 20);
    ctx.fx.hitstop(P.PARRY_HITSTOP);
    ctx.fx.shake(SHAKE.PARRY);
    ctx.fx.burst('spark', this.facing > 0 ? this.x + this.w + 6 : this.x - 6, this.cy, this.facing);
    ctx.fx.sfx('parry');
    ctx.fx.haptic(20);
    ctx.fx.text('PARRY', this.cx, this.y - 10, '#ffe08a');
  }

  update(ctx) {
    const input = ctx.input;
    this.vyBefore = this.vy;
    this.tick(input);
    this.fsm.update(ctx);
    // Hazards are checked after movement so a dash never skips a spike row.
    const hz = ctx.level.hazardIn(this.box);
    if (hz !== 0 && !this.isDead) {
      if (hz === T.HAZARD && this.isDashing) this.fsm.set('fall');
      this.hazardHit(ctx);
    }
  }
}

/* ================================================================== */
/* States                                                              */
/* ================================================================== */
const STATES = {
  idle: {
    update(p, ctx) {
      p.steer(ctx.input, false);
      p.applyGravity();
      p.stepPhysics(ctx);
      if (p.groundedActions(ctx, ctx.input)) return;
      if (ctx.input.axisX !== 0) p.fsm.set('run');
    },
  },

  run: {
    update(p, ctx) {
      p.steer(ctx.input, false);
      p.applyGravity();
      p.stepPhysics(ctx);
      if (p.groundedActions(ctx, ctx.input)) return;
      if (ctx.input.axisX === 0 && Math.abs(p.vx) < 0.2) p.fsm.set('idle');
      if (p.fsm.frame % 9 === 0) ctx.fx.burst('step', p.cx - p.facing * 4, p.bottom, -p.facing);
    },
  },

  jump: {
    enter(p, from, data) {
      p.jumpHolding = true;
      p.jumpHoldFrames = 0;
      p.coyote = 0;
      p.wallStick = 0;
      if (data && data.wall) {
        // Wall jump: kick away diagonally, briefly lock steering.
        p.vx = -data.wall * P.WALL_JUMP_VX;
        p.vy = P.WALL_JUMP_VY;
        p.facing = -data.wall;
        p.wallJumpLock = P.WALL_JUMP_LOCK;
        p.dashAvailable = true;
      } else {
        p.vy = P.JUMP_VEL;
      }
      p.onGround = false;
    },
    update(p, ctx) {
      const input = ctx.input;
      if (p.fsm.frame === 0) {
        ctx.fx.sfx('jump');
        if (p.wallJumpLock > 0) ctx.fx.burst('dust', p.facing > 0 ? p.x : p.x + p.w, p.cy, p.facing);
        else ctx.fx.burst('dust', p.cx, p.bottom, 0);
      }
      p.steer(input, true);
      // Variable height: light gravity while held during the hold window, hard cut on release.
      let g = 1;
      if (p.jumpHolding) {
        if (input.held.jump && p.jumpHoldFrames < P.JUMP_HOLD_FRAMES && p.vy < 0) {
          g = P.JUMP_HOLD_GRAVITY; p.jumpHoldFrames++;
        } else {
          if (!input.held.jump && p.vy < 0) p.vy *= P.JUMP_CUT;
          p.jumpHolding = false;
        }
      }
      p.applyGravity(g);
      const f = p.stepPhysics(ctx);
      if (f.ceil) { p.vy = 0; p.jumpHolding = false; }
      if (p.airActions(ctx, input)) return;
      if (p.vy >= 0) p.fsm.set('fall');
    },
  },

  fall: {
    update(p, ctx) {
      p.steer(ctx.input, true);
      p.applyGravity();
      p.stepPhysics(ctx);
      if (p.airActions(ctx, ctx.input)) return;
    },
  },

  dash: {
    enter(p) {
      p.dashAvailable = false;
      p.dashCooldown = P.DASH_COOLDOWN;
      p.facing = p.dashDir;
      p.vx = p.dashDir * P.DASH_SPEED;
      p.vy = 0;
      p.jumpHolding = false;
    },
    update(p, ctx) {
      if (p.fsm.frame === 0) { ctx.fx.sfx('dash'); ctx.fx.burst('dust', p.cx, p.bottom, -p.dashDir); }
      p.vx = p.dashDir * P.DASH_SPEED;
      p.vy = 0;                                   // gravity frozen for the whole dash
      const f = p.stepPhysics(ctx);
      if (p.fsm.frame % 2 === 0) ctx.fx.afterimage(p);
      const hitWall = f.left || f.right;
      if (p.fsm.frame >= P.DASH_FRAMES - 1 || hitWall) {
        p.vx = hitWall ? 0 : p.dashDir * P.DASH_END_VX;
        p.fsm.set(p.onGround ? (ctx.input.axisX ? 'run' : 'idle') : 'fall');
      }
    },
  },

  wallslide: {
    enter(p) {
      p.vx = 0;
      p.dashAvailable = true;
      p.jumpHolding = false;
      if (p.vy > P.WALL_SLIDE_MAX) p.vy = P.WALL_SLIDE_MAX;
    },
    update(p, ctx) {
      const input = ctx.input;
      p.facing = -p.wallDir;                      // face away from the wall (ready to kick off)
      // Friction: gravity still applies up to the slide cap; above it, friction bleeds speed off.
      if (p.vy > P.WALL_SLIDE_MAX) p.vy = Math.max(P.WALL_SLIDE_MAX, p.vy - P.WALL_SLIDE_FRICTION);
      else p.vy = Math.min(p.vy + P.GRAVITY, P.WALL_SLIDE_MAX);
      p.vx = p.wallDir * 0.5;                     // keep pressing into the wall
      p.stepPhysics(ctx);
      p.wallStick = P.WALL_STICK_FRAMES;
      if (p.fsm.frame % 6 === 0) ctx.fx.burst('dust', p.wallDir > 0 ? p.x + p.w : p.x, p.cy + 4, -p.wallDir);

      if (p.jumpBuffer > 0) { p.jumpBuffer = 0; p.fsm.set('jump', { wall: p.wallDir }); return; }
      if (input.pressed.dash && p.dashCooldown <= 0) { p.dashDir = -p.wallDir; p.fsm.set('dash'); return; }
      if (p.onGround) { p.fsm.set('idle'); return; }
      if (input.axisX !== p.wallDir || !ctx.level.wallAt(p.box, p.wallDir)) { p.fsm.set('fall'); }
    },
  },

  attack: {
    reentrant: true,
    enter(p, from, data) {
      p.attackDir = data?.dir || 'side';
      if (p.comboWindow <= 0) p.attackIndex = 0;
      p.attackHits.clear();
      p.attackQueued = false;
      p.comboWindow = 0;
      p.parrySucceeded = false;
      p.jumpHolding = false;
      p.comboCount = p.attackIndex + 1;
      // The first swing after a parry is a riposte: long lunge, long reach.
      p.riposteSwing = p.riposte > 0 && p.attackDir === 'side';
      p.riposte = 0;
    },
    update(p, ctx) {
      const input = ctx.input;
      const swing = P.COMBO[p.attackIndex];
      const f = p.fsm.frame;
      if (f === 0) ctx.fx.sfx(p.attackIndex === 2 ? 'slash_heavy' : 'slash');
      const total = swing.startup + swing.active + swing.recovery;

      // Forward momentum on each swing, strongest on the active frames.
      if (p.attackDir === 'side') {
        if (f >= swing.startup && f < swing.startup + swing.active) {
          const lunge = p.riposteSwing ? P.RIPOSTE_LUNGE : swing.lunge;
          p.vx = p.facing * lunge * (p.onGround ? 1 : 0.6);
        } else if (p.onGround) {
          p.vx = approach(p.vx, 0, P.RUN_DECEL);
        } else p.steer(input, true);
      } else {
        if (p.onGround) p.vx = approach(p.vx, 0, P.RUN_DECEL); else p.steer(input, true);
      }
      p.applyGravity();
      p.stepPhysics(ctx);

      // Buffer a follow-up press anywhere after the active frames.
      if (input.pressed.attack && f >= swing.startup + 2) p.attackQueued = true;

      // Chain into the next swing once recovery starts (Blasphemous-style cancel).
      if (p.attackQueued && f >= swing.startup + swing.active + 2 && p.attackIndex < P.COMBO.length - 1) {
        p.attackIndex++;
        p.comboWindow = 1;
        p.fsm.set('attack', { dir: input.held.up ? 'up' : (input.held.down && !p.onGround) ? 'down' : 'side' });
        return;
      }
      // Dash-cancel out of recovery.
      if (f >= swing.startup + swing.active && p.tryDash(ctx, input)) return;
      if (f >= total) {
        p.attackCooldown = P.ATTACK_COOLDOWN;
        p.comboWindow = p.attackIndex < P.COMBO.length - 1 ? P.COMBO_WINDOW : 0;
        if (p.attackIndex >= P.COMBO.length - 1) p.attackIndex = 0;
        else p.attackIndex++;
        p.fsm.set(p.onGround ? (input.axisX ? 'run' : 'idle') : 'fall');
      }
    },
    exit(p, to) {
      p.riposteSwing = false;
      if (to !== 'attack' && p.comboWindow === 0) p.attackIndex = 0;
    },
  },

  parry: {
    enter(p) {
      p.parrySucceeded = false;
      p.vx = 0;
      p.jumpHolding = false;
    },
    update(p, ctx) {
      const f = p.fsm.frame;
      if (f === 0) ctx.fx.sfx('parry_ready');
      p.vx = approach(p.vx, 0, P.RUN_DECEL);
      p.applyGravity();
      p.stepPhysics(ctx);
      const activeEnd = P.PARRY_STARTUP + P.PARRY_ACTIVE;
      if (p.parrySucceeded) {
        // Riposte pose: free to act almost immediately so the execution window is usable.
        if (f >= activeEnd || p.tryAttack(ctx, ctx.input) || p.tryDash(ctx, ctx.input)) {
          if (p.fsm.is('parry')) p.fsm.set('idle');
        }
        return;
      }
      // Whiffed: the full recovery is a vulnerability window. No cancels.
      if (f >= activeEnd + P.PARRY_RECOVERY) p.fsm.set(p.onGround ? 'idle' : 'fall');
    },
  },

  hitstun: {
    enter(p, from, data) {
      const dir = data?.dir ?? 0;
      p.vx = dir * P.HURT_KNOCKBACK_X;
      p.vy = P.HURT_KNOCKBACK_Y;
      p.invuln = P.HURT_INVULN;
      p.jumpHolding = false;
      p.comboWindow = 0;
      p.attackIndex = 0;
      p.respawnAfter = !!data?.respawn;
    },
    update(p, ctx) {
      p.vx = approach(p.vx, 0, 0.12);
      p.applyGravity();
      p.stepPhysics(ctx);
      if (p.fsm.frame >= P.HURT_STUN) {
        if (p.respawnAfter) {
          p.x = p.lastSafe.x; p.y = p.lastSafe.y; p.vx = 0; p.vy = 0;
          p.respawnAfter = false;
          ctx.fx.flash('#ffffff', 0.5);
        }
        p.fsm.set(p.onGround ? 'idle' : 'fall');
      }
    },
  },

  dead: {
    enter(p) {
      p.alive = false;
      p.vx = 0;
      p.vy = -3;
      p.invuln = 9999;
    },
    update(p, ctx) {
      if (p.fsm.frame === 0) { ctx.fx.sfx('death'); ctx.fx.shake(SHAKE.EXECUTION); ctx.fx.hitstop(12); }
      p.vx = approach(p.vx, 0, 0.1);
      p.applyGravity();
      p.stepPhysics(ctx);
    },
  },
};
