/* ==========================================================================
   audio.js — Procedural Web Audio sound engine (no audio files).
   Every sound is synthesized live so the game is a single, asset-free page.
   Exposed globally as window.MONO.Audio
   --------------------------------------------------------------------------
   TYCOON palette: heavenly, premium, satisfying — soft sine/triangle bells,
   major-scale arpeggios, gentle reverb/delay shimmer. Wealth, chimes, coins.
   --------------------------------------------------------------------------
   API:
     Audio.resume()                 lazily create + resume the context (on gesture)
     Audio.setEnabled(bool)         master mute
     Audio.setMusic(bool)           ambient bed on/off
     Audio.setVolume(0..1)
     Audio.play(event)              one-shot sfx
     Audio.startAmbient() / stopAmbient()
     Audio.isEnabled() / isMusic()
   ========================================================================== */
(function (root) {
  'use strict';

  var ctx = null;
  var master = null;        // master gain → destination
  var sfxBus = null;        // sfx gain → master
  var musicBus = null;      // ambient gain → master
  var noiseBuffer = null;   // cached white-noise buffer
  var enabled = true;
  var musicOn = false;   // ambient bed is opt-in (toggle on the home screen)
  var volume = 0.8;
  var ambientNodes = [];    // live ambient sources to tear down
  var ambientTimer = null;

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

  // A filtered noise burst (for shakes, whooshes, soft knocks, shimmer air).
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

  // Feedback delay send (heavenly shimmer tail). Returns a node to connect into.
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
  // Shared major-scale touchstones (C major family) keep the palette cohesive.
  // C5 523, D5 587, E5 659, G5 784, A5 880, C6 1047, E6 1319, G6 1568
  var EVENTS = {
    // dice shake + roll: a couple of quick noise/tone ticks then a soft settle
    dice: function () {
      noise({ freq: 2600, freqTo: 1400, filterType: 'bandpass', q: 4, dur: 0.06, gain: 0.12 });
      noise({ freq: 2200, freqTo: 1200, filterType: 'bandpass', q: 4, dur: 0.06, gain: 0.11, at: now() + 0.08 });
      noise({ freq: 1800, freqTo: 900, filterType: 'bandpass', q: 4, dur: 0.06, gain: 0.10, at: now() + 0.16 });
      tone({ freq: 523, type: 'triangle', dur: 0.14, gain: 0.16, at: now() + 0.26,
             filter: { type: 'lowpass', freq: 3000 } });
      tone({ freq: 784, type: 'sine', dur: 0.2, gain: 0.12, at: now() + 0.3 });
    },

    // single token hop blip — short and light, called per tile
    step: function () {
      tone({ freq: 880, type: 'sine', dur: 0.06, gain: 0.09, attack: 0.002,
             filter: { type: 'lowpass', freq: 4000 } });
    },

    // soft arrival chime when the token stops
    land: function () {
      var dest = echoSend(0.22, 0.3, 0.25);
      tone({ freq: 659, type: 'sine', dur: 0.28, gain: 0.16, attack: 0.004, dest: dest });
      tone({ freq: 988, type: 'triangle', dur: 0.3, gain: 0.1, at: now() + 0.05, dest: dest });
    },

    // bright pleasant purchase chime (property bought)
    buy: function () {
      var dest = echoSend(0.2, 0.32, 0.3);
      var seq = [659, 880, 1319];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'triangle', dur: 0.3, gain: 0.18, at: now() + i * 0.07, dest: dest,
               filter: { type: 'lowpass', freq: 5000 } });
      }
      tone({ freq: 330, type: 'sine', dur: 0.25, gain: 0.1 });   // warm root underneath
    },

    // paying rent: a soft descending two-note
    rent: function () {
      tone({ freq: 784, type: 'sine', dur: 0.22, gain: 0.16 });
      tone({ freq: 587, type: 'sine', dur: 0.28, gain: 0.15, at: now() + 0.13,
             filter: { type: 'lowpass', freq: 3000 } });
    },

    // receiving money: bright ascending major arpeggio "cha-ching"
    cashin: function () {
      var dest = echoSend(0.18, 0.34, 0.3);
      var seq = [523, 659, 784, 1047];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'triangle', dur: 0.26, gain: 0.18, at: now() + i * 0.06, dest: dest,
               filter: { type: 'lowpass', freq: 6000 } });
      }
      // sparkly coin shimmer on top
      tone({ freq: 1568, type: 'sine', dur: 0.4, gain: 0.1, at: now() + 0.24, dest: dest });
      tone({ freq: 2093, type: 'sine', dur: 0.45, gain: 0.07, at: now() + 0.3, dest: dest });
    },

    // losing money: lower, shorter
    cashout: function () {
      tone({ freq: 523, type: 'triangle', dur: 0.16, gain: 0.15 });
      tone({ freq: 392, type: 'sine', dur: 0.22, gain: 0.16, at: now() + 0.09,
             filter: { type: 'lowpass', freq: 2400 } });
    },

    // building a house: a small woody knock + tone
    house: function () {
      noise({ freq: 1000, freqTo: 300, filterType: 'lowpass', dur: 0.08, gain: 0.2 });   // knock
      tone({ freq: 392, glideTo: 330, type: 'sine', dur: 0.16, gain: 0.22 });
      tone({ freq: 784, type: 'triangle', dur: 0.2, gain: 0.12, at: now() + 0.06,
             filter: { type: 'lowpass', freq: 3500 } });
    },

    // building a hotel: fuller warm major chord
    hotel: function () {
      var dest = echoSend(0.24, 0.34, 0.28);
      noise({ freq: 900, freqTo: 260, filterType: 'lowpass', dur: 0.09, gain: 0.2 });
      var chord = [392, 494, 587, 784];   // G major spread
      for (var i = 0; i < chord.length; i++) {
        tone({ freq: chord[i], type: 'triangle', dur: 0.55, gain: 0.15, at: now() + 0.02 + i * 0.02,
               dest: dest, filter: { type: 'lowpass', freq: 4500 } });
      }
      tone({ freq: 196, type: 'sine', dur: 0.5, gain: 0.12 });   // warm bass
    },

    // muted, slightly downcast tone
    mortgage: function () {
      tone({ freq: 330, glideTo: 262, type: 'sine', dur: 0.4, gain: 0.2,
             filter: { type: 'lowpass', freq: 900 } });
      tone({ freq: 196, type: 'sine', dur: 0.35, gain: 0.12, at: now() + 0.05 });
    },

    // card draw whoosh (filtered noise sweep)
    card: function () {
      noise({ freq: 600, freqTo: 4000, filterType: 'highpass', dur: 0.28, gain: 0.16, attack: 0.04 });
      noise({ freq: 3000, freqTo: 700, filterType: 'bandpass', q: 2, dur: 0.26, gain: 0.1, attack: 0.03 });
    },

    // brief sparkly sting (after the whoosh, for Chance)
    chance: function () {
      var dest = echoSend(0.16, 0.32, 0.35);
      tone({ freq: 1047, type: 'triangle', dur: 0.18, gain: 0.15, at: now() + 0.02, dest: dest });
      tone({ freq: 1319, type: 'sine', dur: 0.2, gain: 0.13, at: now() + 0.08, dest: dest });
      tone({ freq: 1976, type: 'sine', dur: 0.3, gain: 0.08, at: now() + 0.14, dest: dest });
    },

    // brief warm sting (for Community Chest)
    chest: function () {
      var dest = echoSend(0.2, 0.32, 0.28);
      tone({ freq: 523, type: 'sine', dur: 0.26, gain: 0.16, at: now() + 0.02, dest: dest });
      tone({ freq: 659, type: 'triangle', dur: 0.3, gain: 0.13, at: now() + 0.08, dest: dest });
      tone({ freq: 262, type: 'sine', dur: 0.28, gain: 0.1, at: now() + 0.02 });
    },

    // triumphant short ascending fanfare (passing GO, +$200)
    passgo: function () {
      var dest = echoSend(0.2, 0.36, 0.3);
      var seq = [523, 659, 784, 1047];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'triangle', dur: 0.32, gain: 0.2, at: now() + i * 0.1, dest: dest,
               filter: { type: 'lowpass', freq: 5500 } });
        tone({ freq: seq[i] * 0.5, type: 'sine', dur: 0.3, gain: 0.1, at: now() + i * 0.1 });
      }
      tone({ freq: 1568, type: 'sine', dur: 0.6, gain: 0.1, at: now() + 0.4, dest: dest });   // shimmer
    },

    // a clang/thunk (sent to jail)
    jail: function () {
      noise({ freq: 3000, filterType: 'bandpass', q: 3, dur: 0.18, gain: 0.18 });   // metallic clang
      tone({ freq: 220, glideTo: 90, type: 'square', dur: 0.3, gain: 0.22,
             filter: { type: 'lowpass', freq: 1000 } });
      tone({ freq: 110, glideTo: 55, type: 'sine', dur: 0.35, gain: 0.24 });        // heavy thunk
    },

    // warm two/three-note chord (trade accepted)
    trade: function () {
      var dest = echoSend(0.22, 0.3, 0.26);
      var chord = [523, 659, 784];   // C major
      for (var i = 0; i < chord.length; i++) {
        tone({ freq: chord[i], type: 'sine', dur: 0.4, gain: 0.15, at: now() + i * 0.04, dest: dest });
      }
    },

    // a short tick/blip (a bid was placed)
    auctionbid: function () {
      tone({ freq: 1047, type: 'triangle', dur: 0.07, gain: 0.14, attack: 0.002,
             filter: { type: 'lowpass', freq: 5000 } });
    },

    // a descending minor cadence (a player is eliminated)
    bankrupt: function () {
      var seq = [523, 440, 349, 262];   // descending toward A minor / C
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'sine', dur: 0.5, gain: 0.18, at: now() + i * 0.2,
               filter: { type: 'lowpass', freq: 2200 } });
        tone({ freq: seq[i] * 0.5, type: 'triangle', dur: 0.55, gain: 0.1, at: now() + i * 0.2 });
      }
      tone({ freq: 196, glideTo: 90, type: 'sine', dur: 0.9, gain: 0.16, at: now() + 0.7 });
    },

    // gentle two-note chime ("your turn")
    turn: function () {
      tone({ freq: 659, type: 'sine', dur: 0.14, gain: 0.16 });
      tone({ freq: 988, type: 'triangle', dur: 0.22, gain: 0.14, at: now() + 0.11,
             filter: { type: 'lowpass', freq: 4000 } });
    },

    // full celebratory victory fanfare (ascending major scale + shimmer tail)
    win: function () {
      var dest = echoSend(0.26, 0.42, 0.4);
      var scale = [523, 587, 659, 784, 880, 1047, 1319, 1568];   // C major ascent
      for (var i = 0; i < scale.length; i++) {
        tone({ freq: scale[i], type: 'triangle', dur: 0.45, gain: 0.22, at: now() + i * 0.11, dest: dest,
               filter: { type: 'lowpass', freq: 6000 } });
        tone({ freq: scale[i] * 0.5, type: 'sine', dur: 0.4, gain: 0.1, at: now() + i * 0.11 });
      }
      // glittering shimmer tail
      tone({ freq: 2093, type: 'sine', dur: 1.6, gain: 0.12, at: now() + scale.length * 0.11, dest: dest });
      tone({ freq: 2637, type: 'sine', dur: 1.4, gain: 0.08, at: now() + scale.length * 0.11 + 0.1, dest: dest });
    },

    // soft descending defeat cadence
    lose: function () {
      var seq = [587, 494, 392, 294];
      for (var i = 0; i < seq.length; i++) {
        tone({ freq: seq[i], type: 'sine', dur: 0.6, gain: 0.16, at: now() + i * 0.24,
               filter: { type: 'lowpass', freq: 2000 } });
        tone({ freq: seq[i] * 0.5, type: 'triangle', dur: 0.65, gain: 0.09, at: now() + i * 0.24 });
      }
    },

    // tiny UI click
    click: function () {
      tone({ freq: 740, type: 'sine', dur: 0.05, gain: 0.12, attack: 0.002,
             filter: { type: 'lowpass', freq: 4000 } });
    },

    // tiny UI toggle blip
    toggle: function () {
      tone({ freq: 988, type: 'triangle', dur: 0.05, gain: 0.11, attack: 0.002 });
    },

    // game-start swell
    start: function () {
      var dest = echoSend(0.28, 0.4, 0.32);
      tone({ freq: 262, glideTo: 523, type: 'sine', dur: 0.7, gain: 0.2 });
      tone({ freq: 392, glideTo: 784, type: 'triangle', dur: 0.7, gain: 0.14, dest: dest,
             filter: { type: 'lowpass', freq: 4000 } });
      tone({ freq: 1047, type: 'sine', dur: 0.9, gain: 0.1, at: now() + 0.45, dest: dest });   // shimmer crest
    }
  };

  function play(event) {
    if (!enabled) return;
    if (!ensure()) return;
    tryResume();
    var fn = EVENTS[event];
    if (fn) { try { fn(); } catch (e) { /* never let audio break the game */ } }
  }

  // ----- ambient bed ----------------------------------------------------------
  // A soft, slowly-evolving major pad — very quiet. Heavenly, weightless.
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
    musicBus.gain.exponentialRampToValueAtTime(0.2, now() + 5.0);   // soft, slow fade-in

    // soft airy pad — pure sines, heavily filtered, each voice slowly breathing
    // in and out so it never sits as a flat sustained drone.
    [196.0, 261.63, 329.63].forEach(function (f, i) {              // G3 C4 E4 — warm, sparse
      var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      var g = ctx.createGain();
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 850;
      // very slow detune drift for life
      var lfo = ctx.createOscillator(); lfo.frequency.value = 0.025 + i * 0.01;
      var lfoG = ctx.createGain(); lfoG.gain.value = 2.5;
      lfo.connect(lfoG); lfoG.connect(o.detune);
      // slow amplitude swell — each voice fades up and down independently
      var alfo = ctx.createOscillator(); alfo.frequency.value = 0.045 + i * 0.02;
      var alfoG = ctx.createGain(); alfoG.gain.value = 0.02;
      alfo.connect(alfoG); alfoG.connect(g.gain);
      g.gain.setValueAtTime(0.0001, now());
      g.gain.exponentialRampToValueAtTime(0.028, now() + 6 + i * 2);
      o.connect(lp); lp.connect(g); g.connect(musicBus);
      o.start(); lfo.start(); alfo.start();
      ambientNodes.push(o, lfo, alfo);
    });

    // sparse, gentle high bell-chimes with reverb — the only moving element
    ambientTimer = setInterval(function () {
      if (!musicOn || !enabled || !ctx) return;
      if (Math.random() < 0.3) {
        var notes = [523.25, 659.25, 784.0, 1047.0];
        var n = notes[Math.floor(Math.random() * notes.length)];
        var dest = echoSend(0.5, 0.45, 0.35);
        tone({ freq: n, type: 'sine', dur: 1.4, gain: 0.03, attack: 0.25, dest: dest,
               filter: { type: 'lowpass', freq: 4000 } });
      }
    }, 7000);
  }

  function stopAmbient() {
    if (!ctx) return;
    musicBus.gain.cancelScheduledValues(now());
    musicBus.gain.setValueAtTime(musicBus.gain.value, now());
    musicBus.gain.exponentialRampToValueAtTime(0.0001, now() + 1.0);
    var snapshot = ambientNodes.slice();
    setTimeout(function () {
      snapshot.forEach(function (n) { try { if (n.stop) n.stop(); } catch (e) {} });
    }, 1100);
    if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
    ambientNodes = [];
  }

  // ----- public setters -------------------------------------------------------
  function applyMaster() {
    if (!ctx) return;
    master.gain.cancelScheduledValues(now());
    master.gain.setTargetAtTime(enabled ? volume : 0.0001, now(), 0.05);
  }

  root.MONO = root.MONO || {};
  root.MONO.Audio = {
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
    isEnabled: function () { return enabled; },
    isMusic: function () { return musicOn; }
  };

})(typeof window !== 'undefined' ? window : this);
