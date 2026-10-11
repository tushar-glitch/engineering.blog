# Blogify

Index of high-quality engineering blog posts: fetch → LLM tags + summary → embedding → filter/semantic search → website.
We store metadata and summaries only; readers are always sent to the original post.

```sh
npm install
npm run db                     # Postgres + pgvector in Docker, port 5440
cp .env.example .env           # LLM key (Groq / xAI / any OpenAI-compatible API) + ADMIN_TOKEN
npm run fetch                  # pull all feeds in feeds.json (re-runnable, dedupes by URL)
npm run tag                    # tag + embed all untagged posts with every model in parallel (see below)
npm run dev                    # website on http://localhost:4400 (auto-reloads)
npm test
```

Weekly: `node --env-file=.env check-links.mjs` files dead links into the moderation queue.

## Tagging

`npm run tag` starts one worker process per model listed in `tag.mjs` (NVIDIA GLM-5.3 Flash, NVIDIA Nemotron-3 Super,
Groq gpt-oss-120b). Keys come from `.env` (`NVIDIA_API_KEY`, `GROQ_API_KEY`); a worker without a key is skipped.

- **No post is tagged twice.** Workers claim posts with `UPDATE … FOR UPDATE SKIP LOCKED`, and every write checks
  `claimed_by`, so a worker that lost its claim can't overwrite anything.
- **Workers are independent.** A worker stops on its own when its rate limit is hit (asked to wait > 10 min), its key
  is rejected, its model disappears, the provider fails 3 times in a row, or 10 posts fail in a row. The post it was
  holding goes back to the queue; the other workers carry on.
- **Safe to stop any time.** Ctrl+C hands in-progress posts back. Posts held by killed workers are returned the next
  time the launcher starts. Re-running only picks up untagged posts.

Add or swap a model by editing the `WORKERS` list in `tag.mjs`.

## Website

- `/` browse: hybrid search (pgvector semantic + Postgres full-text, fused with RRF), faceted filters with counts,
  sort by relevance / best / most liked / trending / newest. Typed queries suggest matching filters ("+ kafka").
- `/p/:id` overview: summary, takeaways, numbers, migration, tags, related posts (nearest embeddings), report form.
- `/go/:id` outbound redirect to the original post (counts clicks).
- `/topics`, `/sources`, `/saved` (bookmarks in localStorage), `/submit`, `/about`.
- `/admin` moderation (basic auth; password = `ADMIN_TOKEN`): approve submissions (posts get queued for
  tagging, blogs get appended to `feeds.json`), resolve reports, hide posts, fix moved URLs.
- Likes need no account: an anonymous cookie id, one like per post per browser, rate-limited per IP.

Files: `server.mjs` (routes + SQL), `views.mjs` (HTML, escaped by default), `public/` (CSS + progressive-enhancement JS),
`lib.mjs` (DB schema, feeds, embeddings), `fetch.mjs`, `enrich.mjs`, `check-links.mjs`, `search.mjs` (CLI search).

Add a source: append `{"name", "url"}` to `feeds.json`. The URL can be a feed or a blog page (feed is auto-discovered).
