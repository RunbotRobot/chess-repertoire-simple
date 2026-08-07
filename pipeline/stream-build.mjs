#!/usr/bin/env node
// Streams a Lichess standard-rated PGN dump straight into a scored
// repertoire, without ever buffering the compressed download, the
// decompressed PGN text, or the full games list anywhere in memory or on
// disk. This is what makes a real recent month tractable: its compressed
// dump alone (tens of GB) can exceed available disk in a constrained
// environment, and its decompressed text or parsed-games array (also tens
// of GB, or more) would exceed available RAM even where disk isn't the
// limit. Memory instead stays bounded by the SCORED GRAPH being built
// (see buildPositionGraphAsync in algorithm.js), which is roughly the size
// of the qualifying repertoire, independent of how many games were read to
// produce it.
//
// Pipeline: curl (download, or `cat` for a local file) -> zstd -d
// (decompress) -> parsePgnGamesStream (incremental PGN parsing) ->
// buildPositionGraphAsync (lazy hot-branch expansion) -> scorePass +
// selectRepertoire. Only the LAST stage's output (the graph and the
// resulting repertoire trees) is ever fully materialized.
//
// Download is delegated to curl rather than Node's own https/fetch: curl
// already respects the standard *_PROXY environment variables this
// environment (and most CI/VM environments) rely on, with zero extra
// dependencies or proxy-agent wiring.
//
// Usage:
//   node stream-build.mjs <source> [outFile] [maxPlies] [minGames]
//   <source> is either a Lichess dump URL (https://database.lichess.org/...)
//   or a local .pgn.zst file path (for testing without a network download).

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { parsePgnGamesStream } from './ingest.js';
import { buildPositionGraphAsync, scorePass, selectRepertoire, positionKey } from './algorithm.js';
import { Chess } from '../js/vendor/chess.esm.js';

const source = process.argv[2];
const outFile = process.argv[3] || null;
const maxPlies = process.argv[4] ? Number(process.argv[4]) : 40;
const minGames = process.argv[5] ? Number(process.argv[5]) : 10;

if (!source) {
  console.error('Usage: node stream-build.mjs <url-or-local.pgn.zst> [outFile] [maxPlies] [minGames]');
  process.exit(1);
}

const isUrl = /^https?:\/\//.test(source);

// Only added when both the proxy and its CA bundle are actually present
// (this sandboxed dev environment) -- a real deployment (a plain cloud VM,
// a GitHub Actions runner) has neither and should use curl's normal trust
// store untouched.
const proxyCaBundle = '/root/.ccr/ca-bundle.crt';
const extraCurlArgs = process.env.HTTPS_PROXY && existsSync(proxyCaBundle) ? ['--cacert', proxyCaBundle] : [];

function spawnChecked(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  child.on('error', (err) => {
    console.error(`${cmd} failed to start:`, err.message);
    process.exit(1);
  });
  return child;
}

console.error(`Streaming from ${isUrl ? 'URL' : 'local file'}: ${source}`);
const t0 = Date.now();

// Stage 1: get compressed bytes, from the network or from disk, as a stream.
const fetcher = isUrl
  ? spawnChecked('curl', ['-sS', '-L', '--fail', ...extraCurlArgs, source], { stdio: ['ignore', 'pipe', 'inherit'] })
  : spawnChecked('cat', [source], { stdio: ['ignore', 'pipe', 'inherit'] });

// Stage 2: decompress. -d reads from stdin and writes to stdout when no
// file argument is given; -c is the default for stdout when input is a
// pipe, but pass it explicitly to be unambiguous either way.
const zstd = spawnChecked('zstd', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
fetcher.stdout.pipe(zstd.stdin);
fetcher.stdout.on('error', (err) => { if (err.code !== 'EPIPE') console.error('fetcher stream error:', err.message); });
zstd.stdin.on('error', (err) => { if (err.code !== 'EPIPE') console.error('zstd stdin error:', err.message); });

for (const [proc, name] of [[fetcher, isUrl ? 'curl' : 'cat'], [zstd, 'zstd']]) {
  proc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`${name} exited with code ${code}`);
    if (signal) console.error(`${name} killed by signal ${signal}`);
  });
}

// Stage 3+4: parse and build, entirely incrementally.
const parseStats = {};
const source3 = parsePgnGamesStream(zstd.stdout, parseStats);

let gameCount = 0;
async function* countingSource() {
  for await (const game of source3) {
    gameCount++;
    if (gameCount % 50000 === 0) {
      const elapsedS = (Date.now() - t0) / 1000;
      console.error(`  ${gameCount} games parsed, ${elapsedS.toFixed(0)}s elapsed, ${(gameCount / elapsedS).toFixed(0)} games/s`);
    }
    yield game;
  }
}

const graph = await buildPositionGraphAsync(countingSource(), { maxPlies, minGames });
const buildMs = Date.now() - t0;
console.error(`Built position graph: ${graph.size} nodes from ${gameCount} games (${parseStats.skipped ?? 0} skipped as unfinished) in ${(buildMs / 1000).toFixed(0)}s`);

const t1 = Date.now();
const whiteScores = scorePass(graph, 'white', minGames);
const blackScores = scorePass(graph, 'black', minGames);
const whiteRepertoire = selectRepertoire(graph, whiteScores, 'white', minGames);
const blackRepertoire = selectRepertoire(graph, blackScores, 'black', minGames);
console.error(`Scored and selected both repertoires in ${Date.now() - t1}ms`);

const rootKey = positionKey(new Chess().fen());
const rootNode = graph.get(rootKey);
const rootCandidates = [...rootNode.children.values()]
  .map((edge) => ({ edge, child: graph.get(edge.key) }))
  .filter(({ child }) => child && child.total >= minGames)
  .map(({ edge, child }) => ({ san: edge.san, games: child.total, whiteScore: whiteScores.get(child.key)?.score ?? null }))
  .sort((a, b) => b.games - a.games);

console.error(`\nWhite's root pick: ${whiteRepertoire.myMove?.san} (score ${((whiteRepertoire.myMove?.score ?? 0) * 100).toFixed(1)}%, ${whiteRepertoire.myMove?.child.total} games)`);
console.error(`Root candidates (${rootNode.total} total games reaching the start position):`);
for (const c of rootCandidates) {
  console.error(`  ${c.san.padEnd(6)} games=${String(c.games).padStart(8)}  white_score=${(c.whiteScore * 100).toFixed(1)}%`);
}
console.error(`\nTotal wall time: ${((Date.now() - t0) / 1000).toFixed(0)}s, memory: ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB heap used`);

if (outFile) {
  writeFileSync(outFile, JSON.stringify({ white: whiteRepertoire, black: blackRepertoire }));
  console.error(`Wrote repertoire to ${outFile}`);
}
