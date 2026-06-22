/* ==========================================================================
   audio.js — Procedural Web Audio sound engine (no audio files).
   Every sound is synthesized live so the game is a single, asset-free page.
   Exposed globally as window.BS.Audio
   --------------------------------------------------------------------------
   API:
     Audio.resume()                 lazily create + resume the context (on gesture)
     Audio.setEnabled(bool)         master mute
     Audio.setMusic(bool)           ambient bed on/off
     Audio.setVolume(0..1)
     Audio.setTheme(key)            'abyss' | 'holo' | 'warroom' | 'origami'
     Audio.play(event, opts)        one-shot sfx
     Audio.startAmbient() / stopAmbient()
   ========================================================================== */
(function (root) {
  'use strict';

  var ctx = null;
  var master = null;        // master gain → destination
  var sfxBus = null;        // sfx gain → master
  var musicBus = null;      // ambient gain → master
  var noiseBuffer = null;   // cached white-noise buffer
  var enabled = true;
  var musicOn = true;
  var volume = 0.8;
  var theme = 'abyss';
  var ambientNodes = [];    // live ambient sources to tear down
  var ambientTimer = null;

  // ----- theme sound profiles -------------------------------------------------
  // Each profile shapes the *character* of shared synth recipes.
  var PROFILES = {
    abyss: {
      hoverFreq: 520, clickFreq: 320, clickWave: 'sine',
      pingFreq: 760, pingEcho: true, pingWave: 'sine',
      fireWave: 'sine', missTone: 300,
      sinkBase: 150, victoryScale: [294, 392, 440, 587, 784], minor: false,
      ambient: 'abyss'
    },
    holo: {
      hoverFreq: 880, clickFreq: 660, clickWave: 'triangle',
      pingFreq: 1180, pingEcho: false, pingWave: 'triangle',
      fireWave: 'sawtooth', missTone: 520,
      sinkBase: 180, victoryScale: [523, 659, 784, 1047, 1319], minor: false,
      ambient: 'holo'
    },
    warroom: {
      hoverFreq: 440, clickFreq: 240, clickWave: 'square',
      pingFreq: 680, pingEcho: true, pingWave: 'square',
      fireWave: 'square', missTone: 380,
      sinkBase: 110, victoryScale: [330, 415, 494, 659, 880], minor: false,
      ambient: 'warroom'
    },
    origami: {
      hoverFreq: 990, clickFreq: 740, clickWave: 'triangle',
      pingFreq: 1320, pingEcho: false, pingWave: 'sine',
      fireWave: 'triangle', missTone: 600,
      sinkBase: 220, victoryScale: [523, 587, 659, 880, 1047], minor: false,
      ambient: 'origami'
    }
  };

  function profile() { return PROFILES[theme] || PROFILES.abyss; }

  // ----- lifecycle ------------------------------------------------------------
  function ensure() {
    if (ctx) return true;
    try {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? volume : 0;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 1.0; sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.gain.value = 0.0; musicBus.connect(master);
      noiseBuffer = makeNoise(2);
      return true;
    } catch (e) { return false; }
  }

  function tryResume() {
    if (ctx && ctx.state === 'suspended') {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});   // ignore autoplay-policy rejections
    }
  }

  function resume() {
    if (!ensure()) return;
    tryResume();
  }

  function makeNoise(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ----- primitives -----------------------------------------------------------
  function now() { return ctx.currentTime; }

  // A pitched oscillator with an ADSR-ish gain envelope, routed to sfx bus.
  function tone(opts) {
    opts = opts || {};
    var t = (opts.at || now());
    var osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    var f0 = opts.freq || 440;
    osc.frequency.setValueAtTime(f0, t);
    if (opts.glideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.glideTo), t + (opts.dur || 0.3));
    }
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);

    var g = ctx.createGain();
    var peak = opts.gain == null ? 0.5 : opts.gain;
    var atk = opts.attack == null ? 0.005 : opts.attack;
    var dur = opts.dur || 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    var dest = opts.dest || sfxBus;
    if (opts.filter) {
      var bq = ctx.createBiquadFilter();
      bq.type = opts.filter.type || 'lowpass';
      bq.frequency.value = opts.filter.freq || 1000;
      if (opts.filter.q != null) bq.Q.value = opts.filter.q;
      osc.connect(g); g.connect(bq); bq.connect(dest);
    } else {
      osc.connect(g); g.connect(dest);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
    // free the graph when the source finishes — else silent nodes pile up on
    // the bus over a session and steadily raise CPU per audio frame.
    osc.onended = function () { try { osc.disconnect(); g.disconnect(); if (bq) bq.disconnect(); } catch (e) {} };
    return { osc: osc, gain: g, end: t + dur };
  }

  // A filtered noise burst (for splashes, explosions, paper, static).
  function noise(opts) {
    opts = opts || {};
    var t = (opts.at || now());
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    var bq = ctx.createBiquadFilter();
    bq.type = opts.filterType || 'lowpass';
    bq.frequency.setValueAtTime(opts.freq || 1200, t);
    if (opts.freqTo) bq.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqTo), t + (opts.dur || 0.3));
    if (opts.q != null) bq.Q.value = opts.q;

    var g = ctx.createGain();
    var peak = opts.gain == null ? 0.4 : opts.gain;
    var atk = opts.attack == null ? 0.004 : opts.attack;
    var dur = opts.dur || 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bq); bq.connect(g); g.connect(opts.dest || sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = function () { try { src.disconnect(); bq.disconnect(); g.disconnect(); } catch (e) {} };
    return { src: src, gain: g, end: t + dur };
  }

  // Feedback delay send (sonar echo). Returns a node to connect into.
  // Auto-tears-down once the echo tail has decayed so per-event graphs don't
  // accumulate over a long session.
  function echoSend(time, feedback, mix) {
    time = time || 0.28; feedback = feedback == null ? 0.45 : feedback;
    var input = ctx.createGain();
    var d = ctx.createDelay(1.5);
    d.delayTime.value = time;
    var fb = ctx.createGain(); fb.gain.value = feedback;
    var wet = ctx.createGain(); wet.gain.value = mix == null ? 0.5 : mix;
    input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(sfxBus);
    // time for the feedback loop to decay below ~ -60dB, capped
    var taps = feedback > 0.01 ? Math.log(0.001) / Math.log(feedback) : 1;
    var ttl = Math.min(8, time * (taps + 2)) * 1000 + 600;
    setTimeout(function () {
      try { input.disconnect(); d.disconnect(); fb.disconnect(); wet.disconnect(); } catch (e) {}
    }, ttl);
    return input;
  }

  // ----- event sounds ---------------------------------------------------------
  var EVENTS = {
    hover: function () {
      var p = profile();
      tone({ freq: p.hoverFreq, type: 'sine', dur: 0.06, gain: 0.06, attack: 0.002 });
    },

    click: function () {
      var p = profile();
      tone({ freq: p.clickFreq, type: p.clickWave, dur: 0.09, gain: 0.16, attack: 0.002,
             filter: { type: 'lowpass', freq: 2200 } });
      if (theme === 'warroom') noise({ freq: 2600, filterType: 'bandpass', q: 6, dur: 0.05, gain: 0.12 });
    },

    rotate: function () {
      tone({ freq: 300, glideTo: 520, type: 'triangle', dur: 0.14, gain: 0.14 });
    },

    place: function () {
      // satisfying low "thunk" + a short body
      tone({ freq: 180, glideTo: 90, type: 'sine', dur: 0.18, gain: 0.4 });
      noise({ freq: 900, freqTo: 200, filterType: 'lowpass', dur: 0.12, gain: 0.22 });
      if (theme === 'origami') tone({ freq: 1400, type: 'triangle', dur: 0.05, gain: 0.1, attack: 0.001 });
    },

    invalid: function () {
      tone({ freq: 160, type: 'square', dur: 0.16, gain: 0.18, filter: { type: 'lowpass', freq: 800 } });
      tone({ freq: 150, type: 'square', dur: 0.16, gain: 0.16, at: now() + 0.09 });
    },

    random: function () {
      // quick scatter of blips
      for (var i = 0; i < 5; i++) {
        tone({ freq: 400 + Math.random() * 700, type: 'sine', dur: 0.05, gain: 0.08,
               at: now() + i * 0.04 });
      }
    },

    fire: function () {
      var p = profile();
      // rising launch sweep + airy whoosh
      tone({ freq: 220, glideTo: 760, type: p.fireWave, dur: 0.22, gain: 0.28,
             filter: { type: 'lowpass', freq: 2400 } });
      noise({ freq: 400, freqTo: 3000, filterType: 'highpass', dur: 0.22, gain: 0.18, attack: 0.03 });
    },

    miss: function () {
      var p = profile();
      if (theme === 'origami') {
        // soft "blot" — low pop + damped tone
        tone({ freq: 240, glideTo: 120, type: 'sine', dur: 0.16, gain: 0.22 });
        noise({ freq: 600, freqTo: 200, dur: 0.18, gain: 0.12 });
        return;
      }
      // water splash: descending filtered noise + low plop
      var dest = (theme === 'abyss') ? echoSend(0.22, 0.3, 0.3) : sfxBus;
      noise({ freq: 1800, freqTo: 300, filterType: 'lowpass', dur: 0.32, gain: 0.3, dest: dest });
      tone({ freq: p.missTone, glideTo: p.missTone * 0.5, type: 'sine', dur: 0.2, gain: 0.18 });
    },

    hit: function () {
      // EXPLOSION: noise blast + sub thump + crack
      var dest = (theme === 'abyss' || theme === 'holo') ? echoSend(0.18, 0.25, 0.22) : sfxBus;
      noise({ freq: 2000, freqTo: 120, filterType: 'lowpass', dur: 0.45, gain: 0.55, dest: dest });
      tone({ freq: 120, glideTo: 40, type: 'sine', dur: 0.4, gain: 0.6 });           // sub thump
      tone({ freq: 320, glideTo: 90, type: 'square', dur: 0.18, gain: 0.22,
             filter: { type: 'lowpass', freq: 1400 } });                             // body crack
      if (theme === 'holo') tone({ freq: 1600, type: 'triangle', dur: 0.12, gain: 0.18 }); // crystalline
      if (theme === 'warroom') noise({ freq: 3000, filterType: 'highpass', dur: 0.08, gain: 0.16 }); // sparks
    },

    sunk: function () {
      var p = profile();
      // big descending groan + sub rumble + tail
      var dest = echoSend(0.3, 0.4, 0.35);
      tone({ freq: p.sinkBase * 2.2, glideTo: p.sinkBase * 0.6, type: 'sawtooth', dur: 0.9, gain: 0.35,
             filter: { type: 'lowpass', freq: 1200 }, dest: dest });
      tone({ freq: p.sinkBase, glideTo: p.sinkBase * 0.4, type: 'sine', dur: 1.1, gain: 0.5 });
      noise({ freq: 600, freqTo: 80, filterType: 'lowpass', dur: 1.0, gain: 0.3, dest: dest });
      // metallic creak
      tone({ freq: 90, type: 'square', dur: 0.5, gain: 0.12, at: now() + 0.15,
             filter: { type: 'lowpass', freq: 400 } });
    },

    yourturn: function () {
      var p = profile();
      tone({ freq: p.hoverFreq, type: 'sine', dur: 0.12, gain: 0.2 });
      tone({ freq: p.hoverFreq * 1.5, type: 'sine', dur: 0.18, gain: 0.18, at: now() + 0.1 });
    },

    enemyturn: function () {
      tone({ freq: 200, glideTo: 150, type: 'sine', dur: 0.3, gain: 0.16,
             filter: { type: 'lowpass', freq: 900 } });
    },

    ping: function () {
      var p = profile();
      var dest = p.pingEcho ? echoSend(0.32, 0.5, 0.45) : sfxBus;
      tone({ freq: p.pingFreq, type: p.pingWave, dur: 0.6, gain: 0.18, attack: 0.003, dest: dest,
             filter: { type: 'bandpass', freq: p.pingFreq, q: 8 } });
    },

    victory: function () {
      var p = profile();
      var s = p.victoryScale;
      for (var i = 0; i < s.length; i++) {
        tone({ freq: s[i], type: 'triangle', dur: 0.5, gain: 0.26, at: now() + i * 0.12,
               filter: { type: 'lowpass', freq: 4000 } });
        tone({ freq: s[i] * 0.5, type: 'sine', dur: 0.5, gain: 0.12, at: now() + i * 0.12 });
      }
      // shimmer tail
      tone({ freq: s[s.length - 1] * 2, type: 'sine', dur: 1.2, gain: 0.14, at: now() + s.length * 0.12 });
    },

    defeat: function () {
      // descending minor cadence
      var seq = [392, 349, 311, 233];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'sawtooth', dur: 0.7, gain: 0.22, at: now() + i * 0.22,
               filter: { type: 'lowpass', freq: 1600 } });
        tone({ freq: seq[i] * 0.5, type: 'sine', dur: 0.8, gain: 0.18, at: now() + i * 0.22 });
      }
      noise({ freq: 300, freqTo: 60, dur: 1.4, gain: 0.2, at: now() + 0.6 });
    },

    start: function () {
      tone({ freq: 180, glideTo: 360, type: 'sawtooth', dur: 0.4, gain: 0.24,
             filter: { type: 'lowpass', freq: 2000 } });
      tone({ freq: 90, glideTo: 180, type: 'sine', dur: 0.5, gain: 0.3 });
    },

    toggle: function () {
      tone({ freq: 600, type: 'square', dur: 0.05, gain: 0.12 });
    }
  };

  function play(event) {
    if (!enabled) return;
    if (!ensure()) return;
    tryResume();
    var fn = EVENTS[event];
    if (fn) { try { fn(); } catch (e) { /* never let audio break the game */ } }
  }

  // ----- ambient beds ---------------------------------------------------------
  function clearAmbient() {
    if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
    ambientNodes.forEach(function (n) {
      try { if (n.stop) n.stop(); if (n.disconnect) n.disconnect(); } catch (e) {}
    });
    ambientNodes = [];
  }

  function startAmbient() {
    if (!musicOn || !enabled) return;
    if (!ensure()) return;
    tryResume();
    clearAmbient();
    musicBus.gain.cancelScheduledValues(now());
    musicBus.gain.setValueAtTime(0.0001, now());
    musicBus.gain.exponentialRampToValueAtTime(0.5, now() + 2.5);

    var kind = profile().ambient;
    if (kind === 'abyss' || kind === 'warroom') {
      // deep evolving drone
      var base = (kind === 'abyss') ? 55 : 70;
      [1, 1.5, 2.02].forEach(function (mult, i) {
        var o = ctx.createOscillator();
        o.type = (kind === 'warroom') ? 'square' : 'sine';
        o.frequency.value = base * mult;
        var g = ctx.createGain(); g.gain.value = (i === 0 ? 0.14 : 0.05);
        var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = (kind === 'warroom') ? 220 : 400;
        // slow LFO on detune for movement
        var lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.03;
        var lfoG = ctx.createGain(); lfoG.gain.value = 6;
        lfo.connect(lfoG); lfoG.connect(o.detune);
        o.connect(lp); lp.connect(g); g.connect(musicBus);
        o.start(); lfo.start();
        ambientNodes.push(o, lfo);
      });
      // periodic distant ping / blip
      ambientTimer = setInterval(function () {
        if (!musicOn || !enabled || !ctx) return;
        if (Math.random() < 0.6) {
          var p = profile();
          var dest = echoSend(0.4, 0.55, 0.4);
          tone({ freq: p.pingFreq * (0.8 + Math.random() * 0.5), type: p.pingWave,
                 dur: 0.7, gain: 0.06, dest: dest, filter: { type: 'bandpass', freq: p.pingFreq, q: 10 } });
        }
      }, 4200);
    } else if (kind === 'holo') {
      // airy shimmer pad
      [440, 554, 659].forEach(function (f, i) {
        var o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
        var g = ctx.createGain(); g.gain.value = 0.035;
        var lfo = ctx.createOscillator(); lfo.frequency.value = 0.08 + i * 0.05;
        var lfoG = ctx.createGain(); lfoG.gain.value = 0.02;
        lfo.connect(lfoG); lfoG.connect(g.gain);
        o.connect(g); g.connect(musicBus); o.start(); lfo.start();
        ambientNodes.push(o, lfo);
      });
      var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 110;
      var sg = ctx.createGain(); sg.gain.value = 0.06; sub.connect(sg); sg.connect(musicBus); sub.start();
      ambientNodes.push(sub);
    } else { // origami — gentle music-box motif
      ambientTimer = setInterval(function () {
        if (!musicOn || !enabled || !ctx) return;
        var notes = [523, 587, 659, 784, 880];
        var n = notes[Math.floor(Math.random() * notes.length)];
        tone({ freq: n, type: 'triangle', dur: 0.6, gain: 0.05, filter: { type: 'lowpass', freq: 3000 } });
        if (Math.random() < 0.4) tone({ freq: n * 2, type: 'sine', dur: 0.5, gain: 0.03, at: now() + 0.18 });
      }, 1800);
      var pad = ctx.createOscillator(); pad.type = 'sine'; pad.frequency.value = 130;
      var pg = ctx.createGain(); pg.gain.value = 0.05; pad.connect(pg); pg.connect(musicBus); pad.start();
      ambientNodes.push(pad);
    }
  }

  function stopAmbient() {
    if (!ctx) return;
    musicBus.gain.cancelScheduledValues(now());
    musicBus.gain.setValueAtTime(musicBus.gain.value, now());
    musicBus.gain.exponentialRampToValueAtTime(0.0001, now() + 0.8);
    var snapshot = ambientNodes.slice();
    setTimeout(function () {
      snapshot.forEach(function (n) { try { if (n.stop) n.stop(); } catch (e) {} });
    }, 900);
    if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
    ambientNodes = [];
  }

  // ----- public setters -------------------------------------------------------
  function applyMaster() {
    if (!ctx) return;
    master.gain.cancelScheduledValues(now());
    master.gain.setTargetAtTime(enabled ? volume : 0.0001, now(), 0.05);
  }

  root.BS = root.BS || {};
  root.BS.Audio = {
    resume: resume,
    play: play,
    startAmbient: startAmbient,
    stopAmbient: stopAmbient,
    setEnabled: function (v) {
      enabled = !!v; applyMaster();
      if (!enabled) stopAmbient();
      else if (musicOn) startAmbient();
    },
    setMusic: function (v) {
      musicOn = !!v;
      if (musicOn && enabled) startAmbient(); else stopAmbient();
    },
    setVolume: function (v) { volume = Math.max(0, Math.min(1, v)); applyMaster(); },
    setTheme: function (k) {
      if (theme === k) return;
      theme = k;
      // restart ambient with new profile if music is meant to be playing
      if (musicOn && enabled && ctx) { stopAmbient(); setTimeout(startAmbient, 950); }
    },
    isEnabled: function () { return enabled; },
    isMusic: function () { return musicOn; }
  };

})(typeof window !== 'undefined' ? window : this);
