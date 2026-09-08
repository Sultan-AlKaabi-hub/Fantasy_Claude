/**
 * util.js — tiny, dependency-free helpers shared by logic and rendering.
 * Everything here is pure so it can run in Node for unit tests.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const approach = (v, target, step) =>
  v < target ? Math.min(v + step, target) : Math.max(v - step, target);

/** Axis-aligned bounding box overlap test. Boxes are {x,y,w,h}. */
export function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Deterministic PRNG (mulberry32) so procedural art is stable between boots. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash. Used for stable seeds derived from strings. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Format milliseconds as m:ss.t for the HUD / results screen. */
export function formatTime(ms) {
  const total = Math.max(0, ms | 0);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const t = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${t}`;
}

/**
 * Sanitise a player-supplied display name. Allows letters (any script),
 * digits, spaces, apostrophes, hyphens and underscores; collapses whitespace;
 * caps at 16 characters. Never trust this for HTML — always set via textContent.
 */
export function sanitizeName(raw) {
  const s = String(raw ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _'\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return s;
}

/** Minimal typed event bus. */
export class Emitter {
  constructor() { this._l = new Map(); }
  on(type, fn) {
    if (!this._l.has(type)) this._l.set(type, new Set());
    this._l.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._l.get(type)?.delete(fn); }
  emit(type, payload) {
    const set = this._l.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }
}
