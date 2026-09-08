/**
 * game.js — orchestrates one run: fixed-step simulation, hitstop, world
 * events (checkpoints, shards, the gate), respawn, saving, and rendering.
 *
 * Loop
 *   requestAnimationFrame → accumulate real time → run N fixed 60 Hz steps →
 *   render once. Display refresh rate never changes the simulation.
 *
 * Hitstop
 *   `hitstop` is a global frame counter. While > 0 the world does not step;
 *   only the camera shake and (slowed) particles tick. Every impact sets it
 *   through ctx.fx.hitstop(n) and the largest request wins.
 */
import { STEP_MS, MAX_STEPS_PER_FRAME, VIEW_H, VIEW_W_MIN, VIEW_W_MAX, PLAYER as P, TILE } from './core/constants.js';
import { Camera } from './core/camera.js';
import { Emitter, aabb, clamp, formatTime } from './core/util.js';
import { Particles } from './fx/particles.js';
import { Renderer } from './render/renderer.js';
import { Player } from './entities/player.js';
import { createEnemy } from './entities/enemy.js';
import { resolveCombat } from './combat.js';
import { buildWorld1 } from './world/world1.js';
import { ZONES } from './world/level.js';

const HINTS = [
  { x: 0, text: 'MOVE  ·  JUMP (hold for height)' },
  { x: 220, text: 'DASH through the air  ·  ATTACK x3' },
  { x: 470, text: 'DASH clears the spikes' },
  { x: 1000, text: 'Push into the wall to slide  ·  JUMP to kick off' },
  { x: 1120, text: 'PARRY when the spear flashes white, then strike' },
];

export class Game extends Emitter {
  /**
   * @param {{canvas:HTMLCanvasElement, stage:HTMLElement, input:import('./core/input.js').Input,
   *          audio:import('./core/audio.js').AudioSystem, store:import('./core/storage.js').ProfileStore,
   *          bank:object, backdrop:object}} deps
   */
  constructor(deps) {
    super();
    this.canvas = deps.canvas;
    this.stage = deps.stage;
    this.input = deps.input;
    this.audio = deps.audio;
    this.store = deps.store;
    this.bank = deps.bank;
    this.renderer = new Renderer(deps.bank, deps.backdrop);
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    this.camera = new Camera(384, VIEW_H);
    this.particles = new Particles();

    this.profile = null;
    this.level = null;
    this.player = null;
    this.enemies = [];
    this.checkpoints = [];
    this.pickups = [];
    this.activeCheckpoint = 'start';
    this.shardCount = 0;
    this.kills = 0;
    this.runTimeMs = 0;
    this.hitstop = 0;
    this.banner = null;
    this.hint = null;
    this.hintIndex = 0;
    this.currentZone = null;
    this.safeLeft = 0; this.safeRight = 0;

    this.running = false;
    this.paused = false;
    this.finished = false;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._deathAnnounced = false;
    this._liveTick = 0;
    this._lastLive = '';

    // Side-effect sink handed to entities. Keeps player/enemy modules DOM-free.
    this.fx = {
      sfx: (n) => this.audio.play(n),
      shake: (s) => this.camera.shake(s),
      hitstop: (n) => { this.hitstop = Math.max(this.hitstop, n); },
      burst: (t, x, y, d) => this.particles.burst(t, x, y, d),
      text: (s, x, y, c) => this.particles.text(s, x, y, c),
      afterimage: (p) => this.particles.ghost(p, this.bank.player[this.profile.character].dash),
      flash: (c, a) => this.renderer.flash(c, a),
      haptic: (ms) => {
        // Browsers refuse vibrate() before the first tap; skip silently until then.
        if (!this.profile?.settings.haptics || !navigator.vibrate || navigator.userActivation?.hasBeenActive === false) return;
        try { navigator.vibrate(ms); } catch { /* ignore */ }
      },
    };

    this._loop = this._loop.bind(this);
    this.fit();
  }

  /* ------------------------------------------------------------ */
  /* Sizing                                                        */
  /* ------------------------------------------------------------ */
  /** Size the backbuffer to the stage aspect and scale the display canvas. */
  fit() {
    const rect = this.stage.getBoundingClientRect();
    const cs = getComputedStyle(this.stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const sw = Math.max(200, rect.width - padX), sh = Math.max(150, rect.height - padY);
    const portrait = sh > sw;
    const availH = portrait ? sh * 0.5 : sh;
    const aspect = sw / availH;
    const vw = clamp(Math.round(VIEW_H * aspect), VIEW_W_MIN, VIEW_W_MAX);
    const scale = Math.min(sw / vw, availH / VIEW_H);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = Math.floor(vw * scale), cssH = Math.floor(VIEW_H * scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx2d.imageSmoothingEnabled = false;
    if (this.renderer.buf.width !== vw) this.renderer.resize(vw, VIEW_H);
    this.camera.resize(vw, VIEW_H);
    if (this.player) this.camera.snapTo(this.player);
    this.viewW = vw;
  }

  /* ------------------------------------------------------------ */
  /* Run lifecycle                                                 */
  /* ------------------------------------------------------------ */
  start(profile) {
    this.profile = profile;
    this.level = buildWorld1();
    this.camera.bounds = { w: this.level.pixelW, h: this.level.pixelH };
    this.camera.reduceMotion = !!profile.settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.audio.setMuted(!!profile.settings.muted);

    this.checkpoints = this.level.checkpoints.map((c) => ({ ...c }));
    this.pickups = this.level.pickups.map((s) => ({ ...s, taken: profile.run.shards.includes(s.id) }));
    this.shardCount = this.pickups.filter((s) => s.taken).length;
    this.kills = profile.run.kills;
    this.runTimeMs = profile.run.timeMs;
    this.activeCheckpoint = profile.run.checkpoint;
    this.finished = false;
    this.hitstop = 0;
    this.hintIndex = 0; this.hint = null;
    this.currentZone = null;

    const spawn = this.spawnPoint();
    this.player = new Player(spawn.x, spawn.y);
    this.spawnEnemies();
    this.particles.clear();
    this.camera.snapTo(this.player);
    this.fit();

    this.running = true;
    this.paused = false;
    this._acc = 0;
    this._last = performance.now();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(this._loop);
    this.emit('start');
  }

  spawnPoint() {
    const cp = this.checkpoints.find((c) => c.id === this.activeCheckpoint);
    return cp ? { x: cp.x, y: cp.y } : { ...this.level.playerStart };
  }

  spawnEnemies() {
    this.enemies = this.level.enemies.map(createEnemy);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.input.clearAll();
    this.save();
    this.emit('pause');
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this._last = performance.now();
    this._acc = 0;
    this.input.clearAll();
    this.emit('resume');
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.audio.stopAmbient();
    this.save();
  }

  /** Persist run state into the profile. */
  save() {
    if (!this.profile) return;
    this.profile.run = {
      ...this.profile.run,
      checkpoint: this.activeCheckpoint,
      shards: this.pickups.filter((s) => s.taken).map((s) => s.id),
      kills: this.kills,
      timeMs: this.runTimeMs,
    };
    this.profile = this.store.save(this.profile);
    this.emit('save', this.profile);
  }

  /** Reset the run but keep identity, settings and best time. */
  newRun() {
    this.profile.run = { ...this.profile.run, checkpoint: 'start', shards: [], kills: 0, deaths: 0, timeMs: 0, completed: false };
    this.profile = this.store.save(this.profile);
  }

  respawn() {
    this.profile.run.deaths++;
    const spawn = this.spawnPoint();
    this.player.reset(spawn.x, spawn.y);
    this.spawnEnemies();
    this.particles.clear();
    this.hitstop = 0;
    this.camera.snapTo(this.player);
    this.renderer.flash('#000000', 1);
    this._deathAnnounced = false;
    this.save();
    this.emit('respawn');
  }

  /* ------------------------------------------------------------ */
  /* Loop                                                          */
  /* ------------------------------------------------------------ */
  _loop(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(now - this._last, 250);
    this._last = now;
    if (!this.paused) {
      this._acc += dt;
      let steps = 0;
      while (this._acc >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
        this.step();
        this._acc -= STEP_MS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this._acc = 0;
    } else {
      // Still poll so a pause press while paused is seen by main.js.
      const input = this.input.poll();
      if (input.pressed.pause) this.emit('pauseToggle');
    }
    this.render();
  }

  step() {
    const input = this.input.poll();
    if (input.pressed.pause) { this.emit('pauseToggle'); return; }
    if (this.finished) return;

    const ctx = { input, level: this.level, fx: this.fx, player: this.player };

    if (this.hitstop > 0) {
      this.hitstop--;
      this.particles.update(true);
      this.camera.update(this.player);
      return;
    }

    if (!this.player.isDead) this.runTimeMs += STEP_MS;

    this.player.update(ctx);
    for (const e of this.enemies) e.update(ctx);
    resolveCombat(ctx, this.player, this.enemies);

    // Cull the dead, count kills.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.remove) { this.enemies.splice(i, 1); this.kills++; }
    }

    this.worldEvents(ctx);
    this.ambient();
    this.particles.update(false);
    this.camera.update(this.player);

    // Death → respawn after the animation.
    if (this.player.isDead) {
      if (!this._deathAnnounced) { this._deathAnnounced = true; this.emit('death'); }
      if (this.player.stateFrame >= P.DEATH_FRAMES) this.respawn();
    }

    if (this.banner && this.banner.frames > 0) this.banner.frames--;
    if (this.hint && --this.hint.frames <= 0) this.hint = null;
    this.liveRegion();
  }

  /** Checkpoints, shards, the gate, zone banners, hints. */
  worldEvents(ctx) {
    const p = this.player;
    if (p.isDead) return;
    const pb = p.box;

    for (const c of this.checkpoints) {
      if (c.id === this.activeCheckpoint) continue;
      if (aabb(pb, { x: c.x - 12, y: c.y - 32, w: 24, h: 32 })) {
        this.activeCheckpoint = c.id;
        p.hp = p.maxHp;
        this.fx.sfx('checkpoint');
        this.fx.burst('spark', c.x, c.y - 18, 0);
        this.fx.text('SHRINE LIT', c.x, c.y - 40, '#ffe08a');
        this.save();
        this.emit('checkpoint', c.id);
      }
    }
    for (const s of this.pickups) {
      if (s.taken) continue;
      if (aabb(pb, { x: s.x - 6, y: s.y - 6, w: 12, h: 12 })) {
        s.taken = true; this.shardCount++;
        this.fx.sfx('shard'); this.fx.burst('shard', s.x, s.y, 0);
        this.fx.text('+1', s.x, s.y - 10, '#9fe8ff');
        this.save();
      }
    }
    if (this.level.goal && aabb(pb, this.level.goal)) this.victory();

    // Zone banner
    const zone = this.level.zoneAtPixel(p.cx);
    if (zone.id !== this.currentZone) {
      this.currentZone = zone.id;
      this.banner = { text: zone.name.toUpperCase(), frames: 150, total: 150 };
      this.audio.setZone(zone.id);
      this.emit('zone', zone);
    }
    // Tutorial hints
    if (this.hintIndex < HINTS.length && p.cx >= HINTS[this.hintIndex].x) {
      this.hint = { text: HINTS[this.hintIndex].text, frames: 260 };
      this.hintIndex++;
    }
  }

  victory() {
    this.finished = true;
    this.input.clearAll();
    this.fx.sfx('victory');
    this.fx.shake({ amp: 3, frames: 20 });
    this.renderer.flash('#ffe08a', 0.8);
    const r = this.profile.run;
    r.completed = true;
    if (!r.bestTimeMs || this.runTimeMs < r.bestTimeMs) r.bestTimeMs = this.runTimeMs;
    this.save();
    this.emit('victory', {
      time: formatTime(this.runTimeMs),
      best: formatTime(r.bestTimeMs),
      shards: `${this.shardCount}/${this.pickups.length}`,
      kills: this.kills,
      deaths: r.deaths,
    });
  }

  /** Zone-flavoured ambient particles inside the view. */
  ambient() {
    const z = this.currentZone;
    if (!z || this.renderer.time % 6 !== 0) return;
    const x = this.camera.x + Math.random() * this.viewW;
    if (z === 'market') this.particles.burst('mote', x, this.camera.y + Math.random() * VIEW_H, 0);
    else if (z === 'chapel') this.particles.burst('petal', x, this.camera.y - 4, 0);
    else if (z === 'keep') this.particles.burst('ember', x, this.camera.y + VIEW_H + 2, 0);
  }

  /** Throttled aria-live mirror of the HUD. */
  liveRegion() {
    if (++this._liveTick % 45 !== 0) return;
    const p = this.player;
    const msg = `Health ${p.hp} of ${p.maxHp}. Shards ${this.shardCount} of ${this.pickups.length}. ${ZONES.find((z) => z.id === this.currentZone)?.name || ''}`;
    if (msg !== this._lastLive) { this._lastLive = msg; this.emit('live', msg); }
  }

  render() {
    this.renderer.render(this);
    const g = this.ctx2d;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.renderer.buf, 0, 0, this.canvas.width, this.canvas.height);
  }
}

export { TILE };
