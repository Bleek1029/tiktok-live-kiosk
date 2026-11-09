// Optional: reads chat from YOUR OWN TikTok Live and forwards it to the app.
// Uses the unofficial "tiktok-live-connector" package, which can break whenever
// TikTok changes things. If it isn't installed, the app still works with the
// built-in simulator and POST /api/chat.
module.exports.start = function start(username, onChat) {
  let lib;
  try {
    lib = require('tiktok-live-connector');
  } catch (e) {
    console.log('[connector] tiktok-live-connector not installed. Run: npm i tiktok-live-connector');
    return;
  }
  const Conn = lib.TikTokLiveConnection || lib.WebcastPushConnection;
  const evt = (lib.WebcastEvent && lib.WebcastEvent.CHAT) || 'chat';
  const conn = new Conn(username);
  conn.on(evt, (d) => {
    const user = d.uniqueId || (d.user && d.user.uniqueId) || 'unknown';
    const text = d.comment || '';
    if (text) onChat(user, text);
  });
  conn.connect()
    .then(() => console.log('[connector] connected to @' + username))
    .catch((err) => console.log('[connector] could not connect:', err.message || err));
};
