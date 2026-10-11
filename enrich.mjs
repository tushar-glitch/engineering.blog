// Tag + summarize + embed posts with status 'new'.  Usage: node enrich.mjs [limit]
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { openDb, get, canFetch, htmlToText, embed, toVector } from './lib.mjs';

const LLM = { baseUrl: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
export const MAX_CHARS = Number(process.env.MAX_INPUT_CHARS ?? 24000); // keep under free-tier tokens-per-minute caps
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY ?? 2);
const MIN_CHARS = 1200; // shorter than this is a link post / announcement, not worth a call

// ---------- tag vocabulary ----------
// Fixed lists make reliable filters; free-form lists (technologies, concepts) carry the long tail.

const V = {
  difficulty: ['beginner', 'intermediate', 'advanced', 'expert'],
  content_type: ['case-study', 'migration', 'postmortem', 'architecture', 'deep-dive', 'tutorial', 'benchmark',
    'research', 'lessons-learned', 'opinion', 'announcement', 'other'],
  domains: ['backend', 'frontend', 'mobile', 'distributed-systems', 'databases', 'data-engineering', 'ml-ai',
    'llm', 'infrastructure', 'devops', 'reliability', 'observability', 'security', 'networking', 'performance',
    'testing', 'developer-productivity', 'software-architecture', 'cloud', 'storage', 'streaming-media',
    'real-time', 'search', 'payments', 'compilers-languages', 'operating-systems', 'hardware', 'cost-optimization',
    'engineering-management', 'product-engineering'],
  industry: ['streaming-media', 'social-media', 'e-commerce', 'fintech', 'food-delivery', 'mobility-logistics',
    'travel-hospitality', 'gaming', 'developer-tools', 'cloud-infrastructure', 'databases', 'adtech', 'healthcare',
    'education', 'communication', 'productivity-saas', 'ai', 'security', 'research', 'open-source', 'other'],
  audience: ['backend', 'frontend', 'mobile', 'data', 'ml', 'sre-devops', 'security', 'architect', 'eng-manager'],
};

// Models often send null for "nothing"; treat it as empty/false rather than failing the post.
// Small local models sometimes send a list as one string: "a, b" or "- a\n- b".
const split = (s, sep) => s.split(sep).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
const list = (sep = /\n|,\s*/) => z.preprocess((v) => (typeof v === 'string' ? split(v, sep) : v),
  z.array(z.coerce.string()).nullish().transform((a) => a ?? []));
const flag = () => z.boolean().nullish().transform(Boolean);
const words = (a) => [...new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean))];
const one = (vocab, fallback) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v), // ["advanced"] -> "advanced"
  z.string().nullish().transform((s) => (vocab.includes(s?.toLowerCase()) ? s.toLowerCase() : fallback)));
const many = (vocab) => list().transform((a) => words(a).filter((s) => vocab.includes(s)));
const free = (max) => list().transform((a) => words(a).slice(0, max));

const TagSchema = z.object({
  is_technical: flag(),
  summary: z.string().min(20),
  key_takeaways: list(/\n/),
  company: z.string().nullish().transform((s) => s || null),
  primary_technologies: free(3),
  technologies: free(25),
  concepts: free(20),
  programming_languages: free(8),
  domains: many(V.domains),
  industry: one(V.industry, 'other'),
  content_type: one(V.content_type, 'other'),
  difficulty: one(V.difficulty, 'intermediate'),
  audience: many(V.audience),
  migration: z.object({ from: free(5), to: free(5) }).nullish()
    .transform((m) => (m?.from.length || m?.to.length ? m : null)),
  scale_metrics: list(/\n|;\s*/),
  has_code: flag(),
  has_metrics: flag(),
  quality: z.coerce.number().int().min(1).max(10),
  quality_reason: z.string().nullish().transform((s) => s ?? ''),
});

const SYSTEM = `You classify technical blog posts for a search index used by software engineers.
Return ONLY a JSON object with exactly these keys:

is_technical: boolean - false for marketing, hiring, event recaps, product launches without engineering detail.
summary: 2-3 sentences: what problem, what they did, what result. Concrete, no hype.
key_takeaways: 3-5 short sentences a reader would remember.
company: the organisation whose system is described, or null.
primary_technologies: 1-3 technologies the post is CENTRALLY about (not merely mentioned).
technologies: every meaningful technology, product, protocol or tool discussed.
concepts: engineering concepts/techniques, e.g. "sharding", "consistent hashing", "rate limiting", "cdc", "raft".
programming_languages: languages the post's code or system uses.
domains: any of ${JSON.stringify(V.domains)}
industry: one of ${JSON.stringify(V.industry)}
content_type: one of ${JSON.stringify(V.content_type)}
difficulty: one of ${JSON.stringify(V.difficulty)} - beginner: new engineers; intermediate: working engineers; advanced: senior; expert: staff+/specialists.
audience: any of ${JSON.stringify(V.audience)}
migration: {"from": [...], "to": [...]} if the post describes moving between technologies, else null.
scale_metrics: concrete numbers stated in the post, e.g. "25M concurrent viewers", "1.2B messages/day", "p99 40ms".
has_code: boolean - contains code snippets.
has_metrics: boolean - reports measured numbers/benchmarks.
quality: integer 1-10 for how valuable this is to an experienced engineer. 9-10: rare depth, real production
  numbers, non-obvious lessons. 6-8: solid and specific. 3-5: shallow or generic. 1-2: fluff/marketing.
quality_reason: one sentence justifying the score.

All technology/concept names: lowercase canonical names ("postgresql" not "Postgres", "kubernetes" not "k8s",
"apache kafka" -> "kafka"). Use only facts in the post.`;

// ---------- LLM call (OpenAI-compatible: Groq, xAI Grok, OpenRouter, Ollama...) ----------

// Provider-level problems: the post is fine, the model/API isn't. The post goes back to the queue untouched.
// StopWorker = this worker can't continue (limit reached, key rejected, model gone); others are unaffected.
export class StopWorker extends Error {}
export class ProviderError extends Error {}
// Waits of a few minutes are burst throttling (NVIDIA asks for ~2-5 min); daily caps ask for 15+ min.
const MAX_WAIT = Number(process.env.LLM_MAX_WAIT_SECS ?? 600);

export async function classify(title, url, text, llm = LLM) {
  for (let attempt = 1, limited = 0; ; attempt++) {
    const res = await postJson(llm.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      headers: { authorization: `Bearer ${llm.key}` },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Title: ${title}\nURL: ${url}\n\n${text}` },
        ],
      }),
    }).catch((e) => ({ status: 0, headers: {}, text: e.message })); // dropped connection / timeout
    if (res.status === 429) {
      // Short waits are per-minute limits: ride them out. A long wait (or many in a row) is a daily/hard limit.
      limited++;
      const wait = Number(res.headers['retry-after']) || 15 * limited;
      if (wait > MAX_WAIT || limited > 10) throw new StopWorker(`rate limit reached (retry in ${Math.round(wait / 60)} min)`);
      console.log(`  429, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new StopWorker(`API key rejected (${res.status})`);
    if (res.status === 404) throw new StopWorker(`model not available (404): ${res.text.slice(0, 150)}`);
    if (res.status === 0 || res.status >= 500) {
      if (attempt >= 6) throw new ProviderError(`provider unavailable: ${res.status || res.text}`);
      console.log(`  ${res.status || res.text}, retrying in ${15 * attempt}s`);
      await new Promise((r) => setTimeout(r, 15 * attempt * 1000));
      continue;
    }
    if (res.status !== 200) throw new Error(`LLM HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    // Reasoning models may wrap the JSON in <think>…</think> or ```json fences: take the outermost object.
    const content = (JSON.parse(res.text).choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
    let parsed;
    try {
      parsed = TagSchema.safeParse(JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)));
    } catch (e) {
      parsed = { success: false, error: { issues: [{ path: [], message: 'invalid JSON: ' + e.message }] } };
    }
    if (parsed.success) return parsed.data;
    if (attempt >= 2) throw new Error('bad tags: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  }
}

// node:http instead of fetch: fetch aborts after 5 min without response headers,
// and a local CPU model can take longer than that on one post.
function postJson(url, { headers, body }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (c) => (text += c)).on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    // Hosted APIs sometimes queue a request forever; give up and let the caller retry/fail the post.
    req.setTimeout(Number(process.env.LLM_TIMEOUT_SECS ?? 300) * 1000, () => req.destroy(new Error('LLM request timed out')));
    req.on('error', reject).end(body);
  });
}

// ---------- pipeline ----------

export async function articleText(post) {
  const fromFeed = post.feed_content ? htmlToText(post.feed_content) : '';
  if (fromFeed.length >= 3000) return fromFeed;
  if (!(await canFetch(post.url))) return fromFeed;
  try {
    const page = htmlToText((await get(post.url)).body);
    return page.length > fromFeed.length ? page : fromFeed;
  } catch {
    return fromFeed;
  }
}

// Every write is guarded by claimed_by: if this worker somehow lost the claim, its result is discarded,
// so a post can never be written by two workers.
const OWNED = `id=$1 AND status='working' AND claimed_by=$2`;

async function enrich(db, post, me) {
  const text = await articleText(post);
  if (text.length < MIN_CHARS) {
    await db.query(`UPDATE posts SET status='skipped', error='too short', feed_content=NULL WHERE ${OWNED}`, [post.id, me]);
    return 'skipped';
  }
  // ponytail: long posts are cut to MAX_CHARS; the intro + first sections carry what tagging needs
  const tags = await classify(post.title, post.url, text.slice(0, MAX_CHARS));
  const { summary, ...rest } = tags;
  const embedText = [post.title, summary, tags.key_takeaways.join(' '),
    [...tags.primary_technologies, ...tags.technologies, ...tags.concepts, ...tags.domains, tags.industry,
      tags.content_type].join(', ')].join('\n');
  const vector = await embed(embedText);
  const { rowCount } = await db.query(
    `UPDATE posts SET status='done', error=NULL, summary=$3, tags=$4, embedding=$5, feed_content=NULL, enriched_at=now()
     WHERE ${OWNED}`, [post.id, me, summary, { ...rest, tagged_by: LLM.model }, toVector(vector)]);
  if (!rowCount) return 'claim lost, result discarded';
  return `q${tags.quality} ${tags.difficulty} [${tags.primary_technologies.join(', ')}]`;
}

// Run only when executed directly, so other scripts can import classify().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!LLM.baseUrl || !LLM.key || !LLM.model) {
    console.error('Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env (see .env.example).');
    process.exit(1);
  }
  const limit = Number(process.argv[2] ?? 50);
  const me = `${process.env.WORKER_NAME ?? LLM.model}#${process.pid}`; // unique per running worker
  const db = await openDb();
  // Claims older than 2h belong to a worker that crashed; put them back in the queue.
  await db.query(`UPDATE posts SET status='new', claimed_by=NULL WHERE status='working' AND enriched_at < now() - interval '2 hours'`);
  // Atomic claim: SKIP LOCKED means two workers can never receive the same row.
  const claim = async () => (await db.query(`UPDATE posts SET status='working', claimed_by=$1, enriched_at=now()
    WHERE id = (SELECT id FROM posts WHERE status='new' ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, url, title, source, feed_content`, [me])).rows[0];
  const release = (id) => db.query(`UPDATE posts SET status='new', claimed_by=NULL, enriched_at=NULL WHERE ${OWNED}`, [id, me]);

  const inFlight = new Set();
  let stopReason = null;
  const stop = (why) => { stopReason ??= why; };
  // Ctrl+C / kill: hand unfinished posts back so another worker can take them.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
    stop('interrupted');
    await Promise.all([...inFlight].map(release)).catch(() => {});
    console.log(`[${me}] interrupted, released ${inFlight.size} post(s)`);
    process.exit(0);
  });

  console.log(`[${me}] tagging up to ${limit} posts with ${LLM.model}, ${CONCURRENCY} at a time`);
  let done = 0, tagged = 0, providerFails = 0, postFails = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let p; !stopReason && done < limit && (p = await claim()); ) {
      const n = ++done;
      const t0 = Date.now();
      inFlight.add(p.id);
      try {
        const result = await enrich(db, p, me);
        console.log(`${n}. ${p.source}: ${p.title.slice(0, 70)} -> ${result} (${Math.round((Date.now() - t0) / 1000)}s)`);
        if (result !== 'skipped') tagged++;
        providerFails = postFails = 0;
      } catch (e) {
        if (e instanceof StopWorker || e instanceof ProviderError) {
          await release(p.id); // not the post's fault: leave it for another worker
          console.log(`${n}. RELEASED ${p.title.slice(0, 60)}: ${e.message}`);
          if (e instanceof StopWorker) stop(e.message);
          else if (++providerFails >= 3) stop('provider failing repeatedly: ' + e.message);
        } else {
          console.log(`${n}. FAIL ${p.title.slice(0, 70)}: ${e.message}`);
          await db.query(`UPDATE posts SET status='failed', error=$3 WHERE ${OWNED}`, [p.id, me, e.message.slice(0, 500)]);
          if (++postFails >= 10) stop('10 posts failed in a row');
        }
      } finally {
        inFlight.delete(p.id);
      }
    }
  }));
  console.log(`[${me}] stopped: ${stopReason ?? (done >= limit ? 'reached limit' : 'queue empty')}. Tagged ${tagged}.`);
  await db.end();
  process.exitCode = stopReason ? 2 : 0;
}
