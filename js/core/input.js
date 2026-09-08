/**
 * input.js — unifies keyboard, touch and gamepad into one action snapshot.
 *
 * The simulation never reads raw devices. Each fixed step it calls
 * `input.poll()` and gets back a frozen snapshot with, per action:
 *   held     — the button is currently down
 *   pressed  — went down since the previous step (edge)
 *   released — went up since the previous step (edge)
 *
 * Edge detection is done here (not by the devices) so that a press and release
 * that both happen between two fixed steps still register as a `pressed` —
 * that is what makes 120 Hz touch input feel responsive on a 60 Hz sim.
 *
 * `InputState` is pure and testable; `Input` is the DOM adapter.
 */

export const ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'attack', 'dash', 'parry', 'pause'];

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump', KeyZ: 'jump', KeyK: 'jump',
  KeyX: 'attack', KeyJ: 'attack',
  KeyC: 'dash', KeyL: 'dash', ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyV: 'parry', KeyI: 'parry',
  Escape: 'pause', KeyP: 'pause', Enter: 'pause',
};

/** Standard-mapping gamepad buttons → actions. */
const PADMAP = {
  0: 'jump',   // A / Cross
  2: 'attack', // X / Square
  1: 'dash',   // B / Circle
  3: 'parry',  // Y / Triangle
  5: 'dash',   // RB
  4: 'parry',  // LB
  9: 'pause',  // Start
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

export class InputState {
  constructor() {
    this.down = Object.create(null);      // raw latched "is down" per source-merged action
    this.pressedLatch = Object.create(null);
    this.releasedLatch = Object.create(null);
    this.prev = Object.create(null);
    for (const a of ACTIONS) { this.down[a] = false; this.prev[a] = false; }
  }

  /** Called by a device whenever an action changes. */
  setDown(action, isDown) {
    if (!(action in this.down)) return;
    if (isDown && !this.down[action]) this.pressedLatch[action] = true;
    if (!isDown && this.down[action]) this.releasedLatch[action] = true;
    this.down[action] = isDown;
  }

  /** Produce the per-step snapshot and clear edge latches. */
  poll() {
    const snap = { held: {}, pressed: {}, released: {} };
    for (const a of ACTIONS) {
      snap.held[a] = this.down[a];
      snap.pressed[a] = !!this.pressedLatch[a] || (this.down[a] && !this.prev[a]);
      snap.released[a] = !!this.releasedLatch[a] || (!this.down[a] && this.prev[a]);
      this.prev[a] = this.down[a];
    }
    this.pressedLatch = Object.create(null);
    this.releasedLatch = Object.create(null);
    snap.axisX = (snap.held.right ? 1 : 0) - (snap.held.left ? 1 : 0);
    return snap;
  }

  /** Drop everything (e.g. on window blur) so nothing sticks. */
  clear() {
    for (const a of ACTIONS) {
      if (this.down[a]) this.releasedLatch[a] = true;
      this.down[a] = false;
    }
  }
}

/**
 * DOM adapter. Multiple sources may hold the same action; we OR them so that a
 * key and a touch button both held then one released does not drop the action.
 */
export class Input {
  /**
   * @param {HTMLElement} root       element that receives keyboard focus
   * @param {HTMLElement} touchRoot  container of `[data-action]` buttons and `.dpad`
   */
  constructor(root, touchRoot) {
    this.state = new InputState();
    this.sources = { key: new Set(), touch: new Set(), pad: new Set() };
    this.touchUsed = false;
    this._root = root;
    this._touchRoot = touchRoot;
    this._bind();
  }

  _merge(action) {
    const down = this.sources.key.has(action) || this.sources.touch.has(action) || this.sources.pad.has(action);
    this.state.setDown(action, down);
  }
  _src(src, action, isDown) {
    const set = this.sources[src];
    if (isDown) set.add(action); else set.delete(action);
    this._merge(action);
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      // Let Enter/Escape reach the DOM when a form field has focus.
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      if (e.repeat) return;
      this._src('key', a, true);
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) this._src('key', a, false);
    });
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clearAll(); });

    if (this._touchRoot) this._bindTouch(this._touchRoot);
  }

  _bindTouch(root) {
    // Action buttons: simple press/release with pointer capture.
    root.querySelectorAll('[data-action]').forEach((btn) => {
      const action = btn.dataset.action;
      const down = (e) => {
        e.preventDefault();
        this.touchUsed = true;
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('is-down');
        this._src('touch', action, true);
      };
      const up = (e) => {
        e.preventDefault();
        btn.classList.remove('is-down');
        this._src('touch', action, false);
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // D-pad: one pointer, 8-way by angle from the pad centre with a dead zone,
    // so the thumb can slide between directions without lifting.
    const pad = root.querySelector('.dpad');
    if (!pad) return;
    let activeId = null;
    const dirs = ['left', 'right', 'up', 'down'];
    const apply = (e) => {
      const r = pad.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dead = r.width * 0.12;
      const next = new Set();
      if (Math.hypot(dx, dy) > dead) {
        const ang = Math.atan2(dy, dx);           // -PI..PI, 0 = right
        const a = Math.abs(ang);
        if (a < Math.PI * 0.375) next.add('right');
        else if (a > Math.PI * 0.625) next.add('left');
        if (ang < -Math.PI * 0.125 && ang > -Math.PI * 0.875) next.add('up');
        if (ang > Math.PI * 0.125 && ang < Math.PI * 0.875) next.add('down');
      }
      for (const d of dirs) {
        this._src('touch', d, next.has(d));
        pad.querySelector(`[data-dir="${d}"]`)?.classList.toggle('is-down', next.has(d));
      }
    };
    const release = () => {
      activeId = null;
      for (const d of dirs) {
        this._src('touch', d, false);
        pad.querySelector(`[data-dir="${d}"]`)?.classList.remove('is-down');
      }
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.touchUsed = true;
      activeId = e.pointerId;
      pad.setPointerCapture?.(e.pointerId);
      apply(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === activeId) apply(e); });
    pad.addEventListener('pointerup', (e) => { if (e.pointerId === activeId) release(); });
    pad.addEventListener('pointercancel', (e) => { if (e.pointerId === activeId) release(); });
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Read gamepads. Called once per fixed step before poll(). */
  _pollGamepad() {
    const pads = navigator.getGamepads?.() || [];
    const next = new Set();
    for (const gp of pads) {
      if (!gp) continue;
      gp.buttons.forEach((b, i) => { if (b.pressed && PADMAP[i]) next.add(PADMAP[i]); });
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      if (ax < -0.45) next.add('left'); if (ax > 0.45) next.add('right');
      if (ay < -0.55) next.add('up');  if (ay > 0.55) next.add('down');
    }
    for (const a of ACTIONS) {
      const was = this.sources.pad.has(a), now = next.has(a);
      if (was !== now) this._src('pad', a, now);
    }
  }

  poll() {
    this._pollGamepad();
    return this.state.poll();
  }

  clearAll() {
    for (const s of Object.values(this.sources)) s.clear();
    this.state.clear();
    this._touchRoot?.querySelectorAll('.is-down').forEach((el) => el.classList.remove('is-down'));
  }
}
