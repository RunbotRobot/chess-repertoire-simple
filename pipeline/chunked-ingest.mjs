#!/usr/bin/env node
// Long-running ingestion for a real Lichess month, checkpointed roughly
// every `chunkMinutes` of wall-clock time so it can survive being
// interrupted (a container restart, a manual stop) without losing more
// than about one chunk's worth of progress, and so a usable repertoire is
// available to try well before the whole month finishes.
//
// This is ONE continuous process, not a series of separate hour-long
// invocations: it streams the whole dump start to finish in a single run,
// pausing briefly every chunkMinutes to save a checkpoint and write out a
// fresh scored repertoire, then resuming the same stream. A checkpoint
// only needs to matter if the process actually dies -- on a clean restart
// (`node chunked-ingest.mjs <url> <dir>` run again after a crash), it
// reloads the last checkpoint's confirmed graph AND every still-parked,
// not-yet-resolved game (via the streaming engine's getPendingSnapshot()/
// initialPending), then re-streams the dump from the beginning (Lichess's
// dump isn't seekable mid-stream), skipping the expensive per-game
// graph-building work for every game already accounted for -- only the
// cheap PGN parsing runs for those, so even a late-run restart should cost
// minutes of catch-up, not hours. Because the pending snapshot is restored
// too, not just the confirmed graph, a resume loses zero games.
//
// Uses streaming-engine.mjs (not algorithm.js's createGraphBuilder)
// specifically because a real month's data means the vast majority of
// games end up permanently parked (measured: 98.8% on the real January
// 2013 dump), and holding every one of their full move lists in memory
// for the rest of the run doesn't scale -- see streaming-engine.mjs's own
// header comment for the full rationale. Parked games here are tracked as
// lightweight {gameId, plyIndex, fen} records with no move list; resuming
// one fetches its PGN on demand, in batches, from Lichess's per-game
// export API (pipeline/lichess-fetch.mjs) -- so this needs real network
// access to Lichess (beyond the initial dump download) whenever it's
// actually reconciling, not just while streaming the dump.
//
// Local ingestion throughput (measured on the real July 2026 dump: ~1500
// games/s) vastly outpaces how fast parked games can be politely
// re-fetched from Lichess's API for reconciliation (measured: needing
// ~5+ hours to register a single 5-minute chunk's backlog) -- so this
// can't just feed continuously and reconcile whenever; two mechanisms
// keep it on a predictable, bounded cadence instead:
//   - builder.finish() is called with a deadline (this chunk's own
//     chunkMinutes boundary), so a fresh checkpoint -- however far
//     reconciliation actually got -- lands roughly every chunkMinutes no
//     matter how large the backlog is. A position reconciliation hasn't
//     reached yet just reads as a leaf (not enough data *yet*), the same
//     honest state the very first checkpoint of any run is already in.
//   - feeding pauses early, before chunkMinutes elapses, once the
//     currently-unresolved backlog (builder.getActivePendingCount())
//     passes maxPendingBacklog -- otherwise production would keep
//     outrunning reconciliation by orders of magnitude, growing the
//     in-memory backlog without bound over a month-long run.
//
// Usage:
//   node chunked-ingest.mjs <url> <checkpointDir> [chunkMinutes] [maxPlies] [minGames] [maxPendingBacklog]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePgnGamesStream } from './ingest.js';
import { scorePass, selectRepertoireGraph, positionKey } from './algorithm.js';
import { createStreamingGraphBuilder } from './streaming-engine.mjs';
import { fetchGamesBatch, getRateLimitStats } from './lichess-fetch.mjs';
import { Chess } from '../js/vendor/chess.esm.js';

const url = process.argv[2];
const checkpointDir = process.argv[3];
const chunkMinutes = process.argv[4] ? Number(process.argv[4]) : 60;
const maxPlies = process.argv[5] ? Number(process.argv[5]) : 40;
const minGames = process.argv[6] ? Number(process.argv[6]) : 10;
const maxPendingBacklog = process.argv[7] ? Number(process.argv[7]) : 100000;

if (!url || !checkpointDir) {
  console.error('Usage: node chunked-ingest.mjs <url> <checkpointDir> [chunkMinutes=60] [maxPlies=40] [minGames=10] [maxPendingBacklog=100000]');
  process.exit(1);
}

mkdirSync(checkpointDir, { recursive: true });
const metaPath = join(checkpointDir, 'meta.json');
const nodesPath = join(checkpointDir, 'nodes.json');
const pendingPath = join(checkpointDir, 'pending.json');
const whiteOutPath = join(checkpointDir, 'repertoire-white.json');
const blackOutPath = join(checkpointDir, 'repertoire-black.json');
const logPath = join(checkpointDir, 'progress.log');

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.error(stamped);
  appendFileSync(logPath, stamped + '\n');
}

function serializeNodes(nodes) {
  const arr = [];
  for (const [key, node] of nodes) {
    arr.push([key, {
      fen: node.fen,
      total: node.total,
      whiteWins: node.whiteWins,
      draws: node.draws,
      blackWins: node.blackWins,
      children: [...node.children.entries()],
    }]);
  }
  return arr;
}

function deserializeNodes(arr) {
  const nodes = new Map();
  for (const [key, n] of arr) {
    nodes.set(key, {
      fen: n.fen,
      key,
      total: n.total,
      whiteWins: n.whiteWins,
      draws: n.draws,
      blackWins: n.blackWins,
      children: new Map(n.children),
    });
  }
  return nodes;
}

function writeAtomic(path, content) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// --- Load any existing checkpoint ---
let initialNodes = null;
let initialPending = null;
let gamesAlreadyProcessed = 0;
if (existsSync(metaPath) && existsSync(nodesPath) && existsSync(pendingPath)) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  gamesAlreadyProcessed = meta.gamesProcessed;
  initialNodes = deserializeNodes(JSON.parse(readFileSync(nodesPath, 'utf8')));
  initialPending = JSON.parse(readFileSync(pendingPath, 'utf8'));
  log(`Resuming from checkpoint: ${gamesAlreadyProcessed} games already processed, ${initialNodes.size} nodes loaded, ${initialPending.records.length} games still in flight`);
} else {
  log('No checkpoint found -- starting fresh');
}

// --- Content-Length up front, best-effort, for an ETA (network source only) ---
let totalBytes = null;
if (/^https?:\/\//.test(url)) {
  try {
    const proxyCaBundle = '/root/.ccr/ca-bundle.crt';
    const extra = process.env.HTTPS_PROXY && existsSync(proxyCaBundle) ? ['--cacert', proxyCaBundle] : [];
    const { execFileSync } = await import('node:child_process');
    const headOut = execFileSync('curl', ['-sS', '-I', '-L', ...extra, url], { encoding: 'utf8' });
    const match = headOut.match(/content-length:\s*(\d+)/i);
    if (match) totalBytes = Number(match[1]);
  } catch (err) {
    log(`Could not fetch Content-Length for ETA (non-fatal): ${err.message}`);
  }
}
if (totalBytes) log(`Source size: ${(totalBytes / 1e9).toFixed(2)}GB compressed`);

// --- Spawn the download/decompress pipeline (always from the start -- see file header) ---
const proxyCaBundle = '/root/.ccr/ca-bundle.crt';
const extraCurlArgs = process.env.HTTPS_PROXY && existsSync(proxyCaBundle) ? ['--cacert', proxyCaBundle] : [];
const isUrl = /^https?:\/\//.test(url);

function spawnChecked(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  child.on('error', (err) => {
    log(`${cmd} failed to start: ${err.message}`);
    process.exit(1);
  });
  return child;
}

const fetcher = isUrl
  ? spawnChecked('curl', ['-sS', '-L', '--fail', ...extraCurlArgs, url], { stdio: ['ignore', 'pipe', 'inherit'] })
  : spawnChecked('cat', [url], { stdio: ['ignore', 'pipe', 'inherit'] });
const zstd = spawnChecked('zstd', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });

let bytesFetched = 0;
fetcher.stdout.on('data', (chunk) => { bytesFetched += chunk.length; });
fetcher.stdout.pipe(zstd.stdin);
fetcher.stdout.on('error', (err) => { if (err.code !== 'EPIPE') log(`fetcher stream error: ${err.message}`); });
zstd.stdin.on('error', (err) => { if (err.code !== 'EPIPE') log(`zstd stdin error: ${err.message}`); });
// Tracked so the main loop can tell a genuine end-of-stream (the for-await
// below just sees its source end either way) apart from the download or
// decompression having actually failed partway through (observed: a
// truncated/corrupted download makes zstd exit nonzero) -- without this,
// that failure reads as "Stream exhausted" and the run reports success
// having processed a tiny fraction of the dump, silently stalling the
// whole month's progress while looking healthy in the Actions UI.
//
// fetcherDone/zstdDone/pipelineSettled exist because of a real race,
// observed in practice: the for-await loop's source can hit EOF and let
// the loop finish BEFORE both child processes' own 'exit' events have
// actually fired (a real run's "zstd exited with code 1" log line landed
// *after* "Stream exhausted" had already printed) -- so the loop can't
// just check pipelineFailure the instant it ends; it has to wait for both
// processes to genuinely finish first.
let pipelineFailure = null;
let fetcherDone = false;
let zstdDone = false;
let resolvePipelineSettled;
const pipelineSettled = new Promise((resolve) => { resolvePipelineSettled = resolve; });
for (const [proc, name] of [[fetcher, isUrl ? 'curl' : 'cat'], [zstd, 'zstd']]) {
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) { log(`${name} exited with code ${code}`); pipelineFailure ??= `${name} exited with code ${code}`; }
    if (signal) { log(`${name} killed by signal ${signal}`); pipelineFailure ??= `${name} killed by signal ${signal}`; }
    if (proc === fetcher) fetcherDone = true; else zstdDone = true;
    if (fetcherDone && zstdDone) resolvePipelineSettled();
  });
}

const parseStats = {};
const rawSource = parsePgnGamesStream(zstd.stdout, parseStats);

// --- Skip games already reflected in the loaded checkpoint (cheap: parsing only, no graph work) ---
async function* skipAlreadyProcessed(source, skipCount) {
  let seen = 0;
  for await (const game of source) {
    seen++;
    if (seen <= skipCount) {
      if (seen % 500000 === 0) log(`  catching up: skipped ${seen}/${skipCount} already-processed games`);
      continue;
    }
    yield game;
  }
}
const source = gamesAlreadyProcessed > 0 ? skipAlreadyProcessed(rawSource, gamesAlreadyProcessed) : rawSource;

// --- Build, checkpointing every chunkMinutes ---
// onRound/onFetch: reconciliation (builder.finish(), called from
// checkpointAndScore() below) can run for a long time on a real
// month-scale dataset's cold-start backlog, entirely inside network awaits
// that would otherwise produce zero log output -- indistinguishable from a
// hang from the outside. onFetch is throttled (every 20th chunk, not
// every one) since a single round can involve thousands of them.
let lastFetchLogAt = 0;
const builder = createStreamingGraphBuilder({
  maxPlies, minGames, fetchGamesBatch,
  initialNodes: initialNodes ?? undefined, initialPending: initialPending ?? undefined,
  onRound: (s) => log(`  reconcile round ${s.round}: ${s.toRegister} record(s) to register, ${s.fetched} game(s) to fetch, queue ${s.queueLength}`),
  onFetch: (s) => {
    if (s.completed === s.total || s.completed - lastFetchLogAt >= 20) {
      lastFetchLogAt = s.completed;
      const rl = getRateLimitStats();
      const rlNote = rl.totalHits > 0 ? `, rate-limited ${rl.totalHits}x total (${rl.consecutiveHits} in a row, ${(rl.cooldownMsRemaining / 1000).toFixed(0)}s cooldown left)` : '';
      log(`    [${s.phase}] fetched ${s.completed}/${s.total} batches${rlNote}`);
    }
  },
});
let totalGamesProcessed = gamesAlreadyProcessed;
let gamesThisChunk = 0;
const runStart = Date.now();
let chunkStart = Date.now();
const chunkMs = chunkMinutes * 60 * 1000;

function reportProgress() {
  const elapsedS = (Date.now() - runStart) / 1000;
  const rateGamesPerS = totalGamesProcessed > gamesAlreadyProcessed ? (totalGamesProcessed - gamesAlreadyProcessed) / elapsedS : 0;
  let etaStr = '';
  if (totalBytes && bytesFetched > 0) {
    const fraction = bytesFetched / totalBytes;
    const estTotalS = elapsedS / fraction;
    const remainingS = Math.max(0, estTotalS - elapsedS);
    etaStr = `, ${(fraction * 100).toFixed(2)}% of dump by bytes, ~${(remainingS / 3600).toFixed(1)}h remaining`;
  }
  log(`${totalGamesProcessed} games total (+${gamesThisChunk} this run so far), ${rateGamesPerS.toFixed(0)} games/s${etaStr}`);
}

async function checkpointAndScore(deadlineMs) {
  const t = Date.now();
  const nodes = await builder.finish({ deadlineMs }); // safe to call repeatedly -- see streaming-engine.mjs's doc comment; deadlineMs bounds how long reconciliation gets before this checkpoint is written anyway
  const pendingSnapshot = builder.getPendingSnapshot(); // every still-parked game, so a resume loses none of them
  writeAtomic(nodesPath, JSON.stringify(serializeNodes(nodes)));
  writeAtomic(pendingPath, JSON.stringify(pendingSnapshot));
  writeAtomic(metaPath, JSON.stringify({ gamesProcessed: totalGamesProcessed, updatedAt: new Date().toISOString(), source: url, maxPlies, minGames }));

  const generatedAt = new Date().toISOString();
  const whiteScores = scorePass(nodes, 'white', minGames);
  const blackScores = scorePass(nodes, 'black', minGames);
  const whiteGraph = selectRepertoireGraph(nodes, whiteScores, 'white', minGames);
  const blackGraph = selectRepertoireGraph(nodes, blackScores, 'black', minGames);
  // Wrapped with minGames/generatedAt (rather than writing the bare
  // graph) so a consumer -- the app's repertoireSource.js -- can tell a
  // genuine data-scarcity leaf (total < minGames) apart from a "plenty of
  // games, just none individually qualifying" leaf without hardcoding the
  // threshold this run happened to use, and can show how fresh the data
  // is, since this file gets overwritten repeatedly during a long-running
  // ingestion. Flat (rootKey + nodes-by-key), not a nested tree: a nested
  // tree that also fully recurses every non-chosen alternate (needed so
  // Browse can follow one to its real leaf, not just its top-level score)
  // duplicates any position reachable via more than one path -- real
  // production data hit ~105MB per color that way, over GitHub's 100MB
  // file limit. Keying by position instead caps output at the number of
  // unique qualifying positions, the same order of magnitude as the graph
  // itself, regardless of how many paths (transpositions, or now also
  // alternates) reach any of them. See selectRepertoireGraph's own doc
  // comment in algorithm.js.
  writeAtomic(whiteOutPath, JSON.stringify({ minGames, generatedAt, rootKey: whiteGraph.rootKey, nodes: whiteGraph.nodes }));
  writeAtomic(blackOutPath, JSON.stringify({ minGames, generatedAt, rootKey: blackGraph.rootKey, nodes: blackGraph.nodes }));

  const rootKey = positionKey(new Chess().fen());
  const rootNode = nodes.get(rootKey);
  const qualifying = [...nodes.values()].filter((n) => n.total >= minGames).length;
  const whiteRoot = whiteGraph.nodes[whiteGraph.rootKey];
  log(`Checkpoint: ${nodes.size} nodes (${qualifying} qualifying), ${pendingSnapshot.records.length} games still in flight, white picks ${whiteRoot.myMove?.san ?? 'nothing yet'} (${((whiteRoot.myMove?.score ?? 0) * 100).toFixed(1)}%), root total ${rootNode?.total ?? 0} games -- saved in ${Date.now() - t}ms`);
}

log(`Starting: chunkMinutes=${chunkMinutes} maxPlies=${maxPlies} minGames=${minGames} maxPendingBacklog=${maxPendingBacklog}`);

// Checked every 1000 games fed, not every single one -- getActivePendingCount()
// is O(1) but at ~1500 games/s even a cheap check adds up if run per-game;
// a 1000-game granularity is still far finer than needed against an hour-scale cadence.
const BACKLOG_CHECK_INTERVAL = 1000;

for await (const game of source) {
  builder.feedGame(game);
  totalGamesProcessed++;
  gamesThisChunk++;
  const timeUp = Date.now() - chunkStart >= chunkMs;
  const backlogFull = !timeUp && gamesThisChunk % BACKLOG_CHECK_INTERVAL === 0 && builder.getActivePendingCount() >= maxPendingBacklog;
  if (timeUp || backlogFull) {
    if (backlogFull) log(`Pending backlog reached ${maxPendingBacklog} -- pausing to reconcile before it grows further, rather than waiting out the rest of this chunk's ${chunkMinutes}min.`);
    reportProgress();
    await checkpointAndScore(chunkStart + chunkMs);
    chunkStart = Date.now();
    gamesThisChunk = 0;
  }
}

// Both child processes' 'exit' handlers may not have run yet the instant
// the loop above ends (see the race noted where pipelineFailure is
// declared) -- wait for them, bounded, so a real failure that landed
// slightly late isn't missed.
await Promise.race([pipelineSettled, new Promise((resolve) => setTimeout(resolve, 5000))]);

if (pipelineFailure) {
  // The stream ending here is NOT a genuine "reached the end of the dump"
  // -- checkpoint whatever real progress was made anyway (a resume on the
  // next run will pick up right from here, same as any other interruption)
  // but exit nonzero so this is never mistaken for a successful,
  // completed pass over the whole file.
  log(`Download/decompress pipeline failed (${pipelineFailure}) before the stream was actually exhausted. Saving a checkpoint of what was processed so far; the next run will resume from here.`);
  reportProgress();
  await checkpointAndScore();
  log('Exiting with failure -- this run did NOT reach the end of the dump.');
  process.exit(1);
}

log(`Stream exhausted (${parseStats.skipped ?? 0} games skipped as unfinished across the whole run) -- final checkpoint:`);
reportProgress();
await checkpointAndScore(); // no deadline -- nothing left to feed, so let this one run to full convergence
log('Done.');
