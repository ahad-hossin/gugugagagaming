// POST /api/monopoly/action — the single intent dispatcher. All gameplay
// mutations come through here. Body: { code, playerId, type, payload }.
// Returns { snapshot } on success; the realtime channel also receives it.
'use strict';
var A = require('./_apply.js');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return A.send(res, 405, { error: 'POST only' });
  if (!A.redis.configured()) return A.send(res, 503, { error: 'online play not configured' });
  var body = await A.readBody(req);
  var code = String(body.code || '').toUpperCase().trim();
  var playerId = body.playerId;
  var type = body.type;
  if (!code || !playerId || !type) return A.send(res, 400, { error: 'code, playerId and type are required' });
  var now = Date.now();
  try {
    var result = await A.mutate(code, { type: type, playerId: playerId, payload: body.payload || {} }, now);
    return A.send(res, result.status, result.body);
  } catch (e) {
    return A.send(res, 500, { error: String((e && e.message) || e) });
  }
};
