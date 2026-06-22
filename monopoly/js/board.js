/* ==========================================================================
   board.js — builds the 11×11 board, paints tiles, and positions / animates
   player tokens.  Exposed as window.MONO.Board
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var UI = MONO.UI, B = MONO.board, TILES = B.TILES, GROUPS = B.GROUPS;

  var built = false, tileEls = [], tokenEls = {}, timers = [];

  function gridPos(i) {
    if (i === 0) return { r: 11, c: 11 };
    if (i < 10) return { r: 11, c: 11 - i };
    if (i === 10) return { r: 11, c: 1 };
    if (i < 20) return { r: 21 - i, c: 1 };
    if (i === 20) return { r: 1, c: 1 };
    if (i < 30) return { r: 1, c: i - 19 };
    if (i === 30) return { r: 1, c: 11 };
    return { r: i - 29, c: 11 };
  }
  function groupColor(g) { return GROUPS[g] ? GROUPS[g].color : 'var(--border)'; }
  function abbrev(name) { return name.length > 16 ? name.slice(0, 15) + '…' : name; }

  var CORNER = { 0: ['🏁', 'GO'], 10: ['🔒', 'JAIL'], 20: ['🅿️', 'FREE'], 30: ['🚓', 'GO TO JAIL'] };

  function tileMarkup(t) {
    if (CORNER[t.i]) return '<div class="ico">' + CORNER[t.i][0] + '</div><div class="cap">' + CORNER[t.i][1] + '</div>';
    if (t.type === 'street') return '<div class="bar" style="background:' + groupColor(t.group) + '"></div><div class="houses"></div><div class="nm">' + abbrev(t.name) + '</div><div class="pr">$' + t.price + '</div>';
    if (t.type === 'rail') return '<div class="bar" style="background:' + groupColor('rail') + '"></div><div class="houses"></div><div class="nm">🚂 ' + abbrev(t.name) + '</div><div class="pr">$' + t.price + '</div>';
    if (t.type === 'utility') return '<div class="bar" style="background:' + groupColor('utility') + '"></div><div class="houses"></div><div class="nm">' + (t.i === 12 ? '⚡' : '💧') + ' ' + abbrev(t.name) + '</div><div class="pr">$' + t.price + '</div>';
    if (t.type === 'tax') return '<div class="ico">💸</div><div class="nm">' + abbrev(t.name) + '</div><div class="pr">$' + t.amount + '</div>';
    if (t.type === 'chance') return '<div class="ico">❓</div><div class="nm">Chance</div>';
    if (t.type === 'chest') return '<div class="ico">🎁</div><div class="nm">Chest</div>';
    return '<div class="nm">' + abbrev(t.name) + '</div>';
  }

  function build() {
    if (built) return;
    var board = UI.$('#board'); if (!board) return;
    board.innerHTML = ''; tileEls = [];
    TILES.forEach(function (t) {
      var p = gridPos(t.i);
      var cls = 'tile' + (CORNER[t.i] ? ' corner' : (t.type === 'street' || t.type === 'rail' || t.type === 'utility' ? '' : ' special'));
      var e = UI.el('div', cls);
      e.style.gridRow = p.r; e.style.gridColumn = p.c;
      e.setAttribute('data-tile', t.i);
      e.innerHTML = tileMarkup(t);
      board.appendChild(e);
      tileEls[t.i] = e;
    });
    built = true;
  }

  // paint ownership / houses / mortgage from a snapshot
  function paint(state) {
    if (!built) build();
    TILES.forEach(function (t) {
      var e = tileEls[t.i]; if (!e) return;
      var r = state.props && state.props[t.i];
      e.classList.remove('owned', 'mortgaged');
      e.style.removeProperty('--own');
      var dot = e.querySelector('.ownerdot'); if (dot) dot.remove();
      var houses = e.querySelector('.houses'); if (houses) houses.innerHTML = '';
      if (r && r.owner) {
        var ownerP = playerById(state, r.owner);
        var col = ownerP ? ownerP.color : 'var(--glow)';
        e.classList.add('owned'); e.style.setProperty('--own', col);
        var od = UI.el('span', 'ownerdot'); e.appendChild(od);
        if (r.mortgaged) e.classList.add('mortgaged');
        if (houses && r.houses > 0) {
          if (r.houses === 5) houses.appendChild(UI.el('i', 'hotel'));
          else for (var h = 0; h < r.houses; h++) houses.appendChild(UI.el('i'));
        }
      }
    });
  }
  function playerById(state, id) { for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i]; return null; }

  function flash(i) { var e = tileEls[i]; if (e) { e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash'); } }

  // ---- tokens ----
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function wrapRect() { var w = UI.$('#board-wrap'); return w ? w.getBoundingClientRect() : { left: 0, top: 0, width: 0 }; }
  function centerOf(i, wr) { var e = tileEls[i]; if (!e) return { x: 0, y: 0 }; var r = e.getBoundingClientRect(); return { x: r.left - wr.left + r.width / 2, y: r.top - wr.top + r.height / 2 }; }

  function ensureToken(p) {
    var t = tokenEls[p.id];
    if (!t) { t = UI.el('div', 'token', p.emoji || '•'); UI.$('#tokens').appendChild(t); tokenEls[p.id] = t; }
    t.style.setProperty('--tc', p.color || '#fff');
    return t;
  }
  function removeToken(id) { if (tokenEls[id]) { tokenEls[id].remove(); delete tokenEls[id]; } }

  // compute final positions for every active player, clustering co-located ones
  function layout(state, wr) {
    var byTile = {}, pos = {};
    state.players.forEach(function (p) { if (p.bankrupt) return; (byTile[p.position] = byTile[p.position] || []).push(p.id); });
    var per = wr.width / 11, step = per * 0.28;
    Object.keys(byTile).forEach(function (tileIdx) {
      var ids = byTile[tileIdx], n = ids.length, cols = Math.min(4, Math.ceil(Math.sqrt(n))), rows = Math.ceil(n / cols);
      var c = centerOf(+tileIdx, wr);
      ids.forEach(function (id, k) {
        var col = k % cols, rw = Math.floor(k / cols);
        pos[id] = { x: c.x + (col - (cols - 1) / 2) * step, y: c.y + (rw - (rows - 1) / 2) * step };
      });
    });
    return pos;
  }

  function place(t, p) { t.style.left = p.x + 'px'; t.style.top = p.y + 'px'; }

  // sync(state, moved) — moved:{id,from,to} animates a stepping move
  function sync(state, moved) {
    if (!built) build();
    clearTimers();
    var wr = wrapRect();
    // remove tokens for bankrupt/absent players
    Object.keys(tokenEls).forEach(function (id) { var p = playerById(state, id); if (!p || p.bankrupt) removeToken(id); });
    state.players.forEach(function (p) { if (!p.bankrupt) ensureToken(p); });
    var pos = layout(state, wr);

    var animId = null, dist = 0;
    if (moved && moved.id && moved.from != null && moved.to != null) {
      dist = (moved.to - moved.from + 40) % 40;
      if (dist >= 1 && dist <= 12 && tokenEls[moved.id]) animId = moved.id;
    }
    // place everyone except the animating token
    state.players.forEach(function (p) {
      if (p.bankrupt || p.id === animId) return;
      var t = tokenEls[p.id]; if (t && pos[p.id]) place(t, pos[p.id]);
      if (t) t.classList.toggle('active-tok', state.turn && state.turn.activeId === p.id);
    });

    if (animId) {
      var tok = tokenEls[animId];
      tok.classList.toggle('active-tok', state.turn && state.turn.activeId === animId);
      var i, delay = 0;
      for (var s = 1; s <= dist; s++) {
        (function (idx, last) {
          timers.push(setTimeout(function () {
            var w2 = wrapRect(), c = centerOf(idx, w2);
            place(tok, c);
            tok.classList.remove('hop'); void tok.offsetWidth; tok.classList.add('hop');
            if (MONO.Audio) MONO.Audio.play(last ? 'land' : 'step');
            if (last && pos[animId]) place(tok, pos[animId]);
          }, delay));
        })((moved.from + s) % 40, s === dist);
        delay += 135;
      }
    }
  }

  function relayout(state) { if (state && built) sync(state, null); }

  MONO.Board = {
    build: build, paint: paint, sync: sync, flash: flash, relayout: relayout,
    tileEl: function (i) { return tileEls[i]; }, groupColor: groupColor, centerOf: function (i) { return centerOf(i, wrapRect()); }
  };
})(typeof window !== 'undefined' ? window : this);
