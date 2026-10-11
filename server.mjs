import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openDb, embed, toVector, get } from './lib.mjs';
import * as V from './views.mjs';

const PORT = Number(process.env.PORT ?? 4400);
const PAGE = 20;
const db = await openDb();
embed('warm up', { query: true }).catch((e) => console.error('embedding model failed to load:', e.message));

// ---------- filters -> SQL ----------

const FACET_SQL = {
  difficulty: [`tags->>'difficulty'`],
  type: [`tags->>'content_type'`],
  domain: [`tags->'domains'`, 'array'],
  tech: [`tags->'primary_technologies'`, 'array'],
  industry: [`tags->>'industry'`],
  source: ['source'],
  year: [`extract(year from published_at)::int::text`],
};
const SORTS = {
  best: `(tags->>'quality')::int + ln(1 + likes) DESC, published_at DESC NULLS LAST`,
  liked: `likes DESC, (tags->>'quality')::int DESC, published_at DESC NULLS LAST`,
  trending: `(SELECT count(*) FROM likes l WHERE l.post_id = p.id AND l.created_at > now() - interval '7 days') DESC, clicks DESC, published_at DESC NULLS LAST`,
  newest: `published_at DESC NULLS LAST`,
};
const COLS = `p.id, p.url, p.title, p.source, p.published_at, p.summary, p.tags, p.likes`;

function parseFilters(sp) {
  const f = { ...V.EMPTY, q: (sp.get('q') ?? '').trim().slice(0, 500) };
  for (const key of Object.keys(FACET_SQL)) f[key] = [...new Set(sp.getAll(key).filter(Boolean).map((v) => v.slice(0, 100)))].slice(0, 20);
  const quality = Number(sp.get('quality'));
  f.quality = quality >= 1 && quality <= 10 ? Math.floor(quality) : 6;
  f.code = sp.has('code');
  f.metrics = sp.has('metrics');
  f.sort = ['relevance', ...Object.keys(SORTS)].includes(sp.get('sort')) ? sp.get('sort') : 'auto';
  f.page = Math.min(Math.max(Math.floor(Number(sp.get('page'))) || 1, 1), 500);
  return f;
}

function where(f, except) {
  const params = [];
  const add = (v) => `$${params.push(v)}`;
  const c = [`status = 'done'`, `(tags->>'is_technical')::boolean`, `(tags->>'quality')::int >= ${add(f.quality)}`];
  for (const [key, [sql, kind]] of Object.entries(FACET_SQL)) {
    if (key === except || !f[key].length) continue;
    c.push(kind === 'array' ? `${sql} ?| ${add(f[key])}::text[]` : `${sql} = ANY(${add(f[key])}::text[])`);
  }
  if (f.code) c.push(`(tags->>'has_code')::boolean`);
  if (f.metrics) c.push(`(tags->>'has_metrics')::boolean`);
  return { sql: c.join(' AND '), params, add };
}

// Hybrid search: semantic (pgvector) + keyword (full-text) ranks fused with reciprocal rank fusion.
async function search(f) {
  const w = where(f);
  const sort = f.sort === 'auto' || (f.sort === 'relevance' && !f.q) ? (f.q ? 'relevance' : 'best') : f.sort;
  const page = `LIMIT ${PAGE} OFFSET ${(f.page - 1) * PAGE}`;
  let sql;
  if (f.q) {
    const qv = w.add(toVector(await embed(f.q, { query: true })));
    const qt = w.add(f.q);
    sql = `WITH f AS MATERIALIZED (SELECT id, embedding, tsv FROM posts WHERE ${w.sql}),
      v AS (SELECT id, row_number() OVER (ORDER BY embedding <=> ${qv}::vector) r FROM f ORDER BY r LIMIT 200),
      t AS (SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) r
            FROM f, websearch_to_tsquery('english', ${qt}) q WHERE tsv @@ q ORDER BY r LIMIT 200),
      fused AS (SELECT id, coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) AS score FROM v FULL JOIN t USING (id))
      SELECT ${COLS}, count(*) OVER ()::int total FROM fused JOIN posts p USING (id)
      ORDER BY ${sort === 'relevance' ? 'fused.score DESC' : SORTS[sort]} ${page}`;
  } else {
    sql = `SELECT ${COLS}, count(*) OVER ()::int total FROM posts p WHERE ${w.sql} ORDER BY ${SORTS[sort]} ${page}`;
  }
  const { rows } = await db.query(sql, w.params);
  return { rows, total: rows[0]?.total ?? 0, sort };
}

async function facetCounts(f) {
  const out = {};
  await Promise.all(Object.entries(FACET_SQL).map(async ([key, [sql, kind]]) => {
    const w = where(f, key); // counts ignore the facet's own selection so options stay OR-able
    const q = kind === 'array'
      ? `SELECT v, count(*)::int n FROM posts, jsonb_array_elements_text(${sql}) v WHERE ${w.sql} GROUP BY v ORDER BY n DESC, v LIMIT 400`
      : `SELECT ${sql} v, count(*)::int n FROM posts WHERE ${w.sql} AND ${sql} IS NOT NULL GROUP BY 1 ORDER BY n DESC, 1 LIMIT 400`;
    out[key] = (await db.query(q, w.params)).rows;
  }));
  return out;
}

async function likedSet(visitor, ids) {
  if (!visitor || !ids.length) return new Set();
  const { rows } = await db.query('SELECT post_id FROM likes WHERE visitor = $1 AND post_id = ANY($2::bigint[])', [visitor, ids]);
  return new Set(rows.map((r) => r.post_id));
}

// ---------- cached site-wide data ----------

function cached(ms, fn) {
  let at = 0, value;
  return async () => (Date.now() - at < ms ? value : (value = await fn(), at = Date.now(), value));
}

const getStats = cached(60_000, async () => (await db.query(`SELECT
  count(*) FILTER (WHERE status = 'done' AND (tags->>'is_technical')::boolean AND (tags->>'quality')::int >= 6)::int posts,
  count(*) FILTER (WHERE status = 'new')::int pending,
  count(DISTINCT source)::int sources FROM posts`)).rows[0]);

const getVocab = cached(600_000, async () => (await db.query(`SELECT v FROM posts, jsonb_array_elements_text(tags->'primary_technologies') v
  WHERE status = 'done' GROUP BY v HAVING count(*) >= 2 ORDER BY count(*) DESC`)).rows.map((r) => r.v));

const COLLECTIONS = [
  { title: 'Live video at massive scale', desc: 'Streaming to millions of concurrent viewers.', params: 'q=scaling+live+video+streaming+to+millions+of+concurrent+viewers' },
  { title: 'Database migrations', desc: 'Moving production data between systems, and what it cost.', params: 'type=migration&domain=databases' },
  { title: 'Postmortems', desc: 'Outages, root causes and the fixes that followed.', params: 'type=postmortem' },
  { title: 'Distributed systems, deep end', desc: 'Consensus, replication and failure, for senior engineers.', params: 'domain=distributed-systems&difficulty=advanced&difficulty=expert' },
  { title: 'LLMs in production', desc: 'Serving, evaluating and paying for language models.', params: 'domain=llm' },
  { title: 'Performance engineering', desc: 'Profiling, latency and making things fast.', params: 'domain=performance&quality=7' },
  { title: 'Payments & fintech', desc: 'Ledgers, idempotency and money that must add up.', params: 'industry=fintech' },
  { title: 'Search & ranking', desc: 'Indexing, retrieval and relevance at scale.', params: 'domain=search' },
];
const getCollections = cached(300_000, () => Promise.all(COLLECTIONS.map(async (c) => {
  const f = parseFilters(new URLSearchParams(c.params));
  const href = V.toQuery(f);
  if (f.q) return { ...c, href, count: null };
  const w = where(f);
  return { ...c, href, count: (await db.query(`SELECT count(*)::int n FROM posts WHERE ${w.sql}`, w.params)).rows[0].n };
})));

// Words in a free-text query that map onto filters: "kafka", "migration", "postmortem", "beginner"...
const KEYWORDS = {
  migration: ['type', 'migration'], migrate: ['type', 'migration'], migrated: ['type', 'migration'], migrating: ['type', 'migration'],
  postmortem: ['type', 'postmortem'], outage: ['type', 'postmortem'], outages: ['type', 'postmortem'], incident: ['type', 'postmortem'],
  tutorial: ['type', 'tutorial'], benchmark: ['type', 'benchmark'], benchmarks: ['type', 'benchmark'],
  beginner: ['difficulty', 'beginner'], beginners: ['difficulty', 'beginner'], advanced: ['difficulty', 'advanced'],
  expert: ['difficulty', 'expert'], staff: ['difficulty', 'expert'],
};
function suggestions(f, vocab) {
  if (!f.q) return [];
  const text = ` ${f.q.toLowerCase().replace(/[^a-z0-9.+#]+/g, ' ')} `;
  const out = vocab.filter((t) => t.length > 1 && text.includes(` ${t} `) && !f.tech.includes(t)).map((t) => ['tech', t]);
  for (const [word, [k, v]] of Object.entries(KEYWORDS)) {
    if (text.includes(` ${word} `) && !f[k].includes(v) && !out.some((s) => s[1] === v)) out.push([k, v]);
  }
  return out.slice(0, 6);
}

// ---------- routes ----------

const routes = [];
const route = (method, path, fn) => routes.push([method, path, fn]);

route('GET', /^\/$/, async (ctx) => {
  const f = parseFilters(ctx.url.searchParams);
  const landing = !f.q && f.page === 1 && ctx.url.search === '';
  const [{ rows, total, sort }, facets, stats, collections, vocab] = await Promise.all([
    search(f), facetCounts(f), getStats(), landing ? getCollections() : [], getVocab()]);
  const liked = await likedSet(ctx.visitor, rows.map((r) => r.id));
  return V.homePage({ f, rows, total, liked, facets, collections, suggestions: suggestions(f, vocab), stats, sort });
});

route('GET', /^\/p\/(\d+)$/, async (ctx, id) => {
  const { rows: [p] } = await db.query(`SELECT ${COLS} FROM posts p WHERE id = $1 AND status = 'done'`, [id]);
  if (!p) return null;
  const { rows: related } = await db.query(`SELECT ${COLS} FROM posts p
    WHERE status = 'done' AND id <> $1 AND (tags->>'is_technical')::boolean AND (tags->>'quality')::int >= 6
    ORDER BY embedding <=> (SELECT embedding FROM posts WHERE id = $1) LIMIT 6`, [id]);
  const liked = await likedSet(ctx.visitor, [p.id, ...related.map((r) => r.id)]);
  return V.postPage({ p, liked: liked.has(p.id), related, relatedLiked: liked, reported: ctx.url.searchParams.has('reported'), stats: await getStats() });
});

// Outbound clicks go through here so we can count them; the destination is always the stored URL.
route('GET', /^\/go\/(\d+)$/, async (ctx, id) => {
  const { rows: [p] } = await db.query(`UPDATE posts SET clicks = clicks + 1 WHERE id = $1 AND status = 'done' RETURNING url`, [id]);
  if (!p || !/^https?:\/\//i.test(p.url)) return null;
  return { redirect: p.url };
});

route('POST', /^\/api\/like\/(\d+)$/, async (ctx, id) => {
  if (limited(`like:${ctx.ip}`, 120, 600_000)) return { status: 429, json: { error: 'Too many likes, slow down.' } };
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(`INSERT INTO likes (post_id, visitor) SELECT id, $2 FROM posts WHERE id = $1 AND status = 'done'
      ON CONFLICT DO NOTHING`, [id, ctx.visitor]);
    let liked = true;
    if (ins.rowCount) await c.query('UPDATE posts SET likes = likes + 1 WHERE id = $1', [id]);
    else {
      liked = false;
      const del = await c.query('DELETE FROM likes WHERE post_id = $1 AND visitor = $2', [id, ctx.visitor]);
      if (del.rowCount) await c.query('UPDATE posts SET likes = greatest(likes - 1, 0) WHERE id = $1', [id]);
    }
    const { rows: [p] } = await c.query('SELECT likes FROM posts WHERE id = $1', [id]);
    await c.query('COMMIT');
    return p ? { json: { liked, likes: p.likes } } : { status: 404, json: { error: 'not found' } };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

const REASONS = ['broken', 'moved', 'paywall', 'tags', 'quality', 'other'];
route('POST', /^\/p\/(\d+)\/report$/, async (ctx, id) => {
  const form = await readForm(ctx.req);
  const reason = form.get('reason');
  if (!REASONS.includes(reason)) return { status: 400, text: 'Bad reason' };
  if (!limited(`report:${ctx.ip}`, 10, 3_600_000)) {
    await db.query(`INSERT INTO reports (post_id, reason, note) SELECT id, $2, $3 FROM posts WHERE id = $1`,
      [id, reason, (form.get('note') ?? '').slice(0, 500) || null]);
  }
  return { redirect: `/p/${id}?reported=1` };
});

route('GET', /^\/submit$/, async (ctx) => V.submitPage({
  ok: ctx.url.searchParams.has('ok'), kind: ctx.url.searchParams.get('kind'), stats: await getStats() }));

route('POST', /^\/submit$/, async (ctx) => {
  const form = await readForm(ctx.req);
  const stats = await getStats();
  const kind = form.get('kind') === 'blog' ? 'blog' : 'post';
  const fail = (error, existing) => V.submitPage({ error, existing, kind, stats });
  if (form.get('website')) return { redirect: '/submit?ok=1' }; // honeypot: bots fill every field
  let url;
  try {
    url = new URL((form.get('url') ?? '').trim());
    if (!/^https?:$/.test(url.protocol) || url.href.length > 500) throw 0;
  } catch {
    return fail('Please enter a full http(s) URL.');
  }
  url.hash = '';
  const { rows: [dup] } = await db.query(`SELECT id, status FROM posts WHERE url = $1`, [url.href]);
  if (dup) return fail('That post is already in the index.', dup.status === 'done' ? dup.id : null);
  const { rows: [pending] } = await db.query(`SELECT 1 FROM submissions WHERE url = $1 AND status = 'pending'`, [url.href]);
  if (pending) return fail('That URL is already waiting for review.');
  if (limited(`submit:${ctx.ip}`, 10, 3_600_000)) return fail('Too many submissions from your network. Try again later.');
  await db.query('INSERT INTO submissions (kind, url, name, note) VALUES ($1, $2, $3, $4)',
    [kind, url.href, (form.get('name') ?? '').trim().slice(0, 100) || null, (form.get('note') ?? '').trim().slice(0, 1000) || null]);
  return { redirect: '/submit?ok=1' };
});

route('GET', /^\/topics$/, async () => {
  const base = `status = 'done' AND (tags->>'is_technical')::boolean AND (tags->>'quality')::int >= 6`;
  const facet = (path, min, limit) => db.query(`SELECT v, count(*)::int n FROM posts, jsonb_array_elements_text(tags->'${path}') v
    WHERE ${base} GROUP BY v HAVING count(*) >= ${min} ORDER BY v LIMIT ${limit}`).then((r) => r.rows);
  const [tech, concepts, domains] = await Promise.all([facet('primary_technologies', 1, 2000), facet('concepts', 2, 600), facet('domains', 1, 100)]);
  return V.topicsPage({ tech, concepts, domains, stats: await getStats() });
});

route('GET', /^\/sources$/, async () => {
  const { rows: sources } = await db.query(`SELECT source,
      count(*) FILTER (WHERE status = 'done' AND (tags->>'is_technical')::boolean AND (tags->>'quality')::int >= 6)::int n,
      round(avg((tags->>'quality')::int) FILTER (WHERE status = 'done'), 1) avgq,
      max(published_at) latest
    FROM posts GROUP BY source ORDER BY n DESC, source`);
  return V.sourcesPage({ sources, stats: await getStats() });
});

route('GET', /^\/saved$/, async (ctx) => {
  const ids = (ctx.url.searchParams.get('ids') ?? '').split(',').map(Number).filter((n) => n > 0).slice(0, 200);
  const { rows } = ids.length
    ? await db.query(`SELECT ${COLS} FROM posts p WHERE id = ANY($1::bigint[]) AND status = 'done'`, [ids])
    : { rows: [] };
  rows.sort((a, b) => ids.indexOf(Number(a.id)) - ids.indexOf(Number(b.id)));
  return V.savedPage({ rows, liked: await likedSet(ctx.visitor, rows.map((r) => r.id)), stats: await getStats() });
});

route('GET', /^\/about$/, async () => V.aboutPage({ stats: await getStats() }));

// ---------- admin (HTTP basic auth, password = ADMIN_TOKEN) ----------

function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  const pass = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
  return !!token && pass.length === token.length && timingSafeEqual(Buffer.from(pass), Buffer.from(token));
}
const challenge = { status: 401, headers: { 'www-authenticate': 'Basic realm="blogify admin"' }, text: 'Authentication required' };

route('GET', /^\/admin$/, async (ctx) => {
  if (!process.env.ADMIN_TOKEN) return null;
  if (!isAdmin(ctx.req)) return challenge;
  const [counts, submissions, reports] = await Promise.all([
    db.query(`SELECT status, count(*)::int n FROM posts GROUP BY 1 ORDER BY 2 DESC`),
    db.query(`SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at`),
    db.query(`SELECT r.*, p.title, p.url FROM reports r JOIN posts p ON p.id = r.post_id WHERE r.status = 'open' ORDER BY r.created_at`),
  ]).then((rs) => rs.map((r) => r.rows));
  return V.adminPage({ counts, submissions, reports, stats: await getStats() });
});

route('POST', /^\/admin$/, async (ctx) => {
  if (!process.env.ADMIN_TOKEN) return null;
  if (!isAdmin(ctx.req)) return challenge;
  const form = await readForm(ctx.req);
  const id = Number(form.get('id'));
  switch (form.get('action')) {
    case 'approve': {
      const { rows: [s] } = await db.query(`UPDATE submissions SET status = 'approved' WHERE id = $1 RETURNING *`, [id]);
      if (s?.kind === 'blog') {
        const feeds = JSON.parse(await readFile('feeds.json', 'utf8'));
        if (!feeds.some((x) => x.url === s.url)) {
          feeds.push({ name: s.name || new URL(s.url).hostname.replace(/^www\./, ''), url: s.url });
          await writeFile('feeds.json', '[\n' + feeds.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n]\n');
        }
      } else if (s) {
        const page = await get(s.url).then((r) => r.body).catch(() => '');
        const meta = (prop) => page.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)`, 'i'))?.[1];
        const title = meta('og:title') ?? page.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? s.url;
        const source = s.name || meta('og:site_name') || new URL(s.url).hostname.replace(/^www\./, '');
        await db.query(`INSERT INTO posts (url, title, source) VALUES ($1, $2, $3) ON CONFLICT (url) DO NOTHING`, [s.url, title.slice(0, 300), source]);
      }
      break;
    }
    case 'reject': await db.query(`UPDATE submissions SET status = 'rejected' WHERE id = $1`, [id]); break;
    case 'resolve': await db.query(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [id]); break;
    case 'hide':
      await db.query(`UPDATE posts SET status = 'hidden' WHERE id = $1`, [Number(form.get('post'))]);
      await db.query(`UPDATE reports SET status = 'resolved' WHERE post_id = $1`, [Number(form.get('post'))]);
      break;
    case 'move': {
      const url = new URL(form.get('url'));
      if (/^https?:$/.test(url.protocol)) {
        await db.query(`UPDATE posts SET url = $2 WHERE id = $1`, [Number(form.get('post')), url.href]);
        await db.query(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [id]);
      }
      break;
    }
  }
  return { redirect: '/admin' };
});

const STATIC = { 'style.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8' };
route('GET', /^\/static\/([\w.-]+)$/, async (ctx, name) => {
  if (!STATIC[name]) return null;
  return { body: await readFile(`public/${name}`), headers: { 'content-type': STATIC[name], 'cache-control': 'public, max-age=31536000, immutable' } };
});

// ---------- plumbing ----------

const hits = new Map();
// ponytail: in-memory fixed-window limiter, per process; move to Redis/Postgres if we ever run more than one instance
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 600_000).unref();

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw Object.assign(new Error('Payload too large'), { status: 413 });
  }
  return new URLSearchParams(body);
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let visitor = cookies(req).vid;
  const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY' };
  if (!/^[a-f0-9]{32}$/.test(visitor ?? '')) {
    visitor = randomBytes(16).toString('hex');
    headers['set-cookie'] = `vid=${visitor}; Path=/; Max-Age=63072000; HttpOnly; SameSite=Lax`;
  }
  const ip = (process.env.TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
  const stats = getStats();

  let out;
  try {
    // Same-origin check for every write (likes, reports, submissions, admin).
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      out = { status: 403, text: 'Cross-origin request blocked' };
    } else {
      for (const [method, path, fn] of routes) {
        const m = req.method === method && url.pathname.match(path);
        if (m) { out = await fn({ req, url, visitor, ip }, ...m.slice(1)); break; }
      }
      out ??= { status: 404, html: V.notFoundPage({ stats: await stats }) };
    }
  } catch (e) {
    console.error(req.method, req.url, e);
    out = { status: e.status ?? 500, text: e.status ? e.message : 'Something went wrong.' };
  }
  if (typeof out === 'string') out = { html: out };

  if (out.redirect) res.writeHead(303, { ...headers, location: out.redirect }).end();
  else if (out.json) res.writeHead(out.status ?? 200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(out.json));
  else if (out.html) res.writeHead(out.status ?? 200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(out.html);
  else if (out.body) res.writeHead(200, { ...headers, ...out.headers }).end(out.body);
  else res.writeHead(out.status ?? 200, { ...headers, ...out.headers, 'content-type': 'text/plain; charset=utf-8' }).end(out.text);
});

server.listen(PORT, () => console.log(`Blogify on http://localhost:${PORT}`));
