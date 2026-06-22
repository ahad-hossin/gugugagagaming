/* ==========================================================================
   state.js — client-side snapshot store for TYCOON.
   Holds the latest authoritative GameState snapshot + the previous one (so the
   renderer can diff old→new to drive animations and sounds). Identity (our
   playerId + room code) is persisted in localStorage for seat reconnect.
   Exposed as window.MONO.Store
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};

  var current = null, previous = null;
  var playerId = null, code = null;
  var listeners = [];

  var LS = 'tycoon.session';
  function saveSession() {
    try { localStorage.setItem(LS, JSON.stringify({ code: code, playerId: playerId })); } catch (e) {}
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; }
  }
  function clearSession() { try { localStorage.removeItem(LS); } catch (e) {} }

  function set(snap) {
    if (!snap) return;
    previous = current;
    current = snap;
    if (snap.code) code = snap.code;
    listeners.forEach(function (fn) { try { fn(current, previous); } catch (e) { console.error(e); } });
  }

  function player(id) {
    if (!current) return null;
    for (var i = 0; i < current.players.length; i++) if (current.players[i].id === id) return current.players[i];
    return null;
  }

  MONO.Store = {
    on: function (fn) { listeners.push(fn); },
    set: set,
    get: function () { return current; },
    prev: function () { return previous; },
    setIdentity: function (c, pid) { code = c; playerId = pid; saveSession(); },
    code: function () { return code; },
    me: function () { return playerId; },
    myPlayer: function () { return player(playerId); },
    player: player,
    amHost: function () { return current && current.hostId === playerId; },
    amActive: function () { return current && current.turn && current.turn.activeId === playerId; },
    amSpectator: function () { var p = player(playerId); return !!(p && p.bankrupt); },
    inGame: function () { return !!player(playerId); },
    session: loadSession,
    clearSession: clearSession
  };
})(typeof window !== 'undefined' ? window : this);
