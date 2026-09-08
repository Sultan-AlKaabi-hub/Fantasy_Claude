/**
 * camera.js — smooth follow with facing look-ahead and modular shake.
 *
 * The camera stores its position in world pixels (top-left of the view).
 * Each fixed step it lerps toward a target that sits `LOOK_AHEAD` px in front
 * of the player's facing; the look-ahead itself is lerped so that turning
 * around swings the view smoothly rather than snapping.
 *
 * Shake is trauma-style: `shake({amp, frames})` adds an impulse; the offset
 * each frame is a random vector scaled by the current amplitude which decays
 * geometrically. Multiple shakes stack (capped) rather than replace each other.
 * `reduceMotion` disables shake entirely for players who asked for it.
 */
import { CAMERA as C } from './constants.js';
import { clamp, lerp } from './util.js';

export class Camera {
  constructor(viewW, viewH) {
    this.viewW = viewW;
    this.viewH = viewH;
    this.x = 0; this.y = 0;
    this.lookX = 0;
    this.shakeAmp = 0;
    this.shakeFrames = 0;
    this.offX = 0; this.offY = 0;
    this.reduceMotion = false;
    this.bounds = { w: 10000, h: 10000 };
  }

  resize(viewW, viewH) { this.viewW = viewW; this.viewH = viewH; }

  /** Jump straight to the target (used on spawn / respawn). */
  snapTo(target) {
    this.lookX = target.facing * C.LOOK_AHEAD;
    this.x = target.cx + this.lookX - this.viewW / 2;
    this.y = target.cy - this.viewH / 2;
    this._clamp();
  }

  /** @param {{amp:number, frames:number}} s */
  shake(s) {
    if (this.reduceMotion) return;
    this.shakeAmp = Math.min(C.SHAKE_MAX, this.shakeAmp + s.amp);
    this.shakeFrames = Math.max(this.shakeFrames, s.frames);
  }

  update(target) {
    // Look-ahead eases toward the facing direction; shrinks while wall-sliding.
    const want = target.facing * C.LOOK_AHEAD * (target.state === 'wallslide' ? 0.3 : 1);
    this.lookX = lerp(this.lookX, want, C.LOOK_AHEAD_LERP);

    const tx = target.cx + this.lookX - this.viewW / 2;
    this.x = lerp(this.x, tx, C.LERP);

    // Vertical dead zone so small hops don't bob the camera.
    const ty = target.cy - this.viewH / 2;
    const dy = ty - this.y;
    if (Math.abs(dy) > C.VERTICAL_DEADZONE) {
      this.y = lerp(this.y, ty - Math.sign(dy) * C.VERTICAL_DEADZONE, target.onGround ? C.LERP * 1.4 : C.LERP * 0.8);
    }
    this._clamp();

    // Shake
    if (this.shakeFrames > 0) {
      this.shakeFrames--;
      const a = this.shakeAmp;
      this.offX = (Math.random() * 2 - 1) * a;
      this.offY = (Math.random() * 2 - 1) * a * 0.7;
      this.shakeAmp *= C.SHAKE_DECAY;
    } else {
      this.shakeAmp = 0; this.offX = 0; this.offY = 0;
    }
  }

  _clamp() {
    this.x = clamp(this.x, 0, Math.max(0, this.bounds.w - this.viewW));
    this.y = clamp(this.y, 0, Math.max(0, this.bounds.h - this.viewH));
  }

  /** Integer render origin including shake. */
  get rx() { return Math.round(this.x + this.offX); }
  get ry() { return Math.round(this.y + this.offY); }
}
