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
// Usage:
//   node chunked-ingest.mjs <url> <checkpointDir> [chunkMinutes] [maxPlies] [minGames]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePgnGamesStream } from './ingest.js';
import { scorePass, selectRepertoire, positionKey } from './algorithm.js';
import { createStreamingGraphBuilder } from './streaming-engine.mjs';
import { fetchGamesBatch } from './lichess-fetch.mjs';
import { Chess } from '../js/vendor/chess.esm.js';

const url = process.argv[2];
const checkpointDir = process.argv[3];
const chunkMinutes = process.argv[4] ? Number(process.argv[4]) : 60;
const maxPlies = process.argv[5] ? Number(process.argv[5]) : 40;
const minGames = process.argv[6] ? Number(process.argv[6]) : 10;

if (!url || !checkpointDir) {
  console.error('Usage: node chunked-ingest.mjs <url> <checkpointDir> [chunkMinutes=60] [maxPlies=40] [minGames=10]');
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
for (const [proc, name] of [[fetcher, isUrl ? 'curl' : 'cat'], [zstd, 'zstd']]) {
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) log(`${name} exited with code ${code}`);
    if (signal) log(`${name} killed by signal ${signal}`);
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
const builder = createStreamingGraphBuilder({ maxPlies, minGames, fetchGamesBatch, initialNodes: initialNodes ?? undefined, initialPending: initialPending ?? undefined });
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

async function checkpointAndScore() {
  const t = Date.now();
  const nodes = await builder.finish(); // safe to call repeatedly -- see streaming-engine.mjs's doc comment
  const pendingSnapshot = builder.getPendingSnapshot(); // every still-parked game, so a resume loses none of them
  writeAtomic(nodesPath, JSON.stringify(serializeNodes(nodes)));
  writeAtomic(pendingPath, JSON.stringify(pendingSnapshot));
  writeAtomic(metaPath, JSON.stringify({ gamesProcessed: totalGamesProcessed, updatedAt: new Date().toISOString(), source: url, maxPlies, minGames }));

  const whiteScores = scorePass(nodes, 'white', minGames);
  const blackScores = scorePass(nodes, 'black', minGames);
  const whiteRepertoire = selectRepertoire(nodes, whiteScores, 'white', minGames);
  const blackRepertoire = selectRepertoire(nodes, blackScores, 'black', minGames);
  writeAtomic(whiteOutPath, JSON.stringify(whiteRepertoire));
  writeAtomic(blackOutPath, JSON.stringify(blackRepertoire));

  const rootKey = positionKey(new Chess().fen());
  const rootNode = nodes.get(rootKey);
  const qualifying = [...nodes.values()].filter((n) => n.total >= minGames).length;
  log(`Checkpoint: ${nodes.size} nodes (${qualifying} qualifying), ${pendingSnapshot.records.length} games still in flight, white picks ${whiteRepertoire.myMove?.san ?? 'nothing yet'} (${((whiteRepertoire.myMove?.score ?? 0) * 100).toFixed(1)}%), root total ${rootNode?.total ?? 0} games -- saved in ${Date.now() - t}ms`);
}

log(`Starting: chunkMinutes=${chunkMinutes} maxPlies=${maxPlies} minGames=${minGames}`);

for await (const game of source) {
  builder.feedGame(game);
  totalGamesProcessed++;
  gamesThisChunk++;
  if (Date.now() - chunkStart >= chunkMs) {
    reportProgress();
    await checkpointAndScore();
    chunkStart = Date.now();
    gamesThisChunk = 0;
  }
}

log(`Stream exhausted (${parseStats.skipped ?? 0} games skipped as unfinished across the whole run) -- final checkpoint:`);
reportProgress();
await checkpointAndScore();
log('Done.');
