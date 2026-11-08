/**
 * HappyApi — one interface, two backends:
 *
 *  - Remote: talks to a Happyness server (`/api/...`). Used on the web, and in
 *    the Android app when a community server URL is set in the Mood shield.
 *  - Local:  runs entirely on the phone (Android app). News is fetched through
 *    the native `HappyNative` bridge (no CORS limits), filtered on-device with
 *    the same joy filter as the server, and your own posts/reactions are kept
 *    on the device.
 */
(function () {
  'use strict';

  const PAGE_SIZE = 12;
  const MOODS = ['kindness', 'proud', 'animals', 'nature', 'family', 'funny'];
  const isApp = typeof window.HappyNative !== 'undefined';

  const ls = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`happyness:${key}`); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`happyness:${key}`, JSON.stringify(value)); } catch (e) { /* storage full / private */ }
    },
  };

  function clean(str, max) {
    return String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // ---------------------------------------------------------------- remote
  function remoteApi(base) {
    const root = String(base || '').replace(/\/+$/, '');
    async function call(path, opts) {
      const res = await fetch(`${root}${path}`, opts);
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
    const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return {
      mode: 'remote',
      feed({ tab, page, muted }) {
        const qs = new URLSearchParams({ tab, page: String(page) });
        if (muted && muted.length) qs.set('muted', muted.join(','));
        return call(`/api/feed?${qs}`);
      },
      share(payload) { return post('/api/posts', payload).then((d) => d.post); },
      react(id, reaction, delta) { return post(`/api/posts/${encodeURIComponent(id)}/react`, { reaction, delta }).then((d) => d.post); },
      report(id) { return post(`/api/posts/${encodeURIComponent(id)}/report`); },
      check(text) { return post('/api/check', { text }); },
    };
  }

  // ----------------------------------------------------------------- local
  function localApi() {
    const { assess, findBlocked } = window.JoyFilter;
    const { SOURCES, parseFeed, filterHappy, dedupeAndSort, buildTab } = window.FeedCore;
    const CACHE_MS = 30 * 60 * 1000;
    const FETCH_TIMEOUT_MS = 15000;

    // --- native fetch bridge
    const pending = new Map();
    let seq = 0;
    window.__happyNativeDone = (id, ok, body) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(body); else p.reject(new Error(body || 'fetch failed'));
    };
    function nativeFetch(url) {
      return new Promise((resolve, reject) => {
        const id = `f${++seq}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, FETCH_TIMEOUT_MS + 2000);
        pending.set(id, { resolve, reject, timer });
        window.HappyNative.fetchText(id, url);
      });
    }

    // --- external feed cache
    let cache = ls.get('feedCache', { at: 0, items: [] });
    let inflight = null;

    async function refresh() {
      const results = await Promise.allSettled(SOURCES.map((s) => nativeFetch(s.url).then((xml) => parseFeed(xml, s))));
      const all = [];
      results.forEach((r) => { if (r.status === 'fulfilled') all.push(...filterHappy(r.value).kept); });
      // Keep what we had if every source failed (e.g. offline).
      if (all.length || !cache.items.length) {
        cache = { at: Date.now(), items: dedupeAndSort(all).slice(0, 300) };
      } else {
        cache = { at: Date.now() - CACHE_MS + 5 * 60 * 1000, items: cache.items }; // retry in 5 min
      }
      ls.set('feedCache', cache);
      return cache;
    }

    async function getExternal() {
      if (Date.now() - cache.at > CACHE_MS && !inflight) {
        inflight = refresh().catch(() => cache).finally(() => { inflight = null; });
      }
      if (!cache.items.length && inflight) await inflight;
      return cache.items;
    }

    // --- community posts kept on this phone
    function loadCommunity() {
      let posts = ls.get('localCommunity', null);
      if (!Array.isArray(posts)) {
        const now = Date.now();
        posts = (window.StarterStories || []).map((s, i) => ({
          id: `starter-${i + 1}`,
          type: 'community',
          name: s.name,
          place: s.place || '',
          text: s.text,
          mood: s.mood,
          starter: true,
          createdAt: new Date(now - (i + 1) * 47 * 60 * 1000).toISOString(),
          reactions: { smile: 3 + (i * 7) % 20, heart: 2 + (i * 5) % 15, clap: (i * 3) % 9 },
        }));
        ls.set('localCommunity', posts);
      }
      return posts;
    }
    const saveCommunity = (posts) => ls.set('localCommunity', posts);
    const sortNewest = (posts) => posts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      mode: 'local',
      async feed({ tab, page, muted }) {
        const external = tab === 'community' ? [] : await getExternal();
        let items = buildTab(tab, external, sortNewest(loadCommunity()));
        if (muted && muted.length) {
          items = items.filter((it) => !findBlocked(`${it.title || ''} ${it.summary || ''} ${it.text || ''}`, muted));
        }
        const start = page * PAGE_SIZE;
        return { items: items.slice(start, start + PAGE_SIZE), page, hasMore: start + PAGE_SIZE < items.length, total: items.length };
      },
      async share(body) {
        const name = clean(body.name, 40) || 'A kind stranger';
        const place = clean(body.place, 40);
        const text = clean(body.text, 600);
        const mood = MOODS.includes(body.mood) ? body.mood : 'kindness';
        if (text.length < 15) throw new Error('Tell us a little more — at least a sentence or two.');
        if (/https?:\/\/|www\./i.test(text)) throw new Error('Links are not allowed in stories — just share the moment in your words.');
        const v = assess(`${name} ${place} ${text}`, { minScore: 2 });
        if (!v.ok) {
          throw new Error(v.blocked
            ? 'Happyness only shares light, happy moments, so we could not post this one. If you are going through a hard time, please reach out to someone you trust 💛'
            : 'This does not sound quite happy enough yet. Try describing what made you smile!');
        }
        const post = {
          id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'community', name, place, text, mood, starter: false,
          createdAt: new Date().toISOString(),
          reactions: { smile: 0, heart: 0, clap: 0 },
        };
        const posts = loadCommunity();
        posts.push(post);
        saveCommunity(posts);
        return post;
      },
      async react(id, reaction, delta) {
        const posts = loadCommunity();
        const post = posts.find((p) => p.id === id);
        if (!post || !['smile', 'heart', 'clap'].includes(reaction)) return null;
        post.reactions[reaction] = Math.max(0, (post.reactions[reaction] || 0) + (delta < 0 ? -1 : 1));
        saveCommunity(posts);
        return post;
      },
      async report(id) {
        saveCommunity(loadCommunity().filter((p) => p.id !== id));
        return { ok: true };
      },
      async check(text) {
        const v = assess(clean(text, 600));
        return { ok: v.ok, score: Number.isFinite(v.score) ? v.score : null, reason: v.reason };
      },
    };
  }

  // ------------------------------------------------------------- selection
  function create() {
    if (!isApp) return remoteApi('');
    const server = ls.get('serverUrl', '');
    return server ? remoteApi(server) : localApi();
  }

  window.HappyApi = { isApp, create };
})();
