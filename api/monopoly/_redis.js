// _redis.js — Upstash Redis state store for TYCOON rooms.
// State for a room lives in a hash at `mono:room:<CODE>`:
//   field `state`   = JSON string of the GameState snapshot
//   field `version` = integer, bumped on every successful write
// Writes are atomic compare-and-set via Lua so 16 players can't clobber each
// other; a stale write returns a conflict and the caller refetches + retries.
'use strict';

var TTL_MS = 24 * 60 * 60 * 1000; // rooms expire 24h after last activity
var KEY = function (code) { return 'mono:room:' + String(code).toUpperCase(); };

var _redis = null;
function configured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}
function client() {
  if (_redis) return _redis;
  var Redis = require('@upstash/redis').Redis;
  _redis = Redis.fromEnv();
  return _redis;
}

// Returns { state, version } or null if the room does not exist.
async function getState(code) {
  var h = await client().hgetall(KEY(code));
  if (!h || h.state == null) return null;
  var state = typeof h.state === 'string' ? JSON.parse(h.state) : h.state;
  return { state: state, version: Number(h.version) || 0 };
}

// Create a room only if the code is free. Returns true on create, false if taken.
var CREATE_LUA =
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end " +
  "redis.call('HSET', KEYS[1], 'state', ARGV[1], 'version', '1') " +
  "redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1";

async function createState(code, stateObj) {
  stateObj.version = 1;
  var r = await client().eval(CREATE_LUA, [KEY(code)], [JSON.stringify(stateObj), String(TTL_MS)]);
  return Number(r) === 1;
}

// Compare-and-set. Writes newStateObj only if the stored version still equals
// expectedVersion. Returns { ok:true, version } on success, { ok:false } on
// conflict, { ok:false, missing:true } if the room vanished.
var CAS_LUA =
  "local cur = redis.call('HGET', KEYS[1], 'version') " +
  "if cur == false then return -2 end " +
  "if cur ~= ARGV[1] then return -1 end " +
  "local nv = tonumber(ARGV[1]) + 1 " +
  "redis.call('HSET', KEYS[1], 'state', ARGV[2], 'version', tostring(nv)) " +
  "redis.call('PEXPIRE', KEYS[1], ARGV[3]) return nv";

async function casUpdate(code, expectedVersion, newStateObj) {
  newStateObj.version = expectedVersion + 1;
  var r = Number(await client().eval(
    CAS_LUA,
    [KEY(code)],
    [String(expectedVersion), JSON.stringify(newStateObj), String(TTL_MS)]
  ));
  if (r === -2) return { ok: false, missing: true };
  if (r === -1) return { ok: false };
  return { ok: true, version: r };
}

module.exports = {
  configured: configured,
  getState: getState,
  createState: createState,
  casUpdate: casUpdate,
  TTL_MS: TTL_MS
};
