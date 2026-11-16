// Sound without sound files: every effect is a WebAudio oscillator or a
// burst of filtered noise, shaped by an envelope. The context only exists
// after a user gesture (browsers insist), and far-off gunfire fades with
// distance so the player can tell how close a fight is.
export function createAudio() {
  let ac = null;
  let bus = null;
  let hiss = null;
  let ready = false;

  // Gunfire recipes, one row per weapon kind: noise duration, noise cutoff,
  // noise gain, tone pitch, tone duration, tone gain, tone slide target.
  const SHOTS = {
    sniper: [0.28, 900, 0.9, 90, 0.25, 0.7, 40],
    rifle: [0.14, 1600, 0.7, 140, 0.1, 0.5, 60],
    smg: [0.09, 2200, 0.5, 180, 0.07, 0.35, 80],
    pistol: [0.12, 1400, 0.6, 120, 0.09, 0.45, 55],
  };
  // Little jingles: [pitch, duration, gain, delay] per note.
  const TUNES = {
    reload: [
      [500, 0.06, 0.25, 0],
      [700, 0.06, 0.25, 0.18],
      [420, 0.08, 0.3, 0.4],
    ],
    plant: [
      [600, 0.1, 0.3, 0],
      [900, 0.12, 0.3, 0.12],
    ],
    defuse: [
      [900, 0.1, 0.3, 0],
      [600, 0.14, 0.3, 0.12],
    ],
    buy: [
      [880, 0.07, 0.25, 0],
      [1320, 0.1, 0.25, 0.07],
    ],
    win: [
      [523, 0.14, 0.3, 0],
      [659, 0.14, 0.3, 0.14],
      [784, 0.22, 0.3, 0.28],
    ],
    lose: [
      [392, 0.16, 0.3, 0],
      [311, 0.24, 0.3, 0.16],
    ],
  };

  function wake() {
    if (!ready) return false;
    if (ac) {
      if (ac.state === 'suspended') ac.resume();
      return true;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ac = new Ctor();
    } catch {
      return false;
    }
    bus = ac.createGain();
    bus.gain.value = 0.4;
    bus.connect(ac.destination);
    const samples = ac.sampleRate;
    hiss = ac.createBuffer(1, samples, ac.sampleRate);
    const data = hiss.getChannelData(0);
    for (let i = samples; i-- > 0;) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function burst(dur, cutoff, peak, delay = 0) {
    if (!ac) return;
    const at = ac.currentTime + delay;
    const src = ac.createBufferSource();
    src.buffer = hiss;
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    src.connect(filter).connect(gain).connect(bus);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  function blip(freq, dur, peak, kind = 'sine', slide = null, delay = 0) {
    if (!ac) return;
    const at = ac.currentTime + delay;
    const osc = ac.createOscillator();
    osc.type = kind;
    osc.frequency.setValueAtTime(freq, at);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, at + dur);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(gain).connect(bus);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function playTune(name, kind) {
    for (const [freq, dur, peak, delay] of TUNES[name]) blip(freq, dur, peak, kind, null, delay);
  }

  // Loud up close, a murmur at range: full volume at the muzzle, about
  // a twelfth of it forty metres out.
  function attenuate(distance) {
    if (distance == null) return 1;
    return Math.max(0.06, 1 / (1 + distance * 0.16));
  }

  return {
    unlock() {
      ready = true;
      wake();
    },
    shot(kind, distance) {
      if (!wake()) return;
      const g = attenuate(distance);
      const [nd, nf, ng, tf, td, tg, ts] = SHOTS[kind] || SHOTS.pistol;
      burst(nd, nf, ng * g);
      blip(tf, td, tg * g, 'sine', ts);
    },
    dryFire() {
      if (!wake()) return;
      blip(900, 0.05, 0.2, 'square');
    },
    reload() {
      if (!wake()) return;
      playTune('reload', 'square');
    },
    hit(kill) {
      if (!wake()) return;
      blip(kill ? 1400 : 1000, 0.07, 0.3, 'sine');
      if (kill) blip(1800, 0.12, 0.25, 'sine', null, 0.07);
    },
    hurt() {
      if (!wake()) return;
      blip(160, 0.15, 0.4, 'sawtooth', 70);
    },
    grenadeThrow() {
      if (!wake()) return;
      burst(0.15, 800, 0.25);
    },
    explosion(distance) {
      if (!wake()) return;
      const g = attenuate(distance);
      burst(1.4, 300, 1.0 * g);
      blip(70, 1.1, 0.9 * g, 'sine', 28);
    },
    beep(urgent) {
      if (!wake()) return;
      blip(urgent ? 1500 : 1100, 0.09, 0.35, 'square');
    },
    plant() {
      if (!wake()) return;
      playTune('plant', 'square');
    },
    defuse() {
      if (!wake()) return;
      playTune('defuse', 'square');
    },
    buy() {
      if (!wake()) return;
      playTune('buy', 'sine');
    },
    denied() {
      if (!wake()) return;
      blip(220, 0.14, 0.3, 'square', 160);
    },
    roundWin() {
      if (!wake()) return;
      playTune('win', 'sine');
    },
    roundLose() {
      if (!wake()) return;
      playTune('lose', 'sine');
    },
    click() {
      if (!wake()) return;
      blip(700, 0.05, 0.2, 'sine');
    },
  };
}
