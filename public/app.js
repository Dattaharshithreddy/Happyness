'use strict';

(() => {
  // ---------- state & settings ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`happyness:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`happyness:${key}`, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };

  const settings = {
    muted: store.get('muted', []),
    limit: store.get('limit', 48),
    hideImages: store.get('hideImages', false),
  };
  const reacted = store.get('reacted', {}); // { postId: { smile: true } }
  let api = window.HappyApi.create();

  let tab = store.get('tab', 'all');
  let page = 0;
  let loading = false;
  let hasMore = true;
  let shown = 0;
  let requestId = 0;

  const $ = (sel) => document.querySelector(sel);
  const feedEl = $('#feed');
  const endEl = $('#feedEnd');

  // ---------- little joys sprinkled between stories ----------
  const BREATHERS = [
    ['🌿', 'Take a slow, deep breath. You are doing better than you think.'],
    ['💛', 'Somewhere right now, a stranger is smiling because of someone like you.'],
    ['☀️', 'Drink some water and roll your shoulders back. Tiny kindnesses count — to yourself too.'],
    ['🌈', 'Think of one thing that went right today. Even a small one.'],
    ['🐝', 'You don\'t have to read everything. It\'s okay to close the app and go do something lovely.'],
    ['🌻', 'The world has more helpers than headlines show.'],
    ['✨', 'Send a nice message to someone you haven\'t talked to in a while.'],
  ];

  const AVATAR_COLORS = ['#ffd9a8', '#c9efd8', '#cfe3ff', '#e4d7ff', '#ffd0dc', '#fff0a8'];
  const MOODS = { kindness: '💛 Kindness', proud: '🏆 Proud', animals: '🐾 Animals', nature: '🌿 Nature', family: '🏡 Family', funny: '😄 Funny' };
  const REACTIONS = [['smile', '😊'], ['heart', '❤️'], ['clap', '👏']];

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c) node.append(c.nodeType ? c : document.createTextNode(c));
    return node;
  }

  function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [u, n] of units) {
      const v = Math.floor(s / n);
      if (v >= 1) return `${v} ${u}${v > 1 ? 's' : ''} ago`;
    }
    return 'just now';
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function greeting() {
    const h = new Date().getHours();
    const g = h < 5 ? ['Hello, night owl', '🌙'] : h < 12 ? ['Good morning', '☀️'] : h < 17 ? ['Good afternoon', '🌤️'] : h < 21 ? ['Good evening', '🌇'] : ['Good night', '🌙'];
    $('#greeting').textContent = `${g[0]} ${g[1]}`;
  }

  // ---------- rendering ----------
  function externalCard(item) {
    const img = item.image && /^https:\/\//.test(item.image)
      ? el('img', { class: 'card-img', src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
      : null;
    const label = item.type === 'news' ? '📰 Good news' : '🥰 Wholesome';
    return el('article', { class: 'card' },
      img,
      el('div', { class: 'card-body' },
        el('div', { class: 'meta' },
          el('span', { class: `pill ${item.type}`, text: label }),
          el('span', { text: item.source }),
          el('span', { text: '·' }),
          el('time', { datetime: item.publishedAt, text: timeAgo(item.publishedAt) }),
        ),
        el('h2', {}, el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: item.title })),
        item.summary ? el('p', { text: item.summary }) : null,
        el('a', { class: 'read-more', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read the full story', el('span', { 'aria-hidden': 'true', text: '→' })),
      ),
    );
  }

  function communityCard(post) {
    const color = AVATAR_COLORS[hash(post.name) % AVATAR_COLORS.length];
    const mine = reacted[post.id] || {};
    const buttons = REACTIONS.map(([key, emoji]) => {
      const btn = el('button', {
        class: 'react',
        type: 'button',
        'aria-pressed': mine[key] ? 'true' : 'false',
        'aria-label': `${key} reaction`,
      }, el('span', { 'aria-hidden': 'true', text: emoji }), el('span', { class: 'count', text: String(post.reactions[key] || 0) }));
      btn.addEventListener('click', () => toggleReaction(post, key, btn));
      return btn;
    });

    const reportBtn = el('button', { class: 'icon-btn more', type: 'button', title: 'Hide & report', 'aria-label': 'Hide and report this story', text: '⋯' });
    reportBtn.addEventListener('click', () => reportPost(post, reportBtn.closest('.card')));

    return el('article', { class: 'card post' },
      el('div', { class: 'post-head' },
        el('div', { class: 'avatar', style: `background:${color}`, 'aria-hidden': 'true', text: (post.name.trim()[0] || '★').toUpperCase() }),
        el('div', { class: 'who' },
          el('strong', { text: post.name }),
          el('small', { text: [post.place, timeAgo(post.createdAt)].filter(Boolean).join(' · ') }),
        ),
      ),
      el('p', { class: 'post-text', text: post.text }),
      el('div', { class: 'post-foot' },
        el('span', { class: 'pill community', text: MOODS[post.mood] || '💛 Kindness' }),
        ...buttons,
        post.starter ? el('span', { class: 'starter', text: 'starter story' }) : null,
        reportBtn,
      ),
    );
  }

  function breatherCard(n) {
    const [emoji, text] = BREATHERS[n % BREATHERS.length];
    return el('aside', { class: 'card breather' },
      el('div', { class: 'big', 'aria-hidden': 'true', text: emoji }),
      el('p', { text }),
      el('small', { text: 'a little moment for you' }),
    );
  }

  function skeletons(n = 3) {
    return Array.from({ length: n }, () => el('div', { class: 'card skeleton', 'aria-hidden': 'true' }));
  }

  function renderEnd() {
    endEl.replaceChildren();
    if (settings.limit && shown >= settings.limit) {
      endEl.append(el('div', { class: 'caught-up' },
        el('div', { style: 'font-size:38px', 'aria-hidden': 'true', text: '🌿' }),
        el('h3', { text: 'That\'s a lovely amount of joy for now' }),
        el('p', { text: 'You\'ve read plenty of good news. Maybe take a walk, stretch, or text someone you love?' }),
        el('button', { class: 'btn', style: 'margin-top:14px', type: 'button', text: 'Just a few more', onclick: () => { settings.limit += 12; renderEnd(); } }),
      ));
      return;
    }
    if (hasMore) {
      endEl.append(el('button', { class: 'btn', type: 'button', id: 'loadMore', text: 'Show more happy stories', onclick: loadMore }));
    } else if (shown > 0) {
      endEl.append(el('div', { class: 'caught-up' },
        el('div', { style: 'font-size:38px', 'aria-hidden': 'true', text: '🎉' }),
        el('h3', { text: 'You\'re all caught up!' }),
        el('p', { text: 'New happy stories arrive throughout the day. Why not share one of your own?' }),
      ));
    }
  }

  // ---------- data ----------
  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    const myRequest = ++requestId;
    const skel = skeletons(page === 0 ? 3 : 1);
    feedEl.append(...skel);
    endEl.replaceChildren();
    try {
      const data = await api.feed({ tab, page, muted: settings.muted });
      if (myRequest !== requestId) return; // tab switched meanwhile
      skel.forEach((s) => s.remove());
      const hidden = new Set(store.get('hidden', []));
      for (const item of data.items) {
        if (hidden.has(item.id)) continue;
        if (settings.limit && shown >= settings.limit) break;
        feedEl.append(item.type === 'community' ? communityCard(item) : externalCard(item));
        shown += 1;
        if (shown % 7 === 0) feedEl.append(breatherCard(shown / 7 - 1 + hash(tab)));
      }
      hasMore = data.hasMore;
      page += 1;
      if (shown === 0) {
        feedEl.append(el('div', { class: 'caught-up', style: 'text-align:center' },
          el('div', { style: 'font-size:38px', 'aria-hidden': 'true', text: '🌱' }),
          el('h3', { text: 'Nothing here just yet' }),
          el('p', { text: 'Fresh happy stories are on their way. Check another tab, or share something that made you smile!' }),
        ));
      }
    } catch (err) {
      if (myRequest !== requestId) return;
      skel.forEach((s) => s.remove());
      endEl.append(el('div', { class: 'caught-up' },
        el('h3', { text: 'Couldn\'t reach the joy server 🌧️' }),
        el('p', { text: 'Check your connection and try again.' }),
        el('button', { class: 'btn', style: 'margin-top:12px', type: 'button', text: 'Try again', onclick: () => { loading = false; loadMore(); } }),
      ));
      loading = false;
      return;
    }
    loading = false;
    renderEnd();
  }

  function resetFeed() {
    requestId += 1;
    page = 0;
    shown = 0;
    hasMore = true;
    loading = false;
    feedEl.replaceChildren();
    endEl.replaceChildren();
    loadMore();
  }

  async function toggleReaction(post, key, btn) {
    const mine = reacted[post.id] || (reacted[post.id] = {});
    const on = !mine[key];
    const countEl = btn.querySelector('.count');
    const prev = Number(countEl.textContent) || 0;
    mine[key] = on;
    btn.setAttribute('aria-pressed', String(on));
    countEl.textContent = String(Math.max(0, prev + (on ? 1 : -1)));
    store.set('reacted', reacted);
    try {
      const updated = await api.react(post.id, key, on ? 1 : -1);
      if (updated) countEl.textContent = String(updated.reactions[key]);
    } catch { /* keep optimistic value */ }
  }

  async function reportPost(post, card) {
    if (!confirm('Hide this story and let us know it doesn\'t feel happy?')) return;
    card.style.transition = 'opacity .3s, transform .3s';
    card.style.opacity = '0';
    card.style.transform = 'scale(.97)';
    setTimeout(() => card.remove(), 300);
    const hidden = store.get('hidden', []);
    hidden.push(post.id);
    store.set('hidden', hidden.slice(-500));
    try { await api.report(post.id); } catch { /* ignore */ }
    toast('Thanks — we\'ve hidden it for you 💛');
  }

  // ---------- tabs ----------
  function setTab(next) {
    tab = next;
    store.set('tab', tab);
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    resetFeed();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => b.dataset.tab !== tab && setTab(b.dataset.tab)));

  // ---------- dialogs ----------
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // Share
  const shareDialog = $('#shareDialog');
  const shareForm = $('#shareForm');
  const shareText = $('#shareText');
  const shareMsg = $('#shareMsg');
  const joyFill = $('#joyFill');
  const joyLabel = $('#joyLabel');

  $('#openShare').addEventListener('click', () => {
    shareMsg.textContent = '';
    shareMsg.className = 'form-msg';
    shareDialog.showModal();
    setTimeout(() => shareText.focus(), 50);
  });

  let checkTimer;
  shareText.addEventListener('input', () => {
    clearTimeout(checkTimer);
    const text = shareText.value.trim();
    if (text.length < 8) { joyFill.style.width = '0'; joyLabel.textContent = 'Start typing ✍️'; return; }
    checkTimer = setTimeout(async () => {
      try {
        const v = await api.check(text);
        const pct = v.score === null ? 4 : Math.max(6, Math.min(100, (v.score / 10) * 100));
        joyFill.style.width = `${pct}%`;
        joyLabel.textContent = v.score === null ? 'Let\'s keep it light 🌤️' : v.ok ? (v.score >= 8 ? 'Pure sunshine! 🌞' : 'Lovely! 😊') : 'Add a bit more joy ✨';
      } catch { /* offline */ }
    }, 350);
  });

  shareForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#shareSubmit');
    const fd = new FormData(shareForm);
    const payload = Object.fromEntries(fd.entries());
    btn.disabled = true;
    shareMsg.className = 'form-msg';
    shareMsg.textContent = 'Checking for good vibes…';
    try {
      const newPost = await api.share(payload);
      shareForm.reset();
      joyFill.style.width = '0';
      joyLabel.textContent = 'Start typing ✍️';
      shareDialog.close();
      toast('Shared! Thank you for spreading joy 🌻');
      if (tab === 'all' || tab === 'community' || tab === 'stories') {
        const card = communityCard(newPost);
        feedEl.prepend(card);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      shareMsg.className = 'form-msg err';
      shareMsg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // Settings
  const settingsDialog = $('#settingsDialog');
  const chipsEl = $('#mutedChips');
  const mutedInput = $('#mutedInput');
  const limitSel = $('#dailyLimit');
  const hideImages = $('#hideImages');
  let settingsSnapshot = '';
  const serverInput = $('#serverUrl');
  if (window.HappyApi.isApp) $('#serverField').hidden = false;

  function renderChips() {
    chipsEl.replaceChildren(...settings.muted.map((word) => el('span', { class: 'chip' },
      word,
      el('button', { type: 'button', 'aria-label': `Remove ${word}`, text: '✕', onclick: () => { settings.muted = settings.muted.filter((w) => w !== word); renderChips(); } }),
    )));
  }

  function addMuted() {
    const word = mutedInput.value.trim().toLowerCase().replace(/,/g, '');
    if (word && !settings.muted.includes(word) && settings.muted.length < 50) settings.muted.push(word);
    mutedInput.value = '';
    renderChips();
  }
  mutedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addMuted(); }
    else if (e.key === 'Backspace' && !mutedInput.value && settings.muted.length) { settings.muted.pop(); renderChips(); }
  });
  mutedInput.addEventListener('blur', addMuted);

  $('#openSettings').addEventListener('click', () => {
    renderChips();
    limitSel.value = String(store.get('limit', 48));
    hideImages.checked = settings.hideImages;
    if (serverInput) serverInput.value = store.get('serverUrl', '');
    settingsSnapshot = JSON.stringify([settings.muted, limitSel.value, serverInput ? serverInput.value.trim() : '']);
    settingsDialog.showModal();
  });

  settingsDialog.addEventListener('close', () => {
    addMuted();
    settings.limit = Number(limitSel.value);
    settings.hideImages = hideImages.checked;
    store.set('muted', settings.muted);
    store.set('limit', settings.limit);
    store.set('hideImages', settings.hideImages);
    document.body.classList.toggle('no-images', settings.hideImages);
    if (serverInput) {
      let server = serverInput.value.trim().replace(/\/+$/, '');
      if (server && !/^https?:\/\//i.test(server)) server = `https://${server}`;
      if (server !== store.get('serverUrl', '')) {
        store.set('serverUrl', server);
        api = window.HappyApi.create();
      }
      serverInput.value = server;
    }
    if (JSON.stringify([settings.muted, limitSel.value, serverInput ? serverInput.value.trim() : '']) !== settingsSnapshot) {
      toast('Mood shield updated 🛡️');
      resetFeed();
    }
  });

  // ---------- boot ----------
  greeting();
  document.body.classList.toggle('no-images', settings.hideImages);
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  loadMore();

  // Android back button: close an open sheet first (called from the app).
  window.happyBack = () => {
    const open = document.querySelector('dialog[open]');
    if (open) { open.close(); return true; }
    return false;
  };

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
