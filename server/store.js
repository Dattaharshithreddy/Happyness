'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STARTER = require('../shared/starter-stories');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'posts.json');
const REACTIONS = ['smile', 'heart', 'clap'];
const HIDE_AFTER_REPORTS = 2;

let db = null;
let saveTimer = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(db.posts)) throw new Error('bad file');
  } catch {
    const now = Date.now();
    db = {
      posts: STARTER.map((s, i) => ({
        id: `starter-${i + 1}`,
        name: s.name,
        place: s.place || '',
        text: s.text,
        mood: s.mood,
        starter: true,
        createdAt: new Date(now - (i + 1) * 47 * 60 * 1000).toISOString(),
        reactions: { smile: 3 + (i * 7) % 20, heart: 2 + (i * 5) % 15, clap: (i * 3) % 9 },
        reports: 0,
      })),
    };
    save(true);
  }
  return db;
}

function save(immediate = false) {
  const write = () => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.warn('[store] could not save:', err.message);
    }
  };
  if (immediate) return write();
  if (!saveTimer) saveTimer = setTimeout(write, 500);
}

function publicPost(p) {
  return {
    id: p.id,
    type: 'community',
    name: p.name,
    place: p.place,
    text: p.text,
    mood: p.mood,
    starter: !!p.starter,
    createdAt: p.createdAt,
    reactions: p.reactions,
  };
}

function listPosts() {
  return load()
    .posts.filter((p) => p.reports < HIDE_AFTER_REPORTS)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicPost);
}

function addPost({ name, place, text, mood }) {
  const post = {
    id: crypto.randomUUID(),
    name,
    place,
    text,
    mood,
    starter: false,
    createdAt: new Date().toISOString(),
    reactions: { smile: 0, heart: 0, clap: 0 },
    reports: 0,
  };
  load().posts.push(post);
  save();
  return publicPost(post);
}

function react(id, reaction, delta) {
  if (!REACTIONS.includes(reaction)) return null;
  const post = load().posts.find((p) => p.id === id);
  if (!post) return null;
  post.reactions[reaction] = Math.max(0, (post.reactions[reaction] || 0) + (delta < 0 ? -1 : 1));
  save();
  return publicPost(post);
}

function report(id) {
  const post = load().posts.find((p) => p.id === id);
  if (!post) return false;
  post.reports += 1;
  save();
  return true;
}

module.exports = { listPosts, addPost, react, report, REACTIONS };
