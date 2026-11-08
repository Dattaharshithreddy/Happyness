'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseFeed, filterHappy } = require('../server/feeds');

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Shelter puppies adopted by loving families in record time]]></title>
<link>https://example.org/puppies</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Volunteers celebrate as every dog finds a happy home.</p><img src="https://example.org/p.jpg">]]></description></item>
<item><title>Storm causes devastating floods</title><link>https://example.org/storm</link>
<description>Many homes destroyed.</description></item>
<item><title>Ministers clash over budget</title><link>https://example.org/budget</link><description>Debate.</description></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>Neighbors surprise beloved mail carrier with a wonderful thank you party</title>
<link href="https://www.reddit.com/r/MadeMeSmile/comments/abc/"/><updated>2026-11-01T09:00:00Z</updated>
<content type="html">&lt;p&gt;So wholesome, everyone smiling!&lt;/p&gt;</content></entry></feed>`;

test('parses RSS and keeps only happy items', () => {
  const items = parseFeed(RSS, { id: 't', name: 'Test', kind: 'news' });
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].image, 'https://example.org/p.jpg');
  const { kept, rejected } = filterHappy(items);
  assert.deepStrictEqual(kept.map((i) => i.url), ['https://example.org/puppies']);
  assert.strictEqual(rejected, 2);
});

test('parses Atom (Reddit) feeds', () => {
  const items = parseFeed(ATOM, { id: 'r', name: 'r/MadeMeSmile', kind: 'stories' });
  assert.strictEqual(items.length, 1);
  assert.match(items[0].summary, /wholesome/);
  assert.strictEqual(filterHappy(items).kept.length, 1);
});
