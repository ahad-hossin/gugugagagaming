// GET /api/monopoly/state?code=ABCD — current snapshot (for reconnect / when
// the realtime channel is unavailable).
'use strict';
var A = require('./_apply.js');

module.exports = async function (req, res) {
  if (!A.redis.configured()) return A.send(res, 503, { error: 'online play not configured' });
  var code = String((req.query && req.query.code) || '').toUpperCase().trim();
  if (!code) return A.send(res, 400, { error: 'code required' });
  try {
    var cur = await A.redis.getState(code);
    if (!cur) return A.send(res, 404, { error: 'room not found' });
    return A.send(res, 200, { snapshot: A.publicView(cur.state) });
  } catch (e) {
    return A.send(res, 500, { error: String((e && e.message) || e) });
  }
};
