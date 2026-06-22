/* ==========================================================================
   render.js — turns an authoritative snapshot into the game screen, and
   diffs old→new to drive animations + sound.  Exposed as window.MONO.Render
   Relies on MONO.act(type,payload) (defined in main.js) for intents.
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, Store = MONO.Store, Board = MONO.Board, B = MONO.board, TILES = B.TILES, GROUPS = B.GROUPS;
  var $ = UI.$, el = UI.el, money = UI.money, esc = UI.esc;

  function tile(i) { return TILES[i]; }
  function pById(s, id) { for (var i = 0; i < s.players.length; i++) if (s.players[i].id === id) return s.players[i]; return null; }
  function worth(s, p) {
    var w = p.cash;
    for (var i = 0; i < TILES.length; i++) { var r = s.props[i]; if (r && r.owner === p.id) { var t = tile(i); w += r.mortgaged ? Math.floor(t.price / 2) : t.price; if (t.type === 'street' && r.houses) w += r.houses * t.house; } }
    return w;
  }
  function ownedBy(s, id) { var out = []; for (var i = 0; i < TILES.length; i++) { var r = s.props[i]; if (r && r.owner === id) out.push(i); } return out; }

  // ---- main entry ----
  function render(cur, prev) {
    if (!cur) return;
    if (cur.phase === 'lobby') { document.body.setAttribute('data-screen', 'lobby'); if (MONO.Lobby) MONO.Lobby.render(cur); return; }
    document.body.setAttribute('data-screen', 'game');
    Board.build();
    effects(cur, prev);          // sounds + token movement + floaters (uses prev)
    Board.paint(cur);
    renderDock(cur);
    renderCenter(cur);
    renderControls(cur);
    renderLog(cur);
    renderChat(cur);
    renderMyProps(cur);
    renderPending(cur, prev);
    renderEnd(cur, prev);
  }

  // ---- diff-driven effects ----
  function effects(cur, prev) {
    var A = MONO.Audio;
    // token movement: find a player whose position changed
    var moved = null;
    if (prev) {
      for (var i = 0; i < cur.players.length; i++) {
        var np = cur.players[i], op = pById(prev, np.id);
        if (op && op.position !== np.position && !np.bankrupt) { moved = { id: np.id, from: op.position, to: np.position }; break; }
      }
    }
    Board.sync(cur, moved);

    // dice
    if (cur.turn.dice && (!prev || !prev.turn.dice || prev.turn.dice[0] !== cur.turn.dice[0] || prev.turn.dice[1] !== cur.turn.dice[1] || (prev.turn.activeId !== cur.turn.activeId))) {
      UI.rollDiceAnim(cur.turn.dice[0], cur.turn.dice[1]); if (A) A.play('dice');
    }
    // card draw
    var card = cur.turn._card;
    if (card && (!prev || !prev.turn._card || prev.turn._card.text !== card.text)) {
      UI.showCard(card.deck === 'chance' ? 'Chance' : 'Community Chest', card.text);
      if (A) A.play(card.deck === 'chance' ? 'chance' : 'chest');
    }
    // cash floaters + my sfx
    if (prev) {
      var bw = $('#board-wrap'), rct = bw ? bw.getBoundingClientRect() : null;
      cur.players.forEach(function (np) {
        var op = pById(prev, np.id); if (!op) return;
        var delta = np.cash - op.cash;
        if (delta !== 0 && !np.bankrupt) {
          if (rct) { var c = Board.centerOf(np.position); UI.floater(delta, rct.left + c.x, rct.top + c.y); }
          if (np.id === Store.me() && A) A.play(delta > 0 ? 'cashin' : 'cashout');
        }
      });
    }
    // log-keyword sfx + turn change
    if (A) {
      newLogTexts(cur, prev).forEach(function (txt) {
        if (/passed GO/.test(txt)) A.play('passgo');
        else if (/bought /.test(txt)) A.play('buy');
        else if (/built a hotel/.test(txt)) A.play('hotel');
        else if (/built a house/.test(txt)) A.play('house');
        else if (/mortgaged/.test(txt)) A.play('mortgage');
        else if (/completed a trade/.test(txt)) A.play('trade');
        else if (/sent to Jail/.test(txt)) A.play('jail');
        else if (/went bankrupt/.test(txt)) A.play('bankrupt');
        else if (/ bid \$/.test(txt)) A.play('auctionbid');
        else if (/paid \$\d+ rent/.test(txt)) A.play('rent');
      });
      if (prev && prev.turn.activeId !== cur.turn.activeId && cur.turn.activeId === Store.me() && cur.phase === 'playing') A.play('turn');
    }
    // flash the tile the active player landed on
    if (moved) Board.flash(moved.to);
  }

  function newLogTexts(cur, prev) {
    if (!cur.log || !cur.log.length) return [];
    if (!prev || !prev.log || !prev.log.length) return cur.log.slice(-1).map(function (l) { return l.text; });
    var lastPrev = prev.log[prev.log.length - 1];
    for (var i = cur.log.length - 1; i >= 0; i--) {
      if (cur.log[i].text === lastPrev.text && cur.log[i].t === lastPrev.t) return cur.log.slice(i + 1).map(function (l) { return l.text; });
    }
    return cur.log.slice(-3).map(function (l) { return l.text; });
  }

  // ---- dock (player list) ----
  function renderDock(s) {
    var dock = $('#dock'); if (!dock) return;
    if ($('#dock-count')) $('#dock-count').textContent = '(' + s.players.filter(function (p) { return !p.bankrupt; }).length + '/' + s.players.length + ')';
    dock.innerHTML = '';
    var ordered = s.players.slice().sort(function (a, b) { return a.order - b.order; });
    ordered.forEach(function (p) {
      var card = el('div', 'pcard' + (s.turn.activeId === p.id && s.phase === 'playing' ? ' turn' : '') + (p.bankrupt ? ' out' : '') + (p.id === Store.me() ? ' you' : ''));
      card.style.setProperty('--pc', p.color);
      var props = ownedBy(s, p.id).length;
      card.innerHTML =
        '<div class="av" style="color:' + esc(p.color) + '">' + esc(p.emoji) +
          (p.inJail ? '<span class="badge-jail">🔒</span>' : '') + (!p.connected ? '<span class="badge-off">⚠️</span>' : '') + '</div>' +
        '<div class="who"><div class="n">' + esc(p.name) + (s.hostId === p.id ? ' 👑' : '') + '</div>' +
          '<div class="sub">' + (p.bankrupt ? 'spectating' : (props + ' props · net ' + money(worth(s, p)))) + '</div></div>' +
        '<div class="cash">' + (p.bankrupt ? '—' : money(p.cash)) + '</div>';
      if (!p.bankrupt) card.onclick = function () { if (MONO.playerMenu) MONO.playerMenu(p.id); };
      dock.appendChild(card);
    });
  }

  // ---- centre ----
  function renderCenter(s) {
    var banner = $('#turn-banner'), ac = $('#action-card'), pot = $('#pot');
    if ($('#game-code')) $('#game-code').textContent = s.code;
    var act = pById(s, s.turn.activeId);
    if (pot) { if (s.settings.freeParkingPot && s.bank.pot > 0) { pot.hidden = false; pot.textContent = 'Pot ' + money(s.bank.pot); } else pot.hidden = true; }
    if (s.phase === 'ended') { if (banner) banner.innerHTML = 'Game over'; }
    else if (banner && act) banner.innerHTML = (act.id === Store.me() ? '<b>Your turn</b>' : esc(act.name) + "'s turn") + ' · round ' + s.round + '<span id="turn-secs"></span>';
    if (s.turn.dice) { var ds = UI.$$('.die'); if (ds[0]) ds[0].setAttribute('data-d', s.turn.dice[0]); if (ds[1]) ds[1].setAttribute('data-d', s.turn.dice[1]); }
    if (ac) {
      var txt = '';
      if (s.paused) txt = 'Paused';
      else if (s.turn.awaitingBuy != null) txt = act && act.id === Store.me() ? 'Land on ' + tile(s.turn.awaitingBuy).name : (act ? act.name + ' is deciding on ' + tile(s.turn.awaitingBuy).name : '');
      else if (s.turn.debt) txt = (act ? act.name : '') + ' owes ' + money(s.turn.debt.amount);
      ac.textContent = txt;
    }
  }

  // ---- controls ----
  function btn(label, cls, fn) { var b = el('button', cls, label); b.onclick = fn; return b; }
  function renderControls(s) {
    var c = $('#controls'); if (!c) return;
    c.innerHTML = '';
    var me = Store.myPlayer(), myTurn = s.turn.activeId === Store.me();
    if (s.phase === 'ended') { c.appendChild(hint('Game over')); c.appendChild(btn('Back to arcade', 'btn-n', function () { location.href = '/'; })); return; }
    if (!me || me.bankrupt) {       // spectator
      c.appendChild(hint('👁 Spectating'));
      c.appendChild(btn('Leave', 'btn-n', function () { MONO.leave(); }));
      addCommon(c, s); return;
    }
    if (s.paused) { c.appendChild(hint('⏸ Paused by host')); if (Store.amHost()) c.appendChild(btn('Resume', 'btn-go', function () { MONO.act('resume'); })); addCommon(c, s); return; }
    if (s.pending && s.pending.kind === 'auction') { c.appendChild(hint('🔨 Auction in progress')); addCommon(c, s); return; }
    if (s.pending && s.pending.kind === 'trade') {
      if (s.pending.to === Store.me()) c.appendChild(hint('📩 Trade offer — see the popup'));
      else c.appendChild(hint('Trade pending…'));
      addCommon(c, s); return;
    }
    if (!myTurn) { c.appendChild(hint('Waiting for <b>' + esc((pById(s, s.turn.activeId) || {}).name || '') + '</b>')); addCommon(c, s); return; }

    // my turn
    var t = s.turn;
    if (t.debt) {
      c.appendChild(hint('You owe <b>' + money(t.debt.amount) + '</b> — raise cash or fold'));
      c.appendChild(btn('Manage properties', 'btn-n', function () { selectTab('props'); }));
      c.appendChild(btn('Declare bankruptcy', 'btn-bad', function () {
        UI.confirm({ title: 'Declare bankruptcy?', body: 'You will forfeit everything and become a spectator.', confirm: 'Go bankrupt', danger: true }).then(function (ok) { if (ok) MONO.act('declareBankruptcy'); });
      }));
      return;
    }
    if (t.awaitingBuy != null) {
      var tl = tile(t.awaitingBuy);
      c.appendChild(btn('Buy ' + esc(tl.name) + ' · ' + money(tl.price), 'btn-go', function () { MONO.act('buyProperty'); }));
      c.appendChild(btn(s.settings.auctions ? 'Decline → auction' : 'Decline', 'btn-n', function () { MONO.act('declineBuy'); }));
      return;
    }
    if (me.inJail && t.phase === 'roll') {
      c.appendChild(btn('Pay ' + money(50) + ' to leave', 'btn-n', function () { MONO.act('jailPay'); }));
      if (me.getOutCards.length) c.appendChild(btn('Use Get-Out card', 'btn-n', function () { MONO.act('jailCard'); }));
      c.appendChild(btn('🎲 Roll for doubles', 'btn-roll', function () { MONO.act('jailRoll'); }));
      addManage(c, s); return;
    }
    if (t.phase === 'roll') { c.appendChild(btn('🎲 Roll dice', 'btn-roll', function () { MONO.act('rollDice'); })); addManage(c, s); return; }
    if (t.phase === 'end') {
      c.appendChild(btn('End turn ▸', 'btn-go', function () { MONO.act('endTurn'); }));
      if (t.continues) c.appendChild(hint('You rolled doubles — roll again!'));
      addManage(c, s); return;
    }
    addManage(c, s);
  }
  function hint(html) { var h = el('div', 'hint'); h.innerHTML = html; return h; }
  function addManage(c, s) {
    c.appendChild(el('div', 'spacer'));
    c.appendChild(btn('💱 Trade', 'btn-n', function () { if (MONO.Trade) MONO.Trade.openPicker(); }));
    c.appendChild(btn('🏠 Manage', 'btn-n', function () { selectTab('props'); }));
    addCommon(c, s);
  }
  function addCommon(c, s) {
    if (Store.amHost() && s.phase === 'playing' && !s.paused) c.appendChild(btn('⏸', 'btn-n', function () { MONO.act('pause'); }));
  }
  function selectTab(name) { UI.$$('.tab').forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); }); UI.$$('.tab-pane').forEach(function (p) { p.classList.toggle('on', p.id === 'tab-' + name); }); }
  MONO._selectTab = selectTab;

  // ---- log / chat ----
  function renderLog(s) {
    var log = $('#log'); if (!log) return;
    log.innerHTML = '';
    s.log.slice(-40).forEach(function (l, i, arr) { var li = el('li', i >= arr.length - 1 ? 'fresh' : '', esc(l.text)); log.appendChild(li); });
    log.scrollTop = log.scrollHeight;
  }
  function renderChat(s) {
    var chat = $('#chat'); if (!chat) return;
    chat.innerHTML = '';
    (s.chat || []).forEach(function (m) { chat.appendChild(el('li', '', '<b>' + esc(m.name) + ':</b> ' + esc(m.text))); });
    chat.scrollTop = chat.scrollHeight;
  }

  // ---- my properties ----
  function renderMyProps(s) {
    var box = $('#my-props'); if (!box) return;
    box.innerHTML = '';
    var me = Store.myPlayer(); if (!me) return;
    var mine = ownedBy(s, me.id);
    if (!mine.length) { box.innerHTML = '<p class="dim sm">You don\'t own anything yet.</p>'; return; }
    var myTurn = s.turn.activeId === me.id && !s.paused && !s.pending;
    mine.forEach(function (i) {
      var t = tile(i), r = s.props[i];
      var row = el('div', 'card'); row.style.padding = '.6rem'; row.style.borderLeft = '3px solid ' + Board.groupColor(t.group);
      var info = '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem"><b style="font-size:.85rem">' + esc(t.name) + '</b>' +
        '<span class="dim sm">' + (r.mortgaged ? 'mortgaged' : (t.type === 'street' ? (r.houses === 5 ? 'hotel' : r.houses + ' houses') : '')) + '</span></div>';
      var acts = el('div'); acts.style.cssText = 'display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.4rem';
      if (t.type === 'street' && !r.mortgaged && myTurn) {
        acts.appendChild(btn('Build ' + money(t.house), 'ghost sm', function () { MONO.act('buildHouse', { tile: i }); }));
        if (r.houses > 0) acts.appendChild(btn('Sell', 'ghost sm', function () { MONO.act('sellHouse', { tile: i }); }));
      }
      if (myTurn) {
        if (!r.mortgaged && (t.type !== 'street' || r.houses === 0)) acts.appendChild(btn('Mortgage ' + money(t.mortgage), 'ghost sm', function () { MONO.act('mortgage', { tile: i }); }));
        if (r.mortgaged) acts.appendChild(btn('Unmortgage ' + money(Math.ceil(t.mortgage * 1.1)), 'ghost sm', function () { MONO.act('unmortgage', { tile: i }); }));
      }
      acts.appendChild(btn('Details', 'ghost sm', function () { propDetail(i); }));
      row.innerHTML = info; row.appendChild(acts); box.appendChild(row);
    });
  }

  // ---- property detail modal ----
  function propDetail(i) {
    var t = tile(i), col = Board.groupColor(t.group);
    var rows = '';
    if (t.type === 'street') {
      var labels = ['Rent', 'With 1 house', 'With 2 houses', 'With 3 houses', 'With 4 houses', 'With hotel'];
      t.rent.forEach(function (v, k) { rows += '<tr><td>' + labels[k] + '</td><td>' + money(v) + '</td></tr>'; });
      rows += '<tr><td>House cost</td><td>' + money(t.house) + ' each</td></tr>';
    } else if (t.type === 'rail') {
      [1, 2, 3, 4].forEach(function (n) { rows += '<tr><td>' + n + ' line' + (n > 1 ? 's' : '') + '</td><td>' + money(B.CONST.RAIL_RENT[n - 1]) + '</td></tr>'; });
    } else if (t.type === 'utility') {
      rows += '<tr><td>1 utility</td><td>4× dice</td></tr><tr><td>2 utilities</td><td>10× dice</td></tr>';
    }
    if (t.mortgage) rows += '<tr><td>Mortgage value</td><td>' + money(t.mortgage) + '</td></tr>';
    var box = el('div', 'prop-detail');
    box.innerHTML = '<div class="head" style="background:' + col + '">' + esc(t.name) + '</div>' +
      (t.price ? '<p class="dim sm">Price ' + money(t.price) + '</p>' : '') +
      '<table class="rent-table">' + rows + '</table>' +
      '<div class="row"><button class="primary" id="pd-close">Close</button></div>';
    var m = UI.modal(box);
    $('#pd-close', box).onclick = m.close;
  }
  MONO.propDetail = propDetail;

  // ---- pending (auction / trade) ----
  function renderPending(cur, prev) {
    if (cur.pending && cur.pending.kind === 'auction') { if (MONO.Auction) MONO.Auction.render(cur); }
    else if (MONO.Auction) MONO.Auction.close();
    if (cur.pending && cur.pending.kind === 'trade' && cur.pending.to === Store.me()) { if (MONO.Trade) MONO.Trade.renderIncoming(cur); }
    else if (MONO.Trade) MONO.Trade.closeIncoming(cur);
    // vote-kick banner
    if (cur.vote) renderVote(cur); else closeVote();
  }
  function renderVote(s) {
    if ($('#vote-banner')) return updateVote(s);
    var t = pById(s, s.vote.target); if (!t) return;
    var bar = el('div', 'toast gold'); bar.id = 'vote-banner'; bar.style.pointerEvents = 'auto';
    $('#toast-root').appendChild(bar);
    updateVote(s);
  }
  function updateVote(s) {
    var bar = $('#vote-banner'); if (!bar) return;
    var t = pById(s, s.vote.target); var me = Store.myPlayer();
    var voted = me && s.vote.votes[me.id] != null;
    bar.innerHTML = 'Vote to kick <b>' + esc(t ? t.name : '?') + '</b>? ';
    if (me && !me.bankrupt && me.id !== s.vote.target && !voted) {
      var yes = btn('Yes', 'ghost sm', function () { MONO.act('voteKickCast', { agree: true }); });
      var no = btn('No', 'ghost sm', function () { MONO.act('voteKickCast', { agree: false }); });
      bar.appendChild(yes); bar.appendChild(no);
    } else bar.innerHTML += '<span class="dim sm">(voted)</span>';
  }
  function closeVote() { var b = $('#vote-banner'); if (b) b.remove(); }

  // ---- end overlay ----
  var endShown = false;
  function renderEnd(cur, prev) {
    if (cur.phase !== 'ended') { endShown = false; return; }
    if (endShown) return; endShown = true;
    var w = cur.winnerId ? pById(cur, cur.winnerId) : null;
    var standings = cur.players.slice().sort(function (a, b) { return worth(cur, b) - worth(cur, a); });
    var amWinner = w && w.id === Store.me();
    if (MONO.Audio) MONO.Audio.play(amWinner ? 'win' : 'lose');
    if (amWinner) UI.confetti(160);
    var list = standings.map(function (p, k) { return '<li><span>' + (k + 1) + '. ' + esc(p.emoji) + ' ' + esc(p.name) + (p.bankrupt ? ' <span class="dim">(out)</span>' : '') + '</span><span>' + money(worth(cur, p)) + '</span></li>'; }).join('');
    var box = el('div', 'end-card');
    box.innerHTML = '<div class="crown">' + (amWinner ? '🏆' : '👑') + '</div>' +
      '<div class="winner">' + esc(w ? w.name + ' wins!' : 'Game over') + '</div>' +
      '<p class="dim sm">' + esc(cur.endReason || '') + '</p>' +
      '<ul class="standings">' + list + '</ul>' +
      '<div class="row"><button class="ghost" id="end-stay">Keep viewing</button><button class="primary" id="end-home">Back to arcade</button></div>';
    var m = UI.modal(box, { sticky: true });
    $('#end-stay', box).onclick = m.close;
    $('#end-home', box).onclick = function () { Store.clearSession(); location.href = '/'; };
  }

  MONO.Render = { render: render };
})(typeof window !== 'undefined' ? window : this);
