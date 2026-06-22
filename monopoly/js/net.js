/* ==========================================================================
   net.js — TYCOON transport. Talks to the serverless API and receives
   authoritative snapshots over Ably (with a polling fallback). The client
   never computes game results; it POSTs intents and renders snapshots.
   Exposed as window.MONO.Net
   ========================================================================== */
(function (root) {
  'use strict';
  var MONO = root.MONO = root.MONO || {};
  var Store = MONO.Store;

  var ablyClient = null, channel = null, poll = null, realtime = false;

  // ---- Ably loader (same approach as battleship) ----------------------------
  var ablyLoading = null;
  function loadAbly() {
    if (root.Ably) return Promise.resolve(root.Ably);
    if (ablyLoading) return ablyLoading;
    ablyLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.ably.com/lib/ably.min-1.js';
      s.onload = function () { resolve(root.Ably); };
      s.onerror = function () { reject(new Error('Failed to load realtime SDK')); };
      document.head.appendChild(s);
    });
    return ablyLoading;
  }

  function api(path, opts) {
    return fetch('/api/monopoly/' + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) { var e = new Error(body.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return body;
      });
    });
  }
  function post(path, payload) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }

  // ---- realtime subscription -------------------------------------------------
  function subscribe(code) {
    teardown();
    return loadAbly().then(function (Ably) {
      ablyClient = new Ably.Realtime({ authUrl: '/api/token?clientId=' + encodeURIComponent(Store.me() || 'anon'), echoMessages: true });
      channel = ablyClient.channels.get('monopoly:' + code);
      channel.subscribe('snapshot', function (msg) { if (msg && msg.data) Store.set(msg.data); });
      realtime = true;
    }).catch(function () {
      // no realtime → poll the snapshot endpoint
      realtime = false;
      startPolling(code);
    });
  }
  function startPolling(code) {
    stopPolling();
    poll = setInterval(function () {
      api('state?code=' + encodeURIComponent(code)).then(function (b) { if (b.snapshot) Store.set(b.snapshot); }).catch(function () {});
    }, 2500);
  }
  function stopPolling() { if (poll) { clearInterval(poll); poll = null; } }
  function teardown() {
    stopPolling();
    try { if (channel) channel.detach(); } catch (e) {}
    try { if (ablyClient) ablyClient.close(); } catch (e) {}
    channel = null; ablyClient = null;
  }

  // ---- public API ------------------------------------------------------------
  function create(identity) {
    return post('create', identity).then(function (b) {
      Store.setIdentity(b.code, b.playerId);
      Store.set(b.snapshot);
      return subscribe(b.code).then(function () { return b; });
    });
  }
  function join(code, identity, playerId) {
    var body = { code: code, name: identity.name, color: identity.color, emoji: identity.emoji };
    if (playerId) body.playerId = playerId;
    return post('join', body).then(function (b) {
      Store.setIdentity(code.toUpperCase(), b.playerId);
      Store.set(b.snapshot);
      return subscribe(code.toUpperCase()).then(function () { return b; });
    });
  }
  // resume an existing seat from a saved session
  function resume() {
    var sess = Store.session();
    if (!sess || !sess.code || !sess.playerId) return Promise.reject(new Error('no session'));
    return api('state?code=' + encodeURIComponent(sess.code)).then(function (b) {
      if (!b.snapshot) throw new Error('room gone');
      Store.setIdentity(sess.code, sess.playerId);
      Store.set(b.snapshot);
      // re-announce presence (also reconnects to a started game if our seat exists)
      return post('action', { code: sess.code, playerId: sess.playerId, type: 'setConnected', payload: { connected: true } })
        .then(function (r) { if (r.snapshot) Store.set(r.snapshot); })
        .catch(function () {})
        .then(function () { return subscribe(sess.code); })
        .then(function () { return b; });
    });
  }

  // fire an intent; resolves with the new snapshot, rejects with an Error.
  function action(type, payload) {
    var code = Store.code(), pid = Store.me();
    if (!code || !pid) return Promise.reject(new Error('not in a room'));
    return post('action', { code: code, playerId: pid, type: type, payload: payload || {} })
      .then(function (b) { if (b.snapshot) Store.set(b.snapshot); return b.snapshot; })
      .catch(function (e) {
        if (e.status === 409) {   // lost a race — pull fresh state and surface a soft retry
          return api('state?code=' + encodeURIComponent(code)).then(function (b) { if (b.snapshot) Store.set(b.snapshot); throw e; });
        }
        throw e;
      });
  }

  function refresh() {
    var code = Store.code(); if (!code) return Promise.resolve();
    return api('state?code=' + encodeURIComponent(code)).then(function (b) { if (b.snapshot) Store.set(b.snapshot); });
  }

  MONO.Net = {
    create: create, join: join, resume: resume, action: action,
    refresh: refresh, isRealtime: function () { return realtime; }, teardown: teardown
  };
})(typeof window !== 'undefined' ? window : this);
