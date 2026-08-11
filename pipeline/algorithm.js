// Core scoring/selection algorithm for the empirical repertoire pipeline.
// See chess-repertoire-algorithm-spec.md (design doc) for the full
// rationale — this module implements steps 1, 3, 4, 5, 6, 7, and 8 from
// that spec. It's pure and I/O-free: given already-parsed games, it
// returns scored positions and a materialized per-color repertoire tree.
// Bulk PGN ingestion and FEN extraction from a real Lichess dump are a
// separate concern (see ingest.js). buildPositionGraph() below only gives a
// position a real graph node of its own once that position has accumulated
// >= minGames games (lazy hot-branch expansion, spec steps 5-6) — a
// position that never gathers enough games never gets one.
// That's the actual saving at real multi-GB scale: the returned graph
// stays roughly the size of the qualifying repertoire rather than the size
// of every position any game ever passed through, which is what makes a
// full, unconditional walk balloon into millions of one-off nodes on real
// data. This doesn't change what gets scored: scorePass()/
// selectRepertoire() only ever consult positions with total >= minGames,
// and any such position's tally is identical to what a full, unconditional
// walk would produce, since a position's own tally only depends on which
// games reached exactly that position, never on how far any of them got
// walked past it (spec step 3). See buildPositionGraph's own doc comment
// for the precise invariant, the two-phase mechanism that achieves it, and
// its runtime cost trade-off (memory is the thing this saves — walltime
// savings are real but more modest, and that's an intentional trade given
// this pipeline runs unattended, not interactively).
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
import { wilsonLowerBound } from '../js/chessUtil.js';

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
 * Builds the position graph via lazy hot-branch expansion (spec steps 5-6):
 * a game is only walked past a position once that position has accumulated
 * >= minGames total across ALL games seen so far — a genuinely cold/unique
 * continuation (the overwhelming majority of any deep chess game) never
 * gets walked into at all, which is the whole cost saving. A game parked
 * at a cold position C is resumed the moment any of the following happens:
 * C itself later accumulates enough direct traffic to go hot; some later
 * position D further along THIS SAME game's own remaining move sequence
 * turns out to already be hot (a transposition back into well-trodden
 * territory, even though C itself never gets there); or D goes hot only
 * once combined with this game's own pending contribution — several
 * individually-cold move orders whose games are all separately waiting on
 * the same eventual D, where none of them alone reaches minGames but their
 * SUM does (spec step 6's actual real-world shape: a branch can go
 * hot -> cold -> hot again via transposition, and the "hot again" can be
 * many plies later and only reachable by merging several thin, sub-
 * threshold paths, not just one already-strong one). Catching that last
 * case requires checking a parked game against its ENTIRE remaining move
 * sequence, not just its very next move, since real transpositions can
 * reorder moves many plies apart — see the two-phase implementation note
 * below for how that's kept affordable. Merges by positionKey() throughout,
 * so transpositions combine into one node regardless of how many move
 * orders reached it.
 *
 * Implemented in two phases so the expensive part (registering a parked
 * game's ENTIRE remaining move sequence, spec step 6's multi-way-merge
 * case) is only paid by games that actually need it, not by every park
 * event: phase 1 walks all games once, parking each cold game under just
 * its current position (cheap — O(1) per park) and resolving anything that
 * unblocks directly; phase 2 (reconcileTranspositions) then takes whatever
 * phase 1 left stuck and, ONLY for those, does the full remaining-path
 * registration described above, looping since resolving one game can
 * un-stick it only as far as its next cold ancestor, parking it again
 * fresh. In practice most of a real dataset's parked games never resolve
 * at all (a deep, one-off middlegame position simply never gathers
 * minGames games) and so end up walked once by phase 2's dry run anyway —
 * this still saves the FULL cost a naive full walk would pay (real node
 * creation, edge bookkeeping, and re-walking the SAME cold subtree from
 * every transposing game that reaches it) for a one-time position-only
 * scan, which is where the actual win is: the returned graph's memory
 * footprint stays near the size of the qualifying repertoire, not the
 * size of everything any game ever played through.
 *
 * Invariant: for any position that ends up with total >= minGames — the
 * only positions scorePass()/selectRepertoire() ever look at — its tally
 * (total, whiteWins, draws, blackWins) and its children are IDENTICAL to
 * what a full, unconditional walk of every game would produce. Why: a
 * position's own tally only ever depends on which games reached exactly
 * that position, never on how deep any of them got walked past it (spec
 * step 3) — parking a game just defers recording its DEEPER positions, it
 * never skips or double-counts the position it's parked at, and every
 * parked game remains reachable (see above) for as long as any position on
 * its remaining path could still go hot. Positions that never cross
 * minGames may or may not end up materialized in the returned graph — this
 * is harmless either way, since nothing downstream ever consults a
 * below-threshold position.
 *
 * Callers must pass the SAME minGames to buildPositionGraph as they later
 * pass to scorePass/selectRepertoire — a lower minGames here than there
 * would mean some positions those passes want to treat as qualifying
 * never got walked into and simply won't be in the graph at all.
 *
 * @param {Array<{id: string, result: 'white'|'black'|'draw', moves: string[]}>} games
 *   moves are SAN strings, applied in order from the standard start position.
 * @param {{maxPlies?: number, minGames?: number}} [opts]
 *   maxPlies caps how deep any single game is walked (matching the app's
 *   own maxPlies concept) — games shorter than this are walked to their
 *   actual end; this only trims games that run long, so no position is
 *   ever double-counted or under-counted for a game that simply ended
 *   first. minGames (default 10, matching the spec's qualifying
 *   threshold) is the hotness bar a position must clear before any game is
 *   walked past it.
 * @returns {Map<string, PositionNode>} keyed by positionKey(fen), where
 *   PositionNode = { fen, key, total, whiteWins, draws, blackWins,
 *   children: Map<san, {san, uci, key, games}> } — edge.games is how many
 *   games took THIS specific edge from THIS specific parent, which is NOT
 *   the same thing as the child node's own .total (a transposition can
 *   make .total larger, since it also counts games that reached the same
 *   position via a different parent entirely)
 */
export function buildPositionGraph(games, opts = {}) {
  const builder = createGraphBuilder(opts);
  for (const game of games) builder.feedGame(game);
  return builder.finish();
}

/**
 * Async twin of buildPositionGraph, for a games source that can only be
 * consumed incrementally (a streaming PGN parser reading a multi-GB dump
 * that must never be fully buffered in memory — see ingest.js's
 * parsePgnGamesStream). Shares the exact same builder/scoring semantics;
 * the only difference is `games` may be an async iterable (anything usable
 * with `for await`), not just a plain array.
 *
 * @param {AsyncIterable<{id: string, result: 'white'|'black'|'draw', moves: string[]}>|Array} games
 * @param {{maxPlies?: number, minGames?: number, initialNodes?: Map<string, PositionNode>, initialPending?: object}} [opts]
 *   initialNodes/initialPending resume from a prior checkpoint's confirmed
 *   graph and in-flight parked games respectively — see
 *   createGraphBuilder's getPendingSnapshot() for the pending format and
 *   what a resume does and doesn't preserve.
 * @returns {Promise<Map<string, PositionNode>>}
 */
export async function buildPositionGraphAsync(games, opts = {}) {
  const builder = createGraphBuilder(opts);
  for await (const game of games) builder.feedGame(game);
  return builder.finish();
}

/**
 * The shared engine behind both buildPositionGraph and
 * buildPositionGraphAsync — see buildPositionGraph's own doc comment above
 * for the full design rationale (lazy hot-branch expansion, the two-phase
 * cheap/expensive split, the work queue, the invariant). Takes games one
 * at a time via feedGame() so the caller controls whether the source is a
 * plain array (consumed with a sync for-loop) or an async stream (consumed
 * with for-await) without duplicating any of this logic.
 *
 * Exported (unlike a typical internal helper) so a long-running ingestion
 * process can drive its own feed loop directly — feedGame() some games,
 * call finish() to checkpoint a scoreable snapshot (and getPendingSnapshot()
 * for a full, zero-loss checkpoint that also captures in-flight parked
 * games), then keep feeding more into the SAME builder and finish() again
 * later. Safe to call finish() multiple times over a builder's life:
 * reconcileTranspositions() only does new work for records parked since
 * the last call (each record's expensive chain registration only ever
 * happens once, guarded by its own chainRegistered flag), so periodic
 * finish() calls don't redundantly re-pay earlier calls' cost. See
 * pipeline/chunked-ingest.mjs.
 *
 * @param {{maxPlies?: number, minGames?: number, initialNodes?: Map<string, PositionNode>, initialPending?: object}} opts
 * @returns {{feedGame: (game: {id:string,result:string,moves:string[]}) => void, finish: () => Map<string, PositionNode>, getPendingSnapshot: () => object}}
 */
export function createGraphBuilder(opts) {
  const maxPlies = Number.isFinite(opts.maxPlies) ? opts.maxPlies : Infinity;
  const minGames = Number.isFinite(opts.minGames) ? opts.minGames : 10;
  // Seeding from a prior checkpoint's nodes resumes accumulating into an
  // already-confirmed graph rather than starting over -- see
  // pipeline/chunked-ingest.mjs.
  const nodes = opts.initialNodes instanceof Map ? opts.initialNodes : new Map();
  // A game parked at a cold position is indexed two ways, since either
  // event can be the one that eventually unblocks it:
  //  - pendingByFrom[C]: the position the game is currently SITTING at (C)
  //    might itself accumulate enough games directly to go hot on its own
  //    (cheap, checked for every park — see park() below).
  //  - pendingByTarget[D]: any position D further along the game's own
  //    remaining move sequence might independently go hot via a totally
  //    different move order transposing into it, even though C itself
  //    never does (spec step 6's actual scenario). Populating this is the
  //    expensive part, so it's deferred to reconcileTranspositions() and
  //    only paid by records the cheap pendingByFrom path leaves stuck —
  //    see registerChain() below.
  // Both index the same record objects; `consumed` deduplicates a record
  // that could otherwise be drained twice if both of its triggers fire.
  // Every record gets a stable numeric id (see park() below) precisely so
  // a checkpoint (getPendingSnapshot()) can serialize pendingByFrom and
  // pendingByTarget as id references into one shared records list and
  // reconstruct the SAME shared object on reload (see opts.initialPending
  // below) — without that, a record consumed via one index after reload
  // wouldn't be recognized as already-consumed via the other, and could
  // be resolved (and counted) a second time.
  const pendingByFrom = new Map();
  const pendingByTarget = new Map();
  let nextRecordId = 0;

  // Seeding from a prior checkpoint's pending snapshot (see
  // getPendingSnapshot() below) restores in-flight parked games exactly as
  // they were, instead of silently dropping them — reconstructing each
  // record ONCE and pointing both indices at the SAME object is what keeps
  // `consumed` meaningful across the resume (see the comment above
  // pendingByFrom for why that matters).
  if (opts.initialPending) {
    const recordsById = new Map();
    for (const r of opts.initialPending.records) {
      recordsById.set(r.id, { id: r.id, game: r.game, plyIndex: r.plyIndex, fen: r.fen, consumed: r.consumed, chainRegistered: r.chainRegistered });
    }
    for (const [key, ids] of opts.initialPending.pendingByFrom) {
      pendingByFrom.set(key, ids.map((id) => recordsById.get(id)));
    }
    for (const [key, ids] of opts.initialPending.pendingByTarget) {
      pendingByTarget.set(key, ids.map((id) => recordsById.get(id)));
    }
    nextRecordId = opts.initialPending.nextRecordId;
  }
  // Cascading resolutions (one hot-crossing unblocking games that themselves
  // trigger more crossings) are processed breadth-first through this queue
  // rather than by direct recursive calls — a densely-transposed real
  // dataset can chain thousands of these together, which blew the call
  // stack (RangeError) when drainHot/fastForwardTo/advance called each
  // other directly. `head` avoids O(n) Array#shift() on a queue that can
  // grow into the millions.
  const queue = [];
  let queueHead = 0;
  function enqueueAdvance(game, fen, plyIndex) {
    queue.push({ kind: 'advance', game, fen, plyIndex });
  }
  function enqueueFastForward(record, targetKey) {
    queue.push({ kind: 'fastForward', record, targetKey });
  }
  function drainQueue() {
    while (queueHead < queue.length) {
      const item = queue[queueHead++];
      if (item.kind === 'advance') {
        advance(item.game, new Chess(item.fen), item.plyIndex);
      } else {
        runFastForward(item.record, item.targetKey);
      }
    }
    queue.length = 0;
    queueHead = 0;
  }

  const getOrCreate = (fen) => {
    const key = positionKey(fen);
    let node = nodes.get(key);
    if (!node) {
      node = { fen, key, total: 0, whiteWins: 0, draws: 0, blackWins: 0, children: new Map() };
      nodes.set(key, node);
    }
    return node;
  };

  function addPending(map, key, record) {
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(record);
  }

  // Plays game.moves[plyIndex] from chess's current position (assumed
  // legal — every ply that reaches here has either passed the hotness gate
  // or been explicitly proven safe to force through via transposition),
  // tallies the resulting position, records the edge, and — if this tally
  // is what pushes the resulting position over minGames for the first time
  // — drains anything waiting on it. Returns the resulting node.
  function applyOneMove(game, chess, plyIndex) {
    const fromNode = getOrCreate(chess.fen());
    const san = game.moves[plyIndex];
    const move = chess.move(san);
    if (!move) {
      throw new Error(`illegal move "${san}" in game ${game.id ?? '(no id)'} at ply ${plyIndex}`);
    }
    const uci = move.from + move.to + (move.promotion || '');
    const toNode = getOrCreate(chess.fen());
    // A single parent can only reach a given child via one specific move
    // (different moves from the same position always produce different
    // FENs), so san is a safe, stable key for the children map even
    // though it's not globally unique across positions. edge.games counts
    // EVERY game that actually took this specific edge from THIS parent —
    // deliberately separate from toNode.total, which (via transposition
    // merging) can include games that reached the same position from a
    // totally different parent. Conflating the two is exactly what caused
    // a real displayed-frequency bug (a move's "share" computed as
    // toNode.total / fromNode.total came out over 100%, because toNode's
    // total included traffic from other parents entirely). `|| 0` guards
    // against resuming a checkpoint written before this field existed —
    // an edge missing .games entirely, not just at 0.
    let edge = fromNode.children.get(san);
    if (!edge) { edge = { san, uci, key: toNode.key, games: 0 }; fromNode.children.set(san, edge); }
    edge.games = (edge.games || 0) + 1;
    tallyResult(toNode, game.result);
    maybeResolve(toNode.key);
    return toNode;
  }

  // Advances one game from plyIndex onward (chess already replayed to that
  // point), stopping the moment it reaches a position that isn't hot
  // enough yet to justify walking past — except at the very first ply,
  // which always proceeds regardless of the start position's own count,
  // since nothing would ever get seeded otherwise.
  function advance(game, chess, plyIndex) {
    const plies = Math.min(game.moves.length, maxPlies);
    for (; plyIndex < plies; plyIndex++) {
      const fromNode = getOrCreate(chess.fen());
      if (plyIndex > 0 && fromNode.total < minGames) {
        park(game, plyIndex, chess.fen());
        return;
      }
      applyOneMove(game, chess, plyIndex);
    }
  }

  // Parks a game at a cold position C, indexed only under C for now
  // (pendingByFrom — C might itself accumulate enough direct traffic to go
  // hot, the common case, resolved cheaply). The more expensive
  // transposition-chain registration (see registerChain below) is deferred
  // to reconcileTranspositions(), run once after the main pass, so its cost
  // is paid only by the games that actually need it instead of by every
  // single park event.
  function park(game, plyIndex, fen) {
    const record = { id: nextRecordId++, game, plyIndex, fen, consumed: false, chainRegistered: false };
    addPending(pendingByFrom, positionKey(fen), record);
  }

  // The expensive fallback: registers a parked record under EVERY position
  // its remaining move sequence would still pass through (pendingByTarget
  // for each), not just the immediate next one. A single ply of lookahead
  // isn't enough: real transpositions can reorder moves many plies apart
  // (e.g. ...e6 played on move 1 vs move 4), so a game can be blocked at an
  // early, genuinely sparse ancestor while a MUCH later position on its own
  // path is a well-trodden transposition hub — that later position going
  // hot (via however many other move orders feed it) must still be able to
  // reach back and unblock this game. Only called from
  // reconcileTranspositions() for records the cheap pendingByFrom path
  // didn't resolve — most parked games never need this at all.
  function registerChain(record) {
    record.chainRegistered = true;
    const startKey = positionKey(record.fen);
    const probe = new Chess(record.fen);
    const plies = Math.min(record.game.moves.length, maxPlies);
    for (let i = record.plyIndex; i < plies; i++) {
      const move = probe.move(record.game.moves[i]);
      if (!move) break; // illegal -- advance()/runFastForward() will surface the real error if this game is ever actually resumed
      const key = positionKey(probe.fen());
      // A genuine in-game repetition can bring this exact game back to
      // its OWN currently-parked position later in its own move sequence
      // — registering that recurrence as one of this record's targets
      // would be self-referential: "resolving" it is a zero-ply fast
      // forward back to exactly where it already sits, so it never
      // actually tallies anything, yet looks like real progress to
      // maybeResolve's confirmed+pending prediction. That false signal
      // reliably produced an infinite park/resolve/re-park cycle on real
      // data (a repeating line pooling with itself). Skip it; the chain
      // still registers every OTHER, genuinely later position.
      if (key === startKey) continue;
      addPending(pendingByTarget, key, record);
      if (record.consumed) break; // resolved via an earlier (shallower) key in this same loop
      maybeResolve(key);
    }
  }

  // Runs after the main pass: repeatedly finds parked records that the
  // cheap path never resolved and never had their transposition chain
  // registered, registers them, and drains whatever that unblocks —
  // which can itself park NEW records (a partially-resolved game running
  // into a fresh cold ancestor further down its own path), so this loops
  // until a full round registers nothing new.
  function reconcileTranspositions() {
    let more = true;
    let round = 0;
    // Each round can only set `more` by chain-registering a record for the
    // FIRST time (chainRegistered is never unset), and every record is
    // created by exactly one park() call, so the number of rounds needed
    // is bounded by how many times games can collectively be parked — this
    // cap is a generous multiple of that, purely a defensive fail-loudly
    // guard against a future correctness bug reintroducing a non-
    // terminating cycle (one already did, in development, on real data:
    // real in-game repetition let a record look like it was resolving
    // toward its own currently-parked position, which is zero progress —
    // see registerChain's startKey guard) rather than hanging an
    // unattended, possibly overnight batch run. Bounded by gameCount (games
    // actually fed so far via feedGame), not games.length -- a streaming
    // source has no length to consult upfront.
    const maxRounds = gameCount * 4 + 1000;
    while (more) {
      if (++round > maxRounds) {
        throw new Error(`reconcileTranspositions did not converge after ${maxRounds} rounds -- likely a non-terminating resolution cycle (see the comment above this check)`);
      }
      more = false;
      for (const list of pendingByFrom.values()) {
        for (const record of list) {
          if (!record.consumed && !record.chainRegistered) {
            registerChain(record);
            more = true;
          }
        }
      }
      drainQueue();
    }
  }

  // Replays record.game from record.fen/record.plyIndex forward until it
  // reaches targetKey (proven reachable — this key was registered from an
  // actual dry-run replay of this exact game in park() above), tallying
  // every intermediate position along the way exactly as a full walk
  // would, then enqueues normal gated advancement from there (rather than
  // continuing directly — see the queue comment above).
  function runFastForward(record, targetKey) {
    const chess = new Chess(record.fen);
    let ply = record.plyIndex;
    while (positionKey(chess.fen()) !== targetKey) {
      applyOneMove(record.game, chess, ply);
      ply++;
    }
    enqueueAdvance(record.game, chess.fen(), ply);
  }

  // The single trigger point for "does this position now qualify to be
  // walked past": true either because its own confirmed tally alone
  // clears minGames, or because confirmed + still-unconsumed pending
  // arrivals via transposition (pendingByTarget) would clear it once
  // resolved — the latter is what makes a merge-only crossing (spec step
  // 6: several individually-cold move orders whose COMBINED total is what
  // actually clears the threshold) actually happen, rather than deadlocking
  // forever waiting for any single path to reach minGames on its own.
  // Safe to call repeatedly/redundantly for the same key — resolving is
  // idempotent once nothing is left pending.
  function maybeResolve(key) {
    const confirmed = nodes.get(key)?.total ?? 0;
    if (confirmed < minGames) {
      const pendingCount = (pendingByTarget.get(key) || []).filter((r) => !r.consumed).length;
      if (confirmed + pendingCount < minGames) return;
    }
    drainHot(key);
  }

  function drainHot(key) {
    // Target-side first: applying these is what actually raises this
    // position's confirmed total, so anything waiting on the FROM side
    // (below) sees the real, fully-updated total on its first attempt
    // instead of re-parking and waiting for a second trigger.
    const targetList = pendingByTarget.get(key);
    if (targetList) {
      pendingByTarget.delete(key);
      for (const record of targetList) {
        if (record.consumed) continue;
        record.consumed = true;
        // C (record.fen's position) — and everything between it and `key`
        // — may still be cold; force this game's deferred moves through
        // anyway, since its path to `key` is already proven, then resume
        // normal gated advancement after.
        enqueueFastForward(record, key);
      }
    }
    const fromList = pendingByFrom.get(key);
    if (fromList) {
      pendingByFrom.delete(key); // once hot, always hot -- this key can't be re-queued into
      for (const record of fromList) {
        if (record.consumed) continue;
        record.consumed = true;
        enqueueAdvance(record.game, record.fen, record.plyIndex);
      }
    }
  }

  let gameCount = 0;

  function feedGame(game) {
    gameCount++;
    const chess = new Chess();
    tallyResult(getOrCreate(chess.fen()), game.result); // the root is always tallied, unconditionally, same as every position
    advance(game, chess, 0);
    drainQueue(); // resolve any cascades this game triggered before starting the next -- keeps the queue bounded across millions of games rather than growing unboundedly until the very end
  }

  function finish() {
    reconcileTranspositions(); // the expensive multi-way-merge pass, only for whatever the cheap pass above left stuck
    return nodes;
  }

  // A JSON-serializable snapshot of every still-parked, unresolved game --
  // pass it back in as opts.initialPending on a fresh builder to resume
  // with zero games lost, instead of silently dropping in-flight state.
  // Call only after finish() (so the work queue is guaranteed drained --
  // finish() always leaves it empty) for a consistent, complete snapshot.
  function getPendingSnapshot() {
    const recordsById = new Map();
    function collect(map) {
      for (const list of map.values()) {
        for (const record of list) {
          if (!record.consumed) recordsById.set(record.id, record);
        }
      }
    }
    collect(pendingByFrom);
    collect(pendingByTarget);
    const records = [...recordsById.values()].map((r) => ({ id: r.id, game: r.game, plyIndex: r.plyIndex, fen: r.fen, consumed: r.consumed, chainRegistered: r.chainRegistered }));
    const toIdList = (map) =>
      [...map.entries()]
        .map(([key, list]) => [key, list.filter((r) => !r.consumed).map((r) => r.id)])
        .filter(([, ids]) => ids.length > 0);
    return {
      records,
      pendingByFrom: toIdList(pendingByFrom),
      pendingByTarget: toIdList(pendingByTarget),
      nextRecordId,
    };
  }

  return { feedGame, finish, getPendingSnapshot };
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
      alternates: null, // set only alongside myMove — see below
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
      const scored = qualifying.map(({ edge, child }) => ({ edge, child, s: scores.get(child.key)?.score ?? leafScore(child, color) }));
      for (const c of scored) {
        if (best === null || c.s > best.s) best = c;
      }
      if (best) {
        base.myMove = { san: best.edge.san, uci: best.edge.uci, score: best.s, child: build(best.edge.key) };
        // Other qualifying candidates at this same decision point, not
        // themselves recursed into (this pass only ever follows the single
        // best one) — kept here purely for Browse/UI reference, the same
        // role explorer.js's live-API alternates play.
        //
        // A prior version of this also attached a fully recursed `child`
        // to every alternate, matching how a qualifying opponent reply
        // already works below, specifically so Browse could follow a
        // non-chosen move down to its real leaf. In practice that
        // serialized nearly the entire qualifying graph as a tree (a
        // popular, deep-branching alternate like 1.e4 pulls in thousands
        // of nodes) — real production data hit ~105MB per color, over
        // GitHub's 100MB per-file limit, which broke every push until
        // reverted here. Revisit this as a properly bounded feature (a
        // depth/size cap, or fetching a non-repertoire branch's subtree
        // lazily on demand) rather than unconditional full recursion.
        base.alternates = scored
          .filter((c) => c !== best)
          .map((c) => ({ san: c.edge.san, uci: c.edge.uci, score: c.s, games: c.child.total }))
          .sort((a, b) => b.score - a.score);
      }
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

// Walks forward from `startKey` via the SAME minimax rule scorePass used to
// produce `scores` — argmax at `color`'s own decision points, argmin at the
// opponent's (their best defense, "not letting me win, even if that simply
// means drawing") — until reaching an actual leaf (no qualifying child),
// and returns that leaf's raw tally. This is deliberately NOT the same
// thing as a node's own immediate tally: a candidate move's real strength
// is determined by how the game continues under best play from both
// sides, not by averaging over every game that ever reached the resulting
// position (the overwhelming majority of which involve a mistake
// somewhere further down, on one side or the other, that scorePass's own
// minimax has already effectively discounted). Concretely: after 1.e4 f6
// (a bad reply), White's forced-mate-in-a-few continuation crushes it —
// but the raw tally of "every game that ever reached 1.e4 f6" is
// dominated by amateur games that never found that continuation, showing
// a deceptively modest win rate. The leaf this function resolves to is
// the SAME leaf whose tally already determines the position's propagated
// .score (scorePass and this function share the exact tie-break rule —
// first-encountered wins strict >/< — so they can never disagree about
// which child is "best"); this just also exposes that leaf's raw
// win/draw/loss breakdown, not only the Wilson-adjusted number. `memo` is
// shared across an entire selectRepertoireGraph call so a leaf reachable
// from many different starting positions is only walked to once.
// inProgress mirrors scorePass's own cycle guard (see its doc comment) --
// necessary here too, and for the same underlying reason (real in-game
// repetition), but NOT redundant with scorePass already having safely
// terminated: scorePass's inProgress protection is scoped to each node's
// OWN scoring call and cleared once that node's score is finalized, so
// two nodes can still end up with final scores that point back at each
// other as "best child" (whichever one scorePass happened to resolve
// first treats the other as a leaf for that one call, but the other's
// own later, independent scoring pass can still pick the first as ITS
// best move). Greedily walking "best child" repeatedly, as this function
// does, can then cycle between them forever -- reproduced in practice
// against the real July 2026 dataset (a RangeError stack overflow at
// ~1000 frames, all in this function). Default parameter (rather than a
// required one) so every external call gets its own fresh set, while a
// recursive call correctly threads the same one along its current chain.
function resolveLeafTally(graph, scores, minGames, color, startKey, memo, inProgress = new Set()) {
  if (memo.has(startKey)) return memo.get(startKey);
  const node = graph.get(startKey);
  if (inProgress.has(startKey)) {
    // Cycle -- deliberately NOT memoized (unlike every other return below):
    // this is a stand-in for THIS caller's sake only, not this key's real
    // resolution. A later, non-cyclic call reaching the same key fresh
    // (from outside the cycle, memo still empty for it) must still get its
    // actual answer, not this fallback permanently cached over it.
    return { total: node.total, whiteWins: node.whiteWins, draws: node.draws, blackWins: node.blackWins };
  }
  const scored = scores.get(startKey);
  let result;
  if (!scored || scored.isLeaf) {
    result = { total: node.total, whiteWins: node.whiteWins, draws: node.draws, blackWins: node.blackWins };
  } else {
    inProgress.add(startKey);
    const mover = sideToMove(node.fen);
    const maximizing = mover === color;
    let best = null;
    for (const edge of node.children.values()) {
      const child = graph.get(edge.key);
      if (!child || child.total < minGames) continue;
      const s = scores.get(child.key)?.score ?? leafScore(child, color);
      if (best === null || (maximizing ? s > best.s : s < best.s)) best = { edge, s };
    }
    result = best
      ? resolveLeafTally(graph, scores, minGames, color, best.edge.key, memo, inProgress)
      : { total: node.total, whiteWins: node.whiteWins, draws: node.draws, blackWins: node.blackWins };
    inProgress.delete(startKey);
  }
  memo.set(startKey, result);
  return result;
}

/**
 * Same forward selection as selectRepertoire (spec step 8: one followed
 * move at the builder's own decision points, every qualifying reply at the
 * opponent's), but returns a FLAT, deduplicated graph instead of a nested
 * tree — every qualifying position reachable from root gets exactly one
 * entry, referenced by key from wherever it's reachable, rather than a
 * fresh embedded copy per path that reaches it.
 *
 * This is what makes it safe to also include a full subtree for every
 * qualifying alternate at the builder's own decision points (not just the
 * followed best move) — selectRepertoire tried that once as a nested tree
 * and it blew real output past GitHub's 100MB file limit, because a
 * popular, deep-branching alternate's descendants get duplicated once per
 * distinct path that reaches them (compounding badly once every own-move
 * alternate ALSO recurses, not just the single followed line). Keying by
 * position and visiting each key at most once caps total output size at
 * the number of unique qualifying positions reachable from root — the
 * same order of magnitude as the graph itself — regardless of branching
 * or transpositions, while still letting Browse follow ANY qualifying
 * move, not just the repertoire's own pick, all the way to a real leaf.
 *
 * @param {Map<string, PositionNode>} graph
 * @param {Map<string, {score:number, isLeaf:boolean}>} scores from scorePass(graph, color, minGames)
 * @param {'white'|'black'} color
 * @param {number} minGames must match what scorePass was called with
 * @param {string} [rootFen] defaults to the standard start position
 * @returns {{rootKey: string, nodes: Object<string, FlatRepertoireNode>}} see shape below
 */
export function selectRepertoireGraph(graph, scores, color, minGames, rootFen) {
  const startFen = rootFen || new Chess().fen();
  const rootKey = positionKey(startFen);
  const nodes = {};
  const leafMemo = new Map(); // shared across the whole call -- see resolveLeafTally
  // Breadth-first over KEYS, not paths -- `queued` guards both the initial
  // enqueue and re-enqueue, so a position reachable via many transposing
  // move orders (only more likely now that own alternates branch too) is
  // still visited, and its qualifying children discovered, exactly once.
  const queue = [rootKey];
  let queueHead = 0;
  const queued = new Set([rootKey]);

  while (queueHead < queue.length) {
    const key = queue[queueHead++];
    const node = graph.get(key);
    const scored = scores.get(key);
    const mover = sideToMove(node.fen);
    const leafTally = resolveLeafTally(graph, scores, minGames, color, key, leafMemo);
    const flat = {
      fen: node.fen,
      sideToMove: mover,
      total: node.total,
      whiteWins: node.whiteWins,
      draws: node.draws,
      blackWins: node.blackWins,
      score: scored ? scored.score : leafScore(node, color),
      // The tally of the leaf reached by continued optimal play from here
      // (see resolveLeafTally) -- what Browse's win/draw/loss columns
      // actually display for a move landing on this node, since node's OWN
      // total/whiteWins/draws/blackWins above mixes in every game that
      // ever reached this exact position, most of which diverge from
      // optimal play somewhere further down.
      leafTotal: leafTally.total,
      leafWhiteWins: leafTally.whiteWins,
      leafDraws: leafTally.draws,
      leafBlackWins: leafTally.blackWins,
      myMove: null,
      alternates: null,
      replies: null,
    };
    nodes[key] = flat;
    if (!scored || scored.isLeaf) continue; // nothing below the threshold to select into

    const qualifying = [...node.children.values()]
      .map((edge) => ({ edge, child: graph.get(edge.key) }))
      .filter(({ child }) => child && child.total >= minGames);

    if (mover === color) {
      let best = null;
      const scoredCands = qualifying.map(({ edge, child }) => ({ edge, child, s: scores.get(child.key)?.score ?? leafScore(child, color) }));
      for (const c of scoredCands) {
        if (best === null || c.s > best.s) best = c;
      }
      if (best) {
        // games is the EDGE's own count (see applyOneMove's doc comment) --
        // how many games actually played this move from THIS position, not
        // the child's own .total, which a transposition can inflate with
        // games that reached the same position from somewhere else
        // entirely (the real cause of a move's displayed frequency once
        // coming out over 100%).
        flat.myMove = { san: best.edge.san, uci: best.edge.uci, score: best.s, games: best.edge.games, childKey: best.edge.key };
        flat.alternates = scoredCands
          .filter((c) => c !== best)
          .map((c) => ({ san: c.edge.san, uci: c.edge.uci, score: c.s, games: c.edge.games, childKey: c.edge.key }))
          .sort((a, b) => b.score - a.score);
        for (const c of scoredCands) {
          if (!queued.has(c.edge.key)) { queued.add(c.edge.key); queue.push(c.edge.key); }
        }
      }
    } else {
      flat.replies = qualifying
        .map(({ edge, child }) => ({ san: edge.san, uci: edge.uci, games: edge.games, share: edge.games / node.total, childKey: edge.key }))
        .sort((a, b) => b.games - a.games);
      for (const { edge } of qualifying) {
        if (!queued.has(edge.key)) { queued.add(edge.key); queue.push(edge.key); }
      }
    }
  }

  return { rootKey, nodes };
}

/*
FlatRepertoireNode shape (returned by selectRepertoireGraph, as each value
in .nodes):
  {
    fen, sideToMove, total, whiteWins, draws, blackWins, score,
    leafTotal, leafWhiteWins, leafDraws, leafBlackWins,  // the tally of the leaf reached by continued optimal play from THIS node (see resolveLeafTally) -- what a move landing here should show as its win/draw/loss breakdown, NOT total/whiteWins/draws/blackWins above (which mixes in every game that ever reached this exact position, however it was actually played out from here)
    myMove: { san, uci, score, games, childKey } | null,   // set only at the builder's own decision points that had a qualifying move; games is the EDGE's own count (how many games played this move from HERE), not childKey's node's total; childKey indexes .nodes
    alternates: [{ san, uci, score, games, childKey }] | null,   // EVERY other qualifying candidate at that same decision point (not just a reference -- childKey indexes .nodes, so Browse can follow any of them); set only alongside myMove, sorted by score desc
    replies: [{ san, uci, games, share, childKey }] | null,  // set only at the opponent's decision points, sorted by games desc; games/share are also edge-specific, not the child node's own total
  }
Exactly one of myMove/replies is non-null at any node with a qualifying
child; both are null at a leaf. Unlike RepertoireNode below, this is
addressed by key, not nested -- look up nodes[key] rather than following
an embedded object.
*/

/*
RepertoireNode shape (returned by selectRepertoire, and recursively as
every .child):
  {
    fen, sideToMove, total, whiteWins, draws, blackWins, score,
    myMove: { san, uci, score, child: RepertoireNode } | null,   // set only at the builder's own decision points that had a qualifying move
    alternates: [{ san, uci, score, games }] | null,   // other qualifying candidates at that same decision point, not followed further (reference only) -- see the comment above this shape's build() for why this is deliberately NOT a full recursive child; set only alongside myMove, sorted by score desc
    replies: [{ san, uci, games, share, child: RepertoireNode }] | null,  // set only at the opponent's decision points, sorted by games desc
  }
Exactly one of myMove/replies is non-null at any node with a qualifying
child; both are null at a leaf (no qualifying child — the line ends here,
either from a genuine game-ending position or from running out of
>= minGames data).
*/
