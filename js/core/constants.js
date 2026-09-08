/**
 * constants.js — single source of truth for every tuning number in the game.
 *
 * All motion values are expressed in *pixels per fixed frame* at 60 Hz.
 * The simulation runs on a fixed timestep (see game.js), so a value of 2.6 means
 * "2.6 pixels every 1/60 s" regardless of the display refresh rate.
 *
 * Frame-count windows (coyote time, jump buffer, hitstop, …) are integers so
 * that they are exact and testable rather than floating-point durations.
 */

export const FPS = 60;
export const STEP_MS = 1000 / FPS;
export const MAX_STEPS_PER_FRAME = 5;   // catch-up cap after a tab-switch

export const TILE = 16;

/** Backbuffer: fixed height, width derived from the viewport aspect ratio. */
export const VIEW_H = 240;
export const VIEW_W_MIN = 320;
export const VIEW_W_MAX = 432;

/* ------------------------------------------------------------------ */
/* Player physics (Hollow-Knight-style: fast, floaty apex, hard cut)   */
/* ------------------------------------------------------------------ */
export const PLAYER = Object.freeze({
  W: 12, H: 22,                 // collision box
  MAX_HP: 5,                    // masks / hearts

  GRAVITY: 0.42,
  MAX_FALL: 6.8,
  RUN_ACCEL: 0.55,
  RUN_DECEL: 0.75,
  AIR_ACCEL: 0.42,
  RUN_SPEED: 2.6,

  JUMP_VEL: -5.6,
  JUMP_HOLD_FRAMES: 12,         // gravity is reduced while held, up to this many frames
  JUMP_HOLD_GRAVITY: 0.5,       // gravity multiplier during the hold window
  JUMP_CUT: 0.45,               // vy multiplier when the button is released early
  COYOTE_FRAMES: 5,
  JUMP_BUFFER_FRAMES: 5,

  DASH_SPEED: 7.0,
  DASH_FRAMES: 9,
  DASH_COOLDOWN: 28,
  DASH_END_VX: 2.6,             // horizontal carry after a dash ends

  WALL_SLIDE_MAX: 1.6,
  WALL_SLIDE_FRICTION: 0.35,    // how fast vy decays toward the slide cap
  WALL_JUMP_VX: 3.6,
  WALL_JUMP_VY: -5.4,
  WALL_JUMP_LOCK: 9,            // frames of no horizontal control after a wall jump
  WALL_STICK_FRAMES: 4,         // grace frames to jump after leaving a wall

  // 3-hit combo. Each entry is one swing.
  COMBO: [
    { startup: 3, active: 5, recovery: 8, lunge: 1.6, dmg: 1, hitstop: 4 },
    { startup: 3, active: 5, recovery: 8, lunge: 1.6, dmg: 1, hitstop: 4 },
    { startup: 5, active: 6, recovery: 12, lunge: 2.4, dmg: 2, hitstop: 8 },
  ],
  COMBO_WINDOW: 10,             // frames after a swing during which the next input chains
  ATTACK_BOX: { w: 26, h: 18 }, // forward slash
  ATTACK_BOX_UP: { w: 20, h: 24 },
  ATTACK_BOX_DOWN: { w: 20, h: 20 },
  POGO_VY: -5.0,                // bounce after a downward slash connects
  ATTACK_COOLDOWN: 4,

  // Blasphemous-style parry
  PARRY_STARTUP: 2,
  PARRY_ACTIVE: 8,
  PARRY_RECOVERY: 16,           // whiffed parry leaves the player exposed this long
  PARRY_HITSTOP: 10,
  PARRY_KNOCKBACK: 2.2,         // applied to the enemy (a step back, still in blade reach)
  RIPOSTE_BOX: { w: 48, h: 20 }, // reach of the first strike after a successful parry
  RIPOSTE_LUNGE: 3.4,
  RIPOSTE_FRAMES: 110,          // how long the riposte stays armed
  EXECUTION_DMG_MULT: 4,
  EXECUTION_HITSTOP: 14,

  HURT_KNOCKBACK_X: 3.2,
  HURT_KNOCKBACK_Y: -3.4,
  HURT_STUN: 18,
  HURT_INVULN: 70,
  HURT_HITSTOP: 6,

  DEATH_FRAMES: 90,
});

/* ------------------------------------------------------------------ */
/* Enemies                                                             */
/* ------------------------------------------------------------------ */
export const ENEMY = Object.freeze({
  GRAVITY: 0.42,
  MAX_FALL: 6.0,
  HITSTUN: 14,
  STAGGER_FRAMES: 100,          // execution window after a successful parry
  DEATH_FRAMES: 40,
  FLASH_FRAMES: 6,

  HUSK: {
    W: 14, H: 18, HP: 3,
    PATROL_SPEED: 0.55, CHASE_SPEED: 1.25,
    SIGHT_X: 88, SIGHT_Y: 28,
    ATTACK_RANGE: 20,
    ATTACK: { startup: 18, active: 8, recovery: 22, lunge: 2.4, box: { w: 16, h: 14 }, dmg: 1, parryable: true },
    CONTACT_DMG: 1,
    KNOCKBACK: 2.4,
  },
  ZEALOT: {
    W: 16, H: 24, HP: 6,
    PATROL_SPEED: 0.4, CHASE_SPEED: 1.0,
    SIGHT_X: 130, SIGHT_Y: 36,
    ATTACK_RANGE: 62,
    ATTACK: { startup: 42, active: 10, recovery: 34, lunge: 4.6, box: { w: 30, h: 10 }, dmg: 2, parryable: true },
    CONTACT_DMG: 0,             // Blasphemous style: only the blade hurts
    KNOCKBACK: 1.6,
  },
});

/* ------------------------------------------------------------------ */
/* Camera & feel                                                       */
/* ------------------------------------------------------------------ */
export const CAMERA = Object.freeze({
  LERP: 0.11,                   // per-frame smoothing toward the target
  LOOK_AHEAD: 36,               // px ahead of the facing direction
  LOOK_AHEAD_LERP: 0.06,
  VERTICAL_DEADZONE: 18,
  SHAKE_DECAY: 0.9,
  SHAKE_MAX: 9,
});

export const SHAKE = Object.freeze({
  LIGHT_HIT: { amp: 2, frames: 6 },
  HEAVY_HIT: { amp: 4, frames: 10 },
  PLAYER_HURT: { amp: 5, frames: 12 },
  PARRY: { amp: 4, frames: 9 },
  EXECUTION: { amp: 7, frames: 16 },
  LAND: { amp: 1.2, frames: 4 },
});

/** Save / storage identifiers. Bump SAVE_SCHEMA when the shape changes. */
export const SAVE_SCHEMA = 1;
export const DB_NAME = 'gloomfall';
export const DB_STORE = 'profiles';
export const LS_KEY = `gloomfall::profile::v${SAVE_SCHEMA}`;

/** Character roster. Purely cosmetic variants plus a tiny stat flavour. */
export const CHARACTERS = Object.freeze([
  { id: 'penitent', name: 'The Penitent', cape: '#b3223a', capeDark: '#6e0f22', trim: '#e0b34a', desc: 'Iron faith. Steady blade.' },
  { id: 'wanderer', name: 'The Wanderer', cape: '#3f7fd6', capeDark: '#1f437f', trim: '#c9e8ff', desc: 'Far roads. Light feet.' },
  { id: 'ember',    name: 'The Ember',    cape: '#ff8a2a', capeDark: '#9a3f0c', trim: '#ffe08a', desc: 'Ash-born. Burns bright.' },
]);
