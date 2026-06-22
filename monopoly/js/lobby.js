/* ==========================================================================
   lobby.js — pre-game lobby: player list, host-editable settings, ready/start.
   Exposed as window.MONO.Lobby   (buttons are wired once in main.js)
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, Store = MONO.Store, money = UI.money, el = UI.el, esc = UI.esc, $ = UI.$;

  var TOGGLES = [
    { k: 'auctions', label: 'Auction declined properties' },
    { k: 'freeParkingPot', label: 'Free Parking jackpot' },
    { k: 'evenBuild', label: 'Even-build rule' },
    { k: 'fullSetDoubleRent', label: 'Double rent on full colour set' },
    { k: 'rentInJail', label: 'Collect rent while in jail' },
    { k: 'randomizeOrder', label: 'Randomise turn order' }
  ];
  var RANGES = [
    { k: 'maxPlayers', min: 2, max: 16, step: 1, fmt: function (v) { return v + ' players'; } },
    { k: 'startingCash', min: 500, max: 5000, step: 50, fmt: function (v) { return money(v); } },
    { k: 'turnSeconds', min: 0, max: 300, step: 15, fmt: function (v) { return v ? v + 's / turn' : 'no timer'; } },
    { k: 'roundCap', min: 0, max: 100, step: 5, fmt: function (v) { return v ? v + ' rounds' : 'unlimited'; } }
  ];

  function render(s) {
    var host = Store.amHost();
    if ($('#lobby-code')) $('#lobby-code').textContent = s.code;
    if ($('#lobby-count')) $('#lobby-count').textContent = '(' + s.players.length + '/' + s.settings.maxPlayers + ')';

    // players
    var ul = $('#lobby-players'); ul.innerHTML = '';
    s.players.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (p) {
      var li = el('li');
      li.innerHTML = '<span class="av" style="color:' + esc(p.color) + '">' + esc(p.emoji) + '</span>' +
        '<span class="pname">' + esc(p.name) + (p.id === Store.me() ? ' <span class="dim sm">(you)</span>' : '') + '</span>' +
        (s.hostId === p.id ? '<span class="pill host">host</span>' : '<span class="pill ' + (p.ready ? 'ready' : 'wait') + '">' + (p.ready ? 'ready' : 'wait') + '</span>');
      if (host && p.id !== Store.me()) {
        var k = el('button', 'ghost sm kick', 'kick'); k.onclick = function () { MONO.act('kickPlayer', { target: p.id }); };
        li.appendChild(k);
      }
      ul.appendChild(li);
    });

    // settings
    var box = $('#lobby-settings'); box.innerHTML = '';
    RANGES.forEach(function (r) {
      var v = s.settings[r.k];
      var row = el('div', 'set-row');
      row.innerHTML = '<label>' + labelFor(r.k) + '</label>';
      var input = el('input'); input.type = 'range'; input.min = r.min; input.max = r.max; input.step = r.step; input.value = v; input.disabled = !host;
      var val = el('span', 'val', r.fmt(v));
      input.oninput = function () { val.textContent = r.fmt(+input.value); };
      input.onchange = function () { var o = {}; o[r.k] = +input.value; MONO.act('updateSettings', o); };
      row.appendChild(input); row.appendChild(val); box.appendChild(row);
    });
    TOGGLES.forEach(function (t) {
      var v = !!s.settings[t.k];
      var row = el('div', 'set-row');
      row.innerHTML = '<label>' + esc(t.label) + '</label>';
      var sw = el('label', 'switch');
      var input = el('input'); input.type = 'checkbox'; input.checked = v; input.disabled = !host;
      input.onchange = function () { var o = {}; o[t.k] = input.checked; MONO.act('updateSettings', o); };
      sw.appendChild(input); sw.appendChild(el('span', 'sl'));
      row.appendChild(sw); box.appendChild(row);
    });
    if ($('#lobby-settings-note')) $('#lobby-settings-note').textContent = host ? 'You are the host — tweak the rules above.' : 'Only the host can change the rules.';

    // ready / start buttons
    var me = Store.myPlayer();
    var ready = $('#btn-ready'), start = $('#btn-start');
    if (ready) {
      ready.style.display = host ? 'none' : '';
      ready.textContent = me && me.ready ? '✓ Ready' : 'Ready up';
      ready.classList.toggle('go', !!(me && me.ready));
    }
    if (start) {
      start.hidden = !host;
      var allReady = s.players.length >= 2 && s.players.every(function (p) { return p.ready; });
      start.disabled = !allReady;
      start.textContent = allReady ? 'Start game ▸' : 'Waiting for players…';
    }
  }
  function labelFor(k) {
    return { maxPlayers: 'Max players', startingCash: 'Starting cash', turnSeconds: 'Turn timer', roundCap: 'Round limit' }[k] || k;
  }

  MONO.Lobby = { render: render };
})(typeof window !== 'undefined' ? window : this);
