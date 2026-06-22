/* ==========================================================================
   ai.js — AI opponent. Three tiers, generalised to polyomino ships, with an
   ability policy for "ability mode". Only ever reads the public shot grid +
   the shapes of ships it has already sunk (no peeking at hidden placements).
   Exposed globally as window.BS.AI
   ========================================================================== */
(function (root) {
  'use strict';

  var CELL = root.BS.CELL;
  var Shapes = root.BS.Shapes;

  function AI(size, difficulty, fleetDef) {
    this.size = size;
    this.difficulty = difficulty || 'sailor';
    this.remaining = (fleetDef || []).map(function (s) { return { len: s.shape.length, shape: s.shape }; })
      .sort(function (a, b) { return b.len - a.len; });
    this.charges = { sonar: 2, barrage: 1, torpedo: 1 };
    this.queue = [];      // priority targets (e.g. from a sonar hit)
  }

  function pick(list) { return list.length ? list[Math.floor(Math.random() * list.length)] : null; }

  AI.prototype.inBounds = function (r, c) { return r >= 0 && c >= 0 && r < this.size && c < this.size; };

  AI.prototype.untouched = function (shots) {
    var l = [];
    for (var r = 0; r < this.size; r++) for (var c = 0; c < this.size; c++) if (shots[r][c] === CELL.EMPTY) l.push({ r: r, c: c });
    return l;
  };
  AI.prototype.activeHits = function (shots) {
    var l = [];
    for (var r = 0; r < this.size; r++) for (var c = 0; c < this.size; c++) if (shots[r][c] === CELL.HIT) l.push({ r: r, c: c });
    return l;
  };
  AI.prototype.minRemaining = function () {
    if (!this.remaining.length) return 2;
    return Math.min.apply(null, this.remaining.map(function (s) { return s.len; }));
  };

  // ---- top-level plan (decides ability vs normal shot) -----------------------
  // returns: {type:'fire', cell} | {type:'sonar'|'barrage'|'torpedo', cells, center?}
  AI.prototype.planTurn = function (shots, abilitiesOn) {
    // drain any queued targets first (e.g. sonar contacts)
    while (this.queue.length) {
      var q = this.queue.shift();
      if (this.inBounds(q.r, q.c) && shots[q.r][q.c] === CELL.EMPTY) return { type: 'fire', cell: q };
    }
    var hits = this.activeHits(shots);
    if (abilitiesOn && this.difficulty !== 'cadet' && hits.length === 0) {
      if (this.charges.sonar > 0 && Math.random() < 0.5) {
        var ar = this.bestArea(shots); if (ar) return { type: 'sonar', center: ar.center, cells: ar.cells };
      }
      if (this.charges.barrage > 0 && Math.random() < 0.4) {
        var b = this.bestArea(shots); if (b) return { type: 'barrage', center: b.center, cells: b.cells };
      }
      if (this.charges.torpedo > 0 && Math.random() < 0.4) {
        var ln = this.bestLine(shots); if (ln) return { type: 'torpedo', cells: ln };
      }
    }
    return { type: 'fire', cell: this.chooseMove(shots) };
  };

  AI.prototype.spend = function (kind) { if (this.charges[kind] > 0) this.charges[kind]--; };
  AI.prototype.queueCells = function (cells) {
    var self = this;
    cells.forEach(function (p) { if (p.ship) self.queue.push({ r: p.r, c: p.c }); });
  };

  AI.prototype.recordResult = function (move, res) {
    if (res && res.result === 'sunk' && res.sunkShip) {
      var len = res.sunkShip.len, idx = -1;
      for (var i = 0; i < this.remaining.length; i++) if (this.remaining[i].len === len) { idx = i; break; }
      if (idx !== -1) this.remaining.splice(idx, 1);
    }
  };

  // ---- normal targeting ------------------------------------------------------
  AI.prototype.chooseMove = function (shots) {
    switch (this.difficulty) {
      case 'cadet': return pick(this.untouched(shots));
      case 'admiral': return this.densityMove(shots);
      default: return this.huntTargetMove(shots);
    }
  };

  AI.prototype.huntTargetMove = function (shots) {
    var hits = this.activeHits(shots);
    if (hits.length) { var t = pick(this.targetCandidates(shots, hits)); if (t) return t; }
    var step = this.minRemaining() >= 2 ? 2 : 1;
    var open = this.untouched(shots), parity = [];
    for (var i = 0; i < open.length; i++) if ((open[i].r + open[i].c) % step === 0) parity.push(open[i]);
    return pick(parity.length ? parity : open);
  };

  AI.prototype.targetCandidates = function (shots, hits) {
    var byKey = {}; hits.forEach(function (h) { byKey[h.r + ',' + h.c] = true; });
    var dir = [], omni = [], self = this;
    hits.forEach(function (h) {
      var hL = byKey[h.r + ',' + (h.c - 1)], hR = byKey[h.r + ',' + (h.c + 1)];
      var vU = byKey[(h.r - 1) + ',' + h.c], vD = byKey[(h.r + 1) + ',' + h.c];
      if (hL || hR) { dir.push({ r: h.r, c: h.c - 1 }, { r: h.r, c: h.c + 1 }); }
      if (vU || vD) { dir.push({ r: h.r - 1, c: h.c }, { r: h.r + 1, c: h.c }); }
      omni.push({ r: h.r - 1, c: h.c }, { r: h.r + 1, c: h.c }, { r: h.r, c: h.c - 1 }, { r: h.r, c: h.c + 1 });
    });
    var pool = dir.length ? dir : omni;
    return pool.filter(function (p) { return self.inBounds(p.r, p.c) && shots[p.r][p.c] === CELL.EMPTY; });
  };

  // ---- probability density (generalised to shapes) ---------------------------
  AI.prototype.densityMap = function (shots) {
    var size = this.size, prob = [];
    for (var r = 0; r < size; r++) prob.push(new Array(size).fill(0));
    var hasHits = this.activeHits(shots).length > 0;
    var self = this;
    this.remaining.forEach(function (ship) {
      Shapes.rotations(ship.shape).forEach(function (rotn) {
        var bb = Shapes.bbox(rotn.cells);
        for (var r = 0; r <= size - bb.h; r++) {
          for (var c = 0; c <= size - bb.w; c++) {
            var ok = true, coversHit = 0, cells = [];
            for (var k = 0; k < rotn.cells.length; k++) {
              var rr = r + rotn.cells[k][0], cc = c + rotn.cells[k][1];
              var st = shots[rr][cc];
              if (st === CELL.MISS || st === CELL.SUNK) { ok = false; break; }
              if (st === CELL.HIT) coversHit++;
              cells.push({ r: rr, c: cc, st: st });
            }
            if (!ok) continue;
            if (hasHits && coversHit === 0) continue;
            var w = hasHits ? (1 + coversHit * 25) : 1;
            for (var m = 0; m < cells.length; m++) if (cells[m].st === CELL.EMPTY) prob[cells[m].r][cells[m].c] += w;
          }
        }
      });
    });
    return prob;
  };

  AI.prototype.densityMove = function (shots) {
    var prob = this.densityMap(shots), best = -1, cells = [];
    for (var r = 0; r < this.size; r++) for (var c = 0; c < this.size; c++) {
      if (shots[r][c] !== CELL.EMPTY) continue;
      var v = prob[r][c];
      if (v > best) { best = v; cells = [{ r: r, c: c }]; }
      else if (v === best) cells.push({ r: r, c: c });
    }
    if (best <= 0) return this.huntTargetMove(shots);
    return pick(cells);
  };

  // ---- ability target selection ---------------------------------------------
  AI.prototype.areaCells = function (cr, cc) {
    var out = [];
    for (var r = cr - 1; r <= cr + 1; r++) for (var c = cc - 1; c <= cc + 1; c++) if (this.inBounds(r, c)) out.push({ r: r, c: c });
    return out;
  };
  AI.prototype.bestArea = function (shots) {
    var prob = this.densityMap(shots), best = -1, center = null;
    for (var r = 0; r < this.size; r++) for (var c = 0; c < this.size; c++) {
      var sum = 0, cnt = 0, cells = this.areaCells(r, c);
      for (var i = 0; i < cells.length; i++) { var p = cells[i]; if (shots[p.r][p.c] === CELL.EMPTY) { sum += prob[p.r][p.c]; cnt++; } }
      if (cnt >= 4 && sum > best) { best = sum; center = { r: r, c: c }; }
    }
    if (!center) return null;
    return { center: center, cells: this.areaCells(center.r, center.c) };
  };
  AI.prototype.bestLine = function (shots) {
    var bestN = -1, line = null;
    for (var r = 0; r < this.size; r++) {
      var cells = [], n = 0;
      for (var c = 0; c < this.size; c++) { cells.push({ r: r, c: c }); if (shots[r][c] === CELL.EMPTY) n++; }
      if (n > bestN) { bestN = n; line = cells; }
    }
    for (var c2 = 0; c2 < this.size; c2++) {
      var cc = [], n2 = 0;
      for (var r2 = 0; r2 < this.size; r2++) { cc.push({ r: r2, c: c2 }); if (shots[r2][c2] === CELL.EMPTY) n2++; }
      if (n2 > bestN) { bestN = n2; line = cc; }
    }
    return line;
  };

  root.BS = root.BS || {};
  root.BS.AI = AI;

})(typeof window !== 'undefined' ? window : this);
