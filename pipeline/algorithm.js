// Core scoring/selection algorithm for the empirical repertoire pipeline.
// See chess-repertoire-algorithm-spec.md (design doc) for the full
// rationale — this module implements steps 1, 3, 4, 6 (transposition
// handling only — see note below), 7, and 8 from that spec. It's pure and
// I/O-free: given already-parsed games, it returns scored positions and a
// materialized per-color repertoire tree. Bulk PGN ingestion, FEN
// extraction from a real Lichess dump, and the lazy-expansion/game-ID
// tracking optimization (spec step 5-6, needed to make a real multi-GB
// dataset affordable) are a separate, not-yet-written concern — this
// module intentionally walks every game to full depth rather than lazily
// expanding only "hot" branches. That optimization changes cost, not
// output: a lazily-expanded-and-re-expanded DAG and a fully-walked one
// score identically, since a leaf's tally already includes every game that
// passed through it regardless of how it continued (spec step 3). Fully
// walking is simpler to get right first and is what this prototype exists
// to validate — the real pipeline can add the cost optimization on top of
// this same scoring logic once bulk data makes full-walking too slow.
//
// One deliberate departure from the spec doc's literal step 4 formula:
// leafScore() below uses a Wilson score interval lower bound instead of a
// flat wins/total ratio. This isn't a guess — a real end-to-end run against
// the full January 2013 Lichess dump (121,332 games) surfaced the exact
// failure mode the spec's own minimax design exists to catch, just one
// level up: 1.h3, on only 50 games, out-scored 1.e4 (72,488 games) purely
// from small-sample noise (raw rates: h3 60%, e4 50.0%). The ≥10-game
// qualifying threshold gates whether a position becomes its own scored
// decision point at all, but says nothing about how much two *qualifying*
// samples of very different sizes should be trusted relative to each
// other — Wilson's lower bound fixes exactly that, and since leafScore
// feeds the unmodified minimax propagation, every deeper node inherits the
// same protection, not just the root.
import { Chess } from '../js/vendor/chess.esm.js';

// Positions are keyed by the FEN fields that actually define board state —
// piece placement, side to move, castling rights, en passant target —
// deliberately dropping the halfmove clock and fullmove number. Two games
// reaching "the same position" by different paths almost never agree on
// those counters, and they don't affect what's legal from here on, so
// keying on them would silently defeat transposition merging (spec step 1)
// for the overwhelming majority of real transpositions.
export function positionKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Walks every game's move list, accumulating per-position totals and
 * child-move structure into a single position graph, merging by
 * positionKey() so transpositions combine into one node regardless of how
 * many different move orders reached it.
 *
 * @param {Array<{id: string, result: 'white'|'black'|'draw', moves: string[]}>} games
 *   moves are SAN strings, applied in order from the standard start position.
 * @param {{maxPlies?: number}} [opts] maxPlies caps how deep any single game
 *   is walked (matching the app's own maxPlies concept) — games shorter
 *   than this are walked to their actual end; this only trims games that
 *   run long, so no position is ever double-counted or under-counted for a
 *   game that simply ended first.
 * @returns {Map<string, PositionNode>} keyed by positionKey(fen), where
 *   PositionNode = { fen, key, total, whiteWins, draws, blackWins,
 *   children: Map<san, {san, uci, key}> }
 */
export function buildPositionGraph(games, opts = {}) {
  const maxPlies = Number.isFinite(opts.maxPlies) ? opts.maxPlies : Infinity;
  const nodes = new Map();

  const getOrCreate = (fen) => {
    const key = positionKey(fen);
    let node = nodes.get(key);
    if (!node) {
      node = { fen, key, total: 0, whiteWins: 0, draws: 0, blackWins: 0, children: new Map() };
      nodes.set(key, node);
    }
    return node;
  };

  for (const game of games) {
    const chess = new Chess();
    let node = getOrCreate(chess.fen());
    tallyResult(node, game.result);

    const plies = Math.min(game.moves.length, maxPlies);
    for (let i = 0; i < plies; i++) {
      const san = game.moves[i];
      const move = chess.move(san);
      if (!move) {
        throw new Error(`illegal move "${san}" in game ${game.id ?? '(no id)'} at ply ${i}`);
      }
      const uci = move.from + move.to + (move.promotion || '');
      const childFen = chess.fen();
      const childNode = getOrCreate(childFen);
      // A single parent can only reach a given child via one specific move
      // (different moves from the same position always produce different
      // FENs), so san is a safe, stable key for the children map even
      // though it's not globally unique across positions.
      if (!node.children.has(san)) node.children.set(san, { san, uci, key: childNode.key });
      tallyResult(childNode, game.result);
      node = childNode;
    }
  }

  return nodes;
}

function tallyResult(node, result) {
  node.total++;
  if (result === 'white') node.whiteWins++;
  else if (result === 'black') node.blackWins++;
  else if (result === 'draw') node.draws++;
  else throw new Error(`unknown game result "${result}"`);
}

function sideToMove(fen) {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

// The 95% Wilson score interval lower bound for a proportion — the
// standard fix for "a small sample's raw rate can't be trusted at face
// value against a much larger one." A move with 50 games at 60% wins and a
// move with 72,000 games at 50% wins are NOT equally trustworthy point
// estimates, but the raw win-rate leaf formula this replaced treated them
// as such — which is exactly what let an obscure, barely-tested move (1.h3
// on 50 real games) outrank 1.e4 (72,488 games) in a real end-to-end run.
// Wilson fixes this by reporting the pessimistic end of a confidence
// interval instead of the raw rate: a small sample's interval is wide, so
// its lower bound sits well below its raw rate; a huge sample's interval
// is razor-narrow, so its lower bound sits almost exactly AT its raw rate.
// Ranking by lower bound instead of raw rate is the same technique behind
// "best comment" sorting on Reddit/Stack Overflow and IMDb's weighted
// rating — a handful of lucky results can't outrank a large, consistent
// sample just because their raw average happens to be higher.
// z=1.96 is the conventional 95%-confidence z-score.
function wilsonLowerBound(wins, total, z = 1.96) {
  if (total <= 0) return 0;
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  // Mathematically always >= 0, but floating-point rounding can land a
  // hair below zero for a 0-win sample (center and margin cancel exactly
  // in theory, not quite in float arithmetic) — clamp rather than let a
  // probability print as "-0%".
  return Math.max(0, (center - margin) / denominator);
}

// Draws count as zero for BOTH colors' own-score formulas, independently —
// this is the fix for "a popular drawish line for Black looks fine because
// it also denies White a win": in the black pass a draw is exactly as bad
// as a Black loss, full stop, regardless of what it does to White's score
// in the (separate) white pass. The win count then goes through
// wilsonLowerBound rather than a plain division, so a leaf's score is
// confidence-adjusted from the moment it's computed — everything built on
// top of leafScore (minimax propagation, forward selection) inherits that
// same skepticism toward small samples automatically, at every depth, not
// just at the positions this function is called on directly.
function leafScore(node, color) {
  const wins = color === 'white' ? node.whiteWins : node.blackWins;
  return wilsonLowerBound(wins, node.total);
}

/**
 * Backward minimax scoring pass for ONE color's repertoire (spec step 7).
 * Run this twice — once with color:'white', once with color:'black' — to
 * get both independent scoring axes; nothing about the input graph needs
 * to change between runs, only which side is doing the maximizing.
 *
 * A node with no qualifying (>= minGames) child is a leaf for scoring
 * purposes: its score is the direct win-rate from its own accumulated
 * tally (which already includes games that continued into sub-threshold
 * territory — see buildPositionGraph's doc). A node with at least one
 * qualifying child takes the argmax/argmin of its qualifying children's
 * scores, argmax when `color` is to move there, argmin when the opponent
 * is — non-qualifying children never participate in that comparison at
 * all, per spec step 3.
 *
 * Implemented as memoized recursion rather than a strict "depth layer"
 * sweep: a chess position isn't guaranteed to be reached at the same ply
 * count via every path that transposes into it (a "waste move" detour can
 * reach the same position one or more plies later), so there's no single
 * well-defined depth to layer by in general. Memoized recursion scores
 * every node strictly after all of its own qualifying children, which is
 * what the layered sweep is actually trying to guarantee, without needing
 * depth to be well-defined at all. Genuine repetition (a move sequence
 * that returns to an earlier exact position) would otherwise make this
 * infinite-recurse; the in-progress guard below breaks that by treating a
 * child still being scored as non-qualifying for this parent, the same
 * way a literal repetition draw already resolves in real play.
 *
 * @param {Map<string, PositionNode>} graph from buildPositionGraph
 * @param {'white'|'black'} color which repertoire this pass is scoring for
 * @param {number} minGames the qualifying-child threshold (spec step 3; 10 in the spec)
 * @returns {Map<string, {score: number, isLeaf: boolean}>} keyed by positionKey
 */
export function scorePass(graph, color, minGames) {
  const scores = new Map();
  const inProgress = new Set();

  function qualifyingChildren(node) {
    const out = [];
    for (const edge of node.children.values()) {
      const child = graph.get(edge.key);
      if (child && child.total >= minGames) out.push({ edge, child });
    }
    return out;
  }

  function score(key) {
    if (scores.has(key)) return scores.get(key).score;
    const node = graph.get(key);
    if (inProgress.has(key)) {
      // A cycle (real in-game repetition transposing back to an ancestor)
      // — treat as if this child simply isn't there yet, rather than
      // recursing forever. This can't happen for ordinary opening lines;
      // it only matters for pathologically deep/looping input.
      return leafScore(node, color);
    }
    inProgress.add(key);

    const qualifying = qualifyingChildren(node);
    let result;
    if (qualifying.length === 0) {
      result = { score: leafScore(node, color), isLeaf: true };
    } else {
      const mover = sideToMove(node.fen);
      const maximizing = mover === color;
      let best = null;
      for (const { child } of qualifying) {
        const s = score(child.key);
        if (best === null || (maximizing ? s > best : s < best)) best = s;
      }
      result = { score: best, isLeaf: false };
    }

    inProgress.delete(key);
    scores.set(key, result);
    return result.score;
  }

  for (const key of graph.keys()) {
    const node = graph.get(key);
    if (node.total >= minGames) score(key);
  }
  return scores;
}

/**
 * Forward repertoire-selection pass (spec step 8) — run only after
 * scorePass has fully finished for this color. Walks forward from the
 * root, branching asymmetrically: at the builder's own decision points,
 * only the single already-scored best move is followed (every other
 * child is simply never visited by this pass); at the opponent's decision
 * points, every qualifying child is followed, since a real repertoire
 * needs a prepared response to whatever the opponent actually plays.
 *
 * @param {Map<string, PositionNode>} graph
 * @param {Map<string, {score:number, isLeaf:boolean}>} scores from scorePass(graph, color, minGames)
 * @param {'white'|'black'} color
 * @param {number} minGames must match what scorePass was called with
 * @param {string} [rootFen] defaults to the standard start position
 * @returns {RepertoireNode} see shape below
 */
export function selectRepertoire(graph, scores, color, minGames, rootFen) {
  const startFen = rootFen || new Chess().fen();
  const rootKey = positionKey(startFen);

  function build(key) {
    const node = graph.get(key);
    const scored = scores.get(key);
    const mover = sideToMove(node.fen);
    const base = {
      fen: node.fen,
      sideToMove: mover,
      total: node.total,
      whiteWins: node.whiteWins,
      draws: node.draws,
      blackWins: node.blackWins,
      score: scored ? scored.score : leafScore(node, color),
      myMove: null,
      replies: null,
    };
    if (!scored || scored.isLeaf) return base; // nothing below the threshold to select into

    const qualifying = [...node.children.values()]
      .map((edge) => ({ edge, child: graph.get(edge.key) }))
      .filter(({ child }) => child && child.total >= minGames);

    if (mover === color) {
      // Builder's own move: follow only the argmax/argmin child already
      // identified by scorePass — recompute which one that was (scorePass
      // only kept the numeric best, not a pointer) by matching the score.
      let best = null;
      for (const { edge, child } of qualifying) {
        const s = scores.get(child.key)?.score ?? leafScore(child, color);
        if (best === null || s > best.s) best = { edge, s };
      }
      if (best) base.myMove = { san: best.edge.san, uci: best.edge.uci, score: best.s, child: build(best.edge.key) };
    } else {
      base.replies = qualifying
        .map(({ edge, child }) => ({
          san: edge.san,
          uci: edge.uci,
          games: child.total,
          share: child.total / node.total,
          child: build(edge.key),
        }))
        .sort((a, b) => b.games - a.games);
    }
    return base;
  }

  return build(rootKey);
}

/*
RepertoireNode shape (returned by selectRepertoire, and recursively as
every .child):
  {
    fen, sideToMove, total, whiteWins, draws, blackWins, score,
    myMove: { san, uci, score, child: RepertoireNode } | null,   // set only at the builder's own decision points that had a qualifying move
    replies: [{ san, uci, games, share, child: RepertoireNode }] | null,  // set only at the opponent's decision points, sorted by games desc
  }
Exactly one of myMove/replies is non-null at any node with a qualifying
child; both are null at a leaf (no qualifying child — the line ends here,
either from a genuine game-ending position or from running out of
>= minGames data).
*/
