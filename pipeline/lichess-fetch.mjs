// Batch-fetches full game records from Lichess's per-game PGN export API,
// for streaming-engine.mjs's on-demand resumption of parked games whose
// move lists were never held in memory. Backs the fetchGamesBatch option
// that engine requires.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parsePgnGames } from './ingest.js';

const BATCH_ENDPOINT = 'https://lichess.org/api/games/export/_ids';
// Lichess's documented cap on ids per request to this endpoint.
const MAX_IDS_PER_REQUEST = 300;
// A single request's latency is dominated by Lichess's own per-game
// server-side cost (measured: roughly linear, ~35-40ms/game, e.g. a
// 300-id request takes ~10-11s) rather than by anything on our end, and
// concurrent requests were measured to barely slow each other down (5
// concurrent 100-id batches: ~4.2s total, vs ~3.7s for one alone) with no
// rate-limiting observed at that level -- so running several batches at
// once is a large, close-to-free speedup. Kept modest rather than
// maximized, since this runs for a real multi-day ingestion and shouldn't
// hammer Lichess's shared infrastructure.
const CONCURRENCY = 8;

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 1024 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function curlArgs(extra) {
  const proxyCaBundle = '/root/.ccr/ca-bundle.crt';
  const proxyArgs = process.env.HTTPS_PROXY && existsSync(proxyCaBundle) ? ['--cacert', proxyCaBundle] : [];
  return [...proxyArgs, ...extra];
}

async function fetchBatchOnce(ids) {
  const { stdout } = await execFileP('curl', curlArgs([
    '-sS', '-X', 'POST', BATCH_ENDPOINT,
    '--data', ids.join(','),
    '-w', '\n__HTTP_STATUS__%{http_code}',
  ]));
  const statusMatch = stdout.match(/__HTTP_STATUS__(\d+)\s*$/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
  if (status === 429) {
    const err = new Error('rate limited (429) by Lichess games export API');
    err.rateLimited = true;
    throw err;
  }
  if (status !== null && status !== 200) {
    throw new Error(`Lichess games export API returned HTTP ${status}: ${body.slice(0, 500)}`);
  }
  return body;
}

// Shared across every chunk in a fetchGamesBatch call (and across calls,
// module-level): when ANY worker gets rate-limited, every worker should
// back off together, rather than each independently retrying and piling
// MORE requests onto an already-throttled window. Measured in practice: a
// real month's reconciliation round can need hundreds of sequential
// requests, and a sustained run genuinely does get rate-limited (not just
// a theoretical concern) -- retries are unbounded rather than capped,
// since this runs unattended for potentially days and a 429 is a "wait,
// not a failure" signal, not a reason to crash the whole ingestion.
const rateLimitState = { cooldownUntil: 0, consecutiveHits: 0 };

async function waitForCooldown() {
  const remaining = rateLimitState.cooldownUntil - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function registerRateLimitHit() {
  rateLimitState.consecutiveHits++;
  const backoffMs = Math.min(60000, 2000 * 2 ** (rateLimitState.consecutiveHits - 1));
  rateLimitState.cooldownUntil = Math.max(rateLimitState.cooldownUntil, Date.now() + backoffMs);
}

function registerSuccess() {
  rateLimitState.consecutiveHits = 0;
}

async function fetchChunkWithRetry(chunk, out) {
  for (;;) {
    await waitForCooldown();
    try {
      const body = await fetchBatchOnce(chunk);
      registerSuccess();
      const { games } = parsePgnGames(body);
      for (const g of games) out.set(g.id, { result: g.result, moves: g.moves });
      return;
    } catch (err) {
      if (err.rateLimited) {
        registerRateLimitHit();
        continue; // waitForCooldown() at the top of the next iteration handles the actual wait
      }
      throw err;
    }
  }
}

/**
 * @param {string[]} gameIds
 * @param {{onChunkDone?: ({completed: number, total: number}) => void}} [opts]
 *   onChunkDone fires after each 300-id chunk resolves -- a single call here
 *   can involve thousands of chunks on a real month-scale reconciliation
 *   round, silently, for many minutes, with no other way for a caller to
 *   tell "still working" apart from "stuck".
 * @returns {Promise<Map<string, {result: string, moves: string[]}>>}
 *   Games Lichess doesn't return (unknown id) are simply absent from the
 *   map -- callers (streaming-engine.mjs) treat a missing id as an error
 *   rather than silently continuing.
 */
export async function fetchGamesBatch(gameIds, opts = {}) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < gameIds.length; i += MAX_IDS_PER_REQUEST) chunks.push(gameIds.slice(i, i + MAX_IDS_PER_REQUEST));

  // A small worker pool rather than Promise.all(chunks.map(...)): with
  // potentially hundreds of chunks in one call (a real month's
  // reconciliation round), launching them all at once would open far more
  // simultaneous connections than CONCURRENCY intends to allow.
  let completed = 0;
  let nextChunk = 0;
  async function worker() {
    for (;;) {
      const i = nextChunk++;
      if (i >= chunks.length) return;
      await fetchChunkWithRetry(chunks[i], out);
      completed++;
      opts.onChunkDone?.({ completed, total: chunks.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return out;
}
