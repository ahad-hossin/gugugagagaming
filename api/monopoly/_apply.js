// _apply.js — shared helpers for the TYCOON serverless endpoints.
'use strict';

var redis = require('./_redis.js');
var ably = require('./_ably.js');
var engine = require('./_engine.js');

// Strip server-only/secret fields before sending state to clients. `decks`
// holds the shuffled upcoming-card order, so it must never leave the server.
function publicView(state) {
  var v = {};
  for (var k in state) if (state.hasOwnProperty(k) && k !== 'decks' && k[0] !== '_') v[k] = state[k];
  return v;
}

function randId() {
  return 'p' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}
function makeCode() {
  var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no ambiguous chars
  var s = ''; for (var i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Parse a JSON request body whether or not the runtime pre-parsed it.
function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); } }
    var data = '';
    req.on('data', function (c) { data += c; });
    req.on('end', function () { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}

// Apply an intent to a room with optimistic-concurrency retry, then broadcast.
// Returns { status, body }.
async function mutate(code, intent, now) {
  for (var attempt = 0; attempt < 6; attempt++) {
    var cur = await redis.getState(code);
    if (!cur) return { status: 404, body: { error: 'room not found' } };
    var res = engine.apply(cur.state, intent, now);
    if (!res.ok) return { status: 400, body: { error: res.error } };
    var saved = await redis.casUpdate(code, cur.version, res.state);
    if (saved.missing) return { status: 404, body: { error: 'room not found' } };
    if (saved.ok) {
      var view = publicView(res.state);
      await ably.publishSnapshot(code, view);
      return { status: 200, body: { snapshot: view } };
    }
    // version conflict → reload and retry
  }
  return { status: 409, body: { error: 'busy, please retry' } };
}

function send(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

module.exports = {
  publicView: publicView, randId: randId, makeCode: makeCode,
  readBody: readBody, mutate: mutate, send: send,
  redis: redis, ably: ably, engine: engine
};
