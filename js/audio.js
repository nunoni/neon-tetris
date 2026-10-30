/* ------------------------------------------------------------------ *
 * audio.js — WebAudio synth engine: SFX + procedural Korobeiniki
 * soundtrack with delay/echo, drums, and a beat hook the renderer
 * uses to pulse the scene. No audio files needed.
 * ------------------------------------------------------------------ */
'use strict';

const NOTE = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/* Korobeiniki (traditional) — [midi, beats], 0 = rest */
const MELODY = [
  [76, 1], [71, .5], [72, .5], [74, 1], [72, .5], [71, .5],
  [69, 1], [69, .5], [72, .5], [76, 1], [74, .5], [72, .5],
  [71, 1.5], [72, .5], [74, 1], [76, 1],
  [72, 1], [69, 1], [69, 1.5], [0, .5],

  [74, 1.5], [77, .5], [81, 1], [79, .5], [77, .5],
  [76, 1.5], [72, .5], [76, 1], [74, .5], [72, .5],
  [71, 1], [71, .5], [72, .5], [74, 1], [76, 1],
  [72, 1], [69, 1], [69, 1.5], [0, .5],
];

/* One bass root per 4-beat bar: Am E Am Am | Dm Am E Am */
const BASS_BARS = [45, 40, 45, 45, 38, 45, 40, 45];
const LOOP_BEATS = 32;
const BPM = 150;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicPlaying = false;
    this.onBeat = null;
    this._beatQueue = [];
    this._schedTimer = null;
    this.volume = 0.85;
    try {
      const stored = parseFloat(localStorage.getItem('neon-tetris-3d-vol'));
      if (!isNaN(stored)) this.volume = Math.min(1, Math.max(0, stored));
    } catch (e) { /* ignore */ }
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.8;
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.42;
    this.musicBus.connect(this.master);

    /* echo on the music bus */
    this.delay = this.ctx.createDelay(1.0);
    this.delay.delayTime.value = (60 / BPM) * 0.75;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.28;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.18;
    this.musicBus.connect(this.delay);
    this.delay.connect(feedback);
    feedback.connect(this.delay);
    this.delay.connect(wet);
    wet.connect(this.master);

    /* shared white-noise buffer */
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  applyMasterGain(target) {
    if (!this.ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(this.now);
    this.master.gain.linearRampToValueAtTime(target, this.now + 0.1);
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.muted && this.volume > 0) this.muted = false;
    this.applyMasterGain(this.muted ? 0 : this.volume);
    try { localStorage.setItem('neon-tetris-3d-vol', String(this.volume)); } catch (e) { /* ignore */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyMasterGain(this.muted ? 0 : this.volume);
    return this.muted;
  }

  /* --------------------------- SFX ------------------------------- */

  blip({ freq = 440, dur = 0.05, type = 'square', vol = 0.1, slideTo = null, when = 0, bus = null }) {
    if (!this.ctx) return;
    const t = this.now + when;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(bus || this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise({ dur = 0.1, vol = 0.2, hp = 0, lp = 20000, when = 0, bus = null }) {
    if (!this.ctx) return;
    const t = this.now + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    let node = src;
    if (hp > 0) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = hp;
      node.connect(f); node = f;
    }
    if (lp < 20000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lp;
      node.connect(f); node = f;
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(gain);
    gain.connect(bus || this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  sfx(name, opt = {}) {
    if (!this.ctx) return;
    switch (name) {
      case 'move': this.blip({ freq: 440, dur: 0.025, vol: 0.05 }); break;
      case 'rotate': this.blip({ freq: 330, slideTo: 620, dur: 0.06, vol: 0.09 }); break;
      case 'softstep': this.blip({ freq: 210, dur: 0.02, vol: 0.035, type: 'sine' }); break;
      case 'hold': this.blip({ freq: 520, slideTo: 340, dur: 0.08, vol: 0.09, type: 'sine' }); break;
      case 'harddrop':
        this.noise({ dur: 0.12, vol: 0.28, lp: 500 });
        this.blip({ freq: 180, slideTo: 46, dur: 0.13, vol: 0.32, type: 'sine' });
        break;
      case 'lock':
        this.blip({ freq: 900, dur: 0.02, vol: 0.08 });
        this.noise({ dur: 0.04, vol: 0.08, lp: 900 });
        break;
      case 'clear': {
        const n = Math.min(opt.lines || 1, 4);
        for (let i = 0; i < n + 1; i++) {
          this.blip({ freq: NOTE(69 + i * 4), dur: 0.09, vol: 0.11, type: 'sawtooth', when: i * 0.045 });
        }
        this.noise({ dur: 0.3, vol: 0.1, hp: 3000, when: 0.02 });
        break;
      }
      case 'tetris':
        [69, 72, 76, 81].forEach((m, i) => {
          this.blip({ freq: NOTE(m), dur: 0.22, vol: 0.16, type: 'sawtooth', when: i * 0.07 });
          this.blip({ freq: NOTE(m + 12), dur: 0.22, vol: 0.08, type: 'square', when: i * 0.07 });
        });
        this.blip({ freq: 120, slideTo: 30, dur: 0.4, vol: 0.3, type: 'sine' });
        this.noise({ dur: 0.5, vol: 0.12, hp: 4000, when: 0.05 });
        break;
      case 'tspin':
        this.blip({ freq: 500, slideTo: 950, dur: 0.09, vol: 0.14, type: 'sawtooth' });
        this.blip({ freq: 950, slideTo: 320, dur: 0.1, vol: 0.14, type: 'sawtooth', when: 0.09 });
        break;
      case 'perfect':
        [69, 72, 76, 81, 84, 88, 93].forEach((m, i) => {
          this.blip({ freq: NOTE(m), dur: 0.3, vol: 0.13, type: 'triangle', when: i * 0.05 });
        });
        this.noise({ dur: 0.8, vol: 0.1, hp: 5000 });
        break;
      case 'combo':
        this.blip({ freq: 440 * Math.pow(2, Math.min(opt.combo || 1, 12) / 12), slideTo: 590 * Math.pow(2, Math.min(opt.combo || 1, 12) / 12), dur: 0.07, vol: 0.12 });
        break;
      case 'b2b':
        [69, 73, 76].forEach((m) => this.blip({ freq: NOTE(m), dur: 0.1, vol: 0.07, type: 'sawtooth' }));
        break;
      case 'levelup':
        this.blip({ freq: 220, slideTo: 1320, dur: 0.35, vol: 0.18, type: 'triangle' });
        [88, 93, 100].forEach((m, i) => this.blip({ freq: NOTE(m), dur: 0.12, vol: 0.09, when: 0.3 + i * 0.06 }));
        break;
      case 'gameover':
        [69, 64, 60, 57, 52].forEach((m, i) => {
          this.blip({ freq: NOTE(m), dur: 0.35, vol: 0.14, type: 'sawtooth', when: i * 0.21 });
        });
        this.noise({ dur: 1.6, vol: 0.12, lp: 800, when: 0.2 });
        break;
      case 'count':
        this.blip({ freq: 660, dur: 0.08, vol: 0.12, type: 'square' });
        break;
      case 'go':
        this.blip({ freq: 880, dur: 0.18, vol: 0.16, type: 'square' });
        this.blip({ freq: 1320, dur: 0.3, vol: 0.12, type: 'square', when: 0.02 });
        break;
      case 'select':
        this.blip({ freq: 720, slideTo: 980, dur: 0.07, vol: 0.1 });
        break;
      case 'denied':
        this.blip({ freq: 160, dur: 0.08, vol: 0.1, type: 'square' });
        break;
      default: break;
    }
  }

  /* ------------------------- music -------------------------------- */

  startMusic() {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    this.musicBus.gain.cancelScheduledValues(this.now);
    this.musicBus.gain.setValueAtTime(0.42, this.now);
    this._buildTimeline();
    this._loopStart = this.now + 0.1;
    this._ptr = 0;
    this._nextBeatTime = this._loopStart;
    this._nextBeat = 0;
    this._beatQueue.length = 0;
    if (this._schedTimer) clearInterval(this._schedTimer);
    this._schedTimer = setInterval(() => this._schedule(), 40);
    this._schedule();
  }

  stopMusic() {
    this.musicPlaying = false;
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
    this._beatQueue.length = 0;
  }

  setMusicOn(on) {
    if (!this.ctx) return;
    this.musicBus.gain.cancelScheduledValues(this.now);
    this.musicBus.gain.linearRampToValueAtTime(on ? 0.42 : 0.0, this.now + 0.3);
    if (on && !this.musicPlaying) this.startMusic();
  }

  _buildTimeline() {
    const ev = [];
    let t = 0;
    for (const [midi, dur] of MELODY) {
      if (midi > 0) ev.push({ t, kind: 'lead', midi, dur });
      t += dur;
    }
    for (let bar = 0; bar < BASS_BARS.length; bar++) {
      const root = BASS_BARS[bar];
      for (let e = 0; e < 8; e++) {
        ev.push({ t: bar * 4 + e * 0.5, kind: 'bass', midi: e % 2 === 0 ? root : root + 12, dur: 0.24 });
      }
    }
    for (let b = 0; b < LOOP_BEATS; b++) {
      if (b % 2 === 0) ev.push({ t: b, kind: 'kick' });
      else ev.push({ t: b, kind: 'snare' });
      for (let e = 0; e < 2; e++) ev.push({ t: b + e * 0.5, kind: 'hat' });
    }
    ev.sort((a, b) => a.t - b.t);
    this._timeline = ev;
  }

  _schedule() {
    if (!this.musicPlaying || !this.ctx) return;
    const beatDur = 60 / BPM;
    const lookahead = 0.14;
    while (true) {
      const ev = this._timeline[this._ptr];
      const when = this._loopStart + ev.t * beatDur;
      if (when > this.now + lookahead) break;
      this._playEvent(ev, Math.max(when, this.now + 0.005));
      this._ptr++;
      if (this._ptr >= this._timeline.length) {
        this._ptr = 0;
        this._loopStart += LOOP_BEATS * beatDur;
      }
    }
    /* queue beat markers for the visuals */
    const beatDur2 = 60 / BPM;
    while (this._nextBeatTime < this.now + lookahead + 0.02) {
      if (this._nextBeatTime >= this.now) this._beatQueue.push(this._nextBeatTime);
      this._nextBeat++;
      if (this._nextBeat >= LOOP_BEATS) this._nextBeat = 0;
      this._nextBeatTime += beatDur2;
    }
  }

  update() {
    if (!this.ctx || !this.onBeat) return;
    while (this._beatQueue.length && this._beatQueue[0] <= this.now) {
      this._beatQueue.shift();
      this.onBeat();
    }
    if (this._beatQueue.length > 64) this._beatQueue.length = 0;
  }

  _playEvent(ev, when) {
    const bus = this.musicBus;
    if (ev.kind === 'lead') {
      for (const detune of [-4, 4]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = NOTE(ev.midi);
        osc.detune.value = detune;
        const vib = this.ctx.createOscillator();
        vib.frequency.value = 5.5;
        const vibGain = this.ctx.createGain();
        vibGain.gain.setValueAtTime(0, when);
        vibGain.gain.linearRampToValueAtTime(7, when + 0.12);
        vib.connect(vibGain);
        vibGain.connect(osc.detune);
        vib.start(when); vib.stop(when + ev.dur + 0.1);

        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2400;
        const gain = this.ctx.createGain();
        const dur = ev.dur * (60 / BPM) - 0.03;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(0.085, when + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.05, when + 0.09);
        gain.gain.setValueAtTime(0.05, when + Math.max(0.09, dur - 0.05));
        gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        osc.connect(lp); lp.connect(gain); gain.connect(bus);
        osc.start(when); osc.stop(when + dur + 0.05);
      }
    } else if (ev.kind === 'bass') {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = NOTE(ev.midi);
      const gain = this.ctx.createGain();
      const dur = ev.dur;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.16, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(gain); gain.connect(bus);
      osc.start(when); osc.stop(when + dur + 0.05);
    } else if (ev.kind === 'kick') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, when);
      osc.frequency.exponentialRampToValueAtTime(42, when + 0.1);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.32, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
      osc.connect(gain); gain.connect(bus);
      osc.start(when); osc.stop(when + 0.16);
    } else if (ev.kind === 'snare') {
      this.noise({ dur: 0.09, vol: 0.07, hp: 1800, when: when - this.now, bus });
    } else if (ev.kind === 'hat') {
      this.noise({ dur: 0.03, vol: 0.045, hp: 7000, when: when - this.now, bus });
    }
  }
}

window.AudioEngine = AudioEngine;
