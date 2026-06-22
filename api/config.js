// GET /api/config — tells the client whether the realtime (Ably) backend is set up.
module.exports = function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ realtime: !!process.env.ABLY_API_KEY });
};
