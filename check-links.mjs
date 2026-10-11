// Find dead links among listed posts and file them as reports for the moderation queue.
// Run weekly: node --env-file=.env check-links.mjs
import { openDb, UA } from './lib.mjs';

const db = await openDb();
const { rows } = await db.query(`SELECT id, url FROM posts p WHERE status = 'done'
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.post_id = p.id AND r.status = 'open')`);
console.log(`Checking ${rows.length} links...`);

async function status(url) {
  for (const method of ['HEAD', 'GET']) { // some servers reject HEAD
    try {
      const res = await fetch(url, { method, redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      if (res.ok || method === 'GET') return res.status;
    } catch (e) {
      if (method === 'GET') return e.cause?.code ?? 'unreachable';
    }
  }
}

let dead = 0;
const queue = [...rows];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let p; (p = queue.shift()); ) {
    const s = await status(p.url);
    // Only clear-cut failures; 403/429 usually mean bot protection, not a dead page.
    if (s === 404 || s === 410 || s === 'ENOTFOUND') {
      dead++;
      console.log(`dead ${s} ${p.url}`);
      await db.query(`INSERT INTO reports (post_id, reason, note) VALUES ($1, 'broken', $2)`, [p.id, `auto: ${s}`]);
    }
  }
}));
console.log(`Done. ${dead} dead links reported.`);
await db.end();
