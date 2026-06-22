/* ==========================================================================
   auction.js — live property auction modal.  Exposed as window.MONO.Auction
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, Store = MONO.Store, B = MONO.board, TILES = B.TILES;
  var money = UI.money, el = UI.el, esc = UI.esc, $ = UI.$;

  var modal = null, ticker = null;

  function pById(s, id) { for (var i = 0; i < s.players.length; i++) if (s.players[i].id === id) return s.players[i]; return null; }

  function render(s) {
    var au = s.pending; if (!au || au.kind !== 'auction') return;
    if (!modal) {
      var box = el('div', 'auction'); box.id = 'auction-box';
      modal = UI.modal(box, { sticky: true });
      ticker = setInterval(function () { var cur = Store.get(); if (cur && cur.pending && cur.pending.kind === 'auction') update(cur); }, 1000);
    }
    update(s);
  }

  function update(s) {
    var au = s.pending, box = $('#auction-box'); if (!box) return;
    var me = Store.myPlayer();
    var inIt = me && !me.bankrupt && au.active.indexOf(me.id) >= 0;
    var high = au.high;
    var secs = au.deadline ? Math.max(0, Math.ceil((au.deadline - Date.now()) / 1000)) : null;
    var bidders = au.active.map(function (id) { var p = pById(s, id); return p ? '<span class="pchip" style="--own:' + esc(p.color) + '">' + esc(p.emoji) + ' ' + esc(p.name) + '</span>' : ''; }).join(' ');

    box.innerHTML = '<h2>🔨 Auction</h2>' +
      '<div class="lot">' + esc(TILES[au.tile].name) + '</div>' +
      '<div class="high">' + (high ? money(high.amount) + ' — ' + esc((pById(s, high.id) || {}).name || '') : 'no bids yet') + '</div>' +
      '<div class="dim sm" style="text-align:center">' + (secs != null ? secs + 's left' : '') + '</div>' +
      '<div class="bidders">' + bidders + '</div>';

    if (inIt) {
      var base = high ? high.amount : 0;
      var quick = el('div', 'quick');
      [10, 50, 100].forEach(function (inc) {
        var amt = base + inc;
        var b = el('button', 'ghost sm', '+' + money(inc));
        b.disabled = amt > me.cash;
        b.onclick = function () { MONO.act('auctionBid', { amount: amt }); };
        quick.appendChild(b);
      });
      box.appendChild(quick);
      var customRow = el('div', 'trade-cash'); customRow.style.justifyContent = 'center';
      customRow.innerHTML = '<input type="number" min="' + (base + 1) + '" max="' + me.cash + '" placeholder="amount" style="width:110px">';
      var customBtn = el('button', 'primary', 'Bid');
      customBtn.onclick = function () { var v = +customRow.querySelector('input').value || 0; MONO.act('auctionBid', { amount: v }); };
      customRow.appendChild(customBtn);
      box.appendChild(customRow);
      var pass = el('button', 'btn-bad full', 'Pass'); pass.style.marginTop = '.6rem';
      pass.onclick = function () { MONO.act('auctionPass'); };
      box.appendChild(pass);
      box.appendChild(el('div', 'dim sm', 'Your cash: ' + money(me.cash)));
    } else {
      box.appendChild(el('div', 'dim sm', me && me.bankrupt ? 'Spectating the auction.' : 'You passed.'));
    }
  }

  function close() {
    if (modal) { modal.close(); modal = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  MONO.Auction = { render: render, close: close };
})(typeof window !== 'undefined' ? window : this);
