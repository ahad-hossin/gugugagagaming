// GET /api/token — issues a short-lived Ably token so the secret key never
// reaches the browser. Set ABLY_API_KEY in the Vercel project env vars.
var Ably = require('ably');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  var key = process.env.ABLY_API_KEY;
  if (!key) {
    res.status(503).json({ error: 'ABLY_API_KEY not configured' });
    return;
  }
  try {
    var rest = new Ably.Rest(key);
    var clientId = (req.query && req.query.clientId) || ('anon-' + Math.random().toString(36).slice(2));
    var tokenRequest = await rest.auth.createTokenRequest({ clientId: String(clientId).slice(0, 64) });
    res.status(200).json(tokenRequest);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
