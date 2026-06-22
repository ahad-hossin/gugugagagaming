/* ==========================================================================
   ui.js — shared UI primitives for TYCOON: DOM helpers, money formatting,
   toasts, modals, confirm dialogs (with "don't ask again"), dice + card
   animations, money floaters, confetti.  Exposed as window.MONO.UI
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var d = document;

  function $(sel, ctx) { return (ctx || d).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || d).querySelectorAll(sel)); }
  function el(tag, cls, html) { var e = d.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function money(n) { n = Math.round(n || 0); return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---- toasts ----
  function toast(msg, kind, ms) {
    var root = $('#toast-root'); if (!root) return;
    var t = el('div', 'toast ' + (kind || ''), esc(msg));
    root.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function () { t.remove(); }, 300); }, ms || 2600);
  }

  // ---- modal ----
  function modal(contentEl, opts) {
    opts = opts || {};
    var rootEl = $('#modal-root');
    rootEl.innerHTML = '';
    var box = el('div', 'modal');
    if (typeof contentEl === 'string') box.innerHTML = contentEl; else box.appendChild(contentEl);
    rootEl.appendChild(box);
    rootEl.hidden = false;
    function close() { rootEl.hidden = true; rootEl.innerHTML = ''; }
    if (!opts.sticky) rootEl.onclick = function (e) { if (e.target === rootEl) close(); };
    else rootEl.onclick = null;
    return { box: box, close: close };
  }
  function closeModal() { var r = $('#modal-root'); r.hidden = true; r.innerHTML = ''; }

  // ---- confirm (with optional "don't ask again") ----
  var SKIP_KEY = 'tycoon.skipConfirm';
  function skipSet() { try { return JSON.parse(localStorage.getItem(SKIP_KEY) || '[]'); } catch (e) { return []; } }
  function confirmDialog(o) {
    o = o || {};
    return new Promise(function (resolve) {
      if (o.key && skipSet().indexOf(o.key) >= 0) return resolve(true);
      var box = el('div');
      box.innerHTML = '<h2>' + esc(o.title || 'Are you sure?') + '</h2>' +
        '<p style="color:var(--dim);line-height:1.5">' + esc(o.body || '') + '</p>' +
        (o.key ? '<label class="sm" style="display:flex;gap:.4rem;align-items:center;margin-top:.6rem;color:var(--dim)"><input type="checkbox" id="cf-skip"> don\'t ask me again</label>' : '') +
        '<div class="row"><button class="ghost" id="cf-no">' + esc(o.cancel || 'Cancel') + '</button>' +
        '<button class="' + (o.danger ? 'btn-bad' : 'primary') + '" id="cf-yes">' + esc(o.confirm || 'Confirm') + '</button></div>';
      var m = modal(box, { sticky: true });
      $('#cf-no', box).onclick = function () { m.close(); resolve(false); };
      $('#cf-yes', box).onclick = function () {
        if (o.key && $('#cf-skip', box) && $('#cf-skip', box).checked) {
          var s = skipSet(); s.push(o.key); try { localStorage.setItem(SKIP_KEY, JSON.stringify(s)); } catch (e) {}
        }
        m.close(); resolve(true);
      };
    });
  }

  // ---- dice ----
  function rollDiceAnim(d1, d2) {
    var dice = $('#dice'); if (!dice) return;
    var dies = $$('.die', dice);
    dies.forEach(function (x) { x.classList.remove('rolling'); void x.offsetWidth; x.classList.add('rolling'); });
    setTimeout(function () { if (dies[0]) dies[0].setAttribute('data-d', d1); if (dies[1]) dies[1].setAttribute('data-d', d2); }, 250);
  }

  // ---- card draw overlay ----
  function showCard(kind, text, ms) {
    var ov = $('#card-overlay'); if (!ov) return;
    ov.innerHTML = '';
    var c = el('div', 'draw-card');
    c.innerHTML = '<div class="kind">' + esc(kind) + '</div><div class="txt">' + esc(text) + '</div>';
    ov.appendChild(c); ov.hidden = false;
    clearTimeout(showCard._t);
    showCard._t = setTimeout(function () { ov.hidden = true; ov.innerHTML = ''; }, ms || 2600);
    ov.onclick = function () { ov.hidden = true; ov.innerHTML = ''; };
  }

  // ---- money floater near a point ----
  function floater(amount, x, y) {
    var layer = $('#floaters'); if (!layer) return;
    var f = el('div', 'floater ' + (amount >= 0 ? 'plus' : 'minus'), (amount >= 0 ? '+' : '−') + money(Math.abs(amount)).replace('-', ''));
    f.style.left = x + 'px'; f.style.top = y + 'px';
    layer.appendChild(f);
    setTimeout(function () { f.remove(); }, 1200);
  }

  // ---- confetti ----
  function confetti(n) {
    var layer = $('#confetti'); if (!layer) return;
    var colors = ['#ffd23d', '#3df5ff', '#ff3dee', '#3ddc84', '#ff9f43'];
    for (var i = 0; i < (n || 120); i++) {
      var p = el('i');
      p.style.left = Math.random() * 100 + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (1.6 + Math.random() * 1.8) + 's';
      p.style.animationDelay = (Math.random() * .6) + 's';
      layer.appendChild(p);
      (function (node) { setTimeout(function () { node.remove(); }, 4000); })(p);
    }
  }

  MONO.UI = {
    $: $, $$: $$, el: el, money: money, esc: esc,
    toast: toast, modal: modal, closeModal: closeModal, confirm: confirmDialog,
    rollDiceAnim: rollDiceAnim, showCard: showCard, floater: floater, confetti: confetti
  };
})(typeof window !== 'undefined' ? window : this);
