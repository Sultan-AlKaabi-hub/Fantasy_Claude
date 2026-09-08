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
    this.musicOn = true;
    this.music = null;       // { theme, out, gain, step, nextTime, timer }
    this.theme = null;
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

  setMusicEnabled(on) {
    this.musicOn = on;
    if (!on) this.stopMusic();
    else if (this.theme) { const t = this.theme; this.theme = null; this.playTheme(t); }
  }

  /* ------------------------------------------------------------ */
  /* Generative music: a small lookahead scheduler plays a chord   */
  /* progression (pad + bass + arpeggio) so the game ships no     */
  /* audio files. Themes are keyed by screen / zone.               */
  /* ------------------------------------------------------------ */
  playTheme(name) {
    if (!this.ctx || !this.musicOn || name === this.theme) return;
    this.stopMusic();
    this.theme = name;
    const T = THEMES[name] || THEMES.title;
    const c = this.ctx;
    const gain = c.createGain(); gain.gain.value = 0;
    gain.gain.setTargetAtTime(T.volume, c.currentTime, 1.2);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    lp.connect(gain).connect(this.master);
    const m = { theme: T, out: lp, gain, step: 0, nextTime: c.currentTime + 0.1, timer: 0 };
    this.music = m;
    const stepDur = 60 / T.bpm / 2;                 // eighth notes
    const schedule = () => {
      if (this.music !== m) return;
      let guard = 0;
      while (m.nextTime < c.currentTime + 0.3 && guard++ < 64) {   // guard: never spin if the tab was asleep
        this._playStep(m, m.step, m.nextTime, stepDur);
        m.step++;
        m.nextTime += stepDur;
      }
    };
    schedule();
    m.timer = setInterval(schedule, 120);
  }

  stopMusic() {
    const m = this.music;
    if (!m) return;
    clearInterval(m.timer);
    m.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    setTimeout(() => { try { m.out.disconnect(); } catch { /* ignore */ } }, 2500);
    this.music = null;
    this.theme = null;
  }

  _note(freq, time, dur, type, vol, out, attack = 0.01) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(vol, time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g).connect(out);
    o.start(time); o.stop(time + dur + 0.05);
  }

  _playStep(m, step, time, stepDur) {
    const T = m.theme;
    const barLen = 8;                                     // eighths per bar
    const chord = T.chords[Math.floor(step / (barLen * 2)) % T.chords.length];
    const inBar = step % barLen;
    // pad: one sustained voice per chord change
    if (step % (barLen * 2) === 0) {
      for (const semi of chord) this._note(midi(T.root + semi + 12), time, stepDur * barLen * 2, 'triangle', 0.05, m.out, 0.6);
    }
    // bass on beats 1 and 3
    if (inBar === 0 || inBar === 4) this._note(midi(T.root + chord[0]), time, stepDur * 3, 'sine', 0.16, m.out);
    // arpeggio
    const arp = T.pattern[step % T.pattern.length];
    if (arp !== null) {
      const semi = chord[arp % chord.length] + 12 * Math.floor(arp / chord.length);
      this._note(midi(T.root + semi + 24), time, stepDur * 1.6, T.lead, 0.07, m.out);
    }
    // soft percussion tick for the keep
    if (T.tick && inBar % 2 === 0) this._noiseHitAt(time, inBar === 0 ? 0.12 : 0.05, m.out);
  }

  _noiseHitAt(time, gain, out) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this._noise;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = c.createGain(); g.gain.setValueAtTime(gain, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
    src.connect(f).connect(g).connect(out); src.start(time); src.stop(time + 0.15);
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

  /** Per-zone ambient drone plus the zone's music theme. */
  setZone(zoneId) {
    if (!this.ctx || zoneId === this.zone) return;
    this.zone = zoneId;
    this.playTheme(zoneId);
    this.stopAmbient();
    const c = this.ctx;
    const base = zoneId === 'market' ? 110 : zoneId === 'chapel' ? 82.4 : 55;
    const g = c.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(0.04, c.currentTime, 1.5);
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

/** MIDI note number → Hz. */
function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

/**
 * Themes: root is a MIDI note, chords are semitone stacks over the root,
 * pattern indexes chord tones (null = rest) per eighth note.
 */
const THEMES = {
  title:  { root: 45, bpm: 76, volume: 0.55, lead: 'triangle', chords: [[0, 3, 7], [-4, 0, 3], [-2, 2, 5], [-5, -1, 2]], pattern: [0, 2, 1, 2, 3, 2, 1, null, 0, 2, 1, 4, 3, 2, null, 1] },
  market: { root: 48, bpm: 96, volume: 0.5, lead: 'square', chords: [[0, 4, 7], [-3, 0, 4], [-5, -1, 2], [-7, -3, 0]], pattern: [0, null, 1, 2, null, 1, 3, null, 0, 2, null, 1, 4, null, 2, 1] },
  chapel: { root: 43, bpm: 70, volume: 0.5, lead: 'sine', chords: [[0, 3, 7], [-2, 2, 5], [-4, 0, 3], [-5, -2, 2]], pattern: [0, 1, 2, 3, 4, 3, 2, 1, null, 2, 3, null, 1, 2, null, null] },
  keep:   { root: 41, bpm: 88, volume: 0.55, lead: 'sawtooth', tick: true, chords: [[0, 3, 7], [1, 4, 8], [-2, 1, 5], [0, 3, 6]], pattern: [0, null, 0, 2, null, 1, null, 3, 0, null, 0, 2, 4, null, 1, null] },
};
