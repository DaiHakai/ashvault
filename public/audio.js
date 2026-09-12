/* Sound.
 *
 * Two layers, deliberately different in kind:
 *
 *   MUSIC — real CC0 tracks in public/audio/, looped and crossfaded per zone.
 *           These are public domain (OpenGameArt), so no attribution is owed.
 *           The first version synthesised drones instead and it sounded like a
 *           buzz, because stacked low sines over a noise bed is exactly that.
 *
 *   CUES  — still synthesised, because they are short, dry and need to fire the
 *           instant a roll resolves. Struck metal, stone, wet rope, breath.
 *
 * window.Sound.play(name)      one-shot cue
 * window.Sound.ambience(zone)  crossfade the music ('none' to stop)
 * window.Sound.setMuted(bool)  / window.Sound.isMuted()
 */

(() => {
  'use strict';

  let ctx = null;
  let master = null;
  let currentZone = null;
  // Music is opt-in. A text RPG should never start speaking over a player,
  // especially on a phone; the ♪ button turns it on when wanted.
  let muted = true;

  try {
    muted = localStorage.getItem('ashvault.muted') !== '0';
  } catch { /* private window, or storage blocked — default to unmuted */ }

  /** The context can only start inside a user gesture, so this is called lazily. */
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    return ctx;
  }

  // ----------------------------------------------------------- raw material

  /** A buffer of white noise, reused by everything that needs grit. */
  let noiseBuffer = null;
  function noise() {
    if (noiseBuffer) return noiseBuffer;
    const len = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function noiseSource(loop = false) {
    const src = ctx.createBufferSource();
    src.buffer = noise();
    src.loop = loop;
    return src;
  }

  /** An enveloped oscillator. The workhorse for everything struck or rung. */
  function tone({ freq, type = 'sine', at = 0, dur = 0.2, gain = 0.2, sweepTo = null, dest = null }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest || master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    return osc;
  }

  /** A filtered burst of noise. Everything scraped, struck or bursting. */
  function hit({ at = 0, dur = 0.18, gain = 0.25, freq = 900, q = 1, type = 'bandpass', sweepTo = null }) {
    const t = ctx.currentTime + at;
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    filter.Q.value = q;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------------- cues

  const CUES = {
    /** A die landing on stone: two or three irregular ticks, then nothing. */
    dice() {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const at = i * (0.045 + Math.random() * 0.05);
        hit({ at, dur: 0.05, gain: 0.16 - i * 0.03, freq: 1800 + Math.random() * 1400, q: 2.5 });
      }
    },
    /** The die settling — one soft low knock. */
    settle() {
      hit({ dur: 0.09, gain: 0.2, freq: 420, q: 1.6 });
      tone({ freq: 150, type: 'sine', dur: 0.1, gain: 0.1, sweepTo: 90 });
    },
    hit() {
      hit({ dur: 0.14, gain: 0.3, freq: 1100, q: 0.8, sweepTo: 260 });
      tone({ freq: 170, type: 'triangle', dur: 0.12, gain: 0.18, sweepTo: 70 });
    },
    crit() {
      hit({ dur: 0.26, gain: 0.36, freq: 2600, q: 0.6, sweepTo: 300 });
      tone({ freq: 320, type: 'square', dur: 0.09, gain: 0.1, sweepTo: 160 });
      tone({ freq: 120, type: 'triangle', dur: 0.3, gain: 0.22, sweepTo: 55, at: 0.02 });
    },
    miss() {
      hit({ dur: 0.13, gain: 0.14, freq: 3000, q: 0.5, sweepTo: 1400, type: 'highpass' });
    },
    /** Taking damage: a wet, low thud with no metal in it. */
    hurt() {
      tone({ freq: 200, type: 'sine', dur: 0.16, gain: 0.28, sweepTo: 62 });
      hit({ dur: 0.1, gain: 0.16, freq: 320, q: 1.2 });
    },
    heal() {
      tone({ freq: 400, type: 'sine', dur: 0.5, gain: 0.11, sweepTo: 700 });
      tone({ freq: 600, type: 'sine', dur: 0.45, gain: 0.07, sweepTo: 900, at: 0.05 });
    },
    /** An enemy destroyed: a short collapse. */
    kill() {
      hit({ dur: 0.4, gain: 0.26, freq: 700, q: 0.4, sweepTo: 90 });
      tone({ freq: 90, type: 'triangle', dur: 0.4, gain: 0.16, sweepTo: 42 });
    },
    /** The Grave-Bell. The only pitched sound in the game, and it is not pleasant. */
    bell() {
      [523.25, 784, 1046.5, 1318].forEach((f, i) => {
        tone({ freq: f * 0.997, type: 'sine', dur: 2.4 - i * 0.4, gain: 0.09 / (i + 1), at: i * 0.004 });
        tone({ freq: f * 1.004, type: 'sine', dur: 2.2 - i * 0.4, gain: 0.07 / (i + 1), at: i * 0.004 });
      });
    },
    levelUp() {
      [196, 294, 392].forEach((f, i) =>
        tone({ freq: f, type: 'triangle', dur: 0.7, gain: 0.12, at: i * 0.09 }));
    },
    /** Death. Everything drops away and one low note is left. */
    death() {
      tone({ freq: 140, type: 'sine', dur: 2.2, gain: 0.3, sweepTo: 38 });
      hit({ dur: 1.4, gain: 0.2, freq: 500, q: 0.3, sweepTo: 60 });
    },
    victory() {
      [261.6, 392, 523.25].forEach((f, i) =>
        tone({ freq: f, type: 'sine', dur: 1.6, gain: 0.1, at: i * 0.13 }));
    },
    /** Typing / submitting a command. Kept very quiet — it fires constantly. */
    tick() {
      hit({ dur: 0.03, gain: 0.07, freq: 2400, q: 3 });
    },
    door() {
      hit({ dur: 0.9, gain: 0.24, freq: 260, q: 0.7, sweepTo: 70 });
    },
    portal() {
      tone({ freq: 80, type: 'sine', dur: 2.6, gain: 0.22, sweepTo: 420 });
      tone({ freq: 120, type: 'triangle', dur: 2.4, gain: 0.12, sweepTo: 640, at: 0.1 });
    },
  };

  // -------------------------------------------------------------- ambience
  //
  // Real music, not synthesis. The score is melodic dark fantasy: spacious
  // bells and pads for exploration, a quiet mourning theme for respite, and a
  // proper composed encounter piece for bosses. All tracks are CC0/public
  // domain and crossfade as rooms change.

  const TRACKS = {
    prologue: 'audio/somnium.mp3',
    descent:  'audio/cathedral_in_the_forest.ogg',
    camp:     'audio/somnium.mp3',
    warrens:  'audio/cathedral_in_the_forest.ogg',
    crypt:    'audio/bleeding_out2_2.ogg',
    boss:     'audio/boss_fight_lisboa.mp3',
    hub:      'audio/somnium.mp3',
  };

  const VOLUME = 0.27;
  const FADE_MS = 1400;

  let playing = null;   // { el, zone }
  const cache = new Map();

  function trackFor(zone) {
    const src = TRACKS[zone];
    if (!src) return null;
    if (cache.has(src)) return cache.get(src);
    const el = new Audio(src);
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
    cache.set(src, el);
    return el;
  }

  /**
   * Linear fade on the element's own volume.
   *
   * Uses a timer, not requestAnimationFrame: rAF is paused entirely while the
   * tab is hidden, so a fade started just before the player switched away would
   * never finish and the track would sit silently at volume 0 forever. Timers
   * are throttled when hidden but they still fire, and the ramp is computed from
   * the clock rather than from tick count, so a throttled fade is coarse rather
   * than wrong.
   */
  function fade(el, to, ms, done) {
    const from = el.volume;
    const start = Date.now();
    if (el._fade) clearInterval(el._fade);
    const apply = () => {
      const t = Math.min(1, (Date.now() - start) / ms);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
      if (t >= 1) {
        clearInterval(el._fade);
        el._fade = null;
        if (done) done();
      }
    };
    el._fade = setInterval(apply, 40);
    apply();
  }

  function stopAmbience() {
    if (!playing) return;
    const el = playing.el;
    playing = null;
    fade(el, 0, FADE_MS, () => { try { el.pause(); el.currentTime = 0; } catch { /* ignore */ } });
  }

  function startAmbience(zone) {
    const el = trackFor(zone);
    if (!el) return;
    playing = { el, zone };
    el.volume = 0;
    const go = el.play();
    if (go && go.catch) go.catch(() => { /* blocked until a gesture; retried on the next room */ });
    fade(el, muted ? 0 : VOLUME, FADE_MS);
  }

  // ----------------------------------------------------------------- public

  function play(name) {
    if (muted) return;
    if (!ensure()) return;
    const cue = CUES[name];
    if (!cue) return;
    try { cue(); } catch { /* a cue must never break the game */ }
  }

  function ambience(zone) {
    if (zone === currentZone) return;
    currentZone = zone;
    stopAmbience();
    if (muted) return;
    if (zone && zone !== 'none') {
      // Let the outgoing track get out of the way before the next one opens.
      setTimeout(() => { if (currentZone === zone) startAmbience(zone); }, 300);
    }
  }

  function setMuted(next) {
    muted = Boolean(next);
    try { localStorage.setItem('ashvault.muted', muted ? '1' : '0'); } catch { /* ignore */ }
    if (ctx) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(muted ? 0.0001 : 0.9, t + 0.25);
    }
    if (muted) stopAmbience();
    else if (currentZone && currentZone !== 'none' && !playing) startAmbience(currentZone);
  }

  /** Map a room's zone id onto an ambience bed. */
  function zoneFor(room) {
    if (!room) return 'none';
    if (room.boss) return 'boss';
    if (room.id === 'first_camp') return 'camp';
    if (room.zone === 'prologue') return 'prologue';
    if (room.zone === 'descent') return 'descent';
    if (room.zone === 'hub') return 'hub';
    if (room.zone === 'crypt') return 'crypt';
    return 'warrens';
  }

  window.Sound = { play, ambience, setMuted, isMuted: () => muted, zoneFor };
})();
