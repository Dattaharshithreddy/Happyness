'use strict';

const crypto = require('crypto');
const { assess } = require('./filter');

/**
 * Sources of good news. These are all outlets/communities dedicated to
 * positive stories — and every item is still run through the joy filter.
 */
const SOURCES = [
  { id: 'gnn', name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/', kind: 'news' },
  { id: 'positive', name: 'Positive News', url: 'https://www.positive.news/feed/', kind: 'news' },
  { id: 'optimist', name: 'The Optimist Daily', url: 'https://www.optimistdaily.com/feed/', kind: 'news' },
  { id: 'reasons', name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/', kind: 'news' },
  { id: 'sunny', name: 'Sunny Skyz', url: 'https://www.sunnyskyz.com/rss_tebow.php', kind: 'news' },
  { id: 'r-upliftingnews', name: 'r/UpliftingNews', url: 'https://www.reddit.com/r/UpliftingNews/top/.rss?t=day', kind: 'stories' },
  { id: 'r-mademesmile', name: 'r/MadeMeSmile', url: 'https://www.reddit.com/r/MadeMeSmile/top/.rss?t=day', kind: 'stories' },
  { id: 'r-humansbeingbros', name: 'r/HumansBeingBros', url: 'https://www.reddit.com/r/HumansBeingBros/top/.rss?t=day', kind: 'stories' },
  { id: 'r-aww', name: 'r/aww', url: 'https://www.reddit.com/r/aww/top/.rss?t=day', kind: 'stories' },
  { id: 'r-wholesome', name: 'r/wholesome', url: 'https://www.reddit.com/r/wholesome/top/.rss?t=day', kind: 'stories' },
];

const CACHE_MS = 30 * 60 * 1000; // refresh every 30 minutes
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Happyness/1.0 (uplifting news reader)';

let cache = { at: 0, items: [], stats: {} };
let inflight = null;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function stripCdata(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripHtml(s) {
  return decodeEntities(
    stripCdata(s)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\[link\]|\[comments\]|submitted by\s+\/u\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? stripCdata(m[1]).trim() : '';
}

function attr(xml, tagName, attrName) {
  const m = xml.match(new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']+)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function findImage(block, rawContent) {
  const candidates = [
    attr(block, 'media:content', 'url'),
    attr(block, 'media:thumbnail', 'url'),
    /type=["']image/i.test(block) ? attr(block, 'enclosure', 'url') : '',
  ];
  const decoded = decodeEntities(stripCdata(rawContent));
  const img = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) candidates.push(decodeEntities(img[1]));
  return candidates.find((u) => /^https:\/\//i.test(u)) || '';
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/** Parse RSS 2.0 or Atom XML into plain items. */
function parseFeed(xml, source) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = stripHtml(tag(block, 'title'));
    const rawContent = tag(block, 'content:encoded') || tag(block, 'content') || tag(block, 'description') || tag(block, 'summary');
    let summary = stripHtml(rawContent);
    if (summary.length > 280) summary = `${summary.slice(0, 277).replace(/\s+\S*$/, '')}…`;
    const link = isAtom
      ? attr(block, 'link', 'href') || tag(block, 'id')
      : stripHtml(tag(block, 'link')) || tag(block, 'guid');
    const dateStr = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const date = new Date(dateStr);
    if (!title || !safeUrl(link)) continue;
    // Reddit marks adult posts — drop them even before filtering.
    if (/nsfw|over_18|spoiler/i.test(block)) continue;
    items.push({
      id: crypto.createHash('sha1').update(link).digest('hex').slice(0, 16),
      type: source.kind,
      title,
      summary: summary === title ? '' : summary,
      url: safeUrl(link),
      image: findImage(block, rawContent),
      source: source.name,
      sourceId: source.id,
      publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    });
  }
  return items;
}

async function fetchSource(source) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml, source);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep only happy items; annotate with the joy score. */
function filterHappy(items) {
  const kept = [];
  let rejected = 0;
  for (const item of items) {
    // Headlines must be positive by themselves; the summary can add context
    // but anything blocked anywhere rejects the item.
    const full = assess(`${item.title} ${item.summary}`);
    const head = assess(item.title, { minScore: 1 });
    if (full.ok && (head.ok || full.score >= 4)) kept.push({ ...item, joy: full.score });
    else rejected += 1;
  }
  return { kept, rejected };
}

async function refresh() {
  const results = await Promise.allSettled(SOURCES.map(fetchSource));
  const all = [];
  const stats = {};
  results.forEach((r, i) => {
    const src = SOURCES[i];
    if (r.status === 'fulfilled') {
      const { kept, rejected } = filterHappy(r.value);
      stats[src.id] = { ok: true, kept: kept.length, filteredOut: rejected };
      all.push(...kept);
    } else {
      stats[src.id] = { ok: false, error: String(r.reason && r.reason.message ? r.reason.message : r.reason) };
    }
  });
  // De-duplicate by id and by near-identical title.
  const seen = new Set();
  const unique = all.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(it.id) || seen.has(key)) return false;
    seen.add(it.id);
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  cache = { at: Date.now(), items: unique, stats };
  return cache;
}

/** Get filtered items, refreshing the cache when stale. Never throws. */
async function getItems({ force = false } = {}) {
  const stale = Date.now() - cache.at > CACHE_MS;
  if ((stale || force) && !inflight) {
    inflight = refresh()
      .catch((err) => {
        console.warn('[feeds] refresh failed:', err.message);
        cache.at = Date.now(); // back off; try again after CACHE_MS
        return cache;
      })
      .finally(() => { inflight = null; });
  }
  // First load: wait for data. Later loads: serve stale data instantly.
  if (cache.items.length === 0 && inflight) await inflight;
  return cache;
}

module.exports = { getItems, parseFeed, filterHappy, SOURCES };
