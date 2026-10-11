import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';

export const UA = 'BlogifyBot/0.1 (indexes titles and links only)';

export async function openDb() {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://blogify:blogify@localhost:5440/blogify' });
  // Several processes (tagging workers, server) start at once; run schema setup one at a time or the DDL deadlocks.
  const c = await db.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await setupSchema(c);
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
  return db;
}

async function setupSchema(db) {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS posts (
      id           BIGSERIAL PRIMARY KEY,
      url          TEXT UNIQUE NOT NULL,
      title        TEXT NOT NULL,
      source       TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      feed_content TEXT,                        -- temporary; cleared once enriched
      status       TEXT NOT NULL DEFAULT 'new', -- new | done | skipped | failed
      error        TEXT,
      summary      TEXT,
      tags         JSONB,                       -- see TagSchema in enrich.mjs
      embedding    VECTOR(768),                 -- bge-base-en-v1.5, normalized
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      enriched_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS posts_status ON posts (status);
    CREATE INDEX IF NOT EXISTS posts_tags ON posts USING gin (tags jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS posts_embedding ON posts USING hnsw (embedding vector_cosine_ops);

    ALTER TABLE posts ADD COLUMN IF NOT EXISTS likes  INT NOT NULL DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS clicks INT NOT NULL DEFAULT 0;
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS claimed_by TEXT; -- tagging worker currently holding the post
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS tsv TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(jsonb_to_tsvector('english', coalesce(tags, '{}'), '["string"]'), 'C')) STORED;
    CREATE INDEX IF NOT EXISTS posts_tsv ON posts USING gin (tsv);

    CREATE TABLE IF NOT EXISTS likes (
      post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      visitor    TEXT NOT NULL,             -- anonymous cookie id, no accounts
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, visitor)
    );
    CREATE INDEX IF NOT EXISTS likes_recent ON likes (created_at);

    CREATE TABLE IF NOT EXISTS submissions (
      id         BIGSERIAL PRIMARY KEY,
      kind       TEXT NOT NULL,             -- post | blog
      url        TEXT NOT NULL,
      name       TEXT,
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id         BIGSERIAL PRIMARY KEY,
      post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reason     TEXT NOT NULL,
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'open', -- open | resolved
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---------- feeds ----------

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x)).trim();

// RSS 2.0 and Atom -> [{ title, url, published_at, content }]
export function parseFeed(body) {
  const doc = xml.parse(body);
  if (doc.rss || doc['rdf:RDF']) {
    const items = arr(doc.rss?.channel?.item ?? doc['rdf:RDF']?.item);
    return items.map((i) => ({
      title: text(i.title),
      url: text(i.link) || text(i.guid),
      published_at: toIso(text(i.pubDate) || text(i['dc:date'])),
      content: text(i['content:encoded']) || text(i.description),
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((e) => {
      const links = arr(e.link);
      const link = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
      return {
        title: text(e.title),
        url: link?.['@_href'] ?? text(link),
        published_at: toIso(text(e.published) || text(e.updated)),
        content: text(e.content) || text(e.summary),
      };
    });
  }
  throw new Error('not an RSS/Atom feed');
}

const toIso = (s) => {
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
};

// <link rel="alternate" type="application/rss+xml" href="..."> on an HTML page
export function discoverFeedUrl(html, baseUrl) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/rel=["']?alternate/i.test(tag) && /application\/(rss|atom)\+xml/i.test(tag)) {
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) return new URL(href.replace(/&amp;/g, '&'), baseUrl).href;
    }
  }
  return null;
}

// ---------- html -> text ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// ponytail: regex extraction, good enough as LLM input; swap in @mozilla/readability if tags look noisy
export function htmlToText(html) {
  let h = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<article\b[\s\S]*<\/article>/i) ?? h.match(/<main\b[\s\S]*<\/main>/i);
  if (main) h = main[0];
  return h
    .replace(/<\/(p|div|h[1-6]|li|pre|tr|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// ---------- robots.txt ----------

const robotsCache = new Map();

// Only honours the `User-agent: *` group, prefix-matched Disallow rules.
export function robotsAllows(robotsTxt, path) {
  let applies = false;
  const disallow = [];
  for (const raw of robotsTxt.split('\n')) {
    const [k, ...v] = raw.split('#')[0].split(':');
    const key = k.trim().toLowerCase(), val = v.join(':').trim();
    if (key === 'user-agent') applies = val === '*';
    else if (applies && key === 'disallow' && val) disallow.push(val);
  }
  return !disallow.some((d) => path.startsWith(d));
}

export async function canFetch(url) {
  const { origin, pathname } = new URL(url);
  if (!robotsCache.has(origin)) {
    const res = await fetch(origin + '/robots.txt', { headers: { 'user-agent': UA } }).catch(() => null);
    robotsCache.set(origin, res?.ok ? await res.text() : '');
  }
  return robotsAllows(robotsCache.get(origin), pathname);
}

export async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: await res.text(), type: res.headers.get('content-type') ?? '', url: res.url };
}

// ---------- embeddings (local, free) ----------

let extractor;
// bge-base-en-v1.5: 768 dims, strong retrieval quality, runs on CPU. Downloads ~110MB on first use.
export async function embed(text, { query = false } = {}) {
  if (!extractor) {
    const { pipeline } = await import('@huggingface/transformers');
    extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { dtype: 'q8' });
  }
  const input = query ? 'Represent this sentence for searching relevant passages: ' + text : text;
  const out = await extractor(input, { pooling: 'cls', normalize: true });
  return new Float32Array(out.data);
}

// pgvector text literal
export const toVector = (v) => `[${Array.from(v).join(',')}]`;
