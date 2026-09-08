/**
 * storage.js — offline-first persistence for the player's profile.
 *
 * Strategy
 *   • IndexedDB is the durable store (survives storage pressure better than
 *     localStorage on iOS and is async, so it never blocks a frame).
 *   • localStorage mirrors the same JSON so the title screen can render
 *     synchronously on boot and as a fallback when IndexedDB is unavailable
 *     (private mode on some browsers, WebView restrictions).
 *   • `navigator.storage.persist()` is requested once so the browser is less
 *     likely to evict the data under pressure.
 *
 * Every read goes through `normalizeProfile()`, which fills defaults and
 * discards anything that does not match the schema. Never trust stored data:
 * a hand-edited value must degrade to a default, not to NaN or a crash.
 */
import { SAVE_SCHEMA, DB_NAME, DB_STORE, LS_KEY, CHARACTERS } from './constants.js';
import { sanitizeName } from './util.js';

const PROFILE_ID = 'default';

export function createDefaultProfile() {
  const now = Date.now();
  return {
    schema: SAVE_SCHEMA,
    id: PROFILE_ID,
    name: '',
    character: CHARACTERS[0].id,
    createdAt: now,
    updatedAt: now,
    run: {
      checkpoint: 'start',
      shards: [],
      kills: 0,
      deaths: 0,
      timeMs: 0,
      completed: false,
      bestTimeMs: null,
    },
    settings: {
      muted: false,
      music: true,
      haptics: true,
      reduceMotion: false,
      touchControls: 'auto',     // 'auto' | 'on' | 'off'
    },
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) && v >= 0 ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** Coerce arbitrary (possibly hostile) input into a valid profile. */
export function normalizeProfile(raw) {
  const d = createDefaultProfile();
  if (!raw || typeof raw !== 'object') return d;
  const p = { ...d };
  p.name = sanitizeName(raw.name);
  p.character = CHARACTERS.some((c) => c.id === raw.character) ? raw.character : d.character;
  p.createdAt = num(raw.createdAt, d.createdAt);
  p.updatedAt = num(raw.updatedAt, d.updatedAt);
  const r = raw.run && typeof raw.run === 'object' ? raw.run : {};
  p.run = {
    checkpoint: typeof r.checkpoint === 'string' && /^[a-z0-9_-]{1,24}$/i.test(r.checkpoint) ? r.checkpoint : 'start',
    shards: Array.isArray(r.shards) ? [...new Set(r.shards.filter((s) => typeof s === 'string' && s.length <= 8))].slice(0, 64) : [],
    kills: Math.min(num(r.kills, 0), 99999) | 0,
    deaths: Math.min(num(r.deaths, 0), 99999) | 0,
    timeMs: Math.min(num(r.timeMs, 0), 1e10),
    completed: bool(r.completed, false),
    bestTimeMs: isNum(r.bestTimeMs) && r.bestTimeMs > 0 ? r.bestTimeMs : null,
  };
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  p.settings = {
    muted: bool(s.muted, false),
    music: bool(s.music, true),
    haptics: bool(s.haptics, true),
    reduceMotion: bool(s.reduceMotion, false),
    touchControls: ['auto', 'on', 'off'].includes(s.touchControls) ? s.touchControls : 'auto',
  };
  return p;
}

/** Migrate older schemas forward. Only one schema exists today; the hook is here for the future. */
export function migrateProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const schema = raw.schema | 0;
  if (schema === SAVE_SCHEMA) return raw;
  // schema 0 / unknown: best effort — normalize handles the rest.
  return { ...raw, schema: SAVE_SCHEMA };
}

/* ------------------------------------------------------------------ */
/* Backends                                                            */
/* ------------------------------------------------------------------ */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no-idb'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open-failed'));
    req.onblocked = () => reject(new Error('idb-blocked'));
  });
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function lsWrite(p) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* quota / private mode */ }
}
function lsClear() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

export class ProfileStore {
  constructor() {
    this._db = null;
    this._dbTried = false;
    this._pending = null;
    this._dirty = null;
  }

  async _getDb() {
    if (this._db || this._dbTried) return this._db;
    this._dbTried = true;
    try {
      this._db = await openDb();
      navigator.storage?.persist?.().catch(() => {});
    } catch { this._db = null; }
    return this._db;
  }

  /** Synchronous best-effort read for first paint. */
  peek() {
    const raw = migrateProfile(lsRead());
    return raw ? normalizeProfile(raw) : null;
  }

  /** Authoritative async read: IndexedDB first, mirror fallback. */
  async load() {
    const db = await this._getDb();
    let raw = null;
    if (db) { try { raw = await idbGet(db, PROFILE_ID); } catch { raw = null; } }
    if (!raw) raw = lsRead();
    if (!raw) return null;
    return normalizeProfile(migrateProfile(raw));
  }

  /**
   * Save with write-coalescing: many calls in one frame produce one write.
   * The mirror is written synchronously so a hard refresh mid-save loses nothing.
   */
  save(profile) {
    const clean = normalizeProfile(profile);
    clean.updatedAt = Date.now();
    lsWrite(clean);
    this._dirty = clean;
    if (!this._pending) {
      this._pending = Promise.resolve().then(async () => {
        const db = await this._getDb();
        const toWrite = this._dirty; this._dirty = null; this._pending = null;
        if (db && toWrite) { try { await idbPut(db, toWrite); } catch { /* mirror still holds it */ } }
      });
    }
    return clean;
  }

  async clear() {
    lsClear();
    const db = await this._getDb();
    if (db) { try { await idbDelete(db, PROFILE_ID); } catch { /* ignore */ } }
  }
}
