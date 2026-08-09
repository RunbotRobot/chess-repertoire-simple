// A second, purpose-built graph-building engine for real, multi-day
// ingestion runs, where holding every still-parked game's full move list
// in memory for the rest of the run is not viable at scale. Deliberately
// separate from algorithm.js's createGraphBuilder (which stays untouched,
// fully synchronous, and fully validated by its own test suite) rather
// than bolted onto it, because the fix here changes the shape of control
// flow enough that sharing the implementation isn't clean: some resumption
// paths now need to await a network fetch before they can proceed.
//
// The problem this solves: measured on the real January 2013 Lichess dump
// (121,332 games), 98.8% of all games end up permanently "parked" --
// stuck at a position that never gathers enough traffic to qualify, which
// is inherent to chess's branching factor, not a bug. algorithm.js's
// engine keeps every one of those games' full move lists alive for the
// rest of the run in case it's ever needed, which is fine at 121K games
// (~1.4GB) but scales linearly with total games processed, not with the
// size of the qualifying repertoire -- at a real month's scale
// (~150-200M games) this would need on the order of 100+GB of RAM.
//
// The fix: a parked record here stores only {gameId, result, plyIndex,
// fen} -- never a move list. Walking a record further (to register its
// remaining transposition chain, or to resume it once something it's
// waiting on goes hot) needs its moves, which aren't held locally, so
// those steps fetch them on demand from Lichess's per-game PGN export API
// (batched: POST /api/games/export/_ids, comma-separated ids, one
// response with many games) rather than never discarding them in the
// first place. This is possible specifically because it's TRUE zero-loss,
// not an approximation: nothing is ever given up on prematurely the way a
// bounded-lookahead heuristic would -- a record just waits, cheaply,
// until it's actually needed.
//
// To keep this tractable, network I/O is confined entirely to the async
// finish() call (invoked periodically -- once per checkpoint in
// pipeline/chunked-ingest.mjs -- not once per game): feedGame() itself
// stays fully synchronous and cheap, exactly mirroring algorithm.js's
// walk/park logic minus any live resolution trigger. finish() then runs
// the same kind of round-based reconciliation as algorithm.js's
// reconcileTranspositions, except each round starts by batch-fetching
// every record that needs its transposition chain registered, and ends by
// draining a work queue that batch-fetches whatever ELSE turns out to be
// needed as cascading resolutions unfold (an older, already-registered
// record whose own position just went hot needs fetching too, discovered
// only once the cascade reaches it). Deferring ALL resolution to finish()
// doesn't change the final result versus resolving live during feedGame()
// (see algorithm.js's createGraphBuilder doc on finish() being safe to
// call repeatedly / idempotent) -- it only changes when the work happens,
// batching it usefully instead of firing one fetch per game.
//
// The three previously-hard-won correctness properties are preserved
// unchanged: multi-way combined-threshold crossing (spec step 6: several
// individually-cold move orders whose SUM clears minGames, not just one
// already-strong one), the repetition self-reference guard (a game's own
// future path looping back to its currently-parked position must not look
// like resolution progress -- see registerChain's startKey check), and
// stack-safety via an explicit work queue rather than recursive calls.
import { Chess } from '../js/vendor/chess.esm.js';
import { positionKey } from './algorithm.js';

function tallyResult(node, result) {
  node.total++;
  if (result === 'white') node.whiteWins++;
  else if (result === 'black') node.blackWins++;
  else if (result === 'draw') node.draws++;
  else throw new Error(`unknown game result "${result}"`);
}

/**
 * @param {{maxPlies?: number, minGames?: number, fetchGamesBatch: (gameIds: string[]) => Promise<Map<string,{result:string,moves:string[]}>>, initialNodes?: Map, initialPending?: object, onRound?: (stats:{round:number,toRegister:number,fetched:number,queueLength:number}) => void, onFetch?: (stats:{completed:number,total:number,phase:'register'|'drain'}) => void}} opts
 *   fetchGamesBatch is required -- given a list of Lichess game ids,
 *   resolve every one of them (throwing if any is missing from the
 *   result, rather than silently skipping, so a fetch failure surfaces
 *   loudly instead of quietly losing a game).
 *   onRound/onFetch are both optional, purely-observational progress hooks
 *   into finish() -- a single call can run for a long time on a real
 *   month-scale cold-start backlog, entirely inside network awaits a
 *   caller otherwise has no visibility into.
 * @returns {{feedGame: (game:{id:string,result:string,moves:string[]}) => void, finish: () => Promise<Map>, getPendingSnapshot: () => object}}
 */
export function createStreamingGraphBuilder(opts) {
  const maxPlies = Number.isFinite(opts.maxPlies) ? opts.maxPlies : Infinity;
  const minGames = Number.isFinite(opts.minGames) ? opts.minGames : 10;
  const fetchGamesBatch = opts.fetchGamesBatch;
  if (typeof fetchGamesBatch !== 'function') throw new Error('createStreamingGraphBuilder requires opts.fetchGamesBatch');

  const nodes = opts.initialNodes instanceof Map ? opts.initialNodes : new Map();
  const pendingByFrom = new Map();
  const pendingByTarget = new Map();
  let nextRecordId = 0;
  let gameCount = 0;

  // Restores every still-parked game as a freshly-parked record (chainRegistered:
  // false) rather than replaying its expanded pendingByTarget registration
  // -- see getPendingSnapshot() below for why that registration is
  // deliberately never serialized in the first place. finish() will
  // naturally re-register each of these on its first round after resume;
  // this costs one bounded re-fetch+re-walk per still-pending game
  // (unavoidable -- resuming a record needs its moves regardless), but
  // never needs the checkpoint file itself to hold the registration.
  if (opts.initialPending) {
    for (const r of opts.initialPending.records) {
      const record = { id: r.id, gameId: r.gameId, result: r.result, plyIndex: r.plyIndex, fen: r.fen, consumed: false, chainRegistered: false };
      addPending(pendingByFrom, positionKey(r.fen), record);
    }
    nextRecordId = opts.initialPending.nextRecordId;
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

  // --- Cheap, synchronous, live path (feedGame) -- no resolve triggers, no fetching ---

  function applyOneMoveSimple(gameId, result, moves, chess, plyIndex) {
    const fromNode = getOrCreate(chess.fen());
    const san = moves[plyIndex];
    const move = chess.move(san);
    if (!move) throw new Error(`illegal move "${san}" in game ${gameId} at ply ${plyIndex}`);
    const uci = move.from + move.to + (move.promotion || '');
    const toNode = getOrCreate(chess.fen());
    if (!fromNode.children.has(san)) fromNode.children.set(san, { san, uci, key: toNode.key });
    tallyResult(toNode, result);
    return toNode;
  }

  function park(gameId, result, plyIndex, fen) {
    const record = { id: nextRecordId++, gameId, result, plyIndex, fen, consumed: false, chainRegistered: false };
    addPending(pendingByFrom, positionKey(fen), record);
  }

  function feedGame(game) {
    gameCount++;
    const chess = new Chess();
    tallyResult(getOrCreate(chess.fen()), game.result);
    const plies = Math.min(game.moves.length, maxPlies);
    for (let plyIndex = 0; plyIndex < plies; plyIndex++) {
      const fromNode = getOrCreate(chess.fen());
      if (plyIndex > 0 && fromNode.total < minGames) {
        park(game.id, game.result, plyIndex, chess.fen());
        return;
      }
      applyOneMoveSimple(game.id, game.result, game.moves, chess, plyIndex);
    }
  }

  // --- Reconciliation path (finish) -- resolves cascades, fetches on demand ---

  function applyOneMove(gameId, result, moves, chess, plyIndex) {
    const toNode = applyOneMoveSimple(gameId, result, moves, chess, plyIndex);
    maybeResolve(toNode.key);
    return toNode;
  }

  function advance(gameId, result, moves, chess, plyIndex) {
    const plies = Math.min(moves.length, maxPlies);
    for (; plyIndex < plies; plyIndex++) {
      const fromNode = getOrCreate(chess.fen());
      if (plyIndex > 0 && fromNode.total < minGames) {
        park(gameId, result, plyIndex, chess.fen());
        return;
      }
      applyOneMove(gameId, result, moves, chess, plyIndex);
    }
  }

  function registerChain(record, movesCache) {
    record.chainRegistered = true;
    const { moves } = movesCache.get(record.gameId);
    const startKey = positionKey(record.fen);
    const probe = new Chess(record.fen);
    const plies = Math.min(moves.length, maxPlies);
    for (let i = record.plyIndex; i < plies; i++) {
      const move = probe.move(moves[i]);
      if (!move) break; // illegal -- shouldn't happen against real Lichess data; advance()/runFastForward() would throw if this record is ever actually resumed past here
      const key = positionKey(probe.fen());
      // Self-reference guard: a genuine in-game repetition can bring this
      // exact game back to its OWN currently-parked position later in its
      // own move sequence. Registering that recurrence as a target would
      // be zero-progress (resolving it just fast-forwards back to exactly
      // where it already sits) but would still look like real progress to
      // maybeResolve's confirmed+pending prediction -- see
      // algorithm.js's registerChain for the real infinite loop this
      // caused in development before the guard was added.
      if (key === startKey) continue;
      addPending(pendingByTarget, key, record);
      if (record.consumed) break;
      maybeResolve(key);
    }
  }

  function runFastForward(record, targetKey, movesCache) {
    const { moves } = movesCache.get(record.gameId);
    const chess = new Chess(record.fen);
    let ply = record.plyIndex;
    while (positionKey(chess.fen()) !== targetKey) {
      applyOneMove(record.gameId, record.result, moves, chess, ply);
      ply++;
    }
    enqueueAdvance(record.gameId, record.result, chess.fen(), ply);
  }

  const queue = [];
  let queueHead = 0;
  function enqueueAdvance(gameId, result, fen, plyIndex) {
    queue.push({ kind: 'advance', gameId, result, fen, plyIndex });
  }
  function enqueueFastForward(record, targetKey) {
    queue.push({ kind: 'fastForward', record, targetKey });
  }

  function maybeResolve(key) {
    const confirmed = nodes.get(key)?.total ?? 0;
    if (confirmed < minGames) {
      const pendingCount = (pendingByTarget.get(key) || []).filter((r) => !r.consumed).length;
      if (confirmed + pendingCount < minGames) return;
    }
    drainHot(key);
  }

  function drainHot(key) {
    const targetList = pendingByTarget.get(key);
    if (targetList) {
      pendingByTarget.delete(key);
      for (const record of targetList) {
        if (record.consumed) continue;
        record.consumed = true;
        enqueueFastForward(record, key);
      }
    }
    const fromList = pendingByFrom.get(key);
    if (fromList) {
      pendingByFrom.delete(key);
      for (const record of fromList) {
        if (record.consumed) continue;
        record.consumed = true;
        enqueueAdvance(record.gameId, record.result, record.fen, record.plyIndex);
      }
    }
  }

  // Drains the work queue against movesCache, batch-fetching whatever
  // turns out to be missing (an older, already-chain-registered record
  // resumed via a fromList trigger has never had its moves fetched this
  // finish() call) rather than failing -- deferring blocked items,
  // fetching everything they're blocked on in one batch, then retrying.
  async function drainQueue(movesCache) {
    while (queueHead < queue.length) {
      const deferred = [];
      while (queueHead < queue.length) {
        const item = queue[queueHead++];
        const gameId = item.kind === 'advance' ? item.gameId : item.record.gameId;
        if (!movesCache.has(gameId)) { deferred.push(item); continue; }
        if (item.kind === 'advance') {
          advance(item.gameId, item.result, movesCache.get(gameId).moves, new Chess(item.fen), item.plyIndex);
        } else {
          runFastForward(item.record, item.targetKey, movesCache);
        }
      }
      if (deferred.length === 0) break;
      const missingIds = [...new Set(deferred.map((item) => (item.kind === 'advance' ? item.gameId : item.record.gameId)))];
      const fetched = await fetchGamesBatch(missingIds, {
        onChunkDone: (p) => opts.onFetch?.({ ...p, phase: 'drain' }),
      });
      for (const id of missingIds) {
        if (!fetched.has(id)) throw new Error(`fetchGamesBatch did not return game ${id} -- cannot resume a record without it`);
        movesCache.set(id, fetched.get(id));
      }
      queue.push(...deferred);
    }
    queue.length = 0;
    queueHead = 0;
  }

  // Runs reconciliation to a fixed point: each round batch-fetches every
  // not-yet-registered record's moves, registers them (which may cascade
  // into resolutions via the queue, itself fetching whatever else that
  // needs), and repeats until a round finds nothing left to register and
  // the queue is empty. Safe to call repeatedly over a builder's life,
  // same as algorithm.js's finish() -- each record's registration only
  // ever happens once (chainRegistered), so periodic calls (once per
  // checkpoint) don't redundantly re-pay earlier calls' cost.
  async function finish() {
    let round = 0;
    const maxRounds = gameCount * 4 + 1000;
    const movesCache = new Map();
    for (;;) {
      if (++round > maxRounds) {
        throw new Error(`streaming reconciliation did not converge after ${maxRounds} rounds -- likely a non-terminating resolution cycle`);
      }
      const needRegistration = [];
      for (const list of pendingByFrom.values()) {
        for (const record of list) {
          if (!record.consumed && !record.chainRegistered) needRegistration.push(record);
        }
      }
      if (needRegistration.length === 0 && queueHead >= queue.length) break;

      let fetchCount = 0;
      if (needRegistration.length > 0) {
        const neededIds = [...new Set(needRegistration.map((r) => r.gameId))].filter((id) => !movesCache.has(id));
        fetchCount = neededIds.length;
        if (neededIds.length > 0) {
          const fetched = await fetchGamesBatch(neededIds, {
            onChunkDone: (p) => opts.onFetch?.({ ...p, phase: 'register' }),
          });
          for (const id of neededIds) {
            if (!fetched.has(id)) throw new Error(`fetchGamesBatch did not return game ${id} -- cannot register its transposition chain without it`);
            movesCache.set(id, fetched.get(id));
          }
        }
        for (const record of needRegistration) {
          if (!record.consumed) registerChain(record, movesCache);
        }
      }
      // Reconciliation on a real month-scale dataset can run long enough
      // (a large one-time backlog on a cold start) that silence here reads
      // indistinguishably from a hang -- this is otherwise the only place
      // in the whole builder that can report "still working, here's how
      // much" while a finish() call is in flight, since feedGame() itself
      // never awaits anything and callers can't see inside a single finish()
      // call any other way.
      opts.onRound?.({ round, toRegister: needRegistration.length, fetched: fetchCount, queueLength: queue.length - queueHead });
      await drainQueue(movesCache);
    }
    return nodes;
  }

  // A JSON-serializable snapshot of every still-parked, unresolved game --
  // just the flat list of {gameId, result, plyIndex, fen}, deliberately
  // NOT the expanded pendingByTarget registration.
  // Measured on real data: a stuck game's chain registration can span up
  // to maxPlies target positions, each needing a full position-key string
  // as a map entry -- serializing that dwarfs the records themselves (a
  // 65K-pending-game checkpoint measured at 150MB with it included, versus
  // the low-single-digit-KB-per-1000-games this flat list needs). Losing
  // it on a resume is a bounded, one-time cost, not a repeated one: it
  // just means every restored record re-registers itself (re-fetching and
  // re-walking its own moves, which resuming it needs anyway) on finish()'s
  // first round after reload, exactly as if it had just been freshly
  // parked -- see the initialPending handling above.
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
    const records = [...recordsById.values()].map((r) => ({ id: r.id, gameId: r.gameId, result: r.result, plyIndex: r.plyIndex, fen: r.fen }));
    return { records, nextRecordId };
  }

  return { feedGame, finish, getPendingSnapshot };
}
