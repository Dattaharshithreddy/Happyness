'use strict';

const { SOURCES, parseFeed, filterHappy, dedupeAndSort } = require('../shared/feed-core');

const CACHE_MS = 30 * 60 * 1000; // refresh every 30 minutes
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'Happyness/1.0 (uplifting news reader)';

let cache = { at: 0, items: [], stats: {} };
let inflight = null;

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
    return parseFeed(await res.text(), source);
  } finally {
    clearTimeout(timer);
  }
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
  cache = { at: Date.now(), items: dedupeAndSort(all), stats };
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
