/* ==========================================================================
   dev-server.js — LOCAL DEVELOPMENT ONLY.
   Serves the whole site as static files AND runs the TYCOON rules engine in an
   in-memory store, so you can play TYCOON locally without provisioning Upstash
   or Ably. Realtime is disabled, so the client falls back to polling /state
   (fine for same-machine multi-tab testing).

   Usage:   node monopoly/dev-server.js            # http://localhost:8124
            PORT=9000 node monopoly/dev-server.js

   Production does NOT use this file — Vercel serves the static files and the
   functions in /api/monopoly/* (Upstash + Ably). This is purely a dev aid.
   ========================================================================== */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var engine = require('../api/monopoly/_engine.js');

var ROOT = path.join(__dirname, '..');
var PORT = process.env.PORT || 8124;
var rooms = new Map();   // code -> state

var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function publicView(state) { var v = {}; for (var k in state) if (state.hasOwnProperty(k) && k !== 'decks' && k[0] !== '_') v[k] = state[k]; return v; }
function randId() { return 'p' + Math.random().toString(36).slice(2, 12); }
function makeCode() { var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise(function (r) { var d = ''; req.on('data', function (c) { d += c; }); req.on('end', function () { try { r(d ? JSON.parse(d) : {}); } catch (e) { r({}); } }); }); }

async function handleApi(req, res, url) {
  var now = Date.now();
  if (url.pathname === '/api/config') return json(res, 200, { realtime: false });
  if (url.pathname === '/api/token') return json(res, 503, { error: 'realtime disabled in dev' });

  if (url.pathname === '/api/monopoly/state') {
    var code = (url.searchParams.get('code') || '').toUpperCase();
    var st = rooms.get(code); if (!st) return json(res, 404, { error: 'room not found' });
    return json(res, 200, { snapshot: publicView(st) });
  }
  var body = await readBody(req);
  if (url.pathname === '/api/monopoly/create') {
    var pid = randId(), code;
    do { code = makeCode(); } while (rooms.has(code));
    var state = engine.createGame({ code: code, host: { id: pid, name: body.name || 'Host', color: body.color, emoji: body.emoji }, now: now });
    rooms.set(code, state);
    return json(res, 200, { code: code, playerId: pid, snapshot: publicView(state) });
  }
  if (url.pathname === '/api/monopoly/join') {
    var c = (body.code || '').toUpperCase(); var s = rooms.get(c); if (!s) return json(res, 404, { error: 'room not found' });
    var jid = body.playerId || randId();
    var r = engine.apply(s, { type: 'join', playerId: jid, payload: { name: body.name, color: body.color, emoji: body.emoji } }, now);
    if (!r.ok) return json(res, 400, { error: r.error });
    rooms.set(c, r.state);
    return json(res, 200, { playerId: jid, snapshot: publicView(r.state) });
  }
  if (url.pathname === '/api/monopoly/action') {
    var ac = (body.code || '').toUpperCase(); var as = rooms.get(ac); if (!as) return json(res, 404, { error: 'room not found' });
    var ar = engine.apply(as, { type: body.type, playerId: body.playerId, payload: body.payload || {} }, now);
    if (!ar.ok) return json(res, 400, { error: ar.error });
    rooms.set(ac, ar.state);
    return json(res, 200, { snapshot: publicView(ar.state) });
  }
  return json(res, 404, { error: 'no such endpoint' });
}

function serveStatic(req, res, url) {
  var p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  var file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, function (err, stat) {
    if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, function (e, data) {
      if (e) {            // cleanUrls: try `${p}.html`
        fs.readFile(path.join(ROOT, p + '.html'), function (e2, d2) {
          if (e2) { res.writeHead(404); res.end('not found: ' + p); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

http.createServer(function (req, res) {
  var url = new URL(req.url, 'http://localhost');
  if (url.pathname.indexOf('/api/') === 0) { handleApi(req, res, url).catch(function (e) { json(res, 500, { error: String(e && e.message || e) }); }); return; }
  serveStatic(req, res, url);
}).listen(PORT, function () { console.log('TYCOON dev server → http://localhost:' + PORT + '/monopoly/'); });
