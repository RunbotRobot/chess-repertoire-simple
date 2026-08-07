// Parses a Lichess standard-rated PGN dump (as downloaded from
// database.lichess.org, already decompressed from .pgn.zst) into the
// {id, result, moves} shape algorithm.js's buildPositionGraph expects.
// No filtering by rating band or time control — every rated game in the
// dump counts, per the algorithm spec's step 2. Filename already scopes
// this to rated games only (the "_rated_" dumps), so there's nothing left
// to filter here.
//
// This reads the whole decompressed file into memory at once — fine for
// the sub-1GB range (an early, low-volume month decompresses to well under
// that), but a real recent month decompresses to tens of GB and needs the
// streaming-decompression + line-at-a-time approach described in the spec
// instead. That's a follow-up, not implemented here yet — this module's
// job right now is validating the parse/ingest step against a real dump,
// not the cost-engineering needed for a full-size one.

const RESULT_TO_OUTCOME = { '1-0': 'white', '0-1': 'black', '1/2-1/2': 'draw' };

/**
 * @param {string} pgnText the full decompressed PGN file contents
 * @returns {{games: Array<{id: string, result: string, moves: string[]}>, skipped: number}}
 *   skipped counts games dropped for having an unusable result (e.g. "*",
 *   an in-progress/aborted game a dump can still contain) — not an error,
 *   just not usable data.
 */
export function parsePgnGames(pgnText) {
  const games = [];
  let skipped = 0;
  let id = null;
  let result = null;

  const lines = pgnText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('[Site "')) {
      // Lichess's Site header is the game's canonical URL, e.g.
      // https://lichess.org/j1dkb5dw — the trailing token is the game id.
      const match = line.match(/\/([a-zA-Z0-9]+)"\]\s*$/);
      id = match ? match[1] : null;
    } else if (line.startsWith('[Result "')) {
      const match = line.match(/^\[Result "([^"]+)"\]/);
      result = match ? match[1] : null;
    } else if (line.length > 0 && /^\d+\./.test(line)) {
      const outcome = RESULT_TO_OUTCOME[result];
      if (!outcome) {
        skipped++;
      } else {
        games.push({ id: id || `game${games.length}`, result: outcome, moves: parseMoveText(line) });
      }
      id = null;
      result = null;
    }
  }
  return { games, skipped };
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
