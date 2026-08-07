// Parses a Lichess standard-rated PGN dump (as downloaded from
// database.lichess.org, decompressed from .pgn.zst) into the
// {id, result, moves} shape algorithm.js's buildPositionGraph expects.
// No filtering by rating band or time control — every rated game in the
// dump counts, per the algorithm spec's step 2. Filename already scopes
// this to rated games only (the "_rated_" dumps), so there's nothing left
// to filter here.
//
// Two entry points share one line-by-line state machine (createLineFeeder
// below): parsePgnGames(text) takes the whole file as a string (fine for
// the sub-1GB range — an early, low-volume month decompresses to well
// under that); parsePgnGamesStream(readable) takes a Node Readable and
// yields games incrementally, never buffering the whole file — required
// for a real recent month, which decompresses to tens of GB. See
// pipeline/stream-build.mjs for how that's wired to an actual
// download+decompress pipeline.

import { createInterface } from 'node:readline';

const RESULT_TO_OUTCOME = { '1-0': 'white', '0-1': 'black', '1/2-1/2': 'draw' };

// The shared per-line state machine both parsers below drive. Tracks the
// most recently seen [Site] and [Result] headers and, on hitting a
// movetext line (the actual game, one per PGN record), emits the
// completed game — or counts it as skipped if the result wasn't a usable
// outcome (e.g. "*", an in-progress/aborted game a dump can still
// contain). Kept as one implementation so the array-based and streaming
// parsers can never silently drift apart on what counts as a game.
function createLineFeeder() {
  let id = null;
  let result = null;
  let index = 0;
  let skipped = 0;
  function feedLine(line) {
    if (line.startsWith('[Site "')) {
      // Lichess's Site header is the game's canonical URL, e.g.
      // https://lichess.org/j1dkb5dw — the trailing token is the game id.
      const match = line.match(/\/([a-zA-Z0-9]+)"\]\s*$/);
      id = match ? match[1] : null;
      return null;
    }
    if (line.startsWith('[Result "')) {
      const match = line.match(/^\[Result "([^"]+)"\]/);
      result = match ? match[1] : null;
      return null;
    }
    if (line.length > 0 && /^\d+\./.test(line)) {
      const outcome = RESULT_TO_OUTCOME[result];
      let game = null;
      if (!outcome) {
        skipped++;
      } else {
        game = { id: id || `game${index}`, result: outcome, moves: parseMoveText(line) };
        index++;
      }
      id = null;
      result = null;
      return game;
    }
    return null;
  }
  return { feedLine, getSkipped: () => skipped };
}

/**
 * @param {string} pgnText the full decompressed PGN file contents
 * @returns {{games: Array<{id: string, result: string, moves: string[]}>, skipped: number}}
 *   skipped counts games dropped for having an unusable result (e.g. "*",
 *   an in-progress/aborted game a dump can still contain) — not an error,
 *   just not usable data.
 */
export function parsePgnGames(pgnText) {
  const feeder = createLineFeeder();
  const games = [];
  for (const line of pgnText.split('\n')) {
    const game = feeder.feedLine(line);
    if (game) games.push(game);
  }
  return { games, skipped: feeder.getSkipped() };
}

/**
 * Streaming counterpart to parsePgnGames: consumes a Node Readable
 * (already-decompressed PGN text) line by line via node:readline and
 * yields each parsed game as soon as its movetext line completes it,
 * without ever holding more than one line in memory — the caller can feed
 * each yielded game straight into buildPositionGraphAsync and let it be
 * garbage-collected, so total memory stays bounded by the graph being
 * built, not by the size of the dump being read.
 *
 * @param {import('node:stream').Readable} readable text-mode (or utf8-decodable) readable stream
 * @param {{skipped?: number}} [stats] optional -- mutated in place so the
 *   caller can read the final skipped count after iteration completes
 *   (a generator's return value isn't visible through `for await`).
 * @returns {AsyncGenerator<{id: string, result: string, moves: string[]}>}
 */
export async function* parsePgnGamesStream(readable, stats = {}) {
  const feeder = createLineFeeder();
  const rl = createInterface({ input: readable, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const game = feeder.feedLine(line);
      if (game) yield game;
    }
  } finally {
    stats.skipped = feeder.getSkipped();
    rl.close();
  }
}

function parseMoveText(line) {
  // Strip engine-eval / clock comments ({ [%eval 0.2] }, { [%clk 0:10:00] }
  // etc.) before tokenizing — some months' dumps include these inline,
  // most don't, but they're harmless to always strip.
  const withoutComments = line.replace(/\{[^}]*\}/g, ' ');
  const tokens = withoutComments.trim().split(/\s+/);
  const moves = [];
  for (const tok of tokens) {
    if (tok === '') continue;
    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') continue; // trailing result marker
    if (/^\d+\.(\.\.)?$/.test(tok)) continue; // move-number token, e.g. "12." or "12..."
    // A move-number and the move itself can appear glued together
    // ("12.Nf3") in some PGN styles, though not in the Lichess dumps
    // sampled so far — strip a leading number+dots defensively either way.
    moves.push(tok.replace(/^\d+\.(\.\.)?/, ''));
  }
  return moves;
}
