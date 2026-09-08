/**
 * audio.js — procedural WebAudio SFX and a soft ambient bed.
 *
 * No audio files ship with the game, which keeps the precache small and means
 * offline play never depends on a fetch. Every sound is synthesised from
 * oscillators and filtered noise on the fly.
 *
 * Browsers only allow audio after a user gesture, so `unlock()` is called from
 * the first pointer/key event. Until then every play() is a silent no-op.
 */
export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.ambient = null;
    this.zone = null;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    this._noise = this._makeNoise(1.5);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  _makeNoise(seconds) {
    const c = this.ctx, n = (c.sampleRate * seconds) | 0;
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Short filtered noise burst. */
  _noiseHit({ dur = 0.08, from = 1800, to = 300, gain = 0.5, q = 1, type = 'bandpass' }) {
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this._noise;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  /** Simple tone with pitch sweep. */
  _tone({ type = 'square', from = 440, to = 220, dur = 0.1, gain = 0.25, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  play(name) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case 'jump': this._tone({ type: 'square', from: 300, to: 620, dur: 0.09, gain: 0.12 }); break;
      case 'land': this._noiseHit({ dur: 0.06, from: 600, to: 120, gain: 0.25, type: 'lowpass' }); break;
      case 'dash': this._noiseHit({ dur: 0.14, from: 2500, to: 600, gain: 0.35 }); this._tone({ type: 'sine', from: 180, to: 90, dur: 0.12, gain: 0.15 }); break;
      case 'slash': this._noiseHit({ dur: 0.09, from: 3200, to: 900, gain: 0.35, q: 2 }); break;
      case 'slash_heavy': this._noiseHit({ dur: 0.16, from: 2400, to: 400, gain: 0.5, q: 2 }); this._tone({ type: 'sawtooth', from: 160, to: 60, dur: 0.14, gain: 0.12 }); break;
      case 'hit': this._noiseHit({ dur: 0.08, from: 1200, to: 200, gain: 0.45, type: 'lowpass' }); this._tone({ type: 'square', from: 220, to: 110, dur: 0.06, gain: 0.15 }); break;
      case 'hurt': this._tone({ type: 'sawtooth', from: 320, to: 70, dur: 0.22, gain: 0.3 }); this._noiseHit({ dur: 0.12, from: 800, to: 150, gain: 0.4, type: 'lowpass' }); break;
      case 'parry_ready': this._tone({ type: 'triangle', from: 900, to: 1400, dur: 0.05, gain: 0.08 }); break;
      case 'parry': this._tone({ type: 'triangle', from: 1400, to: 2600, dur: 0.16, gain: 0.3 }); this._noiseHit({ dur: 0.1, from: 5000, to: 2000, gain: 0.3, q: 4 }); break;
      case 'execute': this._noiseHit({ dur: 0.25, from: 1500, to: 120, gain: 0.7, type: 'lowpass' }); this._tone({ type: 'sawtooth', from: 120, to: 35, dur: 0.35, gain: 0.3 }); break;
      case 'pogo': this._tone({ type: 'square', from: 500, to: 900, dur: 0.07, gain: 0.12 }); break;
      case 'deny': this._tone({ type: 'square', from: 200, to: 150, dur: 0.05, gain: 0.06 }); break;
      case 'death': this._tone({ type: 'sawtooth', from: 220, to: 30, dur: 0.9, gain: 0.35 }); this._noiseHit({ dur: 0.5, from: 900, to: 60, gain: 0.5, type: 'lowpass' }); break;
      case 'enemy_die': this._noiseHit({ dur: 0.2, from: 1000, to: 100, gain: 0.45, type: 'lowpass' }); this._tone({ type: 'square', from: 180, to: 50, dur: 0.2, gain: 0.12 }); break;
      case 'telegraph': this._tone({ type: 'square', from: 700, to: 1000, dur: 0.06, gain: 0.14 }); break;
      case 'zealot_charge': this._tone({ type: 'sawtooth', from: 90, to: 260, dur: 0.6, gain: 0.16 }); break;
      case 'husk_growl': this._tone({ type: 'sawtooth', from: 120, to: 70, dur: 0.25, gain: 0.1 }); break;
      case 'shard': this._tone({ type: 'sine', from: 880, to: 1320, dur: 0.12, gain: 0.18 }); this._tone({ type: 'sine', from: 1320, to: 1760, dur: 0.16, gain: 0.14, delay: 0.08 }); break;
      case 'checkpoint': this._tone({ type: 'triangle', from: 440, to: 660, dur: 0.2, gain: 0.2 }); this._tone({ type: 'triangle', from: 660, to: 990, dur: 0.3, gain: 0.16, delay: 0.15 }); break;
      case 'victory': [523, 659, 784, 1046].forEach((f, i) => this._tone({ type: 'triangle', from: f, to: f, dur: 0.3, gain: 0.2, delay: i * 0.14 })); break;
      case 'ui': this._tone({ type: 'square', from: 600, to: 800, dur: 0.04, gain: 0.08 }); break;
      default: break;
    }
  }

  /** Per-zone ambient drone: two detuned oscillators through a low-pass. */
  setZone(zoneId) {
    if (!this.ctx || zoneId === this.zone) return;
    this.zone = zoneId;
    this.stopAmbient();
    const c = this.ctx;
    const base = zoneId === 'market' ? 110 : zoneId === 'chapel' ? 82.4 : 55;
    const g = c.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(0.08, c.currentTime, 1.5);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = zoneId === 'keep' ? 240 : 420;
    const oscs = [0, 3, -5].map((det) => {
      const o = c.createOscillator();
      o.type = zoneId === 'market' ? 'triangle' : 'sawtooth';
      o.frequency.value = base; o.detune.value = det;
      o.connect(lp); o.start();
      return o;
    });
    lp.connect(g).connect(this.master);
    this.ambient = { g, oscs };
  }

  stopAmbient() {
    if (!this.ambient) return;
    const { g, oscs } = this.ambient;
    const t = this.ctx.currentTime;
    g.gain.setTargetAtTime(0, t, 0.5);
    oscs.forEach((o) => o.stop(t + 2));
    this.ambient = null;
  }
}
