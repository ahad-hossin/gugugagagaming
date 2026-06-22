/* ==========================================================================
   fx.js — Canvas visual effects: ambient backdrops (per theme) + transient
   impact bursts (ping ripples, explosions, splashes, bubbles).
   Exposed globally as window.BS.FX
   --------------------------------------------------------------------------
   Two canvases (both pointer-events:none, full viewport):
     #fx-bg  : slow ambient backdrop, drawn behind the UI
     #fx-fg  : transient bursts, drawn above the boards
   Coordinates passed to burst methods are viewport (client) pixels.
   ========================================================================== */
(function (root) {
  'use strict';

  var bg = null, bgx = null, fg = null, fgx = null;
  var W = 0, H = 0, dpr = 1;
  var theme = 'abyss';
  var reduced = false;
  var running = false;
  var particles = [];     // transient bursts (fg)
  var ambient = [];       // ambient agents (bg)
  var lastT = 0;
  var t0 = 0;

  function rnd(a, b) { return a + Math.random() * (b - a); }

  // ---- setup -----------------------------------------------------------------
  function init() {
    bg = document.getElementById('fx-bg');
    fg = document.getElementById('fx-fg');
    if (!bg || !fg) return;
    bgx = bg.getContext('2d');
    fgx = fg.getContext('2d');
    resize();
    root.addEventListener('resize', resize);
    buildAmbient();
    running = true;
    t0 = performance.now();
    requestAnimationFrame(loop);
  }

  function resize() {
    dpr = Math.min(root.devicePixelRatio || 1, 2);
    W = root.innerWidth; H = root.innerHeight;
    [bg, fg].forEach(function (cv) {
      cv.width = Math.floor(W * dpr);
      cv.height = Math.floor(H * dpr);
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
    });
    bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fgx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- ambient agents per theme ---------------------------------------------
  function buildAmbient() {
    ambient = [];
    if (theme === 'abyss') {
      var jn = reduced ? 3 : 7;
      for (var i = 0; i < jn; i++) ambient.push(makeJelly());
      var pn = reduced ? 30 : 90;
      for (var p = 0; p < pn; p++) ambient.push(makePlankton());
      ambient.push(makeAngler());
    } else if (theme === 'holo') {
      var sn = reduced ? 80 : 260;
      for (var s = 0; s < sn; s++) ambient.push(makeStar());
    } else if (theme === 'warroom') {
      // grain handled in draw; a few floating dust motes
      var dn = reduced ? 0 : 40;
      for (var d = 0; d < dn; d++) ambient.push(makeDust('#33FF66'));
    } else if (theme === 'origami') {
      var mn = reduced ? 0 : 34;
      for (var m = 0; m < mn; m++) ambient.push(makeDust('#C9A24B'));
    }
  }

  function makeJelly() {
    return { kind: 'jelly', x: rnd(0, W), y: rnd(0, H), r: rnd(14, 34),
      ph: rnd(0, 6.28), spd: rnd(0.08, 0.22), drift: rnd(-0.2, 0.2),
      hue: Math.random() < 0.5 ? '123,92,255' : '70,232,176' };
  }
  function makePlankton() {
    return { kind: 'plankton', x: rnd(0, W), y: rnd(0, H), r: rnd(0.6, 2.2),
      vx: rnd(-0.15, 0.25), vy: rnd(-0.08, 0.08), tw: rnd(0, 6.28) };
  }
  function makeAngler() {
    return { kind: 'angler', x: rnd(W * 0.2, W * 0.8), y: rnd(H * 0.3, H * 0.7),
      ph: 0, blink: 0 };
  }
  function makeStar() {
    var depth = Math.random();
    return { kind: 'star', x: rnd(0, W), y: rnd(0, H), r: rnd(0.4, 1.8),
      depth: depth, vx: -(0.05 + depth * 0.25), tw: rnd(0, 6.28),
      hue: Math.random() < 0.25 ? '255,61,238' : '124,252,255' };
  }
  function makeDust(rgbName) {
    return { kind: 'dust', x: rnd(0, W), y: rnd(0, H), r: rnd(0.5, 1.6),
      vx: rnd(-0.1, 0.1), vy: rnd(-0.05, 0.05), a: rnd(0.05, 0.2), color: rgbName };
  }

  // ---- main loop -------------------------------------------------------------
  function loop(t) {
    if (!running) return;
    var dt = Math.min(50, t - (lastT || t)); lastT = t;
    drawBg(t, dt);
    drawFg(dt);
    requestAnimationFrame(loop);
  }

  function drawBg(t, dt) {
    bgx.clearRect(0, 0, W, H);
    var time = (t - t0) / 1000;

    if (theme === 'abyss') {
      // caustic shimmer band at top
      if (!reduced) {
        var grad = bgx.createLinearGradient(0, 0, 0, H * 0.4);
        var a = 0.05 + 0.03 * Math.sin(time * 0.6);
        grad.addColorStop(0, 'rgba(47,246,224,' + a + ')');
        grad.addColorStop(1, 'rgba(47,246,224,0)');
        bgx.fillStyle = grad;
        bgx.fillRect(0, 0, W, H * 0.4);
      }
      for (var i = 0; i < ambient.length; i++) {
        var o = ambient[i];
        if (o.kind === 'plankton') {
          o.x += o.vx; o.y += o.vy; o.tw += 0.03;
          if (o.x < 0) o.x = W; if (o.x > W) o.x = 0;
          if (o.y < 0) o.y = H; if (o.y > H) o.y = 0;
          var pa = 0.3 + 0.3 * Math.sin(o.tw);
          bgx.fillStyle = 'rgba(70,232,176,' + pa + ')';
          bgx.beginPath(); bgx.arc(o.x, o.y, o.r, 0, 6.2832); bgx.fill();
        } else if (o.kind === 'jelly') {
          o.ph += 0.02; o.y -= o.spd; o.x += Math.sin(o.ph) * 0.4 + o.drift;
          if (o.y < -50) { o.y = H + 50; o.x = rnd(0, W); }
          var pulse = 0.5 + 0.5 * Math.sin(o.ph * 2);
          var rr = o.r * (0.85 + 0.15 * pulse);
          var g2 = bgx.createRadialGradient(o.x, o.y, 0, o.x, o.y, rr * 2.2);
          g2.addColorStop(0, 'rgba(' + o.hue + ',' + (0.30 * pulse + 0.08) + ')');
          g2.addColorStop(1, 'rgba(' + o.hue + ',0)');
          bgx.fillStyle = g2;
          bgx.beginPath(); bgx.arc(o.x, o.y, rr * 2.2, 0, 6.2832); bgx.fill();
          // bell
          bgx.fillStyle = 'rgba(' + o.hue + ',' + (0.18 + 0.12 * pulse) + ')';
          bgx.beginPath(); bgx.arc(o.x, o.y, rr * 0.6, Math.PI, 0); bgx.fill();
          // tentacles
          if (!reduced) {
            bgx.strokeStyle = 'rgba(' + o.hue + ',0.18)'; bgx.lineWidth = 1;
            for (var tt = -2; tt <= 2; tt++) {
              bgx.beginPath();
              bgx.moveTo(o.x + tt * rr * 0.18, o.y);
              bgx.quadraticCurveTo(o.x + tt * rr * 0.3 + Math.sin(o.ph + tt) * 4,
                o.y + rr * 1.4, o.x + tt * rr * 0.2, o.y + rr * 2.4);
              bgx.stroke();
            }
          }
        } else if (o.kind === 'angler') {
          o.ph += 0.012;
          var ax = o.x + Math.sin(o.ph) * 60, ay = o.y + Math.sin(o.ph * 2) * 30;
          o.blink = (o.blink + 0.02);
          var lit = (Math.sin(o.blink) > -0.3) ? 1 : 0.2;
          var lg = bgx.createRadialGradient(ax, ay, 0, ax, ay, 26);
          lg.addColorStop(0, 'rgba(255,214,107,' + (0.5 * lit) + ')');
          lg.addColorStop(1, 'rgba(255,214,107,0)');
          bgx.fillStyle = lg; bgx.beginPath(); bgx.arc(ax, ay, 26, 0, 6.2832); bgx.fill();
          bgx.fillStyle = 'rgba(255,214,107,' + lit + ')';
          bgx.beginPath(); bgx.arc(ax, ay, 2.2, 0, 6.2832); bgx.fill();
        }
      }
    } else if (theme === 'holo') {
      for (var s = 0; s < ambient.length; s++) {
        var st = ambient[s];
        st.x += st.vx; st.tw += 0.04;
        if (st.x < 0) { st.x = W; st.y = rnd(0, H); }
        var sa = (0.4 + 0.6 * st.depth) * (0.6 + 0.4 * Math.sin(st.tw));
        bgx.fillStyle = 'rgba(' + st.hue + ',' + sa + ')';
        bgx.beginPath(); bgx.arc(st.x, st.y, st.r, 0, 6.2832); bgx.fill();
      }
    } else if (theme === 'warroom') {
      drawDust(time);
      if (!reduced) drawGrain(0.06);
      // moving roll-bar handled by CSS overlay
    } else if (theme === 'origami') {
      drawDust(time);
    }
  }

  function drawDust(time) {
    for (var i = 0; i < ambient.length; i++) {
      var o = ambient[i];
      if (o.kind !== 'dust') continue;
      o.x += o.vx; o.y += o.vy;
      if (o.x < 0) o.x = W; if (o.x > W) o.x = 0;
      if (o.y < 0) o.y = H; if (o.y > H) o.y = 0;
      bgx.fillStyle = 'rgba(' + o.color + ',' + o.a + ')';
      bgx.beginPath(); bgx.arc(o.x, o.y, o.r, 0, 6.2832); bgx.fill();
    }
  }

  function drawGrain(intensity) {
    // sparse random specks (cheap film grain)
    var n = Math.floor((W * H) / 9000);
    bgx.fillStyle = 'rgba(180,255,200,' + intensity + ')';
    for (var i = 0; i < n; i++) {
      bgx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
    }
  }

  // ---- transient bursts (fg) -------------------------------------------------
  function drawFg(dt) {
    fgx.clearRect(0, 0, W, H);
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life += dt;
      var k = p.life / p.dur;
      if (k >= 1) { particles.splice(i, 1); continue; }
      p.draw(p, k);
    }
  }

  function addRing(x, y, color, maxR, dur, delay) {
    particles.push({
      life: -(delay || 0), dur: dur, x: x, y: y,
      draw: function (p, k) {
        if (k < 0) return;
        var ease = 1 - Math.pow(1 - k, 3);
        var r = maxR * ease;
        fgx.globalAlpha = (1 - k) * 0.9;
        fgx.strokeStyle = color;
        fgx.lineWidth = Math.max(0.5, 4 * (1 - k));
        fgx.beginPath(); fgx.arc(p.x, p.y, r, 0, 6.2832); fgx.stroke();
        fgx.globalAlpha = 1;
      }
    });
  }

  function ping(x, y, color) {
    color = color || '#2FF6E0';
    var maxR = reduced ? 60 : 120;
    addRing(x, y, color, maxR, 900, 0);
    if (!reduced) { addRing(x, y, color, maxR, 900, 90); addRing(x, y, color, maxR, 900, 180); }
  }

  function splash(x, y, color) {
    color = color || '#3A7C8C';
    // contracting ring
    particles.push({
      life: 0, dur: 600, x: x, y: y,
      draw: function (p, k) {
        var r = 30 * (1 - k) + 4;
        fgx.globalAlpha = (1 - k) * 0.8;
        fgx.strokeStyle = color; fgx.lineWidth = 2;
        fgx.beginPath(); fgx.arc(p.x, p.y, r, 0, 6.2832); fgx.stroke();
        fgx.globalAlpha = 1;
      }
    });
    if (reduced) return;
    var n = 7;
    for (var i = 0; i < n; i++) {
      var ang = rnd(-2.4, -0.7), sp = rnd(0.4, 1.1);
      particles.push({
        life: 0, dur: rnd(450, 700), x: x, y: y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rnd(1.5, 3.5),
        draw: function (p, k) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.04;
          fgx.globalAlpha = (1 - k) * 0.75;
          fgx.fillStyle = color;
          fgx.beginPath(); fgx.arc(p.x, p.y, p.r * (1 - k * 0.5), 0, 6.2832); fgx.fill();
          fgx.globalAlpha = 1;
        }
      });
    }
  }

  function explosion(x, y, color) {
    color = color || '#FF7A33';
    // white-hot flash
    particles.push({
      life: 0, dur: 160, x: x, y: y,
      draw: function (p, k) {
        var r = 26 * (1 - k);
        var g = fgx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r + 1);
        g.addColorStop(0, 'rgba(255,255,255,' + (1 - k) + ')');
        g.addColorStop(1, 'rgba(255,230,180,0)');
        fgx.fillStyle = g; fgx.beginPath(); fgx.arc(p.x, p.y, r + 1, 0, 6.2832); fgx.fill();
      }
    });
    // shockwave
    addRing(x, y, color, reduced ? 40 : 70, 280, 0);
    if (reduced) return;
    var n = 16;
    for (var i = 0; i < n; i++) {
      var ang = rnd(0, 6.2832), sp = rnd(1.2, 4.2);
      particles.push({
        life: 0, dur: rnd(500, 850), x: x, y: y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: rnd(1.5, 3.8),
        draw: function (p, k) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.06; p.vx *= 0.98;
          var col = k < 0.4 ? '#FFE6C7' : color;
          fgx.globalAlpha = (1 - k);
          fgx.fillStyle = col;
          fgx.beginPath(); fgx.arc(p.x, p.y, p.r * (1 - k * 0.6), 0, 6.2832); fgx.fill();
          fgx.globalAlpha = 1;
        }
      });
    }
  }

  function bubbles(x, y, color) {
    color = color || '#A8FFF4';
    if (reduced) return;
    var n = 14;
    for (var i = 0; i < n; i++) {
      particles.push({
        life: -(i * 40), dur: rnd(900, 1500), x: x + rnd(-14, 14), y: y,
        vy: rnd(0.5, 1.3), r: rnd(1.5, 4), wob: rnd(0, 6.28),
        draw: function (p, k) {
          if (k < 0) return;
          p.y -= p.vy; p.wob += 0.1; p.x += Math.sin(p.wob) * 0.5;
          fgx.globalAlpha = (1 - k) * 0.7;
          fgx.strokeStyle = color; fgx.lineWidth = 1;
          fgx.beginPath(); fgx.arc(p.x, p.y, p.r, 0, 6.2832); fgx.stroke();
          fgx.globalAlpha = 1;
        }
      });
    }
  }

  // brief full-screen vignette flash (hit/sunk feedback)
  function flashScreen(color, strength) {
    if (reduced) return;
    color = color || 'rgba(255,80,40,';
    var s = strength || 0.25;
    particles.push({
      life: 0, dur: 320, x: 0, y: 0,
      draw: function (p, k) {
        var g = fgx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
        g.addColorStop(0, color + '0)');
        g.addColorStop(1, color + (s * (1 - k)) + ')');
        fgx.fillStyle = g; fgx.fillRect(0, 0, W, H);
      }
    });
  }

  function setTheme(k) {
    if (theme === k) return;
    theme = k;
    buildAmbient();
  }
  function setReducedMotion(v) { reduced = !!v; buildAmbient(); }

  root.BS = root.BS || {};
  root.BS.FX = {
    init: init,
    setTheme: setTheme,
    setReducedMotion: setReducedMotion,
    ping: ping, splash: splash, explosion: explosion, bubbles: bubbles,
    flashScreen: flashScreen,
    stop: function () { running = false; },
    start: function () { if (!running) { running = true; lastT = 0; requestAnimationFrame(loop); } }
  };

})(typeof window !== 'undefined' ? window : this);
