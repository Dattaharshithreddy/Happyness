'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { assess, findBlocked } = require('../shared/joy-filter');
const { buildTab } = require('../shared/feed-core');

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

const MSG = {
  blocked: 'Happyness only shares light, happy moments, so we could not post this one. If you are going through a hard time, please reach out to someone you trust 💛',
  notHappy: 'This does not sound quite happy enough yet. Try describing what made you smile!',
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

function clean(str, max) {
  return String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clientIp(req) {
  // Only trust X-Forwarded-For behind a proxy you control (TRUST_PROXY=1).
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

/** In-memory sliding-window rate limiter. */
function makeLimiter() {
  const hits = new Map();
  setInterval(() => hits.clear(), 60 * 60 * 1000).unref();
  return (key, max, windowMs) => {
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length > max;
  };
}

/** Keyword-only moderation (Phase 2 adds AI; see moderation.js). */
async function keywordModerate({ name, place, text }) {
  const v = assess(`${name} ${place} ${text}`, { minScore: 2 });
  if (v.ok) return { decision: 'approve', reason: 'keywords: uplifting', by: 'keywords' };
  return { decision: 'reject', reason: v.blocked ? 'blocked' : 'not_happy', by: 'keywords', detail: v.reason };
}

/**
 * Build the HTTP server.
 * @param {{db: ReturnType<import('./db').open>, feeds: {getItems: Function}, moderate?: Function, adminToken?: string}} deps
 */
function createApp({ db, feeds, moderate = keywordModerate, adminToken = process.env.ADMIN_TOKEN || '' }) {
  const limited = makeLimiter();

  function auth(req) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(\S+)$/i);
    return m ? db.userByToken(m[1]) : null;
  }

  function requireUser(req, res) {
    const user = auth(req);
    if (!user) { send(res, 401, { error: 'Please reopen the app to set up your account.' }); return null; }
    if (user.banned) { send(res, 403, { error: 'This account can no longer post.' }); return null; }
    return user;
  }

  async function body(req, res, limit) {
    try { return await readJson(req, limit); } catch { send(res, 400, { error: 'Invalid request.' }); return null; }
  }

  // ---------- API ----------
  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // The Android app calls this server from its own origin. Auth is a bearer
    // token (no cookies), so a wildcard origin is safe.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (pathname.startsWith('/api/admin/')) return handleAdmin(req, res, url);

    // --- health
    if (method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true });

    // --- account
    if (pathname === '/api/account') {
      if (method === 'POST') {
        if (limited(`acct:${clientIp(req)}`, 10, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many new accounts from this network. Try again later.' });
        const b = await body(req, res, 2000);
        if (!b) return;
        const name = clean(b.name, 40) || 'A kind stranger';
        if (findBlocked(name)) return send(res, 422, { error: 'Please choose a friendlier name.' });
        return send(res, 201, db.createUser(name));
      }
      const user = auth(req);
      if (!user) return send(res, 401, { error: 'Not signed in.' });
      if (method === 'GET') return send(res, 200, { user: db.publicUser(user), posts: db.listOwnPosts(user.id), blocked: db.listBlocks(user.id) });
      if (method === 'PATCH') {
        const b = await body(req, res, 2000);
        if (!b) return;
        const name = clean(b.name, 40);
        if (!name) return send(res, 400, { error: 'Name cannot be empty.' });
        if (findBlocked(name)) return send(res, 422, { error: 'Please choose a friendlier name.' });
        return send(res, 200, { user: db.renameUser(user.id, name) });
      }
      if (method === 'DELETE') {
        db.deleteUser(user.id);
        return send(res, 200, { ok: true, deleted: true });
      }
    }

    // --- feed
    if (method === 'GET' && pathname === '/api/feed') {
      const viewer = auth(req);
      const tab = url.searchParams.get('tab') || 'all';
      const page = Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0);
      const muted = (url.searchParams.get('muted') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);

      const { items: external } = tab === 'community' ? { items: [] } : await feeds.getItems();
      let items = buildTab(tab, external, db.listPosts(viewer && viewer.id));
      if (muted.length) {
        items = items.filter((it) => !findBlocked(`${it.title || ''} ${it.summary || ''} ${it.text || ''}`, muted));
      }
      const start = page * PAGE_SIZE;
      return send(res, 200, { items: items.slice(start, start + PAGE_SIZE), page, hasMore: start + PAGE_SIZE < items.length, total: items.length });
    }

    // --- create a post
    if (method === 'POST' && pathname === '/api/posts') {
      const user = requireUser(req, res);
      if (!user) return;
      if (limited(`post:${user.id}`, 5, 60 * 60 * 1000) || limited(`postip:${clientIp(req)}`, 20, 60 * 60 * 1000)) {
        return send(res, 429, { error: 'You have shared a lot of joy this hour! Please try again a little later.' });
      }
      const b = await body(req, res);
      if (!b) return;
      if (b.agree !== true) return send(res, 400, { error: 'Please agree to the community guidelines first.' });
      const place = clean(b.place, 40);
      const text = clean(b.text, 600);
      const mood = clean(b.mood, 20);
      if (text.length < 15) return send(res, 400, { error: 'Tell us a little more — at least a sentence or two.' });
      if (/https?:\/\/|www\.|\.(com|net|org|io)\b/i.test(text)) return send(res, 400, { error: 'Links are not allowed in stories — just share the moment in your words.' });

      const verdict = await moderate({ name: user.name, place, text });
      if (verdict.decision === 'reject') {
        return send(res, 422, { error: verdict.reason === 'blocked' ? MSG.blocked : MSG.notHappy, reason: verdict.reason });
      }
      const status = verdict.decision === 'review' ? 'pending' : 'published';
      const post = db.createPost(user.id, { name: user.name, place, text, mood, status, moderation: `${verdict.by}: ${verdict.detail || verdict.reason}` });
      return send(res, 201, {
        post,
        notice: status === 'pending' ? 'Thanks! Your story will appear after a quick check 🌼' : undefined,
      });
    }

    let m;
    // --- delete own post
    if (method === 'DELETE' && (m = pathname.match(/^\/api\/posts\/([\w-]{1,64})$/))) {
      const user = requireUser(req, res);
      if (!user) return;
      return db.deleteOwnPost(user.id, m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
    }

    // --- react
    if (method === 'POST' && (m = pathname.match(/^\/api\/posts\/([\w-]{1,64})\/react$/))) {
      const user = requireUser(req, res);
      if (!user) return;
      if (limited(`react:${user.id}`, 120, 60 * 1000)) return send(res, 429, { error: 'Slow down a little 🙂' });
      const b = await body(req, res, 1000);
      if (!b) return;
      const on = b.on !== undefined ? !!b.on : Number(b.delta) > 0;
      const post = db.setReaction(user.id, m[1], b.reaction, on);
      return post ? send(res, 200, { post }) : send(res, 404, { error: 'Not found' });
    }

    // --- report
    if (method === 'POST' && (m = pathname.match(/^\/api\/posts\/([\w-]{1,64})\/report$/))) {
      const user = requireUser(req, res);
      if (!user) return;
      if (limited(`report:${user.id}`, 30, 60 * 60 * 1000)) return send(res, 429, { error: 'Too many reports.' });
      const b = (await body(req, res, 2000)) || {};
      const r = db.report(user.id, m[1], clean(b.reason, 200));
      return r ? send(res, 200, { ok: true, ...r }) : send(res, 404, { error: 'Not found' });
    }

    // --- block / unblock a person
    if ((m = pathname.match(/^\/api\/users\/([\w-]{1,64})\/block$/)) && (method === 'POST' || method === 'DELETE')) {
      const user = requireUser(req, res);
      if (!user) return;
      if (method === 'DELETE') { db.unblock(user.id, m[1]); return send(res, 200, { ok: true }); }
      return db.block(user.id, m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
    }

    // --- live joy meter
    if (method === 'POST' && pathname === '/api/check') {
      if (limited(`check:${clientIp(req)}`, 240, 60 * 1000)) return send(res, 429, { error: 'Slow down a little 🙂' });
      const b = await body(req, res);
      if (!b) return;
      const v = assess(clean(b.text, 600));
      return send(res, 200, { ok: v.ok, score: Number.isFinite(v.score) ? v.score : null, reason: v.reason });
    }

    if (method === 'GET' && pathname === '/api/status') {
      const { at, items, stats } = await feeds.getItems();
      return send(res, 200, { updatedAt: at ? new Date(at).toISOString() : null, externalItems: items.length, sources: stats });
    }

    return send(res, 404, { error: 'Not found' });
  }

  // ---------- admin (moderation) ----------
  async function handleAdmin(req, res, url) {
    const given = String(req.headers['x-admin-token'] || '');
    const ok = adminToken.length >= 16 && given.length === adminToken.length
      && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(adminToken));
    if (!ok) {
      if (limited(`admin-fail:${clientIp(req)}`, 10, 15 * 60 * 1000)) return send(res, 429, { error: 'Too many attempts.' });
      return send(res, 401, { error: adminToken ? 'Wrong admin token.' : 'Admin is disabled: set ADMIN_TOKEN (16+ characters) on the server.' });
    }
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/api/admin/queue') return send(res, 200, { stats: db.stats(), queue: db.moderationQueue() });
    let m;
    if (req.method === 'POST' && (m = pathname.match(/^\/api\/admin\/posts\/([\w-]{1,64})$/))) {
      const b = await body(req, res, 2000);
      if (!b) return;
      const status = b.action === 'approve' ? 'published' : b.action === 'remove' ? 'removed' : null;
      if (!status) return send(res, 400, { error: 'action must be approve or remove' });
      return db.setPostStatus(m[1], status, `admin: ${b.action}`) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
    }
    if (req.method === 'POST' && (m = pathname.match(/^\/api\/admin\/users\/([\w-]{1,64})\/ban$/))) {
      return db.banUser(m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Not found' });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ---------- static files ----------
  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
    if (rel === '/') rel = '/index.html';
    if (rel === '/config.js') {
      const cfg = { server: '', storeSafe: process.env.STORE_SAFE === '1', contactEmail: process.env.CONTACT_EMAIL || '' };
      return send(res, 200, `window.HAPPYNESS_CONFIG = ${JSON.stringify(cfg)};\n`, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    }
    // Friendly URLs for the legal pages (Play Store needs public links).
    if (['/privacy', '/terms', '/delete-account', '/admin'].includes(rel)) rel += '.html';
    const base = rel.startsWith('/shared/') ? SHARED_DIR : PUBLIC_DIR;
    if (base === SHARED_DIR) rel = rel.slice('/shared'.length);
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => (e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': MIME['.html'] })));
      }
      const ext = path.extname(file);
      const cache = ext === '.html' || file.endsWith('sw.js') || file.endsWith('config.js') ? 'no-cache' : 'public, max-age=3600';
      send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    }
  });
}

if (require.main === module) {
  const db = require('./db').open();
  const feeds = require('./feeds');
  let moderate;
  try { moderate = require('./moderation').createModerator(); } catch { moderate = undefined; }
  const PORT = Number(process.env.PORT) || 3000;
  createApp({ db, feeds, moderate }).listen(PORT, () => {
    console.log(`\n  🌻 Happyness is running at http://localhost:${PORT}\n`);
    feeds.getItems().then(({ items }) => console.log(`  Loaded ${items.length} happy stories from the web.`));
  });
}

module.exports = { createApp, keywordModerate };
