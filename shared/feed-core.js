/**
 * Feed parsing + happy-filtering, shared by the Node server and the Android
 * app (which runs it on-device inside the WebView).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./joy-filter'));
  else root.FeedCore = factory(root.JoyFilter);
})(typeof self !== 'undefined' ? self : this, function (JoyFilter) {
  'use strict';

  const { assess } = JoyFilter;

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
    { id: 'r-upliftingnews', name: 'r/UpliftingNews', url: 'https://www.reddit.com/r/UpliftingNews/top/.rss?t=day', kind: 'news', personalOnly: true },
    { id: 'r-mademesmile', name: 'r/MadeMeSmile', url: 'https://www.reddit.com/r/MadeMeSmile/top/.rss?t=day', kind: 'stories', personalOnly: true },
    { id: 'r-humansbeingbros', name: 'r/HumansBeingBros', url: 'https://www.reddit.com/r/HumansBeingBros/top/.rss?t=day', kind: 'stories', personalOnly: true },
    { id: 'r-aww', name: 'r/aww', url: 'https://www.reddit.com/r/aww/top/.rss?t=day', kind: 'stories', personalOnly: true },
    { id: 'r-wholesome', name: 'r/wholesome', url: 'https://www.reddit.com/r/wholesome/top/.rss?t=day', kind: 'stories', personalOnly: true },
  ];

  /**
   * Sources allowed in a build. Store-safe builds (Play Store) leave out
   * Reddit, whose API terms don't allow this kind of reuse without approval.
   */
  function sourcesFor({ storeSafe = false } = {}) {
    return storeSafe ? SOURCES.filter((s) => !s.personalOnly) : SOURCES.slice();
  }

  /**
   * Store-safe items show only the headline, source and a link to the
   * original article; no copied summaries or images.
   */
  function makeStoreSafe(item) {
    return Object.assign({}, item, { summary: '', image: '' });
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

  function decodeEntities(s) {
    return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch (e) { return m; }
      }
      const v = ENTITIES[code.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function stripCdata(s) {
    return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }

  function stripHtml(s) {
    let text = stripCdata(s);
    // Some feeds (e.g. Reddit) send HTML that is itself entity-encoded
    // ("&lt;table&gt;..."). Decode it first so the tags can be removed.
    if (/&lt;\/?[a-z!]/i.test(text)) text = decodeEntities(text);
    return decodeEntities(
      text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    )
      .replace(/<[^>]*>/g, ' ') // tags that only appeared after the final decode
      .replace(/submitted\s+by\s+\/?u\/\S+/gi, ' ')
      .replace(/\[(link|comments)\]/gi, ' ')
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
    } catch (e) {
      return '';
    }
  }

  /** Small stable string hash (FNV-1a, 2 rounds) used for item ids. */
  function hashId(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822507);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
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
        id: hashId(link),
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

  /** Keep only happy items; annotate with the joy score. */
  function filterHappy(items) {
    const kept = [];
    let rejected = 0;
    for (const item of items) {
      // Headlines must be positive by themselves; the summary can add context
      // but anything blocked anywhere rejects the item.
      const full = assess(`${item.title} ${item.summary}`);
      const head = assess(item.title, { minScore: 1 });
      if (full.ok && (head.ok || full.score >= 4)) kept.push(Object.assign({}, item, { joy: full.score }));
      else rejected += 1;
    }
    return { kept, rejected };
  }

  /** De-duplicate by id and near-identical title, newest first. */
  function dedupeAndSort(items) {
    const seen = new Set();
    const unique = items.filter((it) => {
      const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (seen.has(it.id) || seen.has(key)) return false;
      seen.add(it.id);
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return unique;
  }

  /** Interleave two lists (2 from a, 1 from b) so the feed feels varied. */
  function interleave(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length) out.push(a[i++]);
      if (i < a.length) out.push(a[i++]);
      if (j < b.length) out.push(b[j++]);
    }
    return out;
  }

  /** Build the list for a tab from external items + community posts. */
  function buildTab(tab, external, community) {
    if (tab === 'news') return external.filter((i) => i.type === 'news');
    if (tab === 'stories') return interleave(external.filter((i) => i.type === 'stories'), community);
    if (tab === 'community') return community;
    return interleave(external, community);
  }

  return { SOURCES, sourcesFor, makeStoreSafe, parseFeed, filterHappy, dedupeAndSort, interleave, buildTab, hashId };
});
