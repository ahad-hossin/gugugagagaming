/* ==========================================================================
   trade.js — propose trades (pick partner → build offer) and respond to an
   incoming offer.  Exposed as window.MONO.Trade
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, Store = MONO.Store, B = MONO.board, TILES = B.TILES, Board = MONO.Board;
  var money = UI.money, el = UI.el, esc = UI.esc, $ = UI.$;

  function tile(i) { return TILES[i]; }
  function ownedBy(s, id) { var o = []; for (var i = 0; i < TILES.length; i++) { var r = s.props[i]; if (r && r.owner === id) o.push(i); } return o; }
  function pById(s, id) { for (var i = 0; i < s.players.length; i++) if (s.players[i].id === id) return s.players[i]; return null; }

  // ---- pick a partner ----
  function openPicker(targetId) {
    var s = Store.get(); if (!s) return;
    if (targetId) return openBuilder(targetId);
    var others = s.players.filter(function (p) { return !p.bankrupt && p.id !== Store.me(); });
    if (!others.length) return UI.toast('No one to trade with.', 'bad');
    var box = el('div');
    box.innerHTML = '<h2>Trade with…</h2>';
    var list = el('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:.4rem';
    others.forEach(function (p) {
      var b = el('button', 'ghost full', '<span class="av" style="color:' + esc(p.color) + '">' + esc(p.emoji) + '</span> ' + esc(p.name) + ' · ' + money(p.cash));
      b.style.cssText = 'display:flex;align-items:center;gap:.5rem;justify-content:flex-start';
      b.onclick = function () { openBuilder(p.id); };
      list.appendChild(b);
    });
    box.appendChild(list);
    UI.modal(box);
  }

  // ---- build an offer ----
  function openBuilder(toId) {
    var s = Store.get(), me = Store.myPlayer(), them = pById(s, toId);
    if (!me || !them) return;
    var give = { cash: 0, props: [], cards: 0 }, get = { cash: 0, props: [], cards: 0 };

    var box = el('div');
    box.innerHTML = '<h2>Propose a trade to ' + esc(them.name) + '</h2>' +
      '<div class="trade-grid">' +
        '<div class="trade-col" id="tc-mine"><h3>You give</h3></div>' +
        '<div class="trade-col" id="tc-theirs"><h3>' + esc(them.name) + ' gives</h3></div>' +
      '</div>' +
      '<div class="balance" id="tc-balance"></div>' +
      '<div class="row"><button class="ghost" id="tc-cancel">Cancel</button><button class="primary" id="tc-send">Send offer</button></div>';

    fillCol($('#tc-mine', box), me, give, false);
    fillCol($('#tc-theirs', box), them, get, true);

    function fillCol(col, owner, side, theirs) {
      ownedBy(s, owner.id).forEach(function (i) {
        var t = tile(i), r = s.props[i];
        var row = el('label', 'pi');
        row.innerHTML = '<input type="checkbox"><span class="pchip" style="--own:' + Board.groupColor(t.group) + '"><span class="pchip-dot"></span>' + esc(t.name) + (r.houses ? ' 🏠' : '') + '</span>';
        row.querySelector('input').onchange = function () {
          if (this.checked) side.props.push(i); else side.props = side.props.filter(function (x) { return x !== i; });
          updateBalance();
        };
        col.appendChild(row);
      });
      var cashRow = el('div', 'trade-cash');
      cashRow.innerHTML = 'Cash <input type="number" min="0" max="' + owner.cash + '" value="0">';
      cashRow.querySelector('input').oninput = function () { side.cash = Math.max(0, Math.min(owner.cash, +this.value || 0)); updateBalance(); };
      col.appendChild(cashRow);
      if (owner.getOutCards && owner.getOutCards.length) {
        var cardRow = el('div', 'trade-cash');
        cardRow.innerHTML = 'Get-out cards <input type="number" min="0" max="' + owner.getOutCards.length + '" value="0">';
        cardRow.querySelector('input').oninput = function () { side.cards = Math.max(0, Math.min(owner.getOutCards.length, +this.value || 0)); updateBalance(); };
        col.appendChild(cardRow);
      }
    }
    function updateBalance() {
      var net = get.cash - give.cash;
      $('#tc-balance', box).innerHTML = 'You give ' + summary(give) + ' &nbsp;↔&nbsp; you get ' + summary(get) +
        (net !== 0 ? '<br><span style="color:' + (net > 0 ? 'var(--good)' : 'var(--bad)') + '">net cash ' + (net > 0 ? '+' : '') + money(net) + '</span>' : '');
    }
    function summary(side) {
      var parts = [];
      if (side.cash) parts.push(money(side.cash));
      if (side.props.length) parts.push(side.props.length + ' prop' + (side.props.length > 1 ? 's' : ''));
      if (side.cards) parts.push(side.cards + ' card' + (side.cards > 1 ? 's' : ''));
      return parts.length ? parts.join(' + ') : 'nothing';
    }
    updateBalance();

    var m = UI.modal(box);
    $('#tc-cancel', box).onclick = m.close;
    $('#tc-send', box).onclick = function () {
      if (!give.props.length && !give.cash && !give.cards && !get.props.length && !get.cash && !get.cards) return UI.toast('Add something to the trade.', 'bad');
      MONO.act('tradePropose', { to: toId, give: give, get: get });
      m.close();
    };
  }

  // ---- incoming offer ----
  var incoming = null, incomingId = null;
  function renderIncoming(s) {
    var tr = s.pending; if (!tr || tr.kind !== 'trade' || tr.to !== Store.me()) return;
    if (incomingId === tr.id) return;          // already showing this one
    incomingId = tr.id;
    var from = pById(s, tr.from);
    var box = el('div');
    box.innerHTML = '<h2>' + esc(from ? from.name : '?') + ' offers a trade</h2>' +
      '<div class="balance">You receive <b>' + describe(s, tr.give) + '</b><br>You give <b>' + describe(s, tr.get) + '</b></div>' +
      '<div class="row"><button class="btn-bad" id="ti-no">Decline</button><button class="btn-go" id="ti-yes">Accept</button></div>';
    incoming = UI.modal(box, { sticky: true });
    $('#ti-no', box).onclick = function () { MONO.act('tradeRespond', { accept: false }); };
    $('#ti-yes', box).onclick = function () { MONO.act('tradeRespond', { accept: true }); };
  }
  function describe(s, side) {
    var parts = [];
    if (side.cash) parts.push(money(side.cash));
    (side.props || []).forEach(function (i) { parts.push(tile(i).name); });
    if (side.cards) parts.push(side.cards + ' get-out card' + (side.cards > 1 ? 's' : ''));
    return parts.length ? parts.join(', ') : 'nothing';
  }
  function closeIncoming(s) {
    if (incoming && (!s.pending || s.pending.kind !== 'trade' || s.pending.to !== Store.me())) { incoming.close(); incoming = null; incomingId = null; }
  }

  MONO.Trade = {
    openPicker: openPicker, renderIncoming: renderIncoming, closeIncoming: closeIncoming,
    _init: function () { Board = MONO.Board; }
  };
})(typeof window !== 'undefined' ? window : this);
