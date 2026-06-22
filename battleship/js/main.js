/* ==========================================================================
   main.js — App controller. Owns settings + game state and wires the engine,
   AI, audio, FX and view together into the full game flow.
   ========================================================================== */
(function (root) {
  'use strict';

  var BS = root.BS;
  var UI = BS.UI, Audio = BS.Audio, FX = BS.FX, Store = BS.Store, THEMES = BS.THEMES;
  var $ = UI.$, $$ = UI.$$;

  var S = {
    settings: null,
    stats: null,
    game: null,
    ai: null,
    locked: false,            // input lock during AI / animations
    selected: null,           // ship id being placed
    rot: 0,                   // placement rotation (0-3)
    charges: { sonar: 2, barrage: 1, torpedo: 1 },
    ability: null,            // armed ability awaiting a target
    abilityOrient: 'row',     // torpedo line orientation
    peerGone: false,          // online: opponent disconnected
    rematchSent: false, rematchPeer: false,
    cursor: { r: 0, c: 0 },
    started: false,           // first user gesture (audio unlock)
    gen: 0,                   // game generation — invalidates stale timeouts
    fleetReady: false,        // tracks placement-complete transition
    mode: 'local',            // 'local' (vs AI) | 'online' (vs peer)
    net: null,                // active transport
    netKind: 'local',         // 'local' (BroadcastChannel) | 'ably'
    role: 'host',             // 'host' | 'guest'
    myTurn: false,            // online: is it my turn to fire?
    iAmReady: false,          // online: I finished placement
    peerReady: false,         // online: opponent finished placement
    sessionStarted: false,    // online: handshake/board build done
    battleStarted: false,     // online: battle began (guard)
    diffNotes: {
      cadet: 'Fires blind. A gentle warm-up.',
      sailor: 'Hunts methodically once it lands a hit.',
      admiral: 'Probability-density targeting. Merciless.'
    }
  };

  // ---- DOM refs --------------------------------------------------------------
  var boardPlayer, boardEnemy, scopePlayer, scopeEnemy, tray, logEl;

  function theme() { return THEMES[S.settings.theme] || THEMES.abyss; }
  function fxColors() { return theme().fx; }

  // =====================================================================
  // BOOT
  // =====================================================================
  function boot() {
    S.settings = Store.load();
    S.stats = Store.loadStats();
    boardPlayer = $('#board-player'); boardEnemy = $('#board-enemy');
    scopePlayer = boardPlayer.closest('.board-scope');
    scopeEnemy = boardEnemy.closest('.board-scope');
    tray = $('#ship-tray'); logEl = $('#log');

    FX.init();
    applyTheme(S.settings.theme, true);
    FX.setReducedMotion(S.settings.reduced || prefersReduced());
    Audio.setEnabled(S.settings.sound);
    Audio.setMusic(S.settings.music);
    Audio.setVolume(S.settings.volume);

    buildThemeChips($('#title-themes'));
    buildThemeChips($('#settings-themes'));
    syncSettingsControls();
    renderLifetime();

    bindGlobal();
    bindSettings();
    bindPlacement();
    bindBattle();
    bindKeyboard();

    UI.showScreen('title');
    document.body.dataset.phase = 'title';
  }

  function prefersReduced() {
    return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // =====================================================================
  // THEME
  // =====================================================================
  function applyTheme(key, silent) {
    S.settings.theme = key;
    var t = THEMES[key] || THEMES.abyss;
    document.body.dataset.theme = key;
    document.documentElement.style.colorScheme = (key === 'origami') ? 'light' : 'dark';

    $('#brand-name').textContent = t.brand;
    var title = $('#game-title'); title.textContent = t.title; title.dataset.text = t.title;
    $('#game-tagline').textContent = t.tagline;
    $('#play-label').textContent = t.play;
    var startBtn = $('#btn-start'); if (startBtn) startBtn.textContent = t.start;
    $('#theme-chip').textContent = t.label;
    document.title = t.title + ' — A Battleship Game';

    FX.setTheme(key);
    Audio.setTheme(key);
    $$('.theme-chip').forEach(function (chip) {
      chip.setAttribute('aria-checked', chip.dataset.theme === key ? 'true' : 'false');
    });
    Store.save(S.settings);
    if (!silent) Audio.play('toggle');
  }

  function buildThemeChips(container) {
    if (!container) return;
    container.innerHTML = '';
    BS.THEME_ORDER.forEach(function (key) {
      var t = THEMES[key];
      var chip = document.createElement('button');
      chip.className = 'theme-chip';
      chip.dataset.theme = key;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', key === S.settings.theme ? 'true' : 'false');
      chip.innerHTML = '<span class="swatch" style="color:' + t.fx.ping + ';background:' + t.fx.ping + '"></span>' +
        '<span>' + t.label + '</span>';
      chip.addEventListener('click', function () { applyTheme(key); });
      chip.addEventListener('mouseenter', function () { if (S.started) Audio.play('hover'); });
      container.appendChild(chip);
    });
  }

  // =====================================================================
  // NEW GAME / PLACEMENT
  // =====================================================================
  function newGame() {
    S.mode = 'local';
    S.gen++;                  // any pending timeout from a prior game is now stale
    S.rot = 0; S.ability = null;
    S.game = new BS.Game({ size: S.settings.boardSize, fleet: S.settings.fleet });
    S.ai = new BS.AI(S.settings.boardSize, S.settings.difficulty, S.game.fleetDef);
    S.game.ai.randomize();           // hide enemy fleet now
    S.locked = false;
    document.body.classList.remove('win', 'lose');

    UI.buildBoard(boardPlayer, S.settings.boardSize);
    UI.buildBoard(boardEnemy, S.settings.boardSize);
    UI.setTarget(boardEnemy, false);
    UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    enterPlacement();
  }

  function enterPlacement() {
    document.body.dataset.phase = 'placement';
    S.game.phase = 'placement';
    S.selected = S.game.human.ships[0] ? S.game.human.ships[0].id : null;
    S.cursor = { r: 0, c: 0 };
    S.rot = 0; S.ability = null;
    S.fleetReady = false;
    renderTray();
    renderFleets();
    $('#turn-text').textContent = 'Deploy your fleet';
    updateStartButton();
    logEl.innerHTML = '';
    UI.announce('Placement phase. Position your ' + S.game.human.ships.length + ' ships.');
  }

  function renderTray() {
    tray.innerHTML = '';
    S.game.human.ships.forEach(function (s) {
      var tok = document.createElement('div');
      tok.className = 'ship-token' + (s.placed ? ' placed' : '') + (s.id === S.selected ? ' selected' : '');
      tok.dataset.ship = s.id;
      tok.setAttribute('draggable', 'true');
      tok.setAttribute('aria-label', s.name + ', ' + s.len + ' cells' + (s.placed ? ', placed' : ''));
      // mini grid of the ship's shape
      var bb = BS.Shapes.bbox(s.shape);
      var set = {}; s.shape.forEach(function (p) { set[p[0] + ',' + p[1]] = true; });
      var grid = document.createElement('span');
      grid.className = 'ship-shape';
      grid.style.gridTemplateColumns = 'repeat(' + bb.w + ',1fr)';
      for (var rr = 0; rr < bb.h; rr++) for (var cc = 0; cc < bb.w; cc++) {
        var i = document.createElement('i'); if (!set[rr + ',' + cc]) i.className = 'gap'; grid.appendChild(i);
      }
      var name = document.createElement('span'); name.className = 'ship-name'; name.textContent = s.name;
      tok.appendChild(grid); tok.appendChild(name);
      tray.appendChild(tok);
    });
  }

  function selectShip(id) {
    S.selected = id;
    $$('.ship-token', tray).forEach(function (t) {
      t.classList.toggle('selected', t.dataset.ship === id);
    });
  }

  function nextUnplaced() {
    var ships = S.game.human.ships;
    for (var i = 0; i < ships.length; i++) if (!ships[i].placed) return ships[i].id;
    return null;
  }

  function originFor(r, c, ship) {
    // clamp so the rotated shape stays in bounds — forgiving placement
    var bb = S.game.human.bboxOf(ship.shape, S.rot), size = S.game.size;
    return { r: Math.max(0, Math.min(r, size - bb.h)), c: Math.max(0, Math.min(c, size - bb.w)) };
  }

  function previewAt(r, c) {
    if (S.game.phase !== 'placement' || !S.selected) return;
    var ship = S.game.human.shipById(S.selected);
    if (!ship) return;
    var o = originFor(r, c, ship);
    var cells = S.game.human.footprint(ship.shape, S.rot, o.r, o.c);
    var ok = S.game.human.canPlaceShape(ship.shape, S.rot, o.r, o.c, ship.id);
    UI.showPreview(boardPlayer, cells, ok);
  }

  function placeAt(r, c) {
    if (!S.selected) { UI.toast('Pick a ship first'); UI.announce('Pick a ship first'); return; }
    var ship = S.game.human.shipById(S.selected);
    if (!ship) return;
    var o = originFor(r, c, ship);
    if (S.game.human.place(S.selected, o.r, o.c, S.rot)) {
      Audio.play('place');
      UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
      UI.clearPreview(boardPlayer);
      renderTray();
      var nxt = nextUnplaced();
      if (nxt) selectShip(nxt);
      updateStartButton();
      UI.announce(ship.name + ' placed at ' + UI.coordLabel(o.r, o.c));
    } else {
      Audio.play('invalid');
      UI.toast("Can't place there");
      UI.announce("Can't place there");
    }
  }

  function rotateShip() {
    S.rot = (S.rot + 1) % 4;
    Audio.play('rotate');
    previewAt(S.cursor.r, S.cursor.c);
  }

  function randomizeFleet() {
    S.game.human.randomize();
    Audio.play('random');
    UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
    UI.clearPreview(boardPlayer);
    renderTray();
    updateStartButton();
    UI.announce('Fleet auto-placed.');
  }

  function clearFleet() {
    S.game.human.clearAll();
    Audio.play('click');
    UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
    renderTray();
    selectShip(S.game.human.ships[0].id);
    updateStartButton();
  }

  function updateStartButton() {
    var btn = $('#btn-start');
    var ready = S.game.human.allPlaced();
    btn.disabled = !ready;
    if (ready && !S.fleetReady) UI.announce('Fleet ready. Press Start Battle.');
    S.fleetReady = ready;
  }

  // =====================================================================
  // BATTLE
  // =====================================================================
  function startBattle() {
    if (!S.game.human.allPlaced()) return;
    S.mode = 'local';
    S.game.startBattle();
    document.body.dataset.phase = 'battle';
    S.cursor = { r: (S.game.size / 2) | 0, c: (S.game.size / 2) | 0 };
    S.myTurn = true; S.locked = false;
    resetCharges();
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    renderFleets();
    Audio.play('start');
    setTurn();
    UI.pushLog(logEl, 'Battle stations. ' + theme().turn.you + '.', 'you');
    UI.announce('Battle begins. ' + theme().turn.you + '. Fire on enemy waters.');
  }

  function resetCharges() {
    S.charges = { sonar: 2, barrage: 1, torpedo: 1 };
    S.ability = null; S.abilityOrient = 'row';
    document.body.dataset.abilities = S.settings.abilities ? 'on' : 'off';
    updateAbilityBar();
  }

  // single source of truth for turn UI (drives both local and online)
  function setTurn() {
    document.body.dataset.turn = S.myTurn ? 'human' : 'ai';
    $('#turn-text').textContent = S.myTurn ? theme().turn.you
      : (S.mode === 'online' ? "Opponent's move…" : theme().turn.enemy);
    UI.setTarget(boardEnemy, S.myTurn && S.game.phase === 'battle' && !S.locked);
    UI.highlightCoords(scopeEnemy, null);
    updateAbilityBar();
    renderHud();
  }

  function renderHud() {
    var s = S.game.stats;
    var acc = s.human.shots ? Math.round(100 * s.human.hits / s.human.shots) : 0;
    $('#hud-readout').innerHTML =
      'Shots <b>' + s.human.shots + '</b>' +
      ' · Hits <b>' + s.human.hits + '</b>' +
      ' · Acc <b>' + acc + '%</b>' +
      ' · Enemy left <b>' + S.game.ai.shipsRemaining() + '</b>';
  }

  function renderFleets() {
    UI.fleetPips($('#fleet-player'), S.game.human, false);
    UI.fleetPips($('#fleet-enemy'), S.game.ai, true);  // hide enemy ship names until sunk
  }

  // ---- unified attack pipeline (single shots + abilities; local + online) ----
  var CELL = BS.CELL;
  function inB(p) { return p.r >= 0 && p.c >= 0 && p.r < S.game.size && p.c < S.game.size; }
  function myTurnActive() { return S.game.phase === 'battle' && S.myTurn && !S.locked; }

  function normRes(res) {
    var o = { r: res.r, c: res.c, outcome: res.result, gameOver: !!res.gameOver };
    if (res.result === 'sunk' && res.sunkShip) {
      o.shipName = res.sunkShip.name; o.shipLen = res.sunkShip.len;
      o.cells = res.sunkShip.cells.map(function (p) { return { r: p.r, c: p.c }; });
    }
    return o;
  }

  // entry from board click / keyboard
  function humanFire(r, c) {
    if (!myTurnActive()) return;
    if (S.ability) { fireAbilityAt(r, c); return; }
    takeShot([{ r: r, c: c }], 'shot');
  }

  // I attack the enemy with a set of cells
  function takeShot(cells, kind) {
    if (!myTurnActive()) return;
    cells = cells.filter(function (p) { return inB(p) && S.game.ai.shots[p.r][p.c] === CELL.EMPTY; });
    if (!cells.length) { Audio.play('invalid'); return; }
    S.locked = true; setTurn();
    Audio.play('fire');
    cells.forEach(function (p) { UI.impact(boardEnemy, p.r, p.c, 'ping', fxColors()); });
    var gen = S.gen;
    if (S.mode === 'online') {
      S.net.send('fire', { cells: cells, kind: kind });
    } else {
      var results = cells.map(function (p) { return normRes(S.game.ai.receiveFire(p.r, p.c)); });
      var over = S.game.ai.allSunk();
      setTimeout(function () { if (S.gen === gen) onMyResults(results, kind, over, true); }, 400);
    }
  }

  function takeScan(cells) {
    if (!myTurnActive()) return;
    cells = cells.filter(inB);
    if (!cells.length) return;
    S.locked = true; setTurn();
    Audio.play('ping');
    UI.impact(boardEnemy, cells[0].r, cells[0].c, 'ping', fxColors());
    var gen = S.gen;
    if (S.mode === 'online') {
      S.net.send('scan', { cells: cells });
    } else {
      var results = S.game.ai.scan(cells);
      setTimeout(function () { if (S.gen === gen) onScanResults(results); }, 400);
    }
  }

  function applyResultToEnemy(res) {
    var ai = S.game.ai;
    if (res.outcome === 'miss') ai.shots[res.r][res.c] = CELL.MISS;
    else if (res.outcome === 'hit') ai.shots[res.r][res.c] = CELL.HIT;
    else if (res.outcome === 'sunk') {
      var cells = (res.cells && res.cells.length) ? res.cells : [{ r: res.r, c: res.c }];
      cells.forEach(function (cl) { ai.shots[cl.r][cl.c] = CELL.SUNK; });
      var sh = ai.ships.find(function (s) { return !s.sunk && s.len === res.shipLen; })
        || ai.ships.find(function (s) { return !s.sunk; });
      if (sh) { sh.sunk = true; sh.hits = sh.len; sh.cells = cells; if (res.shipName) sh.name = res.shipName; }
    }
  }

  // reveal my attack results on the enemy board, then settle the turn
  function onMyResults(results, kind, gameOver, alreadyApplied) {
    if (!alreadyApplied) results.forEach(applyResultToEnemy);
    results.forEach(function (res) {
      S.game.stats.human.shots++;
      if (res.outcome === 'hit' || res.outcome === 'sunk') S.game.stats.human.hits++;
    });
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    results.forEach(function (res, i) { setTimeout(function () { revealOne(boardEnemy, res, 'you'); }, i * 110); });
    var gen = S.gen, done = results.length * 110 + 80;
    setTimeout(function () {
      if (S.gen !== gen) return;
      renderHud(); renderFleets();
      if (gameOver) { endGame('human'); return; }
      var keep = kind === 'shot' && results.some(function (r) { return r.outcome === 'hit' || r.outcome === 'sunk'; }) && S.settings.fireAgain;
      endMyTurn(keep);
    }, done);
  }

  function onScanResults(results) {
    var n = 0;
    results.forEach(function (p) { if (p.ship && S.game.ai.shots[p.r][p.c] === CELL.EMPTY) { S.game.ai.detected[p.r][p.c] = true; n++; } });
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    Audio.play('ping');
    UI.pushLog(logEl, '<b>You</b> · sonar pulse — ' + n + ' contact' + (n === 1 ? '' : 's'), 'you');
    UI.announce('Sonar: ' + n + ' contacts.');
    renderHud();
    endMyTurn(false);   // sonar uses your turn
  }

  // reveal one cell's result (board already painted)
  function revealOne(boardEl, res, who) {
    var t = theme(), col = fxColors(), coord = UI.coordLabel(res.r, res.c), actor = who === 'you' ? 'You' : 'Enemy';
    if (res.outcome === 'miss') {
      UI.impact(boardEl, res.r, res.c, 'miss', col); Audio.play('miss');
      UI.pushLog(logEl, '<b>' + actor + '</b> ' + t.verbs.fire + ' ' + coord + ' — ' + t.verbs.miss, who === 'you' ? 'you' : '');
    } else if (res.outcome === 'hit') {
      UI.impact(boardEl, res.r, res.c, 'hit', col); Audio.play('hit');
      UI.pushLog(logEl, '<b>' + actor + '</b> ' + t.verbs.fire + ' ' + coord + ' — ' + t.verbs.hit, 'hit');
    } else if (res.outcome === 'sunk') {
      UI.impact(boardEl, res.r, res.c, 'sunk', col); Audio.play('sunk');
      var nm = res.shipName || 'ship';
      UI.pushLog(logEl, '<b>' + actor + '</b> ' + (who === 'you' ? 'sank the enemy ' : 'sank your ') + nm + '! (' + t.verbs.sunk + ')', 'sunk');
      UI.announce(actor + ' sank ' + (who === 'you' ? 'the enemy ' : 'your ') + nm);
    }
  }

  // opponent/AI attacks MY board → resolve + reveal
  function resolveIncoming(cells, kind) {
    var results = [], over = false;
    for (var i = 0; i < cells.length; i++) {
      var res = S.game.human.receiveFire(cells[i].r, cells[i].c);
      if (!res.valid) continue;
      results.push(normRes(res));
      if (res.gameOver) over = true;
    }
    UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
    results.forEach(function (res, i) { setTimeout(function () { revealOne(boardPlayer, res, 'enemy'); }, i * 110); });
    return { results: results, gameOver: over };
  }

  // ---- turn transitions (S.myTurn drives both modes) ----
  function endMyTurn(keep) {
    if (keep) { S.myTurn = true; S.locked = false; setTurn(); return; }
    S.myTurn = false; S.locked = true; setTurn();
    if (S.mode === 'local') aiTurn();
  }
  function endOppTurn(kind, results, gameOver) {
    if (gameOver) { endGame(S.mode === 'online' ? 'opponent' : 'ai'); return; }
    var keep = kind === 'shot' && results.some(function (r) { return r.outcome === 'hit' || r.outcome === 'sunk'; }) && S.settings.fireAgain;
    if (keep) {
      if (S.mode === 'local') { var g = S.gen; setTimeout(function () { if (S.gen === g) aiStep(); }, 650); }
      else { S.myTurn = false; S.locked = true; setTurn(); }
    } else {
      S.myTurn = true; S.locked = false; setTurn();
      Audio.play('yourturn'); UI.announce(theme().turn.you);
    }
  }

  // ---- local AI turn ----
  function aiTurn() {
    if (S.game.phase !== 'battle') return;
    S.locked = true; setTurn();
    Audio.play('enemyturn');
    var gen = S.gen;
    setTimeout(function () { if (S.gen === gen) aiStep(); }, 650);
  }

  function aiStep() {
    if (S.game.phase !== 'battle' || S.myTurn) return;
    var gen = S.gen;
    var plan = S.ai.planTurn(S.game.human.shots, S.settings.abilities);

    if (plan.type === 'sonar') {
      S.ai.spend('sonar');
      var scan = S.game.human.scan(plan.cells);
      S.ai.queueCells(scan);
      Audio.play('ping'); UI.impact(boardPlayer, plan.center.r, plan.center.c, 'ping', fxColors());
      UI.pushLog(logEl, '<b>Enemy</b> · sonar pulse on your waters', '');
      setTimeout(function () { if (S.gen === gen) endOppTurn('sonar', [], false); }, 750);
      return;
    }
    if (plan.type === 'barrage' || plan.type === 'torpedo') {
      S.ai.spend(plan.type);
      var cells = plan.cells.filter(function (p) { return S.game.human.shots[p.r][p.c] === CELL.EMPTY; });
      Audio.play('fire');
      cells.forEach(function (p) { UI.impact(boardPlayer, p.r, p.c, 'ping', fxColors()); });
      var inc = resolveIncoming(cells, plan.type);
      UI.pushLog(logEl, '<b>Enemy</b> · ' + (plan.type === 'barrage' ? 'artillery barrage!' : 'torpedo run!'), 'hit');
      setTimeout(function () {
        if (S.gen !== gen) return;
        renderHud(); renderFleets();
        endOppTurn(plan.type, inc.results, inc.gameOver);
      }, cells.length * 110 + 500);
      return;
    }
    // normal shot
    var mv = plan.cell;
    if (!mv) { endOppTurn('shot', [], false); return; }
    Audio.play('fire'); UI.impact(boardPlayer, mv.r, mv.c, 'ping', fxColors());
    var inc1 = resolveIncoming([mv], 'shot');
    var r0 = inc1.results[0];
    if (r0) S.ai.recordResult(mv, { result: r0.outcome, sunkShip: r0.outcome === 'sunk' ? { len: r0.shipLen } : null });
    setTimeout(function () {
      if (S.gen !== gen) return;
      renderHud(); renderFleets();
      endOppTurn('shot', inc1.results, inc1.gameOver);
    }, 500);
  }

  // ---- abilities (sonar / barrage / torpedo) ---------------------------------
  var ABILITY_META = {
    sonar: { label: 'Sonar', ico: '📡', hint: 'Tap a cell to scan a 3×3 area for contacts.' },
    barrage: { label: 'Barrage', ico: '💥', hint: 'Tap a cell to bombard a 3×3 area.' },
    torpedo: { label: 'Torpedo', ico: '🚀', hint: 'Tap a cell to fire a full line. Press R to switch row/column.' }
  };

  function abilityCells(kind, r, c) {
    var out = [], i, j;
    if (kind === 'sonar' || kind === 'barrage') {
      for (i = r - 1; i <= r + 1; i++) for (j = c - 1; j <= c + 1; j++) if (i >= 0 && j >= 0 && i < S.game.size && j < S.game.size) out.push({ r: i, c: j });
    } else if (kind === 'torpedo') {
      if (S.abilityOrient === 'col') { for (i = 0; i < S.game.size; i++) out.push({ r: i, c: c }); }
      else { for (j = 0; j < S.game.size; j++) out.push({ r: r, c: j }); }
    }
    return out;
  }

  function armAbility(kind) {
    if (!S.settings.abilities) return;
    if (!myTurnActive()) { UI.toast('Wait for your turn'); Audio.play('invalid'); return; }
    if ((S.charges[kind] || 0) <= 0) { UI.toast('No ' + ABILITY_META[kind].label + ' charges left'); Audio.play('invalid'); return; }
    if (S.ability === kind) { disarmAbility(); return; }
    S.ability = kind; S.abilityOrient = 'row';
    Audio.play('click');
    boardEnemy.classList.add('aiming');
    UI.toast(ABILITY_META[kind].hint, 2600);
    updateAbilityBar();
  }

  function disarmAbility() {
    S.ability = null;
    boardEnemy.classList.remove('aiming');
    UI.clearPreview(boardEnemy);
    updateAbilityBar();
  }

  function previewAbility(r, c) {
    if (!S.ability || !myTurnActive()) return;
    UI.showPreview(boardEnemy, abilityCells(S.ability, r, c), true);
  }

  function fireAbilityAt(r, c) {
    var kind = S.ability; if (!kind) return;
    var cells = abilityCells(kind, r, c);
    if (kind === 'sonar') {
      S.charges.sonar--; disarmAbility(); takeScan(cells);
    } else {
      var valid = cells.filter(function (p) { return S.game.ai.shots[p.r][p.c] === CELL.EMPTY; });
      if (!valid.length) { Audio.play('invalid'); UI.toast('Nothing new to hit there'); return; }
      S.charges[kind]--; disarmAbility(); takeShot(valid, kind);
    }
  }

  function updateAbilityBar() {
    var bar = $('#ability-bar'); if (!bar) return;
    ['sonar', 'barrage', 'torpedo'].forEach(function (kind) {
      var btn = bar.querySelector('[data-ability="' + kind + '"]'); if (!btn) return;
      var n = S.charges ? (S.charges[kind] || 0) : 0;
      btn.querySelector('.ab-charge').textContent = '×' + n;
      btn.disabled = n <= 0 || !myTurnActive();
      btn.classList.toggle('armed', S.ability === kind);
    });
  }

  // =====================================================================
  // GAME OVER
  // =====================================================================
  function endGame(winner) {
    S.game.phase = 'over';
    S.locked = true; S.ability = null;
    UI.setTarget(boardEnemy, false);
    var won = winner === 'human';
    document.body.classList.add(won ? 'win' : 'lose');

    // reset rematch handshake UI for a fresh round
    if (S.mode === 'online') {
      S.rematchSent = false; S.rematchPeer = false;
      var pa = $('#btn-playagain'); if (pa) { pa.disabled = false; pa.textContent = 'Request Rematch'; }
      var rs = $('#rematch-status'); if (rs) rs.hidden = true;
    } else {
      var pa2 = $('#btn-playagain'); if (pa2) { pa2.disabled = false; pa2.textContent = 'Play Again'; }
      var rs2 = $('#rematch-status'); if (rs2) rs2.hidden = true;
    }

    var s = S.game.stats;
    var stats = Store.recordGame(won, s.human.shots, s.human.hits);
    S.stats = stats; renderLifetime();

    var acc = s.human.shots ? Math.round(100 * s.human.hits / s.human.shots) : 0;
    var t = theme();
    $('#gameover-emblem').textContent = won ? '⚓' : '☠';
    $('#gameover-title').textContent = won ? 'Victory' : 'Defeat';
    $('#gameover-sub').textContent = won
      ? 'The enemy fleet lies at the bottom.'
      : 'Your fleet has been lost.';
    $('#result-stats').innerHTML =
      stat('Shots', s.human.shots) +
      stat('Hits', s.human.hits) +
      stat('Accuracy', acc + '%') +
      stat('Win streak', stats.streak);

    setTimeout(function () {
      Audio.play(won ? 'victory' : 'defeat');
      UI.openModal('gameover');
      UI.announce(won ? 'Victory! Enemy fleet destroyed.' : 'Defeat. Your fleet was sunk.');
    }, 600);
  }

  function stat(label, val) {
    return '<div><dt>' + label + '</dt><dd>' + val + '</dd></div>';
  }

  function renderLifetime() {
    var s = S.stats;
    var winRate = s.played ? Math.round(100 * s.won / s.played) : 0;
    $('#lifetime-stats').innerHTML =
      stat('Played', s.played) +
      stat('Won', s.won) +
      stat('Win rate', winRate + '%') +
      stat('Best streak', s.bestStreak) +
      stat('Fewest shots', s.bestShots == null ? '—' : s.bestShots);
  }

  // =====================================================================
  // EVENT BINDING
  // =====================================================================
  function unlockAudio() {
    if (S.started) return;
    S.started = true;
    Audio.resume();
    if (S.settings.sound && S.settings.music) Audio.startAmbient();
  }

  function bindGlobal() {
    ['pointerdown', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, unlockAudio, { once: true });
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      handleAction(act, btn);
    });

    // hover sfx for primary buttons (only after the audio gesture-unlock)
    document.addEventListener('mouseover', function (e) {
      if (!S.started) return;
      var b = e.target.closest('.btn, .icon-btn, .seg-btn');
      if (b && !b.disabled) Audio.play('hover');
    });

    // pause ambient + the FX render loop when the tab is hidden (saves CPU/GPU)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { Audio.stopAmbient(); FX.stop(); }
      else { FX.start(); if (S.settings.sound && S.settings.music) Audio.startAmbient(); }
    });

    $('#scrim').addEventListener('click', UI.closeDrawer);

    var rci = $('#room-code-input');
    if (rci) {
      rci.addEventListener('input', function () { this.value = this.value.toUpperCase(); });
      rci.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); joinRoom(); } });
    }
  }

  function handleAction(act, btn) {
    switch (act) {
      case 'play':
        unlockAudio(); Audio.play('click');
        UI.showScreen('game'); newGame(); break;
      case 'play-again':
        if (S.mode === 'online') { requestRematch(); }
        else { Audio.play('click'); UI.closeModal('gameover'); newGame(); }
        break;
      case 'home':
        Audio.play('click'); goHome(); break;
      case 'new-online':
        Audio.play('click'); goHome(); openOnline(); break;
      case 'settings': Audio.play('click'); UI.openDrawer(); break;
      case 'close-settings': Audio.play('click'); UI.closeDrawer(); break;
      case 'howto': Audio.play('click'); UI.openModal('howto'); break;
      case 'close-howto': Audio.play('click'); UI.closeModal('howto'); break;
      case 'online': unlockAudio(); Audio.play('click'); openOnline(); break;
      case 'close-online': Audio.play('click'); closeSession(); UI.closeModal('online'); break;
      case 'create-room': createRoom(); break;
      case 'join-room': joinRoom(); break;
      case 'copy-code': copyCode(); break;
      case 'leave-room': Audio.play('click'); closeSession(); resetOnlineLobby(); break;
      case 'sound': toggleSound(btn); break;
      case 'rotate': rotateShip(); break;
      case 'randomize': randomizeFleet(); break;
      case 'clear-place': clearFleet(); break;
      case 'start': Audio.play('click'); if (S.mode === 'online') onlineReady(); else startBattle(); break;
    }
  }

  function toggleSound(btn) {
    S.settings.sound = !S.settings.sound;
    Audio.setEnabled(S.settings.sound);
    if (S.settings.sound) { Audio.resume(); Audio.play('toggle'); if (S.settings.music) Audio.startAmbient(); }
    btn.setAttribute('aria-pressed', S.settings.sound ? 'true' : 'false');
    btn.querySelector('.ico').textContent = S.settings.sound ? '🔊' : '🔇';
    $('#opt-sound').checked = S.settings.sound;
    Store.save(S.settings);
  }

  // ---- placement interaction -------------------------------------------------
  function bindPlacement() {
    tray.addEventListener('click', function (e) {
      var tok = e.target.closest('.ship-token');
      if (!tok) return;
      selectShip(tok.dataset.ship); Audio.play('click');
    });
    tray.addEventListener('dragstart', function (e) {
      var tok = e.target.closest('.ship-token');
      if (!tok) return;
      selectShip(tok.dataset.ship);
      e.dataTransfer.setData('text/plain', tok.dataset.ship);
      e.dataTransfer.effectAllowed = 'move';
    });

    boardPlayer.addEventListener('click', function (e) {
      if (S.game.phase !== 'placement') return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      placeAt(+cell.dataset.r, +cell.dataset.c);
    });
    boardPlayer.addEventListener('mousemove', function (e) {
      if (S.game.phase !== 'placement') return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      S.cursor = { r: +cell.dataset.r, c: +cell.dataset.c };
      previewAt(S.cursor.r, S.cursor.c);
    });
    boardPlayer.addEventListener('mouseleave', function () {
      if (S.game.phase === 'placement') UI.clearPreview(boardPlayer);
    });
    boardPlayer.addEventListener('dragover', function (e) {
      if (S.game.phase !== 'placement') return;
      e.preventDefault();
      var cell = e.target.closest('.cell'); if (!cell) return;
      previewAt(+cell.dataset.r, +cell.dataset.c);
    });
    boardPlayer.addEventListener('drop', function (e) {
      if (S.game.phase !== 'placement') return;
      e.preventDefault();
      var cell = e.target.closest('.cell'); if (!cell) return;
      placeAt(+cell.dataset.r, +cell.dataset.c);
    });
  }

  // ---- battle interaction ----------------------------------------------------
  function bindBattle() {
    boardEnemy.addEventListener('click', function (e) {
      if (!S.game || S.game.phase !== 'battle') return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      humanFire(+cell.dataset.r, +cell.dataset.c);
    });
    boardEnemy.addEventListener('mousemove', function (e) {
      if (!S.game || S.game.phase !== 'battle' || !S.myTurn) return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      var r = +cell.dataset.r, c = +cell.dataset.c;
      S.cursor = { r: r, c: c };
      UI.highlightCoords(scopeEnemy, r, c);
      if (S.ability) previewAbility(r, c);
    });
    boardEnemy.addEventListener('mouseleave', function () {
      UI.highlightCoords(scopeEnemy, null);
      if (S.ability) UI.clearPreview(boardEnemy);
    });
    var bar = $('#ability-bar');
    if (bar) bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ability]'); if (!b || b.disabled) return;
      armAbility(b.dataset.ability);
    });
  }

  // ---- settings --------------------------------------------------------------
  function bindSettings() {
    segGroup('#seg-size', 'size', function (v) {
      S.settings.boardSize = +v; persist();
      if (S.game) { newGame(); }
    });
    segGroup('#seg-fleet', 'fleet', function (v) {
      S.settings.fleet = v; persist(); updateFleetNote();
      if (S.game) { newGame(); }
    });
    segGroup('#seg-diff', 'diff', function (v) {
      S.settings.difficulty = v; persist(); updateDiffNote();
      if (S.game && S.ai) S.ai = new BS.AI(S.settings.boardSize, v, S.game.fleetDef);
    });

    $('#opt-sound').addEventListener('change', function () {
      S.settings.sound = this.checked; Audio.setEnabled(this.checked);
      if (this.checked && S.settings.music) { Audio.resume(); Audio.startAmbient(); }
      var b = $('#btn-sound'); b.setAttribute('aria-pressed', this.checked ? 'true' : 'false'); b.querySelector('.ico').textContent = this.checked ? '🔊' : '🔇';
      persist();
    });
    $('#opt-music').addEventListener('change', function () {
      S.settings.music = this.checked; Audio.setMusic(this.checked); persist();
    });
    $('#opt-volume').addEventListener('input', function () {
      S.settings.volume = this.value / 100; Audio.setVolume(S.settings.volume);
    });
    $('#opt-volume').addEventListener('change', persist);
    $('#opt-fireagain').addEventListener('change', function () { S.settings.fireAgain = this.checked; persist(); });
    $('#opt-abilities').addEventListener('change', function () {
      S.settings.abilities = this.checked;
      document.body.dataset.abilities = this.checked ? 'on' : 'off';
      persist();
      if (S.game && S.game.phase === 'battle') updateAbilityBar();
    });
    $('#opt-reduced').addEventListener('change', function () {
      S.settings.reduced = this.checked; FX.setReducedMotion(this.checked || prefersReduced());
      document.body.dataset.reduced = this.checked ? 'true' : 'false'; persist();
    });
  }

  function segGroup(sel, attr, onPick) {
    var group = $(sel); if (!group) return;
    var btns = $$('.seg-btn', group);
    function selectBtn(b) {
      btns.forEach(function (x) { x.setAttribute('aria-checked', 'false'); x.tabIndex = -1; });
      b.setAttribute('aria-checked', 'true'); b.tabIndex = 0;
      Audio.play('click');
      onPick(b.dataset[attr]);
    }
    btns.forEach(function (b, i) {
      b.tabIndex = b.getAttribute('aria-checked') === 'true' ? 0 : -1;
      b.addEventListener('click', function () { selectBtn(b); });
      b.addEventListener('keydown', function (e) {
        var idx = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') idx = (i + 1) % btns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') idx = (i - 1 + btns.length) % btns.length;
        if (idx >= 0) { e.preventDefault(); btns[idx].focus(); selectBtn(btns[idx]); }
      });
    });
  }

  function syncSettingsControls() {
    markSeg('#seg-size', 'size', String(S.settings.boardSize));
    markSeg('#seg-fleet', 'fleet', S.settings.fleet);
    markSeg('#seg-diff', 'diff', S.settings.difficulty);
    $('#opt-sound').checked = S.settings.sound;
    $('#opt-music').checked = S.settings.music;
    $('#opt-volume').value = Math.round(S.settings.volume * 100);
    $('#opt-fireagain').checked = S.settings.fireAgain;
    $('#opt-abilities').checked = S.settings.abilities;
    $('#opt-reduced').checked = S.settings.reduced;
    document.body.dataset.reduced = S.settings.reduced ? 'true' : 'false';
    document.body.dataset.abilities = S.settings.abilities ? 'on' : 'off';
    var b = $('#btn-sound'); b.setAttribute('aria-pressed', S.settings.sound ? 'true' : 'false'); b.querySelector('.ico').textContent = S.settings.sound ? '🔊' : '🔇';
    updateFleetNote(); updateDiffNote();
  }

  function markSeg(sel, attr, val) {
    var group = $(sel); if (!group) return;
    $$('.seg-btn', group).forEach(function (b) {
      b.setAttribute('aria-checked', b.dataset[attr] === val ? 'true' : 'false');
    });
  }

  function updateFleetNote() {
    var f = BS.FLEETS[S.settings.fleet]; if (f) $('#fleet-note').textContent = f.desc;
  }
  function updateDiffNote() { $('#diff-note').textContent = S.diffNotes[S.settings.difficulty] || ''; }

  function persist() { Store.save(S.settings); }

  // ---- keyboard --------------------------------------------------------------
  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Escape') {
        if (S.ability) { disarmAbility(); return; }
        UI.closeDrawer(); UI.closeModal('howto');
        if ($('#online').classList.contains('show')) { closeSession(); resetOnlineLobby(); UI.closeModal('online'); }
        return;
      }
      // don't hijack typing in form fields
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

      var phase = S.game ? S.game.phase : 'title';
      var canFire = S.game && phase === 'battle' && S.myTurn && !S.locked;

      if (phase === 'placement') {
        if (k === 'r' || k === 'R') { e.preventDefault(); rotateShip(); return; }
        if (arrow(k)) { e.preventDefault(); moveCursor(k, boardPlayer); previewAt(S.cursor.r, S.cursor.c); return; }
        if (k === 'Enter' || k === ' ') { e.preventDefault(); placeAt(S.cursor.r, S.cursor.c); return; }
      } else if (phase === 'battle' && canFire) {
        if ((k === 'r' || k === 'R') && S.ability === 'torpedo') {
          e.preventDefault(); S.abilityOrient = S.abilityOrient === 'row' ? 'col' : 'row';
          Audio.play('rotate'); previewAbility(S.cursor.r, S.cursor.c); return;
        }
        if (arrow(k)) {
          e.preventDefault(); moveCursor(k, boardEnemy); UI.highlightCoords(scopeEnemy, S.cursor.r, S.cursor.c);
          if (S.ability) previewAbility(S.cursor.r, S.cursor.c);
          return;
        }
        if (k === 'Enter' || k === ' ') { e.preventDefault(); humanFire(S.cursor.r, S.cursor.c); return; }
      }
    });
  }

  function arrow(k) { return k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight'; }

  function moveCursor(k, boardEl) {
    var n = S.game.size;
    if (k === 'ArrowUp') S.cursor.r = (S.cursor.r - 1 + n) % n;
    if (k === 'ArrowDown') S.cursor.r = (S.cursor.r + 1) % n;
    if (k === 'ArrowLeft') S.cursor.c = (S.cursor.c - 1 + n) % n;
    if (k === 'ArrowRight') S.cursor.c = (S.cursor.c + 1) % n;
    UI.moveCursor(boardEl, S.cursor.r, S.cursor.c);
    Audio.play('hover');
  }

  // =====================================================================
  // ONLINE MULTIPLAYER — pure message relay (each browser owns its fleet)
  // =====================================================================
  function openOnline() {
    resetOnlineLobby();
    UI.openModal('online');
    $('#online-mode').textContent = 'Checking connection…';
    $('#online-note').textContent = '';
    BS.Net.probeRealtime().then(function (rt) {
      S.netKind = rt ? 'ably' : 'local';
      if (rt) {
        $('#online-mode').textContent = 'Online · play over the internet with a room code.';
      } else {
        $('#online-mode').textContent = 'Same device · open a second browser tab to play.';
        $('#online-note').textContent = 'Internet play activates once an ABLY_API_KEY is set on the server.';
      }
    });
  }

  function resetOnlineLobby() {
    var pick = $('#online-pick'), wait = $('#online-wait');
    if (pick) pick.hidden = false;
    if (wait) wait.hidden = true;
    var inp = $('#room-code-input'); if (inp) inp.value = '';
    var st = $('#online-status'); if (st) st.textContent = 'Waiting for opponent…';
  }

  function createRoom() { Audio.play('click'); startSession(BS.Net.makeCode(), 'host'); }

  function joinRoom() {
    var code = (($('#room-code-input').value) || '').trim().toUpperCase();
    if (code.length < 4) { UI.toast('Enter the 4-character room code'); Audio.play('invalid'); return; }
    Audio.play('click'); startSession(code, 'guest');
  }

  function copyCode() {
    var code = $('#room-code-show').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { UI.toast('Code copied'); }).catch(function () {});
    Audio.play('click');
  }

  function startSession(code, role) {
    closeSession();
    S.mode = 'online'; S.role = role; S.roomCode = code;
    S.sessionStarted = false; S.battleStarted = false; S.iAmReady = false; S.peerReady = false;
    S.net = BS.Net.create(S.netKind);
    $('#online-pick').hidden = true;
    $('#online-wait').hidden = false;
    $('#room-code-show').textContent = code;
    $('#online-status').textContent = role === 'host' ? 'Waiting for opponent…' : 'Connecting…';
    wireNet();
    S.net.connect(code, role).then(function () {
      if (role === 'guest') $('#online-status').textContent = 'Connected. Syncing with host…';
    }).catch(function (e) {
      UI.toast('Connection failed: ' + ((e && e.message) || e));
      closeSession(); resetOnlineLobby();
    });
  }

  function wireNet() {
    var net = S.net;
    net.onPeer(function (ev) { if (ev === 'join') onPeerJoin(); else if (ev === 'leave') onPeerLeave(); });
    net.on('config', function (p) {
      if (S.role !== 'guest') return;
      S.settings.boardSize = p.size; S.settings.fleet = p.fleet;
      S.settings.fireAgain = !!p.fireAgain; S.settings.abilities = !!p.abilities;
      startOnlineGame(false);
    });
    net.on('ready', function () { S.peerReady = true; maybeBeginBattle(); });
    net.on('fire', function (p) { onIncomingFire(p); });
    net.on('result', function (p) { onMyResults(p.results || [], p.kind, p.gameOver, false); });
    net.on('scan', function (p) { onIncomingScan(p); });
    net.on('scanResult', function (p) { onScanResults(p.results || []); });
    net.on('rematch-request', function () { onRematchRequest(); });
    net.on('rematch-decline', function () { onRematchDecline(); });
  }

  function onPeerJoin() {
    if (S.sessionStarted) return;
    if (S.role === 'host') {
      S.net.send('config', { size: S.settings.boardSize, fleet: S.settings.fleet, fireAgain: S.settings.fireAgain, abilities: S.settings.abilities });
      startOnlineGame(false);
    }
    // guest waits for the 'config' message
  }

  function onPeerLeave() {
    if (S.mode !== 'online' || S.peerGone) return;
    S.peerGone = true; S.locked = true;
    if (S.game) S.game.phase = 'over';
    UI.setTarget(boardEnemy, false);
    UI.closeModal('gameover');
    if ($('#online') && $('#online').classList.contains('show')) {
      var st = $('#online-status'); if (st) st.textContent = 'Opponent left the room.';
    }
    Audio.play('defeat');
    $('#leftgame-msg').textContent = S.battleStarted
      ? 'Your opponent disconnected mid-battle.'
      : 'Your opponent left the room.';
    UI.openModal('leftgame');
    UI.announce('Opponent left the game. Session ended.');
    closeSession();   // tear down the transport — the session is over
  }

  function startOnlineGame(isRematch) {
    if (S.sessionStarted) return;
    S.sessionStarted = true;
    S.gen++;
    S.battleStarted = false; S.iAmReady = false; S.peerReady = false; S.fleetReady = false;
    S.rematchSent = false; S.rematchPeer = false;
    S.myTurn = (S.role === 'host');
    S.game = new BS.Game({ size: S.settings.boardSize, fleet: S.settings.fleet });
    S.game.ai.clearAll();
    document.body.classList.remove('win', 'lose');

    UI.buildBoard(boardPlayer, S.settings.boardSize);
    UI.buildBoard(boardEnemy, S.settings.boardSize);
    UI.setTarget(boardEnemy, false);
    UI.paintBoard(boardPlayer, S.game.human, { showShips: true });
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    enterPlacement();
    $('#btn-start').textContent = 'Ready';

    UI.closeModal('online'); UI.closeModal('gameover');
    UI.showScreen('game');
    UI.toast(isRematch ? 'Rematch! Place your fleet.' : 'Opponent connected — place your fleet!');
    Audio.play('start');
  }

  function onlineReady() {
    if (!S.game.human.allPlaced()) return;
    S.iAmReady = true;
    S.net.send('ready', {});
    var b = $('#btn-start'); b.disabled = true; b.textContent = 'Waiting…';
    $('#turn-text').textContent = 'Waiting for opponent…';
    UI.announce('Fleet ready. Waiting for opponent.');
    maybeBeginBattle();
  }

  function maybeBeginBattle() {
    if (S.battleStarted) return;
    if (S.iAmReady && S.peerReady) beginOnlineBattle();
  }

  function beginOnlineBattle() {
    S.battleStarted = true;
    S.game.phase = 'battle';
    document.body.dataset.phase = 'battle';
    S.cursor = { r: (S.game.size / 2) | 0, c: (S.game.size / 2) | 0 };
    S.locked = !S.myTurn;
    resetCharges();
    UI.paintBoard(boardEnemy, S.game.ai, { showShips: false });
    renderFleets();
    Audio.play('start');
    setTurn();
    UI.pushLog(logEl, 'Battle stations — ' + (S.myTurn ? 'you fire first.' : 'opponent fires first.'), 'you');
    UI.announce(S.myTurn ? 'Your turn. Fire on enemy waters.' : 'Opponent fires first.');
  }

  // opponent attacked MY board (single shot or ability)
  function onIncomingFire(p) {
    if (S.mode !== 'online' || S.game.phase !== 'battle') return;
    var cells = p.cells || [];
    Audio.play('fire');
    cells.forEach(function (c) { UI.impact(boardPlayer, c.r, c.c, 'ping', fxColors()); });
    var gen = S.gen;
    setTimeout(function () {
      if (S.gen !== gen) return;
      var inc = resolveIncoming(cells, p.kind);
      S.net.send('result', { results: inc.results, kind: p.kind, gameOver: inc.gameOver });
      setTimeout(function () {
        if (S.gen !== gen) return;
        renderHud(); renderFleets();
        endOppTurn(p.kind, inc.results, inc.gameOver);
      }, inc.results.length * 110 + 150);
    }, 350);
  }

  // opponent scanned MY waters (sonar) — no damage; they spent their turn
  function onIncomingScan(p) {
    if (S.mode !== 'online' || S.game.phase !== 'battle') return;
    var results = S.game.human.scan(p.cells || []);
    S.net.send('scanResult', { results: results });
    Audio.play('ping');
    UI.pushLog(logEl, '<b>Enemy</b> · swept your waters with sonar', '');
    endOppTurn('sonar', [], false);
  }

  // ---- rematch handshake (needs both players to agree) ----
  function requestRematch() {
    if (S.peerGone) { goHome(); return; }
    S.rematchSent = true;
    if (S.net) S.net.send('rematch-request', {});
    if (S.rematchPeer) { doRematch(); return; }
    var sub = $('#rematch-status');
    if (sub) { sub.hidden = false; sub.textContent = 'Rematch requested — waiting for opponent…'; }
    var b = $('#btn-playagain'); if (b) { b.disabled = true; b.textContent = 'Waiting…'; }
    Audio.play('click');
  }
  function onRematchRequest() {
    if (S.peerGone) return;
    S.rematchPeer = true;
    if (S.rematchSent) { doRematch(); return; }
    var sub = $('#rematch-status');
    if (sub) { sub.hidden = false; sub.textContent = 'Opponent wants a rematch!'; }
    var b = $('#btn-playagain'); if (b) b.textContent = 'Accept Rematch';
    Audio.play('yourturn'); UI.toast('Opponent wants a rematch'); UI.announce('Opponent requests a rematch.');
  }
  function onRematchDecline() {
    UI.toast('Opponent declined the rematch');
    var sub = $('#rematch-status'); if (sub) { sub.hidden = false; sub.textContent = 'Opponent declined.'; }
    var b = $('#btn-playagain'); if (b) { b.disabled = true; b.textContent = 'Declined'; }
  }
  function doRematch() {
    S.rematchSent = false; S.rematchPeer = false; S.sessionStarted = false;
    var sub = $('#rematch-status'); if (sub) sub.hidden = true;
    var b = $('#btn-playagain'); if (b) { b.disabled = false; b.textContent = 'Play Again'; }
    startOnlineGame(true);
  }

  function closeSession() {
    if (S.net) {
      try { if (S.battleStarted && !S.peerGone && S.game && S.game.phase !== 'over') S.net.send('rematch-decline', {}); } catch (e) {}
      try { S.net.close(); } catch (e) {}
      S.net = null;
    }
    S.mode = 'local'; S.sessionStarted = false; S.battleStarted = false;
    S.iAmReady = false; S.peerReady = false; S.peerGone = false;
    S.rematchSent = false; S.rematchPeer = false;
  }

  function goHome() {
    UI.closeModal('gameover'); UI.closeModal('online'); UI.closeModal('leftgame'); UI.closeDrawer();
    closeSession();
    document.body.dataset.phase = 'title'; UI.showScreen('title'); renderLifetime();
  }

  // ---- go --------------------------------------------------------------------
  // Lightweight debug handle (used by automated tests; harmless in production).
  BS._main = S;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : this);
