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

// Real Reddit Atom feeds HTML-escape the post body (&lt;table&gt;...).
const REDDIT_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><entry>
<title>Solar met 75% of the world's electricity demand growth in 2025, outpacing forecasts.</title>
<link href="https://www.reddit.com/r/UpliftingNews/comments/abc/solar/"/><updated>2026-11-08T09:00:00+00:00</updated>
<media:thumbnail url="https://b.thumbs.redditmedia.com/solar.jpg" />
<content type="html">&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;a href=&quot;https://www.reddit.com/r/UpliftingNews/comments/abc/solar/&quot;&gt; &lt;img src=&quot;https://b.thumbs.redditmedia.com/solar.jpg&quot; alt=&quot;Solar&quot; /&gt; &lt;/a&gt; &lt;/td&gt;&lt;td&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/someone&quot;&gt; /u/someone &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://example.org/solar&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/UpliftingNews/comments/abc/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt; &lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
</entry></feed>`;

test('escaped HTML in Reddit posts never leaks into the summary', () => {
  const [item] = parseFeed(REDDIT_ATOM, { id: 'r', name: 'r/UpliftingNews', kind: 'news' });
  assert.doesNotMatch(item.summary, /[<>]|&lt;|href|submitted by/i);
  assert.strictEqual(item.image, 'https://b.thumbs.redditmedia.com/solar.jpg');
});
