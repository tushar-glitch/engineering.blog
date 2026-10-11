import assert from 'node:assert/strict';
import { parseFeed, discoverFeedUrl, htmlToText, robotsAllows } from './lib.mjs';

const rss = parseFeed(`<rss><channel><item><title><![CDATA[Scaling <Kafka>]]></title><link>https://a.com/1</link>
  <pubDate>Mon, 06 Jan 2025 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>body</p>]]></content:encoded></item></channel></rss>`);
assert.deepEqual(rss, [{ title: 'Scaling <Kafka>', url: 'https://a.com/1', published_at: '2025-01-06T10:00:00.000Z', content: '<p>body</p>' }]);

const atom = parseFeed(`<feed><entry><title type="html">Post</title><link rel="replies" href="https://a.com/c"/>
  <link rel="alternate" href="https://a.com/2"/><updated>2025-02-01T00:00:00Z</updated><summary>s</summary></entry></feed>`);
assert.equal(atom[0].url, 'https://a.com/2');
assert.equal(atom[0].title, 'Post');
assert.equal(atom.length, 1);
assert.throws(() => parseFeed('<html></html>'));

assert.equal(discoverFeedUrl('<link rel="alternate" type="application/rss+xml" href="/feed.xml">', 'https://b.com/blog/'), 'https://b.com/feed.xml');
assert.equal(discoverFeedUrl('<link rel="stylesheet" href="x.css">', 'https://b.com'), null);

assert.equal(
  htmlToText('<nav>menu</nav><article><h1>Title</h1><p>Tom &amp; Jerry&#39;s <b>cache</b></p><script>x()</script></article><footer>f</footer>'),
  "Title\nTom & Jerry's cache");

const robots = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin # private\n';
assert.equal(robotsAllows(robots, '/blog/post'), true);
assert.equal(robotsAllows(robots, '/admin/x'), false);
assert.equal(robotsAllows('', '/anything'), true);

// Feed titles/summaries are untrusted: the template helper must escape them.
const { html, toString, toQuery, EMPTY } = await import('./views.mjs');
assert.equal(toString(html`<h3>${'<img src=x onerror=alert(1)>'}</h3>`), '<h3>&lt;img src=x onerror=alert(1)&gt;</h3>');
assert.equal(toString(html`<a title="${'" onmouseover="x'}">`), '<a title="&quot; onmouseover=&quot;x">');
assert.equal(toString(html`<ul>${['a', html`<b>${'<i>'}</b>`]}</ul>`), '<ul>a<b>&lt;i&gt;</b></ul>');
assert.equal(toQuery({ ...EMPTY, q: 'kafka', tech: ['redis', 'go'], quality: 8 }), '/?q=kafka&tech=redis&tech=go&quality=8');
assert.equal(toQuery(EMPTY), '/');

console.log('all tests passed');
