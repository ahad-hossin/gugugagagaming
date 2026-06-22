/* ==========================================================================
   ui.js — View layer. Builds boards + coordinate rails, paints cell states,
   renders fleet status / log / toasts / a11y announcements, and triggers the
   canvas FX at the right screen coordinates. No game rules live here.
   Exposed globally as window.BS.UI
   ========================================================================== */
(function (root) {
  'use strict';

  var doc = document;
  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }
  var LETTERS = 'ABCDEFGHIJKLMNOPQRST';

  function coordLabel(r, c) { return LETTERS[r] + (c + 1); }

  // Build (or rebuild) a board grid + coordinate rails inside its .board-scope.
  function buildBoard(boardEl, size, handlers) {
    // anchor to the .board-scope — NOT boardEl.parentNode, which becomes the
    // frame itself after the first build (that caused nested frames + doubled rails)
    var scope = boardEl.closest('.board-scope') || boardEl.parentNode;
    var frame = scope.querySelector('.grid-frame');
    if (!frame) {
      frame = doc.createElement('div');
      frame.className = 'grid-frame';
      scope.insertBefore(frame, boardEl);
    }
    if (boardEl.parentNode !== frame) frame.appendChild(boardEl);
    frame.querySelectorAll('.coords').forEach(function (n) { n.remove(); });

    var top = doc.createElement('div'); top.className = 'coords coords-top';
    var left = doc.createElement('div'); left.className = 'coords coords-left';
    top.style.gridTemplateColumns = 'repeat(' + size + ',1fr)';
    left.style.gridTemplateRows = 'repeat(' + size + ',1fr)';
    for (var c = 0; c < size; c++) { var s = doc.createElement('span'); s.textContent = (c + 1); s.dataset.col = c; top.appendChild(s); }
    for (var r = 0; r < size; r++) { var l = doc.createElement('span'); l.textContent = LETTERS[r]; l.dataset.row = r; left.appendChild(l); }
    frame.insertBefore(top, boardEl);
    frame.insertBefore(left, boardEl);

    // cells
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = 'repeat(' + size + ',1fr)';
    boardEl.style.gridTemplateRows = 'repeat(' + size + ',1fr)';
    for (var rr = 0; rr < size; rr++) {
      for (var cc = 0; cc < size; cc++) {
        var cell = doc.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = rr; cell.dataset.c = cc;
        cell.tabIndex = (rr === 0 && cc === 0) ? 0 : -1;   // roving tabindex
        cell.setAttribute('aria-label', coordLabel(rr, cc));
        boardEl.appendChild(cell);
      }
    }
    return frame;
  }

  function cellAt(boardEl, r, c) {
    return boardEl.children[r * gridSize(boardEl) + c];
  }
  function gridSize(boardEl) { return Math.sqrt(boardEl.children.length) | 0; }

  // Paint cell states from a Board's shot grid (+ optionally show own ships).
  function paintBoard(boardEl, board, opts) {
    opts = opts || {};
    var CELL = root.BS.CELL;
    var n = board.size;
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var el = cellAt(boardEl, r, c);
        if (!el) continue;
        el.className = 'cell';
        var label = coordLabel(r, c);
        if (opts.showShips && board.grid[r][c] !== null) {
          el.classList.add('ship');
          addShipEdges(el, board, r, c);
          label += ', your ship';
        }
        var st = board.shots[r][c];
        if (st === CELL.MISS) { el.classList.add('miss'); label += ', miss'; }
        else if (st === CELL.HIT) { el.classList.add('hit'); label += ', hit'; }
        else if (st === CELL.SUNK) { el.classList.add('sunk'); label += ', sunk'; }
        else if (board.detected && board.detected[r][c]) { el.classList.add('detected'); label += ', sonar contact'; }
        el.setAttribute('aria-label', label);
      }
    }
  }

  // outline a polyomino: border only on sides with no same-ship neighbour
  function addShipEdges(el, board, r, c) {
    var id = board.grid[r][c];
    function same(rr, cc) {
      return rr >= 0 && cc >= 0 && rr < board.size && cc < board.size && board.grid[rr][cc] === id;
    }
    if (!same(r - 1, c)) el.classList.add('edge-top');
    if (!same(r + 1, c)) el.classList.add('edge-bottom');
    if (!same(r, c - 1)) el.classList.add('edge-left');
    if (!same(r, c + 1)) el.classList.add('edge-right');
  }

  function setTarget(boardEl, on) { boardEl.classList.toggle('is-target', !!on); }

  // preview during placement
  function clearPreview(boardEl) {
    $$('.cell.preview, .cell.preview-bad', boardEl).forEach(function (el) {
      el.classList.remove('preview', 'preview-bad');
    });
  }
  function showPreview(boardEl, cells, ok) {
    clearPreview(boardEl);
    cells.forEach(function (p) {
      var el = cellAt(boardEl, p.r, p.c);
      if (el) el.classList.add(ok ? 'preview' : 'preview-bad');
    });
  }

  // keyboard cursor highlight
  function moveCursor(boardEl, r, c) {
    $$('.cell.cursor', boardEl).forEach(function (e) { e.classList.remove('cursor'); });
    var prev = boardEl.querySelector('.cell[tabindex="0"]');
    if (prev) prev.tabIndex = -1;
    var el = cellAt(boardEl, r, c);
    if (el) { el.classList.add('cursor'); el.tabIndex = 0; try { el.focus(); } catch (e) {} }
  }
  function clearCursor(boardEl) { $$('.cell.cursor', boardEl).forEach(function (e) { e.classList.remove('cursor'); }); }

  // active coordinate rail highlight
  function highlightCoords(scopeEl, r, c) {
    if (!scopeEl) return;
    $$('.coords span', scopeEl).forEach(function (s) { s.classList.remove('active'); });
    if (r == null) return;
    var top = scopeEl.querySelector('.coords-top');
    var left = scopeEl.querySelector('.coords-left');
    if (top && top.children[c]) top.children[c].classList.add('active');
    if (left && left.children[r]) left.children[r].classList.add('active');
  }

  // ---- fleet status pips -----------------------------------------------------
  function fleetPips(containerEl, board, hideAfloat) {
    containerEl.innerHTML = '';
    board.ships.forEach(function (s) {
      var pip = doc.createElement('span');
      pip.className = 'pip';
      var label = hideAfloat && !s.sunk ? '■' : s.name;
      pip.innerHTML = '<span class="pip-name">' + (s.sunk ? s.name : label) + '</span><span class="pip-len">' + s.len + '</span>';
      if (s.sunk) pip.classList.add('is-sunk');
      else if (s.hits > 0) pip.classList.add('is-hit');
      pip.title = s.name + ' (' + s.len + ')' + (s.sunk ? ' — sunk' : '');
      containerEl.appendChild(pip);
    });
  }

  // ---- log / toast / announce ------------------------------------------------
  function pushLog(listEl, html, cls) {
    var li = doc.createElement('li');
    if (cls) li.className = cls;
    li.innerHTML = html;
    listEl.insertBefore(li, listEl.firstChild);
    while (listEl.children.length > 40) listEl.removeChild(listEl.lastChild);
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.classList.add('show'); t.setAttribute('aria-hidden', 'false');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); t.setAttribute('aria-hidden', 'true'); }, ms || 2200);
  }

  function announce(msg) {
    var live = $('#live');
    if (live) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); }
  }

  // ---- screen + overlay management ------------------------------------------
  function showScreen(name) {
    $$('.screen').forEach(function (s) { s.classList.remove('is-active'); });
    var el = $('#screen-' + name);
    if (el) el.classList.add('is-active');
  }

  // focus management for overlays (drawer + modals)
  var _focusReturn = null, _trapEl = null;
  function _focusables(el) {
    return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', el)
      .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
  }
  function _trap(e) {
    if (e.key !== 'Tab' || !_trapEl) return;
    var f = _focusables(_trapEl); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function _openOverlay(el) {
    _focusReturn = doc.activeElement; _trapEl = el;
    doc.addEventListener('keydown', _trap, true);
    var f = _focusables(el);
    if (f.length) setTimeout(function () { try { f[0].focus(); } catch (e) {} }, 30);
  }
  function _closeOverlay() {
    if (!_trapEl) return;
    doc.removeEventListener('keydown', _trap, true);
    _trapEl = null;
    var r = _focusReturn; _focusReturn = null;
    if (r && r.focus) setTimeout(function () { try { r.focus(); } catch (e) {} }, 0);
  }

  function openDrawer() { var d = $('#settings'); d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('show'); _openOverlay(d); }
  function closeDrawer() { $('#settings').classList.remove('open'); $('#settings').setAttribute('aria-hidden', 'true'); $('#scrim').classList.remove('show'); _closeOverlay(); }
  function openModal(id) { var m = $('#' + id); m.classList.add('show'); m.setAttribute('aria-hidden', 'false'); _openOverlay(m); }
  function closeModal(id) { var m = $('#' + id); m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); _closeOverlay(); }

  // ---- FX trigger at a cell --------------------------------------------------
  function center(cell) {
    var b = cell.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }

  // kind: 'ping' | 'miss' | 'hit' | 'sunk'
  function impact(boardEl, r, c, kind, colors) {
    var cell = cellAt(boardEl, r, c);
    if (!cell) return;
    var FX = root.BS.FX, p = center(cell);
    if (kind === 'ping') { FX.ping(p.x, p.y, colors.ping); }
    else if (kind === 'miss') { FX.splash(p.x, p.y, colors.miss); cell.classList.add('scan'); }
    else if (kind === 'hit') { FX.explosion(p.x, p.y, colors.hit); cell.classList.add('just-hit'); FX.flashScreen(colors.flash, 0.18); }
    else if (kind === 'sunk') { FX.explosion(p.x, p.y, colors.sunk); FX.bubbles(p.x, p.y, colors.ping); FX.flashScreen(colors.flash, 0.3); }
  }

  root.BS = root.BS || {};
  root.BS.UI = {
    $: $, $$: $$, coordLabel: coordLabel,
    buildBoard: buildBoard, paintBoard: paintBoard, cellAt: cellAt, gridSize: gridSize,
    setTarget: setTarget, clearPreview: clearPreview, showPreview: showPreview,
    moveCursor: moveCursor, clearCursor: clearCursor, highlightCoords: highlightCoords,
    fleetPips: fleetPips, pushLog: pushLog, toast: toast, announce: announce,
    showScreen: showScreen, openDrawer: openDrawer, closeDrawer: closeDrawer,
    openModal: openModal, closeModal: closeModal, impact: impact, center: center
  };

})(typeof window !== 'undefined' ? window : this);
