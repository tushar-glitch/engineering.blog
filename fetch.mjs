// Pull every feed in feeds.json and insert new posts. Safe to re-run: existing URLs are ignored.
import { readFileSync } from 'node:fs';
import { openDb, parseFeed, discoverFeedUrl, get } from './lib.mjs';

const feeds = JSON.parse(readFileSync('feeds.json', 'utf8'));
const db = await openDb();
const insert = (...row) => db.query(
  `INSERT INTO posts (url, title, source, published_at, feed_content) VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (url) DO NOTHING`, row);

async function pull({ name, url }) {
  let res = await get(url);
  if (!/xml|rss|atom/i.test(res.type) && /<html/i.test(res.body.slice(0, 2000))) {
    const feedUrl = discoverFeedUrl(res.body, res.url) ?? await probe(res.url);
    if (!feedUrl) throw new Error('no feed found on page');
    res = await get(feedUrl);
  }
  let added = 0;
  for (const p of parseFeed(res.body)) {
    if (!p.url || !p.title) continue;
    const link = new URL(p.url, res.url).href;
    added += (await insert(link, p.title, name, p.published_at, p.content || null)).rowCount;
  }
  return added;
}

// No <link rel=alternate>? Try the usual feed paths under the page and the site root.
async function probe(pageUrl) {
  const base = pageUrl.endsWith('/') ? pageUrl : pageUrl + '/';
  const { origin } = new URL(pageUrl);
  for (const root of new Set([base, origin + '/', origin + '/blog/'])) {
    for (const path of ['feed', 'feed.xml', 'rss.xml', 'atom.xml', 'index.xml', 'rss', 'feed/']) {
      try {
        const { body } = await get(root + path);
        if (/<(rss|feed|rdf:RDF)\b/.test(body.slice(0, 1000))) return root + path;
      } catch {}
    }
  }
  return null;
}

const failed = [];
let total = 0;
const queue = [...feeds];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let f; (f = queue.shift()); ) {
    try {
      const n = await pull(f);
      total += n;
      console.log(`ok   ${f.name.padEnd(28)} +${n}`);
    } catch (e) {
      failed.push(f.name);
      console.log(`FAIL ${f.name.padEnd(28)} ${e.message}`);
    }
  }
}));

const { rows: [{ c }] } = await db.query('SELECT count(*)::int c FROM posts');
console.log(`\n${feeds.length - failed.length}/${feeds.length} feeds ok, ${total} new posts, ${c} total.`);
if (failed.length) console.log('Failed:', failed.join(', '));
await db.end();
