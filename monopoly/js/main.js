/* ==========================================================================
   main.js — bootstrap: identity prefs, screen wiring, the act() intent helper,
   turn-timer tick, presence + reconnect, audio gesture unlock.
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, Store = MONO.Store, Net = MONO.Net, Audio = MONO.Audio, $ = UI.$, esc = UI.esc;

  var COLORS = ['#3df5ff', '#ff3dee', '#ffd23d', '#3ddc84', '#ff9f43', '#ff4d5e', '#5a7dff', '#b8a6ff', '#6fd3ff', '#ff7ad9', '#9b6a4a', '#c9d6e6', '#7CFC00', '#FF6EC7', '#00E5FF', '#FF8C00'];
  var EMOJIS = ['🎩', '🚗', '🐕', '🐈', '🚀', '⛵', '🎸', '👑', '🦄', '🐉', '🍔', '⚽', '🎲', '💎', '🤖', '👻', '🦊', '🐢', '🍀', '🛸'];

  var prefs = loadPrefs();
  function loadPrefs() { try { return Object.assign({ name: '', color: COLORS[0], emoji: EMOJIS[0], sound: true, music: false }, JSON.parse(localStorage.getItem('tycoon.prefs') || '{}')); } catch (e) { return { name: '', color: COLORS[0], emoji: EMOJIS[0], sound: true, music: false }; } }
  function savePrefs() { try { localStorage.setItem('tycoon.prefs', JSON.stringify(prefs)); } catch (e) {} }
  function identity() { return { name: ($('#id-name').value || prefs.name || 'Player').slice(0, 20), color: prefs.color, emoji: prefs.emoji }; }

  // ---- intent helper ----
  function act(type, payload) {
    if (Audio) Audio.play('click');
    return Net.action(type, payload).catch(function (e) { if (e.status !== 409) UI.toast(e.message || 'Action failed', 'bad'); throw e; });
  }
  MONO.act = act;
  MONO.leave = function () {
    UI.confirm({ title: 'Leave the game?', body: 'You can rejoin from the same browser while the game is running.', confirm: 'Leave' }).then(function (ok) {
      if (!ok) return;
      Net.action('leave', {}).catch(function () {});
      Net.teardown(); Store.clearSession(); location.href = '/';
    });
  };

  // ---- player menu (dock click) ----
  MONO.playerMenu = function (id) {
    var s = Store.get(); if (!s || s.phase !== 'playing') return;
    if (id === Store.me()) return;
    var p = Store.player(id); if (!p) return;
    var box = UI.el('div');
    box.innerHTML = '<h2>' + esc(p.emoji) + ' ' + esc(p.name) + '</h2>';
    var col = UI.el('div'); col.style.cssText = 'display:flex;flex-direction:column;gap:.5rem';
    var me = Store.myPlayer();
    if (me && !me.bankrupt) {
      var t = UI.el('button', 'primary full', '💱 Propose a trade'); t.onclick = function () { UI.closeModal(); MONO.Trade.openPicker(id); }; col.appendChild(t);
      if (!s.vote) { var v = UI.el('button', 'ghost full', '🗳 Start vote-kick'); v.onclick = function () { UI.closeModal(); act('voteKickStart', { target: id }); }; col.appendChild(v); }
    }
    if (Store.amHost()) { var k = UI.el('button', 'btn-bad full', '👢 Kick (host)'); k.onclick = function () { UI.closeModal(); act('kickPlayer', { target: id }); }; col.appendChild(k); }
    box.appendChild(col);
    var m = UI.modal(box); var c = UI.el('button', 'ghost full', 'Close'); c.style.marginTop = '.6rem'; c.onclick = m.close; box.appendChild(c);
  };

  // ---- shared helpers ----
  function copyInvite() {
    var url = location.origin + '/monopoly/?room=' + (Store.code() || '');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { UI.toast('Invite link copied!', 'good'); }, function () { prompt('Copy this link:', url); });
    else prompt('Copy this link:', url);
  }
  function openGameMenu() {
    var box = UI.el('div');
    box.innerHTML = '<h2>Menu</h2>';
    var col = UI.el('div'); col.style.cssText = 'display:flex;flex-direction:column;gap:.5rem';
    function row(label, fn) { var b = UI.el('button', 'ghost full', label); b.style.textAlign = 'left'; b.onclick = fn; col.appendChild(b); return b; }
    row('📋 Copy invite link', function () { copyInvite(); });
    var sb = row(prefs.sound ? '🔊 Sound: on' : '🔇 Sound: off', function () { prefs.sound = !prefs.sound; savePrefs(); applySound(); sb.textContent = prefs.sound ? '🔊 Sound: on' : '🔇 Sound: off'; });
    var mb = row(prefs.music ? '🎵 Music: on' : '🎵 Music: off', function () { prefs.music = !prefs.music; savePrefs(); if (Audio) Audio.resume(); applyMusic(); mb.textContent = prefs.music ? '🎵 Music: on' : '🎵 Music: off'; });
    box.appendChild(col);
    var m = UI.modal(box);
    var leave = UI.el('button', 'btn-bad full', '🚪 Leave game'); leave.style.marginTop = '.6rem';
    leave.onclick = function () { m.close(); MONO.leave(); };
    box.appendChild(leave);
    var close = UI.el('button', 'link full', 'Close'); close.onclick = m.close; box.appendChild(close);
  }

  // ====================== boot ======================
  document.addEventListener('DOMContentLoaded', function () {
    starfield();
    buildIdentityUI();
    wireHome();
    wireLobby();
    wireGame();
    applySound();
    applyMusic();

    Store.on(function (cur, prev) { MONO.Render.render(cur, prev); });
    Store.on(reactionFx);

    // deep link ?room=CODE
    var room = new URLSearchParams(location.search).get('room');
    if (room) $('#join-code').value = room.toUpperCase().slice(0, 4);

    // resume an in-progress seat
    var sess = Store.session();
    if (sess && sess.code) { $('#resume-bar').hidden = false; }

    // unlock audio on first gesture
    var unlock = function () { if (Audio) { Audio.resume(); if (prefs.music) Audio.startAmbient(); } document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock); };
    document.addEventListener('pointerdown', unlock); document.addEventListener('keydown', unlock);

    setInterval(tick, 1500);
    var rt; addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var s = Store.get(); if (s && s.phase !== 'lobby') MONO.Board.relayout(s); }, 150); });
    addEventListener('pagehide', function () { try { navigator.sendBeacon && Net.action('leave', {}); } catch (e) {} });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Store.code()) Net.action('setConnected', { connected: true }).catch(function () {}); });
  });

  // ---- identity UI ----
  function buildIdentityUI() {
    $('#id-name').value = prefs.name || '';
    $('#id-name').oninput = function () { prefs.name = this.value; savePrefs(); };
    var sw = $('#id-colors');
    COLORS.forEach(function (c) {
      var b = UI.el('span', 'swatch'); b.style.background = c; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', c === prefs.color ? 'true' : 'false'); b.style.color = c;
      b.onclick = function () { prefs.color = c; savePrefs(); UI.$$('.swatch').forEach(function (x) { x.setAttribute('aria-checked', 'false'); }); b.setAttribute('aria-checked', 'true'); };
      sw.appendChild(b);
    });
    $('#id-emoji').textContent = prefs.emoji;
    var pop = $('#emoji-pop');
    EMOJIS.forEach(function (e) { var b = UI.el('button', '', e); b.onclick = function () { prefs.emoji = e; savePrefs(); $('#id-emoji').textContent = e; pop.hidden = true; }; pop.appendChild(b); });
    $('#id-emoji').onclick = function () { pop.hidden = !pop.hidden; };
  }

  // ---- home ----
  function wireHome() {
    $('#btn-create').onclick = function () {
      if (!identity().name.trim()) return UI.toast('Enter a name first.', 'bad');
      busy($('#btn-create'), true);
      Net.create(identity()).then(function () {}).catch(function (e) { UI.toast(e.message || 'Could not create room', 'bad'); }).then(function () { busy($('#btn-create'), false); });
    };
    $('#btn-join').onclick = function () {
      var code = ($('#join-code').value || '').toUpperCase().trim();
      if (!identity().name.trim()) return UI.toast('Enter a name first.', 'bad');
      if (code.length < 4) return UI.toast('Enter a 4-letter code.', 'bad');
      busy($('#btn-join'), true);
      Net.join(code, identity()).catch(function (e) { UI.toast(e.message || 'Could not join', 'bad'); }).then(function () { busy($('#btn-join'), false); });
    };
    $('#btn-resume').onclick = function () { Net.resume().catch(function (e) { UI.toast('Could not rejoin: ' + (e.message || ''), 'bad'); Store.clearSession(); $('#resume-bar').hidden = true; }); };
    $('#btn-forget').onclick = function () { Store.clearSession(); $('#resume-bar').hidden = true; };
    var st = $('#sound-toggle');
    st.onclick = function () { prefs.sound = !prefs.sound; savePrefs(); applySound(); };
    var mt = $('#music-toggle');
    if (mt) mt.onclick = function () { prefs.music = !prefs.music; savePrefs(); if (Audio) Audio.resume(); applyMusic(); };
    $('#join-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#btn-join').click(); });
  }
  function applySound() {
    if (Audio) Audio.setEnabled(prefs.sound);
    var st = $('#sound-toggle'); if (st) { st.textContent = prefs.sound ? '🔊 Sound on' : '🔇 Sound off'; st.setAttribute('aria-pressed', String(prefs.sound)); }
  }
  function applyMusic() {
    if (Audio) Audio.setMusic(prefs.music);
    var mt = $('#music-toggle'); if (mt) { mt.textContent = prefs.music ? '🎵 Music on' : '🎵 Music off'; mt.setAttribute('aria-pressed', String(prefs.music)); }
  }
  function busy(btn, on) { if (btn) { btn.disabled = on; btn.style.opacity = on ? '.6' : ''; } }

  // ---- lobby ----
  function wireLobby() {
    $('#btn-ready').onclick = function () { act('setReady', {}); };
    $('#btn-start').onclick = function () { act('startGame', {}).then(function () { if (Audio) Audio.play('start'); }).catch(function () {}); };
    $('#btn-leave-lobby').onclick = function () { Net.action('leave', {}).catch(function () {}); Net.teardown(); Store.clearSession(); location.reload(); };
    $('#btn-copy').onclick = copyInvite;
    if (navigator.share) { var sh = $('#btn-share'); sh.hidden = false; sh.onclick = function () { navigator.share({ title: 'TYCOON', text: 'Join my game!', url: location.origin + '/monopoly/?room=' + (Store.code() || '') }).catch(function () {}); }; }
  }

  // ---- game ----
  function wireGame() {
    UI.$$('.tab').forEach(function (t) { t.onclick = function () { MONO._selectTab(t.getAttribute('data-tab')); }; });
    $('#chat-send').onclick = sendChat;
    $('#chat-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
    var rb = $('#reactions-bar');
    ['👍', '😂', '😮', '😡', '🎉', '💸', '🤝', '🔥'].forEach(function (e) { var b = UI.el('button', '', e); b.onclick = function () { Net.action('reaction', { emoji: e }).catch(function () {}); }; rb.appendChild(b); });
    $('#game-menu-btn').onclick = openGameMenu;
    if ($('#game-copy')) $('#game-copy').onclick = copyInvite;
    // delegate tile clicks → property detail
    $('#board').addEventListener('click', function (e) {
      var tileEl = e.target.closest('.tile'); if (!tileEl) return;
      var i = +tileEl.getAttribute('data-tile'); var t = MONO.board.TILES[i];
      if (t && (t.type === 'street' || t.type === 'rail' || t.type === 'utility')) MONO.propDetail(i);
    });
  }
  function sendChat() {
    var inp = $('#chat-input'); var txt = (inp.value || '').trim(); if (!txt) return;
    inp.value = ''; Net.action('chat', { text: txt }).catch(function () {});
  }

  // ---- reactions floating ----
  var seenReactions = 0;
  function reactionFx(cur) {
    if (!cur || !cur.reactions) return;
    if (cur.reactions.length < seenReactions) seenReactions = 0;
    var fresh = cur.reactions.slice(seenReactions); seenReactions = cur.reactions.length;
    if (cur.phase !== 'playing' && cur.phase !== 'ended') return;
    fresh.forEach(function (r) {
      var p = Store.player(r.id); if (!p) return;
      var wrap = $('#board-wrap'); if (!wrap) return;
      var rct = wrap.getBoundingClientRect(), c = MONO.Board.centerOf(p.position);
      var f = UI.el('div', 'floater', r.emoji);
      f.style.left = (rct.left + c.x) + 'px'; f.style.top = (rct.top + c.y) + 'px'; f.style.fontSize = '1.6rem';
      $('#floaters').appendChild(f); setTimeout(function () { f.remove(); }, 1200);
    });
  }

  // ---- timer tick (auto-resolve stalls) ----
  var lastTimeout = 0;
  function tick() {
    var s = Store.get(); if (!s || s.phase !== 'playing') return;
    var now = Date.now();
    // turn countdown display
    var secEl = $('#turn-secs');
    if (secEl) { if (s.turn.deadline && !s.paused) { var sec = Math.max(0, Math.ceil((s.turn.deadline - now) / 1000)); secEl.textContent = ' · ⏱ ' + sec + 's'; } else secEl.textContent = ''; }
    if (s.paused) return;
    if (now - lastTimeout < 3000) return;
    var fire = false;
    if (s.pending && s.pending.kind === 'auction' && s.pending.deadline && now > s.pending.deadline + 600) fire = true;
    else if (s.vote && s.vote.deadline && now > s.vote.deadline + 600) fire = true;
    else if (s.turn && s.turn.deadline && now > s.turn.deadline) { fire = (s.turn.activeId === Store.me()) || now > s.turn.deadline + 4000; }
    if (fire) { lastTimeout = now; act('claimTimeout').catch(function () {}); }
  }

  // ---- starfield (same as the hub) ----
  function starfield() {
    var c = $('#stars'); if (!c) return; var x = c.getContext('2d'), W, H, dpr = Math.min(devicePixelRatio || 1, 2), stars = [];
    function resize() { W = innerWidth; H = innerHeight; c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px'; x.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = []; var n = Math.min(140, Math.floor(W * H / 14000));
      for (var i = 0; i < n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + .2, vx: -(Math.random() * .15 + .02), tw: Math.random() * 6.28, h: Math.random() < .25 ? '255,210,61' : '61,245,255' }); }
    var reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
    function loop() { x.clearRect(0, 0, W, H);
      for (var i = 0; i < stars.length; i++) { var s = stars[i]; if (!reduce) { s.x += s.vx; s.tw += .03; if (s.x < 0) { s.x = W; s.y = Math.random() * H; } }
        x.fillStyle = 'rgba(' + s.h + ',' + (.35 + .5 * Math.sin(s.tw)) + ')'; x.beginPath(); x.arc(s.x, s.y, s.r, 0, 6.2832); x.fill(); }
      requestAnimationFrame(loop); }
    addEventListener('resize', resize); resize(); loop();
  }
})(typeof window !== 'undefined' ? window : this);
