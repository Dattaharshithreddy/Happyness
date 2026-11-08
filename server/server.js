'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { assess, findBlocked } = require('../shared/joy-filter');
const feeds = require('./feeds');
const { buildTab } = require('../shared/feed-core');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const PAGE_SIZE = 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- tiny helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// Very small in-memory rate limiter: `max` actions per `windowMs` per IP+key.
const hits = new Map();
function rateLimited(req, key, max, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = `${key}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

function clean(str, max) {
  return String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const { pathname } = url;

  // The Android app (and any other client) may use this server as its
  // community server, so allow cross-origin calls. No cookies are used.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && pathname === '/api/feed') {
    const tab = url.searchParams.get('tab') || 'all';
    const page = Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0);
    const muted = (url.searchParams.get('muted') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);

    const { items: external } = await feeds.getItems();
    const community = store.listPosts();
    let items = buildTab(tab, external, community);

    // Personal "mood shield": hide anything containing the user's muted words.
    if (muted.length) {
      items = items.filter((it) => {
        const text = `${it.title || ''} ${it.summary || ''} ${it.text || ''}`;
        return !findBlocked(text, muted);
      });
    }

    const start = page * PAGE_SIZE;
    return send(res, 200, {
      items: items.slice(start, start + PAGE_SIZE),
      page,
      hasMore: start + PAGE_SIZE < items.length,
      total: items.length,
    });
  }

  if (req.method === 'POST' && pathname === '/api/posts') {
    if (rateLimited(req, 'post', 5, 60 * 60 * 1000)) {
      return send(res, 429, { error: 'You have shared a lot of joy this hour! Please try again a little later.' });
    }
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const name = clean(body.name, 40) || 'A kind stranger';
    const place = clean(body.place, 40);
    const text = clean(body.text, 600);
    const mood = ['kindness', 'proud', 'animals', 'nature', 'family', 'funny'].includes(body.mood) ? body.mood : 'kindness';
    if (text.length < 15) return send(res, 400, { error: 'Tell us a little more — at least a sentence or two.' });
    if (/https?:\/\/|www\./i.test(text)) return send(res, 400, { error: 'Links are not allowed in stories — just share the moment in your words.' });

    const verdict = assess(`${name} ${place} ${text}`, { minScore: 2 });
    if (!verdict.ok) {
      return send(res, 422, {
        error: verdict.blocked
          ? 'Happyness only shares light, happy moments, so we could not post this one. If you are going through a hard time, please reach out to someone you trust 💛'
          : 'This does not sound quite happy enough yet. Try describing what made you smile!',
        reason: verdict.reason,
      });
    }
    return send(res, 201, { post: store.addPost({ name, place, text, mood }) });
  }

  let m;
  if (req.method === 'POST' && (m = pathname.match(/^\/api\/posts\/([\w-]{1,64})\/react$/))) {
    if (rateLimited(req, 'react', 120, 60 * 1000)) return send(res, 429, { error: 'Slow down a little 🙂' });
    let body;
    try { body = await readJson(req, 1000); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const post = store.react(m[1], body.reaction, body.delta);
    return post ? send(res, 200, { post }) : send(res, 404, { error: 'Not found' });
  }

  if (req.method === 'POST' && (m = pathname.match(/^\/api\/posts\/([\w-]{1,64})\/report$/))) {
    if (rateLimited(req, 'report', 20, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many reports.' });
    return store.report(m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
  }

  if (req.method === 'POST' && pathname === '/api/check') {
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const v = assess(clean(body.text, 600));
    return send(res, 200, { ok: v.ok, score: Number.isFinite(v.score) ? v.score : null, reason: v.reason });
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const { at, items, stats } = await feeds.getItems();
    return send(res, 200, { updatedAt: at ? new Date(at).toISOString() : null, externalItems: items.length, sources: stats });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel === '/') rel = '/index.html';
  const base = rel.startsWith('/shared/') ? SHARED_DIR : PUBLIC_DIR;
  if (base === SHARED_DIR) rel = rel.slice('/shared'.length);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => (e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': MIME['.html'] })));
    }
    const ext = path.extname(file);
    const cache = ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  🌻 Happyness is running at http://localhost:${PORT}\n`);
    feeds.getItems().then(({ items }) => console.log(`  Loaded ${items.length} happy stories from the web.`));
  });
}

module.exports = { server };
