// POST /api/monopoly/create — create a room, return {code, playerId, snapshot}.
'use strict';
var A = require('./_apply.js');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return A.send(res, 405, { error: 'POST only' });
  if (!A.redis.configured()) return A.send(res, 503, { error: 'online play not configured (UPSTASH_REDIS_REST_* missing)' });
  var body = await A.readBody(req);
  var now = Date.now();
  var playerId = A.randId();
  var host = {
    id: playerId,
    name: String(body.name || 'Host').slice(0, 20),
    color: body.color || '#3df5ff',
    emoji: body.emoji || '🎩'
  };
  try {
    for (var attempt = 0; attempt < 8; attempt++) {
      var code = A.makeCode();
      var state = A.engine.createGame({ code: code, host: host, now: now });
      var created = await A.redis.createState(code, state);
      if (created) {
        var view = A.publicView(state);
        return A.send(res, 200, { code: code, playerId: playerId, snapshot: view });
      }
    }
    return A.send(res, 500, { error: 'could not allocate a room code' });
  } catch (e) {
    return A.send(res, 500, { error: String((e && e.message) || e) });
  }
};
