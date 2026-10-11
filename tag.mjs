// Run every tagging model in parallel:  npm run tag  (or: node --env-file=.env tag.mjs [posts per worker])
//
// Each worker is a separate process (enrich.mjs) with its own model and limits. Workers claim posts
// atomically in Postgres, so no post is ever tagged by two models. When one worker hits its rate limit,
// loses its key or keeps failing, only that worker stops; its unfinished post goes back to the queue
// and the others keep going.
import { spawn } from 'node:child_process';
import { openDb } from './lib.mjs';

const NVIDIA = 'https://integrate.api.nvidia.com/v1';
const WORKERS = [
  // NVIDIA's free tier allows ~40 requests/min per account, shared by both NVIDIA workers.
  { name: 'nvidia-glm', baseUrl: NVIDIA, model: 'z-ai/glm-5.3-flash', key: 'NVIDIA_API_KEY', concurrency: 4, maxChars: 16000, timeout: 180 },
  { name: 'nvidia-nemotron', baseUrl: NVIDIA, model: 'nvidia/nemotron-3-super-120b-a12b', key: 'NVIDIA_API_KEY', concurrency: 2, maxChars: 16000, timeout: 120 },
  // Groq free tier: 8k tokens/min, 200k tokens/day. Stops itself when the daily cap is hit.
  { name: 'groq-gpt-oss', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', key: 'GROQ_API_KEY', concurrency: 1, maxChars: 12000, timeout: 120 },
];

const limit = process.argv[2] ?? '100000';
const running = new Map();

// Posts claimed by a worker process that no longer exists (killed, crashed) go back to the queue.
// Claims of workers that are still alive (e.g. another launcher) are left alone.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
{
  const db = await openDb();
  const { rows } = await db.query(`SELECT DISTINCT claimed_by FROM posts WHERE status = 'working'`);
  const dead = rows.map((r) => r.claimed_by).filter((c) => !c || !alive(Number(c.split('#')[1])));
  const { rowCount } = await db.query(`UPDATE posts SET status='new', claimed_by=NULL, enriched_at=NULL
    WHERE status = 'working' AND (claimed_by IS NULL OR claimed_by = ANY($1))`, [dead]);
  if (rowCount) console.log(`Released ${rowCount} post(s) left behind by stopped workers.`);
  await db.end();
}

for (const w of WORKERS) {
  const key = process.env[w.key] ?? (w.key === 'GROQ_API_KEY' && /groq\.com/.test(process.env.LLM_BASE_URL ?? '') ? process.env.LLM_API_KEY : undefined);
  if (!key) {
    console.log(`[${w.name}] skipped: ${w.key} is not set in .env`);
    continue;
  }
  const child = spawn(process.execPath, ['--no-warnings', 'enrich.mjs', limit], {
    env: {
      ...process.env, WORKER_NAME: w.name, LLM_BASE_URL: w.baseUrl, LLM_MODEL: w.model, LLM_API_KEY: key,
      LLM_CONCURRENCY: String(w.concurrency), MAX_INPUT_CHARS: String(w.maxChars), LLM_TIMEOUT_SECS: String(w.timeout),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(w.name, child);
  const prefix = (stream, out) => {
    let buf = '';
    stream.setEncoding('utf8').on('data', (chunk) => {
      const lines = (buf + chunk).split('\n');
      buf = lines.pop();
      for (const line of lines) if (line.trim()) out.write(`${new Date().toTimeString().slice(0, 8)} [${w.name}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code) => {
    running.delete(w.name);
    console.log(`[${w.name}] exited (${code === 0 ? 'done' : code === 2 ? 'stopped itself' : 'crashed, code ' + code}). Still running: ${[...running.keys()].join(', ') || 'none'}`);
  });
}

if (!running.size) console.log('No workers started. Add NVIDIA_API_KEY and/or GROQ_API_KEY to .env.');
// Ctrl+C reaches the workers directly (same console); they release their posts and exit. Just wait for them.
process.on('SIGINT', () => console.log('Stopping workers…'));
