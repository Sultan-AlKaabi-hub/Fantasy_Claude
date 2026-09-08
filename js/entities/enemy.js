/**
 * enemy.js — base Enemy FSM plus the two vertical-slice archetypes.
 *
 * States: patrol, chase, attack, hitstun, stagger, dead
 *
 *   patrol  — walk between bounds, turn at ledges and walls
 *   chase   — approach the player when they are in sight (never walks off a ledge)
 *   attack  — startup (telegraph) → active (lunge + hitbox) → recovery
 *   hitstun — knocked back after taking a hit
 *   stagger — the execution window opened by a successful parry
 *   dead    — brief death animation, then removed
 *
 * Husk   : Hollow-Knight "Husk" — slow patroller, short lunge bite, contact damage.
 * Zealot : Blasphemous acolyte  — long, loud telegraph then a parryable spear thrust.
 */
import { Entity } from './entity.js';
import { StateMachine } from '../core/fsm.js';
import { ENEMY as E, SHAKE, PLAYER as P } from '../core/constants.js';
import { approach, sign } from '../core/util.js';

function canTransition(from, to) {
  if (from === 'dead') return false;
  if (from === 'stagger') return to === 'dead' || to === 'chase' || to === 'hitstun';
  if (from === 'hitstun') return to === 'dead' || to === 'chase' || to === 'stagger';
  return true;
}

export class Enemy extends Entity {
  /**
   * @param {'husk'|'zealot'} type
   * @param {number} x feet centre x
   * @param {number} y feet y
   * @param {number} minX patrol bound (px)
   * @param {number} maxX patrol bound (px)
   */
  constructor(type, x, y, minX, maxX) {
    const cfg = type === 'zealot' ? E.ZEALOT : E.HUSK;
    super(x - cfg.W / 2, y - cfg.H, cfg.W, cfg.H);
    this.type = type;
    this.cfg = cfg;
    this.spawn = { x, y, minX, maxX };
    this.minX = minX; this.maxX = maxX;
    this.maxHp = cfg.HP; this.hp = cfg.HP;
    this.facing = Math.random() < 0.5 ? -1 : 1;
    this.telegraph = 0;      // 0..1 for the renderer (how "charged" the attack is)
    this.staggered = false;
    this.fsm = new StateMachine(this, STATES, canTransition);
    this.fsm.set('patrol');
  }

  get isDead() { return this.fsm.is('dead'); }
  get contactDamage() { return this.isDead || this.fsm.is('stagger') ? 0 : this.cfg.CONTACT_DMG; }

  /** Active attack hitbox, or null. */
  get attackHitbox() {
    if (!this.fsm.is('attack')) return null;
    const a = this.cfg.ATTACK;
    const f = this.fsm.frame;
    if (f < a.startup || f >= a.startup + a.active) return null;
    return this.frontBox(a.box.w, a.box.h, this.type === 'zealot' ? -2 : 0);
  }
  get attackParryable() { return this.cfg.ATTACK.parryable; }
  get attackDamage() { return this.cfg.ATTACK.dmg; }

  applyGravity() { this.vy = Math.min(this.vy + E.GRAVITY, E.MAX_FALL); }

  stepPhysics(ctx) {
    this.wasOnGround = this.onGround;
    const f = ctx.level.moveBody(this);
    this.onGround = f.ground;
    return f;
  }

  /** Would walking `dir` step off a ledge or into a wall / patrol bound? */
  blocked(ctx, dir) {
    const ahead = { x: this.x + dir * (this.w / 2 + 2), y: this.y, w: this.w, h: this.h };
    if (ctx.level.wallAt(this.box, dir)) return true;
    if (this.onGround && !ctx.level.groundBelow(ahead)) return true;
    const nx = this.cx + dir * 4;
    if (nx < this.minX + this.w / 2 || nx > this.maxX - this.w / 2) return true;
    return false;
  }

  seesPlayer(ctx) {
    const pl = ctx.player;
    if (!pl || pl.isDead) return false;
    return Math.abs(pl.cx - this.cx) < this.cfg.SIGHT_X && Math.abs(pl.cy - this.cy) < this.cfg.SIGHT_Y;
  }

  inAttackRange(ctx) {
    const pl = ctx.player;
    return Math.abs(pl.cx - this.cx) < this.cfg.ATTACK_RANGE && Math.abs(pl.bottom - this.bottom) < 22;
  }

  /**
   * Receive a hit from the player.
   * @returns {boolean} whether the hit landed (false if already dead)
   */
  takeHit(ctx, dmg, fromX, opts = {}) {
    if (this.isDead) return false;
    const execution = this.fsm.is('stagger');
    const amount = execution ? dmg * P.EXECUTION_DMG_MULT : dmg;
    this.hp -= amount;
    this.flash = E.FLASH_FRAMES;
    const dir = sign(this.cx - fromX) || 1;
    ctx.fx.burst(execution ? 'gore' : 'blood', this.cx, this.cy, dir);
    ctx.fx.haptic(execution ? 60 : 15);
    if (execution) {
      ctx.fx.hitstop(P.EXECUTION_HITSTOP);
      ctx.fx.shake(SHAKE.EXECUTION);
      ctx.fx.sfx('execute');
      ctx.fx.text('EXECUTED', this.cx, this.y - 12, '#ff5d5d');
    } else {
      ctx.fx.hitstop(opts.hitstop ?? 4);
      ctx.fx.shake(opts.heavy ? SHAKE.HEAVY_HIT : SHAKE.LIGHT_HIT);
      ctx.fx.sfx('hit');
    }
    if (this.hp <= 0) {
      this.vx = dir * this.cfg.KNOCKBACK * 1.5;
      this.vy = -2.5;
      this.fsm.set('dead');
    } else {
      this.fsm.set('hitstun', { dir, force: this.cfg.KNOCKBACK });
    }
    return true;
  }

  /** The player parried this enemy's attack: knock back + open the execution window. */
  onParried(ctx, fromX) {
    const dir = sign(this.cx - fromX) || -this.facing;
    this.vx = dir * P.PARRY_KNOCKBACK;
    this.vy = -1.8;
    this.flash = 10;
    this.fsm.set('stagger');
  }

  update(ctx) {
    this.tickTimers();
    this.fsm.update(ctx);
    if (this.fsm.is('dead') && this.fsm.frame >= E.DEATH_FRAMES) this.remove = true;
  }
}

/* ================================================================== */
const STATES = {
  patrol: {
    enter(e) { e.telegraph = 0; e.staggered = false; },
    update(e, ctx) {
      if (e.onGround && e.blocked(ctx, e.facing)) e.facing = -e.facing;
      e.vx = approach(e.vx, e.facing * e.cfg.PATROL_SPEED, 0.2);
      e.applyGravity();
      e.stepPhysics(ctx);
      if (e.seesPlayer(ctx)) e.fsm.set('chase');
    },
  },

  chase: {
    enter(e) { e.telegraph = 0; e.staggered = false; },
    update(e, ctx) {
      const pl = ctx.player;
      if (!e.seesPlayer(ctx)) {
        // Lose interest after a moment.
        if (e.fsm.frame > 45) e.fsm.set('patrol');
        e.vx = approach(e.vx, 0, 0.2);
      } else {
        const dir = sign(pl.cx - e.cx) || e.facing;
        e.facing = dir;
        const canStep = e.onGround && !e.blocked(ctx, dir);
        e.vx = approach(e.vx, canStep ? dir * e.cfg.CHASE_SPEED : 0, 0.25);
        if (e.inAttackRange(ctx) && e.onGround) { e.fsm.set('attack'); return; }
      }
      e.applyGravity();
      e.stepPhysics(ctx);
    },
  },

  attack: {
    enter(e) { e.vx = 0; e.telegraph = 0; },
    update(e, ctx) {
      const a = e.cfg.ATTACK;
      const f = e.fsm.frame;
      const activeStart = a.startup, activeEnd = a.startup + a.active;

      if (f < activeStart) {
        // Telegraph: freeze, crouch, flash. Zealots also shout so the player can hear it coming.
        e.telegraph = f / activeStart;
        if (f === 0) ctx.fx.sfx(e.type === 'zealot' ? 'zealot_charge' : 'husk_growl');
        if (f === activeStart - 6) { e.flash = 4; ctx.fx.sfx('telegraph'); }
        e.vx = approach(e.vx, 0, 0.5);
      } else if (f < activeEnd) {
        e.telegraph = 1;
        if (f === activeStart) ctx.fx.burst('dust', e.cx - e.facing * 4, e.bottom, -e.facing);
        // Lunge / thrust: forward momentum while the hitbox is out.
        const canStep = !e.blocked(ctx, e.facing) || e.type === 'zealot';
        e.vx = canStep ? e.facing * a.lunge : 0;
      } else {
        e.telegraph = 0;
        e.vx = approach(e.vx, 0, 0.3);
        if (f >= activeEnd + a.recovery) { e.fsm.set('chase'); return; }
      }
      e.applyGravity();
      e.stepPhysics(ctx);
    },
    exit(e) { e.telegraph = 0; },
  },

  hitstun: {
    enter(e, from, data) {
      e.vx = (data?.dir ?? -e.facing) * (data?.force ?? 2);
      e.vy = -1.5;
      e.telegraph = 0;
    },
    update(e, ctx) {
      e.vx = approach(e.vx, 0, 0.18);
      e.applyGravity();
      e.stepPhysics(ctx);
      if (e.fsm.frame >= E.HITSTUN) e.fsm.set('chase');
    },
  },

  stagger: {
    enter(e) { e.staggered = true; e.telegraph = 0; },
    update(e, ctx) {
      e.vx = approach(e.vx, 0, 0.2);
      e.applyGravity();
      e.stepPhysics(ctx);
      if (e.fsm.frame >= E.STAGGER_FRAMES) { e.staggered = false; e.fsm.set('chase'); }
    },
    exit(e) { e.staggered = false; },
  },

  dead: {
    enter(e) { e.alive = false; e.telegraph = 0; e.staggered = false; },
    update(e, ctx) {
      if (e.fsm.frame === 0) { ctx.fx.sfx('enemy_die'); ctx.fx.burst('gore', e.cx, e.cy, e.facing); }
      e.vx = approach(e.vx, 0, 0.12);
      e.applyGravity();
      e.stepPhysics(ctx);
    },
  },
};

export function createEnemy(spec) {
  return new Enemy(spec.type, spec.x, spec.y, spec.minX, spec.maxX);
}
