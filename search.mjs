// node search.mjs "how did companies scale live streaming to millions of viewers" --difficulty advanced
// Flags: --tech --mentions --concept --domain --industry --type --difficulty --company --min-quality --limit --all
import { parseArgs } from 'node:util';
import { openDb, embed, toVector } from './lib.mjs';

const { values: f, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries([
    ...['tech', 'mentions', 'concept', 'domain', 'industry', 'type', 'difficulty', 'company', 'min-quality', 'limit']
      .map((k) => [k, { type: 'string' }]),
    ['all', { type: 'boolean' }], // include non-technical / low quality
  ]),
});
const query = positionals.join(' ').trim();

// Every tag filter becomes one jsonb containment check, served by the GIN index.
const contains = {
  ...(f.tech && { primary_technologies: [f.tech.toLowerCase()] }),
  ...(f.mentions && { technologies: [f.mentions.toLowerCase()] }),
  ...(f.concept && { concepts: [f.concept.toLowerCase()] }),
  ...(f.domain && { domains: [f.domain] }),
  ...(f.industry && { industry: f.industry }),
  ...(f.type && { content_type: f.type }),
  ...(f.difficulty && { difficulty: f.difficulty }),
  ...(!f.all && { is_technical: true }),
};
const params = [JSON.stringify(contains), f.all ? 1 : Number(f['min-quality'] ?? 6), Number(f.limit ?? 10)];
let where = `status='done' AND tags @> $1::jsonb AND (tags->>'quality')::int >= $2`;
if (f.company) where += ` AND tags->>'company' ILIKE $${params.push(f.company)}`;

let order = `(tags->>'quality')::int DESC, published_at DESC NULLS LAST`;
if (query) order = `embedding <=> $${params.push(toVector(await embed(query, { query: true })))}::vector`;

const db = await openDb();
const client = await db.connect();
await client.query('SET hnsw.iterative_scan = relaxed_order'); // keep scanning when filters reject neighbours
const { rows } = await client.query(
  `SELECT title, url, source, published_at, summary, tags FROM posts WHERE ${where} ORDER BY ${order} LIMIT $3`, params);
client.release();
await db.end();

if (!rows.length) console.log('No matches.');
rows.forEach((r, i) => {
  const t = r.tags;
  console.log(`\n${i + 1}. ${r.title}`);
  console.log(`   ${r.source} · ${r.published_at?.toISOString().slice(0, 10) ?? '?'} · ${t.difficulty} · ${t.content_type} · quality ${t.quality}/10`);
  console.log(`   core: ${t.primary_technologies.join(', ') || '-'}${t.migration ? `  ·  migration: ${t.migration.from.join('+')} -> ${t.migration.to.join('+')}` : ''}`);
  console.log(`   ${r.summary}`);
  console.log(`   ${r.url}`);
});
