const express = require('express');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');

const PORT = process.env.PORT || 3000;

let db = { sessions: [], blacklist: [], buyers: {}, nextOrderId: 1 };
const save = () => store.save(db);

const current = () => db.sessions.find((s) => !s.endedAt) || null;

// ---------- pin parsing ----------
// Accepts: "mine 12", "m12", "#12", "pin 12 x2", "mine12 2pcs"
const PIN_RE = /^\s*(?:mine|m|pin|#)\s*#?\s*(\d{1,4})\b(?:.*?(?:x|\*)\s*(\d{1,2})\b|.*?\b(\d{1,2})\s*(?:pcs|pc|piece|pieces)\b)?/i;
function parsePin(text) {
  const m = PIN_RE.exec(text || '');
  if (!m) return null;
  return { pin: m[1], qty: Math.min(parseInt(m[2] || m[3] || '1', 10) || 1, 20) };
}

// ---------- buyers ----------
function badgeFor(user) {
  const b = db.buyers[user];
  if (!b || b.checkedOut === 0) return 'NEW';
  if (b.checkedOut >= 5 || b.spent >= 3000) return 'JOY';
  return 'OLD';
}

// ---------- SSE ----------
const clients = new Set();
function snapshot() {
  const s = current();
  return {
    session: s,
    blacklist: db.blacklist,
    badges: s ? Object.fromEntries([...new Set(s.orders.map((o) => o.user))].map((u) => [u, badgeFor(u)])) : {},
    totals: s ? totalsOf(s) : null,
  };
}
function totalsOf(s) {
  const live = s.orders.filter((o) => o.status !== 'cancelled');
  return {
    orders: live.length,
    pieces: live.reduce((a, o) => a + o.qty, 0),
    buyers: new Set(live.map((o) => o.user)).size,
    value: live.reduce((a, o) => a + (o.price || 0) * o.qty, 0),
    checkedOut: live.filter((o) => o.status === 'checked_out').length,
  };
}
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

// ---------- chat ingestion ----------
function ingestChat(user, text) {
  const s = current();
  if (!s) return { ok: false, error: 'No live session. Start one first.' };
  user = String(user || 'unknown').trim().slice(0, 40);
  text = String(text || '').trim().slice(0, 200);
  if (!text) return { ok: false, error: 'Empty comment.' };

  const blocked = db.blacklist.some((b) => b.user.toLowerCase() === user.toLowerCase());
  const chat = { t: Date.now(), user, text, pinned: false, blocked };
  const pin = parsePin(text);

  if (pin && !blocked) {
    const item = s.items[pin.pin] || null;
    const existing = s.orders.find((o) => o.user === user && o.pin === pin.pin && o.status === 'mine');
    if (existing) {
      existing.qty += pin.qty;
    } else {
      s.orders.push({
        id: db.nextOrderId++,
        user, pin: pin.pin, qty: pin.qty,
        item: item ? item.name : null,
        price: item ? item.price : null,
        status: 'mine',
        badge: badgeFor(user),
        t: Date.now(),
      });
    }
    chat.pinned = true;
  }
  s.chat.push(chat);
  if (s.chat.length > 300) s.chat.shift();
  save();
  broadcast();
  return { ok: true, pinned: chat.pinned, blocked };
}

// ---------- app ----------
// ---------- login (single shared password) ----------
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DAY = 24 * 60 * 60 * 1000;
const hmac = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function makeToken() { const exp = String(Date.now() + 14 * DAY); return exp + '.' + hmac(exp); }
function validToken(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = Buffer.from(hmac(exp)), got = Buffer.from(sig);
  return good.length === got.length && crypto.timingSafeEqual(good, got);
}
function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name);
  return m ? m[1] : null;
}
const attempts = new Map(); // ip -> { n, reset }

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.get('/healthz', (_req, res) => res.send('ok'));

app.post('/api/login', (req, res) => {
  const now = Date.now();
  const a = attempts.get(req.ip) || { n: 0, reset: now + 15 * 60 * 1000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 15 * 60 * 1000; }
  if (a.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  a.n++; attempts.set(req.ip, a);
  if (!APP_PASSWORD || crypto.timingSafeEqual(digest(req.body.password || ''), digest(APP_PASSWORD))) {
    attempts.delete(req.ip);
    res.setHeader('Set-Cookie', `tg=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * DAY / 1000}${req.secure ? '; Secure' : ''}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password.' });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'tg=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  if (['/login.html', '/style.css'].includes(req.path)) return next();
  if (validToken(cookieOf(req, 'tg'))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in.' });
  res.redirect('/login.html');
});

app.get('/api/me', (_req, res) => res.json({ auth: !!APP_PASSWORD }));

// full backup of all records (free Render databases have no backups!)
app.get('/api/export', (_req, res) => {
  res.set('Content-Disposition', `attachment; filename="tagasulat-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(db);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/session/start', (req, res) => {
  if (current()) return res.status(400).json({ error: 'A session is already running.' });
  const name = String(req.body.name || '').trim().slice(0, 60) || 'Live ' + new Date().toLocaleString('en-PH');
  db.sessions.push({ id: Date.now(), name, startedAt: Date.now(), endedAt: null, items: {}, orders: [], chat: [] });
  save(); broadcast();
  res.json({ ok: true });
});

app.post('/api/session/end', (_req, res) => {
  const s = current();
  if (!s) return res.status(400).json({ error: 'No running session.' });
  s.endedAt = Date.now();
  save(); broadcast();
  res.json({ ok: true });
});

app.post('/api/chat', (req, res) => {
  const r = ingestChat(req.body.user, req.body.text);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post('/api/items', (req, res) => {
  const s = current();
  if (!s) return res.status(400).json({ error: 'No running session.' });
  const pin = String(req.body.pin || '').trim();
  const name = String(req.body.name || '').trim().slice(0, 60);
  const price = Number(req.body.price);
  if (!/^\d{1,4}$/.test(pin) || !name || !(price >= 0)) return res.status(400).json({ error: 'Need a pin number, item name, and price.' });
  s.items[pin] = { name, price };
  // fill in open orders that were pinned before the price was set
  s.orders.filter((o) => o.pin === pin && o.status === 'mine' && o.price == null).forEach((o) => { o.item = name; o.price = price; });
  save(); broadcast();
  res.json({ ok: true });
});

app.delete('/api/items/:pin', (req, res) => {
  const s = current();
  if (s) { delete s.items[req.params.pin]; save(); broadcast(); }
  res.json({ ok: true });
});

app.post('/api/orders/:id/status', (req, res) => {
  const s = current();
  const o = s && s.orders.find((x) => x.id === Number(req.params.id));
  const status = req.body.status;
  if (!o || !['mine', 'confirmed', 'checked_out', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Bad request.' });
  const wasOut = o.status === 'checked_out';
  o.status = status;
  const b = (db.buyers[o.user] = db.buyers[o.user] || { checkedOut: 0, spent: 0 });
  const value = (o.price || 0) * o.qty;
  if (status === 'checked_out' && !wasOut) { b.checkedOut += 1; b.spent += value; }
  if (wasOut && status !== 'checked_out') { b.checkedOut = Math.max(0, b.checkedOut - 1); b.spent = Math.max(0, b.spent - value); }
  save(); broadcast();
  res.json({ ok: true });
});

app.post('/api/orders/:id/edit', (req, res) => {
  const s = current();
  const o = s && s.orders.find((x) => x.id === Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Not found.' });
  if (req.body.qty != null) o.qty = Math.max(1, Math.min(20, parseInt(req.body.qty, 10) || 1));
  if (req.body.price != null) o.price = Math.max(0, Number(req.body.price) || 0);
  if (req.body.item != null) o.item = String(req.body.item).slice(0, 60);
  save(); broadcast();
  res.json({ ok: true });
});

app.post('/api/blacklist', (req, res) => {
  const user = String(req.body.user || '').trim();
  if (!user) return res.status(400).json({ error: 'Need a username.' });
  if (!db.blacklist.some((b) => b.user.toLowerCase() === user.toLowerCase())) {
    db.blacklist.push({ user, reason: String(req.body.reason || '').slice(0, 100), t: Date.now() });
    const s = current();
    if (s) s.orders.forEach((o) => { if (o.user === user && o.status === 'mine') o.status = 'cancelled'; });
  }
  save(); broadcast();
  res.json({ ok: true });
});

app.delete('/api/blacklist/:user', (req, res) => {
  db.blacklist = db.blacklist.filter((b) => b.user.toLowerCase() !== req.params.user.toLowerCase());
  save(); broadcast();
  res.json({ ok: true });
});

app.get('/api/history', (_req, res) => {
  res.json(db.sessions.slice().reverse().map((s) => ({
    id: s.id, name: s.name, startedAt: s.startedAt, endedAt: s.endedAt, totals: totalsOf(s),
  })));
});

app.get('/api/history/:id', (req, res) => {
  const s = db.sessions.find((x) => x.id === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  res.json({ session: s, totals: totalsOf(s) });
});

// Raw ESC/POS bytes for a 58mm thermal printer (send with any raw-print tool,
// Web Serial/Bluetooth bridge, or `cat label.bin > /dev/usb/lp0` on Linux).
app.get('/api/orders/:id/escpos', (req, res) => {
  const s = current() || db.sessions[db.sessions.length - 1];
  const o = s && s.orders.find((x) => x.id === Number(req.params.id));
  if (!o) return res.status(404).end();
  const ESC = 0x1b, GS = 0x1d;
  const parts = [];
  const txt = (t) => parts.push(Buffer.from(t.replace(/[^\x20-\x7e\n]/g, '?'), 'ascii'));
  parts.push(Buffer.from([ESC, 0x40]));                 // init
  parts.push(Buffer.from([ESC, 0x61, 0x01]));           // center
  parts.push(Buffer.from([GS, 0x21, 0x11]));            // double size
  txt(`#${o.pin}\n`);
  parts.push(Buffer.from([GS, 0x21, 0x00]));            // normal
  parts.push(Buffer.from([ESC, 0x45, 0x01]));           // bold on
  txt(`@${o.user}\n`);
  parts.push(Buffer.from([ESC, 0x45, 0x00]));
  parts.push(Buffer.from([ESC, 0x61, 0x00]));           // left
  txt('--------------------------------\n');
  txt(`${o.item || 'Item #' + o.pin} x${o.qty}\n`);
  if (o.price != null) txt(`PHP ${(o.price * o.qty).toFixed(2)}\n`);
  txt(`Order ${o.id}  ${new Date(o.t).toLocaleTimeString('en-PH')}\n`);
  txt('\n\n\n');
  parts.push(Buffer.from([GS, 0x56, 0x00]));            // cut
  res.type('application/octet-stream').send(Buffer.concat(parts));
});

async function start() {
  if (process.env.NODE_ENV === 'production' && !APP_PASSWORD) {
    console.error('APP_PASSWORD is not set. Refusing to start a public server with no login.');
    process.exit(1);
  }
  db = Object.assign(db, await store.init());
  const server = app.listen(PORT, () => {
    console.log(`Tagasulat running at http://localhost:${PORT}`);
    if (process.env.TIKTOK_USERNAME) require('./connector').start(process.env.TIKTOK_USERNAME, ingestChat);
  });
  const stop = async () => { server.close(); await store.flush(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
start().catch((e) => { console.error('Startup failed:', e); process.exit(1); });
