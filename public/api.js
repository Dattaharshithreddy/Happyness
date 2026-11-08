/**
 * HappyApi — one interface, two backends:
 *
 *  - Remote: talks to a Happyness server (`/api/...`). Used on the website,
 *    and in the Android app when a community server is configured (built in
 *    via config.js, or typed in the Mood shield). Your posts are shared with
 *    everyone using that server.
 *  - Local:  runs entirely on the phone (Android app with no server). News is
 *    fetched through the native `HappyNative` bridge, filtered on-device, and
 *    your posts/reactions stay on the phone.
 *
 * Accounts are anonymous: the first time you post or react, the app creates an
 * account and keeps its secret token on this device.
 */
(function () {
  'use strict';

  const PAGE_SIZE = 12;
  const MOODS = ['kindness', 'proud', 'animals', 'nature', 'family', 'funny'];
  const isApp = typeof window.HappyNative !== 'undefined';
  const config = Object.assign({ server: '', storeSafe: false, contactEmail: '' }, window.HAPPYNESS_CONFIG || {});

  const ls = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`happyness:${key}`); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`happyness:${key}`, JSON.stringify(value)); } catch (e) { /* storage full / private */ }
    },
    del(key) {
      try { localStorage.removeItem(`happyness:${key}`); } catch (e) { /* ignore */ }
    },
  };

  function clean(str, max) {
    return String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // ---------------------------------------------------------------- remote
  function remoteApi(base) {
    const root = String(base || '').replace(/\/+$/, '');
    const acctKey = `account:${root || 'same-origin'}`;
    let account = ls.get(acctKey, null); // { token, user }

    async function call(path, { method = 'GET', body, authed = true } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authed && account) headers.Authorization = `Bearer ${account.token}`;
      const res = await fetch(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    async function ensureAccount(name) {
      if (account) return account;
      const data = await call('/api/account', { method: 'POST', body: { name: clean(name, 40) }, authed: false });
      account = { token: data.token, user: data.user };
      ls.set(acctKey, account);
      return account;
    }

    /** Run an authed request; if the server forgot us (401), start a fresh account once. */
    async function withAccount(fn, name) {
      await ensureAccount(name);
      try {
        return await fn();
      } catch (err) {
        if (err.status !== 401) throw err;
        account = null;
        ls.del(acctKey);
        await ensureAccount(name);
        return fn();
      }
    }

    return {
      mode: 'remote',
      config,
      hasAccount: () => !!account,
      accountName: () => (account ? account.user.name : ''),
      feed({ tab, page, muted }) {
        const qs = new URLSearchParams({ tab, page: String(page) });
        if (muted && muted.length) qs.set('muted', muted.join(','));
        return call(`/api/feed?${qs}`);
      },
      async share(payload) {
        const name = clean(payload.name, 40);
        return withAccount(async () => {
          if (name && name !== account.user.name) {
            const d = await call('/api/account', { method: 'PATCH', body: { name } });
            account.user = d.user;
            ls.set(acctKey, account);
          }
          const d = await call('/api/posts', { method: 'POST', body: { text: payload.text, place: payload.place, mood: payload.mood, agree: payload.agree === true } });
          return Object.assign(d.post, { notice: d.notice });
        }, name);
      },
      react(id, reaction, on) {
        return withAccount(() => call(`/api/posts/${encodeURIComponent(id)}/react`, { method: 'POST', body: { reaction, on } })).then((d) => d.post);
      },
      report(id, reason) {
        return withAccount(() => call(`/api/posts/${encodeURIComponent(id)}/report`, { method: 'POST', body: { reason } }));
      },
      block(userId) {
        return withAccount(() => call(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' }));
      },
      unblock(userId) {
        return withAccount(() => call(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'DELETE' }));
      },
      deletePost(id) {
        return withAccount(() => call(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      },
      async getAccount() {
        if (!account) return null;
        try { return await call('/api/account'); } catch (err) {
          if (err.status === 401) { account = null; ls.del(acctKey); return null; }
          throw err;
        }
      },
      async rename(name) {
        return withAccount(async () => {
          const d = await call('/api/account', { method: 'PATCH', body: { name } });
          account.user = d.user;
          ls.set(acctKey, account);
          return d.user;
        }, name);
      },
      async deleteAccount() {
        if (account) {
          try { await call('/api/account', { method: 'DELETE' }); } catch (err) { if (err.status !== 401) throw err; }
        }
        account = null;
        ls.del(acctKey);
        return true;
      },
      check(text) { return call('/api/check', { method: 'POST', body: { text }, authed: false }); },
    };
  }

  // ----------------------------------------------------------------- local
  function localApi() {
    const { assess, findBlocked } = window.JoyFilter;
    const { parseFeed, filterHappy, dedupeAndSort, buildTab, sourcesFor, makeStoreSafe } = window.FeedCore;
    const SOURCES = sourcesFor({ storeSafe: config.storeSafe });
    const CACHE_MS = 30 * 60 * 1000;
    const FETCH_TIMEOUT_MS = 15000;
    const cacheKey = `feedCache:v3:${config.storeSafe ? 'safe' : 'full'}`;

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
    let cache = ls.get(cacheKey, { at: 0, items: [] });
    let inflight = null;

    async function refresh() {
      const results = await Promise.allSettled(SOURCES.map((s) => nativeFetch(s.url).then((xml) => parseFeed(xml, s))));
      const all = [];
      results.forEach((r) => { if (r.status === 'fulfilled') all.push(...filterHappy(r.value).kept); });
      let items = dedupeAndSort(all).slice(0, 300);
      if (config.storeSafe) items = items.map(makeStoreSafe);
      if (items.length || !cache.items.length) {
        cache = { at: Date.now(), items };
      } else {
        cache = { at: Date.now() - CACHE_MS + 5 * 60 * 1000, items: cache.items }; // offline: retry in 5 min
      }
      ls.set(cacheKey, cache);
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
    const ME = 'me';
    function loadCommunity() {
      let posts = ls.get('localCommunity', null);
      if (!Array.isArray(posts)) {
        const now = Date.now();
        posts = (window.StarterStories || []).map((s, i) => ({
          id: `starter-${i + 1}`,
          type: 'community',
          authorId: `starter-author-${i + 1}`,
          name: s.name,
          place: s.place || '',
          text: s.text,
          mood: s.mood,
          starter: true,
          createdAt: new Date(now - (i + 1) * 47 * 60 * 1000).toISOString(),
          reactions: { smile: 3 + (i * 7) % 20, heart: 2 + (i * 5) % 15, clap: (i * 3) % 9 },
          mine: {},
        }));
        ls.set('localCommunity', posts);
      }
      return posts;
    }
    const saveCommunity = (posts) => ls.set('localCommunity', posts);
    const blocked = () => ls.get('localBlocked', []);
    const visible = () => {
      const b = new Set(blocked().map((x) => x.id));
      return loadCommunity()
        .filter((p) => !b.has(p.authorId))
        .map((p) => Object.assign({}, p, { own: p.authorId === ME, mine: p.mine || {} }))
        .sort((a, b2) => b2.createdAt.localeCompare(a.createdAt));
    };

    return {
      mode: 'local',
      config,
      hasAccount: () => true,
      accountName: () => ls.get('localName', ''),
      async feed({ tab, page, muted }) {
        const external = tab === 'community' ? [] : await getExternal();
        let items = buildTab(tab, external, visible());
        if (muted && muted.length) {
          items = items.filter((it) => !findBlocked(`${it.title || ''} ${it.summary || ''} ${it.text || ''}`, muted));
        }
        const start = page * PAGE_SIZE;
        return { items: items.slice(start, start + PAGE_SIZE), page, hasMore: start + PAGE_SIZE < items.length, total: items.length };
      },
      async share(body) {
        const name = clean(body.name, 40) || ls.get('localName', '') || 'A kind stranger';
        const place = clean(body.place, 40);
        const text = clean(body.text, 600);
        const mood = MOODS.includes(body.mood) ? body.mood : 'kindness';
        if (body.agree !== true) throw new Error('Please agree to the community guidelines first.');
        if (text.length < 15) throw new Error('Tell us a little more — at least a sentence or two.');
        if (/https?:\/\/|www\./i.test(text)) throw new Error('Links are not allowed in stories — just share the moment in your words.');
        const v = assess(`${name} ${place} ${text}`, { minScore: 2 });
        if (!v.ok) {
          throw new Error(v.blocked
            ? 'Happyness only shares light, happy moments, so we could not post this one. If you are going through a hard time, please reach out to someone you trust 💛'
            : 'This does not sound quite happy enough yet. Try describing what made you smile!');
        }
        ls.set('localName', name);
        const post = {
          id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'community', authorId: ME, name, place, text, mood, starter: false,
          createdAt: new Date().toISOString(),
          reactions: { smile: 0, heart: 0, clap: 0 },
          mine: {},
        };
        const posts = loadCommunity();
        posts.push(post);
        saveCommunity(posts);
        return Object.assign({}, post, { own: true });
      },
      async react(id, reaction, on) {
        const posts = loadCommunity();
        const post = posts.find((p) => p.id === id);
        if (!post || !['smile', 'heart', 'clap'].includes(reaction)) return null;
        post.mine = post.mine || {};
        if (!!post.mine[reaction] !== !!on) {
          post.reactions[reaction] = Math.max(0, (post.reactions[reaction] || 0) + (on ? 1 : -1));
          post.mine[reaction] = !!on;
        }
        saveCommunity(posts);
        return post;
      },
      async report(id) {
        saveCommunity(loadCommunity().filter((p) => p.id !== id));
        return { ok: true, hidden: true };
      },
      async block(userId) {
        const post = loadCommunity().find((p) => p.authorId === userId);
        const list = blocked().filter((b) => b.id !== userId);
        list.push({ id: userId, name: post ? post.name : 'Someone', blockedAt: new Date().toISOString() });
        ls.set('localBlocked', list);
        return { ok: true };
      },
      async unblock(userId) {
        ls.set('localBlocked', blocked().filter((b) => b.id !== userId));
        return { ok: true };
      },
      async deletePost(id) {
        saveCommunity(loadCommunity().filter((p) => !(p.id === id && p.authorId === ME)));
        return { ok: true };
      },
      async getAccount() {
        return {
          user: { id: ME, name: ls.get('localName', '') || 'You' },
          posts: visible().filter((p) => p.own).map((p) => Object.assign({ status: 'published' }, p)),
          blocked: blocked(),
          local: true,
        };
      },
      async rename(name) {
        ls.set('localName', clean(name, 40));
        return { id: ME, name: clean(name, 40) };
      },
      async deleteAccount() {
        saveCommunity(loadCommunity().filter((p) => p.authorId !== ME));
        ['localName', 'localBlocked', 'agreed'].forEach(ls.del);
        return true;
      },
      async check(text) {
        const v = assess(clean(text, 600));
        return { ok: v.ok, score: Number.isFinite(v.score) ? v.score : null, reason: v.reason };
      },
    };
  }

  // ------------------------------------------------------------- selection
  function serverUrl() {
    return ls.get('serverUrl', '') || config.server || '';
  }

  function create() {
    if (!isApp) return remoteApi(config.server || '');
    const server = serverUrl();
    return server ? remoteApi(server) : localApi();
  }

  window.HappyApi = { isApp, config, create, serverUrl };
})();
