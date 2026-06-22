// _ably.js — push a fresh GameState snapshot to all clients in a room.
// Clients subscribe to channel `monopoly:<CODE>` and render whatever snapshot
// arrives. If ABLY_API_KEY is unset we silently skip — clients fall back to
// GET /api/monopoly/state polling.
'use strict';

var _rest = null;
function configured() { return !!process.env.ABLY_API_KEY; }
function rest() {
  if (_rest) return _rest;
  var Ably = require('ably');
  _rest = new Ably.Rest(process.env.ABLY_API_KEY);
  return _rest;
}

// Publish the snapshot (best-effort; never throws into the request path).
async function publishSnapshot(code, snapshot) {
  if (!configured()) return;
  try {
    var ch = rest().channels.get('monopoly:' + String(code).toUpperCase());
    await ch.publish('snapshot', snapshot);
  } catch (e) { /* push is best-effort; state is already persisted */ }
}

module.exports = { configured: configured, publishSnapshot: publishSnapshot };
