'use strict';

/**
 * Happyness community database (SQLite, built into Node 22+ — no packages).
 *
 * Accounts are anonymous: the app creates an account once and keeps a secret
 * token on the device. We store only a SHA-256 hash of that token, a display
 * name, and what the person posts/reacts/reports/blocks. No email, no phone,
 * no password.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STARTER = require('../shared/starter-stories');

// node:sqlite prints an "experimental" warning once; keep logs tidy.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning).includes('SQLite')) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

const REACTIONS = ['smile', 'heart', 'clap'];
const MOODS = ['kindness', 'proud', 'animals', 'nature', 'family', 'funny'];
const REPORTS_TO_HIDE = Number(process.env.REPORTS_TO_HIDE) || 3;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- public id (shown to clients)
  token_hash  TEXT UNIQUE,                   -- sha256 of the device's secret token
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  banned      INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0     -- the "starter stories" author
);

CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- display name at posting time
  place       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  mood        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'published', -- published | pending | hidden | removed
  moderation  TEXT NOT NULL DEFAULT '',      -- why (for the admin page)
  starter     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_status_created ON posts(status, created_at);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, kind)
);

-- Seed reaction counts for starter stories (so they don't look empty).
CREATE TABLE IF NOT EXISTS reaction_seed (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  n           INTEGER NOT NULL,
  PRIMARY KEY (post_id, kind)
);

CREATE TABLE IF NOT EXISTS reports (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
`;

const now = () => new Date().toISOString();
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function open(file = process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'happyness.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  // ---------- seed starter stories on a fresh database ----------
  if (!q('SELECT 1 FROM users WHERE is_system = 1').get()) {
    tx(() => {
      const sysId = 'happyness';
      q('INSERT INTO users (id, token_hash, name, created_at, is_system) VALUES (?, NULL, ?, ?, 1)').run(sysId, 'Happyness', now());
      const t0 = Date.now();
      STARTER.forEach((s, i) => {
        const id = `starter-${i + 1}`;
        const at = new Date(t0 - (i + 1) * 47 * 60 * 1000).toISOString();
        q(`INSERT INTO posts (id, user_id, name, place, text, mood, status, starter, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'published', 1, ?)`).run(id, sysId, s.name, s.place || '', s.text, s.mood, at);
        const seed = { smile: 3 + (i * 7) % 20, heart: 2 + (i * 5) % 15, clap: (i * 3) % 9 };
        for (const k of REACTIONS) q('INSERT INTO reaction_seed (post_id, kind, n) VALUES (?, ?, ?)').run(id, k, seed[k]);
      });
    });
  }

  // ---------- users ----------
  function publicUser(u) {
    return u && { id: u.id, name: u.name, createdAt: u.created_at, banned: !!u.banned };
  }

  function createUser(name) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO users (id, token_hash, name, created_at) VALUES (?, ?, ?, ?)').run(id, hashToken(token), name, now());
    return { token, user: publicUser(q('SELECT * FROM users WHERE id = ?').get(id)) };
  }

  function userByToken(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    return q('SELECT * FROM users WHERE token_hash = ?').get(hashToken(token)) || null;
  }

  function getUser(id) {
    return q('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  function renameUser(id, name) {
    q('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    return publicUser(getUser(id));
  }

  /** Permanently delete an account and everything it created. */
  function deleteUser(id) {
    const u = getUser(id);
    if (!u || u.is_system) return false;
    q('DELETE FROM users WHERE id = ?').run(id); // cascades to posts, reactions, reports, blocks
    return true;
  }

  // ---------- posts ----------
  function counts(postId) {
    const out = { smile: 0, heart: 0, clap: 0 };
    for (const r of q('SELECT kind, n FROM reaction_seed WHERE post_id = ?').all(postId)) out[r.kind] += r.n;
    for (const r of q('SELECT kind, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY kind').all(postId)) out[r.kind] += r.n;
    return out;
  }

  function mine(postId, viewerId) {
    const out = {};
    if (!viewerId) return out;
    for (const r of q('SELECT kind FROM reactions WHERE post_id = ? AND user_id = ?').all(postId, viewerId)) out[r.kind] = true;
    return out;
  }

  function publicPost(p, viewerId) {
    return {
      id: p.id,
      type: 'community',
      authorId: p.user_id,
      name: p.name,
      place: p.place,
      text: p.text,
      mood: p.mood,
      starter: !!p.starter,
      status: p.status,
      own: !!viewerId && p.user_id === viewerId,
      createdAt: p.created_at,
      reactions: counts(p.id),
      mine: mine(p.id, viewerId),
    };
  }

  function createPost(userId, { name, place, text, mood, status = 'published', moderation = '' }) {
    const id = crypto.randomUUID();
    q(`INSERT INTO posts (id, user_id, name, place, text, mood, status, moderation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, name, place, text, MOODS.includes(mood) ? mood : 'kindness', status, moderation, now());
    return publicPost(q('SELECT * FROM posts WHERE id = ?').get(id), userId);
  }

  function getPost(id) {
    return q('SELECT * FROM posts WHERE id = ?').get(id) || null;
  }

  /** Published posts for the feed, minus anyone the viewer blocked. */
  function listPosts(viewerId, limit = 500) {
    const rows = viewerId
      ? q(`SELECT p.* FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.status = 'published' AND u.banned = 0
             AND p.user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
           ORDER BY p.created_at DESC LIMIT ?`).all(viewerId, limit)
      : q(`SELECT p.* FROM posts p JOIN users u ON u.id = p.user_id
           WHERE p.status = 'published' AND u.banned = 0
           ORDER BY p.created_at DESC LIMIT ?`).all(limit);
    return rows.map((p) => publicPost(p, viewerId));
  }

  /** Posts the viewer wrote, whatever their status (so they can see "in review"). */
  function listOwnPosts(userId) {
    return q("SELECT * FROM posts WHERE user_id = ? AND status != 'removed' ORDER BY created_at DESC").all(userId).map((p) => publicPost(p, userId));
  }

  function deleteOwnPost(userId, postId) {
    const p = getPost(postId);
    if (!p || p.user_id !== userId) return false;
    q('DELETE FROM posts WHERE id = ?').run(postId);
    return true;
  }

  function setReaction(userId, postId, kind, on) {
    const p = getPost(postId);
    if (!p || p.status !== 'published' || !REACTIONS.includes(kind)) return null;
    if (on) q('INSERT OR IGNORE INTO reactions (post_id, user_id, kind) VALUES (?, ?, ?)').run(postId, userId, kind);
    else q('DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND kind = ?').run(postId, userId, kind);
    return publicPost(p, userId);
  }

  // ---------- reports & blocks ----------
  /** Report a post. Enough distinct reports hide it until an admin reviews. */
  function report(userId, postId, reason) {
    const p = getPost(postId);
    if (!p) return null;
    q(`INSERT INTO reports (post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(post_id, user_id) DO UPDATE SET reason = excluded.reason`).run(postId, userId, reason, now());
    const { n } = q('SELECT COUNT(*) AS n FROM reports WHERE post_id = ? AND resolved = 0').get(postId);
    let hidden = false;
    if (p.status === 'published' && n >= REPORTS_TO_HIDE) {
      q("UPDATE posts SET status = 'hidden', moderation = ? WHERE id = ?").run(`hidden after ${n} reports`, postId);
      hidden = true;
    }
    return { reports: n, hidden };
  }

  function block(userId, blockedId) {
    if (userId === blockedId || !getUser(blockedId)) return false;
    q('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(userId, blockedId, now());
    return true;
  }

  function unblock(userId, blockedId) {
    q('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId);
    return true;
  }

  function listBlocks(userId) {
    return q(`SELECT u.id, u.name, b.created_at AS blockedAt FROM blocks b JOIN users u ON u.id = b.blocked_id
              WHERE b.user_id = ? ORDER BY b.created_at DESC`).all(userId).map((r) => ({ ...r }));
  }

  // ---------- admin ----------
  /** Posts that need a human: held by moderation, hidden by reports, or reported. */
  function moderationQueue() {
    const rows = q(`SELECT p.*, u.banned AS user_banned,
                      (SELECT COUNT(*) FROM reports r WHERE r.post_id = p.id AND r.resolved = 0) AS open_reports,
                      (SELECT GROUP_CONCAT(r.reason, ' | ') FROM reports r WHERE r.post_id = p.id AND r.resolved = 0) AS report_reasons
                    FROM posts p JOIN users u ON u.id = p.user_id
                    WHERE p.status IN ('pending', 'hidden')
                       OR (p.status = 'published' AND EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id AND r.resolved = 0))
                    ORDER BY p.created_at DESC LIMIT 200`).all();
    return rows.map((p) => ({
      ...publicPost(p),
      moderation: p.moderation,
      openReports: p.open_reports,
      reportReasons: p.report_reasons || '',
      userBanned: !!p.user_banned,
    }));
  }

  function setPostStatus(postId, status, note = '') {
    if (!['published', 'removed', 'pending', 'hidden'].includes(status)) return false;
    const r = q('UPDATE posts SET status = ?, moderation = ? WHERE id = ?').run(status, note, postId);
    if (status === 'published' || status === 'removed') q('UPDATE reports SET resolved = 1 WHERE post_id = ?').run(postId);
    return r.changes > 0;
  }

  function banUser(userId) {
    const u = getUser(userId);
    if (!u || u.is_system) return false;
    tx(() => {
      q('UPDATE users SET banned = 1 WHERE id = ?').run(userId);
      q("UPDATE posts SET status = 'removed', moderation = 'author banned' WHERE user_id = ?").run(userId);
      q('UPDATE reports SET resolved = 1 WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(userId);
    });
    return true;
  }

  function stats() {
    const one = (sql) => q(sql).get().n;
    return {
      users: one('SELECT COUNT(*) AS n FROM users WHERE is_system = 0'),
      posts: one("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'"),
      inReview: one("SELECT COUNT(*) AS n FROM posts WHERE status IN ('pending', 'hidden')"),
      openReports: one('SELECT COUNT(*) AS n FROM reports WHERE resolved = 0'),
    };
  }

  return {
    raw: db,
    close: () => db.close(),
    createUser, userByToken, getUser, renameUser, deleteUser, publicUser,
    createPost, getPost, listPosts, listOwnPosts, deleteOwnPost, setReaction,
    report, block, unblock, listBlocks,
    moderationQueue, setPostStatus, banUser, stats,
  };
}

module.exports = { open, REACTIONS, MOODS };
