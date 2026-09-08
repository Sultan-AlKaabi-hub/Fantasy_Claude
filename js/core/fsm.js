/**
 * fsm.js — a strict, minimal finite state machine.
 *
 * Each state is a plain object:
 *   { enter(owner, from, data), update(owner, ctx), exit(owner, to) }
 *
 * Transitions go through `set()` which:
 *   1. refuses unknown states (throws — a typo should fail loudly in dev),
 *   2. consults the optional `canTransition(from, to)` guard so that illegal
 *      moves (e.g. Dead -> Attacking) are impossible by construction,
 *   3. runs exit/enter hooks in order and resets the per-state frame counter.
 *
 * `frame` counts fixed steps spent in the current state and is the backbone of
 * every startup/active/recovery window in the game.
 */
export class StateMachine {
  /**
   * @param {object} owner   the entity that owns this machine
   * @param {Record<string, object>} states
   * @param {(from:string, to:string)=>boolean} [canTransition]
   */
  constructor(owner, states, canTransition) {
    this.owner = owner;
    this.states = states;
    this.canTransition = canTransition || (() => true);
    this.current = null;
    this.previous = null;
    this.frame = 0;
    this._locked = false;
  }

  get name() { return this.current; }
  is(...names) { return names.includes(this.current); }

  /**
   * Request a transition. Returns true if it happened.
   * @param {string} to
   * @param {*} [data] optional payload passed to enter()
   */
  set(to, data) {
    const state = this.states[to];
    if (!state) throw new Error(`FSM: unknown state "${to}"`);
    if (this.current === to && !state.reentrant) return false;
    if (this.current !== null && !this.canTransition(this.current, to)) return false;
    if (this._locked) throw new Error(`FSM: re-entrant transition ${this.current} -> ${to}`);

    this._locked = true;
    const from = this.current;
    try {
      if (from !== null) this.states[from].exit?.(this.owner, to);
      this.previous = from;
      this.current = to;
      this.frame = 0;
      state.enter?.(this.owner, from, data);
    } finally {
      this._locked = false;
    }
    return true;
  }

  /** Advance one fixed step. */
  update(ctx) {
    const state = this.states[this.current];
    if (!state) return;
    const before = this.current;
    state.update?.(this.owner, ctx);
    // Only count the frame if no transition happened inside update(); a new
    // state must see frame === 0 on its own first update.
    if (this.current === before) this.frame++;
  }
}
