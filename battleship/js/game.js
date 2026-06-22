/* ==========================================================================
   game.js — Pure Battleship engine (no DOM/audio/theme).
   Ships are polyominoes (arbitrary cell shapes) with 4-way rotation, so the
   fleet can include L / T / square / S pieces, not just straight lines.
   Exposed globally as window.BS.{Game,Board,CELL,FLEETS,Shapes}
   ========================================================================== */
(function (root) {
  'use strict';

  var CELL = { EMPTY: 0, MISS: 1, HIT: 2, SUNK: 3 };

  // ---- shape helpers ---------------------------------------------------------
  // A shape is an array of [dr,dc] offsets. We normalise so the min row/col = 0.
  function normalize(cells) {
    var minR = Infinity, minC = Infinity;
    cells.forEach(function (p) { if (p[0] < minR) minR = p[0]; if (p[1] < minC) minC = p[1]; });
    return cells.map(function (p) { return [p[0] - minR, p[1] - minC]; });
  }
  // rotate 90° clockwise `times`: (r,c) -> (c,-r)
  function rotate(cells, times) {
    var out = cells.map(function (p) { return p.slice(); });
    times = ((times % 4) + 4) % 4;
    for (var t = 0; t < times; t++) out = out.map(function (p) { return [p[1], -p[0]]; });
    return normalize(out);
  }
  function bbox(cells) {
    var maxR = 0, maxC = 0;
    cells.forEach(function (p) { if (p[0] > maxR) maxR = p[0]; if (p[1] > maxC) maxC = p[1]; });
    return { h: maxR + 1, w: maxC + 1 };
  }
  // distinct rotations (square/dot collapse to fewer)
  function rotations(cells) {
    var seen = {}, out = [];
    for (var t = 0; t < 4; t++) {
      var r = rotate(cells, t);
      var key = r.map(function (p) { return p[0] + ',' + p[1]; }).sort().join(';');
      if (!seen[key]) { seen[key] = true; out.push({ rot: t, cells: r }); }
    }
    return out;
  }

  // canonical shapes
  var SH = {
    I2: [[0, 0], [0, 1]],
    I3: [[0, 0], [0, 1], [0, 2]],
    I4: [[0, 0], [0, 1], [0, 2], [0, 3]],
    I5: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
    L3: [[0, 0], [1, 0], [1, 1]],
    L4: [[0, 0], [1, 0], [2, 0], [2, 1]],
    T4: [[0, 0], [0, 1], [0, 2], [1, 1]],
    S4: [[0, 1], [0, 2], [1, 0], [1, 1]],
    O4: [[0, 0], [0, 1], [1, 0], [1, 1]],
    dot: [[0, 0]]
  };

  // ---- fleet presets ---------------------------------------------------------
  function ship(id, name, shape) { return { id: id, name: name, shape: shape }; }
  var FLEETS = {
    skirmish: {
      label: 'Skirmish', desc: '3 ships · fast & deadly',
      ships: [ship('cruiser', 'Cruiser', SH.I3), ship('submarine', 'Submarine', SH.I3), ship('destroyer', 'Destroyer', SH.I2)]
    },
    classic: {
      label: 'Classic', desc: '5 ships · the original line-up',
      ships: [
        ship('carrier', 'Carrier', SH.I5), ship('battleship', 'Battleship', SH.I4),
        ship('cruiser', 'Cruiser', SH.I3), ship('submarine', 'Submarine', SH.I3),
        ship('destroyer', 'Destroyer', SH.I2)
      ]
    },
    armada: {
      label: 'Armada', desc: '7 ships · total war',
      ships: [
        ship('carrier', 'Carrier', SH.I5), ship('battleship', 'Battleship', SH.I4),
        ship('cruiser', 'Cruiser', SH.I3), ship('submarine', 'Submarine', SH.I3),
        ship('destroyer', 'Destroyer', SH.I2), ship('frigate', 'Frigate', SH.I2),
        ship('patrol', 'Patrol Boat', SH.dot)
      ]
    },
    tactical: {
      label: 'Tactical', desc: '5 ships · L / T / square hulls',
      ships: [
        ship('carrier', 'Carrier', SH.I5), ship('hauler', 'Hauler', SH.L4),
        ship('hammer', 'Hammerhead', SH.T4), ship('bunker', 'Bunker', SH.O4),
        ship('skiff', 'Skiff', SH.L3)
      ]
    },
    vanguard: {
      label: 'Vanguard', desc: '5 ships · all bent hulls',
      ships: [
        ship('fortress', 'Fortress', SH.O4), ship('wing', 'Wing', SH.L4),
        ship('arrow', 'Arrowhead', SH.T4), ship('zag', 'Zag', SH.S4),
        ship('picket', 'Picket', SH.I2)
      ]
    }
  };

  // ---------------------------------------------------------------------------
  function Board(size, fleetDef) {
    this.size = size;
    this.grid = makeGrid(size, null);
    this.shots = makeGrid(size, CELL.EMPTY);
    this.detected = makeGrid(size, false);   // sonar reveals (attacker's view)
    this.ships = (fleetDef || []).map(function (s) {
      return {
        id: s.id, name: s.name, shape: s.shape, len: s.shape.length,
        cells: [], rot: 0, anchor: null, placed: false, hits: 0, sunk: false
      };
    });
  }

  Board.prototype.shipById = function (id) {
    for (var i = 0; i < this.ships.length; i++) if (this.ships[i].id === id) return this.ships[i];
    return null;
  };

  // absolute cells for a shape placed at anchor (r,c) with rotation `rot`
  Board.prototype.footprint = function (shape, rot, r, c) {
    return rotate(shape, rot).map(function (p) { return { r: r + p[0], c: c + p[1] }; });
  };
  Board.prototype.bboxOf = function (shape, rot) { return bbox(rotate(shape, rot)); };

  Board.prototype.canPlaceShape = function (shape, rot, r, c, ignoreId) {
    var cells = this.footprint(shape, rot, r, c);
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.r < 0 || cell.c < 0 || cell.r >= this.size || cell.c >= this.size) return false;
      var occ = this.grid[cell.r][cell.c];
      if (occ !== null && occ !== ignoreId) return false;
    }
    return true;
  };

  Board.prototype.place = function (id, r, c, rot) {
    var s = this.shipById(id);
    if (!s) return false;
    if (!this.canPlaceShape(s.shape, rot, r, c, id)) return false;
    this.clearShip(id);
    var cells = this.footprint(s.shape, rot, r, c);
    for (var i = 0; i < cells.length; i++) this.grid[cells[i].r][cells[i].c] = id;
    s.cells = cells; s.rot = rot; s.anchor = { r: r, c: c }; s.placed = true;
    return true;
  };

  Board.prototype.clearShip = function (id) {
    var s = this.shipById(id);
    if (!s) return;
    for (var i = 0; i < s.cells.length; i++) {
      var cell = s.cells[i];
      if (this.grid[cell.r][cell.c] === id) this.grid[cell.r][cell.c] = null;
    }
    s.cells = []; s.placed = false;
  };

  Board.prototype.clearAll = function () {
    this.grid = makeGrid(this.size, null);
    this.detected = makeGrid(this.size, false);
    for (var i = 0; i < this.ships.length; i++) {
      var s = this.ships[i];
      s.cells = []; s.placed = false; s.hits = 0; s.sunk = false; s.rot = 0; s.anchor = null;
    }
  };

  Board.prototype.allPlaced = function () { return this.ships.every(function (s) { return s.placed; }); };

  Board.prototype.randomize = function (rng) {
    rng = rng || Math.random;
    this.clearAll();
    for (var i = 0; i < this.ships.length; i++) {
      var s = this.ships[i], placed = false, attempts = 0;
      while (!placed && attempts < 2000) {
        attempts++;
        var rot = Math.floor(rng() * 4);
        var bb = this.bboxOf(s.shape, rot);
        var r = Math.floor(rng() * (this.size - bb.h + 1));
        var c = Math.floor(rng() * (this.size - bb.w + 1));
        if (this.canPlaceShape(s.shape, rot, r, c, s.id)) { this.place(s.id, r, c, rot); placed = true; }
      }
      if (!placed) this.placeFirstFit(s);
    }
  };

  Board.prototype.placeFirstFit = function (s) {
    for (var rot = 0; rot < 4; rot++) {
      var bb = this.bboxOf(s.shape, rot);
      for (var r = 0; r <= this.size - bb.h; r++)
        for (var c = 0; c <= this.size - bb.w; c++)
          if (this.canPlaceShape(s.shape, rot, r, c, s.id)) { this.place(s.id, r, c, rot); return; }
    }
  };

  Board.prototype.receiveFire = function (r, c) {
    if (r < 0 || c < 0 || r >= this.size || c >= this.size) return { valid: false };
    if (this.shots[r][c] !== CELL.EMPTY) return { valid: false, already: true };
    var id = this.grid[r][c];
    if (id === null) { this.shots[r][c] = CELL.MISS; return { valid: true, result: 'miss', r: r, c: c }; }
    this.shots[r][c] = CELL.HIT;
    var s = this.shipById(id);
    s.hits++;
    var sunk = s.hits >= s.len;
    if (sunk) { s.sunk = true; for (var i = 0; i < s.cells.length; i++) this.shots[s.cells[i].r][s.cells[i].c] = CELL.SUNK; }
    return { valid: true, result: sunk ? 'sunk' : 'hit', r: r, c: c, shipId: id, sunkShip: sunk ? s : null, gameOver: this.allSunk() };
  };

  // sonar: report ship presence for the given cells (no damage)
  Board.prototype.scan = function (cells) {
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var p = cells[i];
      if (p.r < 0 || p.c < 0 || p.r >= this.size || p.c >= this.size) continue;
      out.push({ r: p.r, c: p.c, ship: this.grid[p.r][p.c] !== null });
    }
    return out;
  };

  Board.prototype.allSunk = function () { return this.ships.length > 0 && this.ships.every(function (s) { return s.sunk; }); };
  Board.prototype.shipsRemaining = function () { return this.ships.filter(function (s) { return !s.sunk; }).length; };
  Board.prototype.cellsRemaining = function () { var t = 0; for (var i = 0; i < this.ships.length; i++) t += (this.ships[i].len - this.ships[i].hits); return t; };

  // ---------------------------------------------------------------------------
  function Game(opts) {
    opts = opts || {};
    this.size = opts.size || 10;
    this.fleetKey = opts.fleet || 'classic';
    var def = (FLEETS[this.fleetKey] || FLEETS.classic).ships;
    this.fleetDef = def;
    this.human = new Board(this.size, def);
    this.ai = new Board(this.size, def);
    this.phase = 'placement';
    this.turn = 'human';
    this.winner = null;
    this.stats = { human: { shots: 0, hits: 0 }, ai: { shots: 0, hits: 0 } };
  }

  Game.prototype.startBattle = function (rng) {
    this.ai.randomize(rng);
    this.phase = 'battle'; this.turn = 'human'; this.winner = null;
  };
  Game.prototype.humanFire = function (r, c) {
    if (this.phase !== 'battle' || this.turn !== 'human') return { valid: false };
    var res = this.ai.receiveFire(r, c);
    if (!res.valid) return res;
    this.stats.human.shots++;
    if (res.result === 'hit' || res.result === 'sunk') this.stats.human.hits++;
    if (res.gameOver) { this.phase = 'over'; this.winner = 'human'; }
    else if (res.result === 'miss') this.turn = 'ai';
    return res;
  };
  Game.prototype.aiFire = function (r, c) {
    if (this.phase !== 'battle' || this.turn !== 'ai') return { valid: false };
    var res = this.human.receiveFire(r, c);
    if (!res.valid) return res;
    this.stats.ai.shots++;
    if (res.result === 'hit' || res.result === 'sunk') this.stats.ai.hits++;
    if (res.gameOver) { this.phase = 'over'; this.winner = 'ai'; }
    else if (res.result === 'miss') this.turn = 'human';
    return res;
  };

  function makeGrid(size, fill) {
    var g = [];
    for (var r = 0; r < size; r++) { var row = []; for (var c = 0; c < size; c++) row.push(fill); g.push(row); }
    return g;
  }

  root.BS = root.BS || {};
  root.BS.Game = Game;
  root.BS.Board = Board;
  root.BS.CELL = CELL;
  root.BS.FLEETS = FLEETS;
  root.BS.Shapes = { rotate: rotate, normalize: normalize, bbox: bbox, rotations: rotations, SH: SH };

})(typeof window !== 'undefined' ? window : this);
