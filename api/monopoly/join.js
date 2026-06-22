// POST /api/monopoly/join — join a lobby (or reconnect with an existing
// playerId). Body: { code, playerId?, name, color, emoji }.
// Returns { playerId, snapshot }.
'use strict';
var A = require('./_apply.js');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return A.send(res, 405, { error: 'POST only' });
  if (!A.redis.configured()) return A.send(res, 503, { error: 'online play not configured' });
  var body = await A.readBody(req);
  var code = String(body.code || '').toUpperCase().trim();
  if (!code) return A.send(res, 400, { error: 'room code required' });
  var playerId = body.playerId || A.randId();
  var now = Date.now();
  try {
    var result = await A.mutate(code, {
      type: 'join', playerId: playerId,
      payload: { name: body.name, color: body.color, emoji: body.emoji }
    }, now);
    if (result.status === 200) result.body.playerId = playerId;
    return A.send(res, result.status, result.body);
  } catch (e) {
    return A.send(res, 500, { error: String((e && e.message) || e) });
  }
};
