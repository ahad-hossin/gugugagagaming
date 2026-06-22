/* ==========================================================================
   net.js — Multiplayer transport abstraction.
   Two interchangeable backends with the SAME interface:
     • 'local' — BroadcastChannel: two tabs of the same browser/origin.
                 Needs no server; great for same-device play + testing.
     • 'ably'  — Ably Realtime pub/sub over the internet (token auth via
                 /api/token). Loaded lazily from CDN.
   The game is a pure message relay: each browser owns its own fleet and only
   broadcasts shots and results — so there is no server-side game logic.
   Exposed globally as window.BS.Net
   --------------------------------------------------------------------------
   transport API:
     connect(code, role) -> Promise        role: 'host' | 'guest'
     send(type, payload)
     on(type, fn)                          fn(payload, fromId)
     onPeer(fn)                            fn('join'|'leave')
     close()
     kind
   ========================================================================== */
(function (root) {
  'use strict';

  function randId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function Emitter() { this.handlers = {}; this.peer = []; }
  Emitter.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  };
  Emitter.prototype.onPeer = function (fn) { this.peer.push(fn); };
  Emitter.prototype._emit = function (type, payload, from) {
    (this.handlers[type] || []).forEach(function (h) { try { h(payload, from); } catch (e) {} });
  };
  Emitter.prototype._peer = function (ev) {
    this.peer.forEach(function (h) { try { h(ev); } catch (e) {} });
  };

  // ---------------------------------------------------------------------------
  // LOCAL — BroadcastChannel (same-origin tabs)
  // ---------------------------------------------------------------------------
  function LocalTransport() { Emitter.call(this); this.kind = 'local'; this.id = randId(); this.peers = {}; }
  LocalTransport.prototype = Object.create(Emitter.prototype);

  LocalTransport.prototype.connect = function (code, role) {
    var self = this;
    this.role = role; this.code = String(code).toUpperCase();
    if (typeof BroadcastChannel === 'undefined') {
      return Promise.reject(new Error('BroadcastChannel unsupported'));
    }
    this.bc = new BroadcastChannel('sonar-room-' + this.code);
    this.bc.onmessage = function (e) {
      var m = e.data;
      if (!m || m.from === self.id) return;
      if (m.type === '__hello') { self._seen(m.from); self._raw('__ack', {}); return; }
      if (m.type === '__ack') { self._seen(m.from); return; }
      if (m.type === '__beat') { self._seen(m.from); return; }
      if (m.type === '__bye') {
        if (self.peers[m.from]) { delete self.peers[m.from]; self._peer('leave'); }
        return;
      }
      self._emit(m.type, m.payload, m.from);
    };
    this._unload = function () { self._raw('__bye', {}); };
    root.addEventListener('beforeunload', this._unload);
    this._raw('__hello', {});
    // heartbeat + liveness check (catches tab closes that skip beforeunload)
    this._beat = setInterval(function () { self._raw('__beat', {}); }, 2000);
    this._check = setInterval(function () {
      var now = Date.now();
      Object.keys(self.peers).forEach(function (id) {
        if (now - self.peers[id] > 6000) { delete self.peers[id]; self._peer('leave'); }
      });
    }, 1500);
    return Promise.resolve();
  };

  LocalTransport.prototype._seen = function (from) {
    var fresh = !this.peers[from];
    this.peers[from] = Date.now();
    if (fresh) this._peer('join');
  };
  LocalTransport.prototype._raw = function (type, payload) {
    if (this.bc) this.bc.postMessage({ from: this.id, type: type, payload: payload });
  };
  LocalTransport.prototype.send = function (type, payload) { this._raw(type, payload); };
  LocalTransport.prototype.close = function () {
    if (this._unload) root.removeEventListener('beforeunload', this._unload);
    if (this._beat) clearInterval(this._beat);
    if (this._check) clearInterval(this._check);
    if (this.bc) { try { this._raw('__bye', {}); this.bc.close(); } catch (e) {} }
    this.bc = null; this.peers = {};
  };

  // ---------------------------------------------------------------------------
  // ABLY — internet pub/sub
  // ---------------------------------------------------------------------------
  var ablyLoading = null;
  function loadAbly() {
    if (root.Ably) return Promise.resolve(root.Ably);
    if (ablyLoading) return ablyLoading;
    ablyLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.ably.com/lib/ably.min-1.js';
      s.onload = function () { resolve(root.Ably); };
      s.onerror = function () { reject(new Error('Failed to load Ably SDK')); };
      document.head.appendChild(s);
    });
    return ablyLoading;
  }

  function AblyTransport() { Emitter.call(this); this.kind = 'ably'; this.id = randId(); this.joined = false; }
  AblyTransport.prototype = Object.create(Emitter.prototype);

  AblyTransport.prototype.connect = function (code, role) {
    var self = this;
    this.role = role; this.code = String(code).toUpperCase();
    return loadAbly().then(function (Ably) {
      return new Promise(function (resolve, reject) {
        var clientId = self.id;
        self.client = new Ably.Realtime({
          authUrl: '/api/token?clientId=' + encodeURIComponent(clientId),
          echoMessages: false,
          clientId: clientId
        });
        var settled = false;
        var failTimer = setTimeout(function () {
          if (!settled) { settled = true; reject(new Error('Realtime connection timed out')); }
        }, 12000);

        self.client.connection.on('failed', function () {
          if (!settled) { settled = true; clearTimeout(failTimer); reject(new Error('Realtime auth failed (is ABLY_API_KEY set?)')); }
        });
        self.client.connection.on('connected', function () {
          // wire channel + presence ONCE; Ably preserves them across reconnects,
          // so re-running here would stack duplicate listeners → double dispatch.
          if (!self._wired) {
            self._wired = true;
            self.channel = self.client.channels.get('sonar:room:' + self.code);
            self.channel.subscribe(function (msg) {
              if (msg.clientId === self.id) return;        // ignore our own messages
              self._emit(msg.name, msg.data, msg.clientId);
            });
            var other = function (m) { return m && m.clientId && m.clientId !== self.id; };
            self.channel.presence.subscribe('enter', function (m) { if (other(m)) self._peer('join'); });
            self.channel.presence.subscribe('present', function (m) { if (other(m)) self._peer('join'); });
            self.channel.presence.subscribe('leave', function (m) { if (other(m)) self._peer('leave'); });
            self.channel.presence.enter({ role: role });
            self.channel.presence.get(function (err, members) {
              if (!err && members && members.some(other)) self._peer('join');
            });
            // release the connection promptly when the tab/page goes away
            self._unload = function () {
              try { if (self.channel) self.channel.presence.leave(); } catch (e) {}
              try { if (self.client) self.client.close(); } catch (e) {}
            };
            root.addEventListener('pagehide', self._unload);
          }
          if (!settled) { settled = true; clearTimeout(failTimer); resolve(); }
        });
      });
    });
  };
  AblyTransport.prototype.send = function (type, payload) {
    if (this.channel) this.channel.publish(type, payload);
  };
  AblyTransport.prototype.close = function () {
    if (this._unload) { root.removeEventListener('pagehide', this._unload); this._unload = null; }
    try { if (this.channel) { this.channel.presence.leave(); this.channel.detach(); } } catch (e) {}
    try { if (this.client) this.client.close(); } catch (e) {}
    this.channel = null; this.client = null; this._wired = false;
  };

  // ---------------------------------------------------------------------------
  function create(kind) {
    return kind === 'ably' ? new AblyTransport() : new LocalTransport();
  }

  // Probe whether the internet backend is configured on the server.
  function probeRealtime() {
    if (typeof fetch === 'undefined' || location.protocol === 'file:') return Promise.resolve(false);
    return fetch('/api/config').then(function (r) { return r.ok ? r.json() : { realtime: false }; })
      .then(function (d) { return !!d.realtime; })
      .catch(function () { return false; });
  }

  function makeCode() {
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    var s = '';
    for (var i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  root.BS = root.BS || {};
  root.BS.Net = { create: create, probeRealtime: probeRealtime, makeCode: makeCode };

})(typeof window !== 'undefined' ? window : this);
