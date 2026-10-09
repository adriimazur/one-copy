// One Copy — mail that leaves your hands.
// Zero-dependency server: a letter exists in exactly one place at a time.
// Either it's held by one device, or it's "in transit" behind a single-use link.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 4321;
const DB = path.join(__dirname, 'data.json');
const PAGE = path.join(__dirname, 'index.html');

let letters = {};
try { letters = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => fs.writeFile(DB, JSON.stringify(letters, null, 2), () => {});
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
});

// The outside of the envelope: what anyone holding a valid link may see before opening.
const outside = (l) => ({
  id: l.id,
  stamp: l.stamp,
  hops: l.hops.map(({ from, to, sentAt, openedAt }) => ({ from, to, sentAt, openedAt })),
});
// The whole thing: only for whoever holds it.
const inside = (l) => ({ ...outside(l), body: l.body, notes: l.hops.filter((h) => h.note).map(({ from, to, note }) => ({ from, to, note })) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(PAGE).pipe(res);
  }

  // POST /api/letters — write + seal. The author never holds it; it goes straight into transit.
  if (req.method === 'POST' && parts[1] === 'letters' && !parts[2]) {
    const b = await readBody(req);
    const body = clean(b.body, 4000), to = clean(b.to, 40), from = clean(b.from, 40);
    if (!body || !to || !from) return json(res, 400, { error: 'A letter needs a body, a recipient and a sender.' });
    const l = {
      id: rid(), token: rid(12), holder: null, body, stamp: clean(b.stamp, 12) || 'dusk',
      hops: [{ from, to, note: null, sentAt: Date.now(), openedAt: null }],
    };
    letters[l.id] = l; save();
    return json(res, 200, { id: l.id, token: l.token });
  }

  // GET /api/desk?device= — every letter this device currently holds.
  if (req.method === 'GET' && parts[1] === 'desk') {
    const device = url.searchParams.get('device');
    const held = Object.values(letters).filter((l) => device && l.holder === device).map(outside);
    held.sort((a, b) => b.hops.at(-1).openedAt - a.hops.at(-1).openedAt);
    return json(res, 200, { letters: held });
  }

  const l = parts[1] === 'letters' && letters[parts[2]];
  if (parts[1] === 'letters' && !l) return json(res, 404, { error: 'No such letter.' });

  // GET /api/letters/:id?token=&device= — what can I see from here?
  if (req.method === 'GET' && l && !parts[3]) {
    const device = url.searchParams.get('device'), token = url.searchParams.get('token');
    if (device && l.holder === device) return json(res, 200, { state: 'yours', letter: inside(l) });
    if (l.token && token === l.token) return json(res, 200, { state: 'sealed', letter: outside(l) });
    const last = l.hops.at(-1);
    return json(res, 200, { state: 'gone', where: l.holder ? 'held' : 'transit', from: last.from, to: last.to });
  }

  // POST /api/letters/:id/open — breaking the seal. The link dies, this device holds the only copy.
  if (req.method === 'POST' && l && parts[3] === 'open') {
    const b = await readBody(req);
    if (!l.token || b.token !== l.token || !b.device) return json(res, 409, { error: 'Someone else got there first.' });
    l.token = null; l.holder = clean(b.device, 64); l.hops.at(-1).openedAt = Date.now(); save();
    return json(res, 200, { letter: inside(l) });
  }

  // POST /api/letters/:id/forward — pass it on. It leaves your desk.
  if (req.method === 'POST' && l && parts[3] === 'forward') {
    const b = await readBody(req);
    if (!b.device || l.holder !== b.device) return json(res, 403, { error: "It isn't yours to send." });
    const to = clean(b.to, 40), from = clean(b.from, 40);
    if (!to || !from) return json(res, 400, { error: 'Who is it from, and who is it for?' });
    l.holder = null; l.token = rid(12);
    l.hops.push({ from, to, note: clean(b.note, 160) || null, sentAt: Date.now(), openedAt: null });
    save();
    return json(res, 200, { id: l.id, token: l.token });
  }

  json(res, 404, { error: 'Not found.' });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log(`One Copy is open:\n  http://localhost:${PORT}${lan ? `\n  http://${lan.address}:${PORT}  (phones on the same wifi)` : ''}`);
});
