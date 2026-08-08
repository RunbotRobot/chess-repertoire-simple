// Data source backed by a precomputed repertoire file (pipeline/algorithm.js's
// selectRepertoire, as written out periodically by pipeline/chunked-ingest.mjs)
// instead of live per-position Lichess Explorer lookups -- see explorer.js's
// header comment for that live path. The whole tree for a color is fetched
// once and held in memory; every position lookup after that is a pure,
// synchronous walk down myMove.child / replies[].child links, so there's no
// per-position network cost and no cache-freshness/history-window concept
// the way explorer.js has (a fresh checkpoint is a whole new file, not
// something to escalate into piecemeal).
//
// Exposes getLocalPosition/peekLocalPosition with the same {node, ...}
// return contract as explorer.js's getPosition/peekPosition, and the same
// repertoire-node shape ({games, myMove, alternates, opponentMoves,
// leafReason, windowInfo}) quiz.js and app.js's Browse rendering already
// consume -- so app.js can pick between the two sources with a single
// settings check, without quiz.js or Browse needing to know which is live.

const state = new Map(); // color -> { url, root, minGames, generatedAt }

function localRepertoireUrl(settings, color) {
  const base = (settings.localDataUrl || './data').replace(/\/+$/, '');
  return `${base}/repertoire-${color}.json`;
}

async function ensureLoaded(color, settings, opts = {}) {
  const url = localRepertoireUrl(settings, color);
  const existing = state.get(color);
  if (existing && existing.url === url) return existing;

  opts.onBeforeFetch?.();
  opts.onFetchProgress?.({ completed: 0, total: 1 });
  // no-store: this file gets overwritten repeatedly by an in-progress
  // ingestion run, and a stale HTTP-cached copy would silently hide new
  // checkpoints indefinitely (same reasoning as sw.js's shell-install fetch).
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load local repertoire data from ${url}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.minGames !== 'number' || !data.root) {
    throw new Error(`${url} doesn't look like a repertoire checkpoint file (expected {minGames, generatedAt, root})`);
  }
  opts.onFetchProgress?.({ completed: 1, total: 1 });

  const entry = { url, root: data.root, minGames: data.minGames, generatedAt: data.generatedAt || null };
  state.set(color, entry);
  return entry;
}

// Walks uciPath from the tree's root, following whichever of
// myMove/replies matches each step -- both are populated exclusively by
// selectRepertoire, so any path this module itself ever hands back out
// (via translateNode's myMove.uci / opponentMoves[].uci) is guaranteed to
// match one of these branches; returns null only for a path this source
// never offered in the first place.
function findNode(root, uciPath) {
  let node = root;
  for (const uci of uciPath) {
    if (node.myMove && node.myMove.uci === uci) { node = node.myMove.child; continue; }
    const reply = node.replies?.find((r) => r.uci === uci);
    if (reply) { node = reply.child; continue; }
    return null;
  }
  return node;
}

// Mirrors explorer.js's computeNodeFromRaw leafReason values so the shared
// leafGamesMessage()/windowInfoDebugText() UI code in app.js needs no
// changes: 'insufficient-total' when this exact position never cleared the
// pipeline's own minGames threshold in the first place, 'no-qualifying-move'
// / 'no-qualifying-reply' when it did but nothing below it did (mirrors
// scorePass/selectRepertoire's isLeaf-despite-qualifying-total case).
function translateNode(repNode, minGames, color) {
  const games = repNode.total;
  if (repNode.myMove) {
    return {
      games,
      myMove: {
        san: repNode.myMove.san,
        uci: repNode.myMove.uci,
        score: repNode.myMove.score,
        games: repNode.myMove.child.total,
      },
      alternates: (repNode.alternates || []).map((a) => ({ san: a.san, uci: a.uci, score: a.score, games: a.games })),
      opponentMoves: null,
      leafReason: null,
    };
  }
  if (repNode.replies) {
    return {
      games,
      myMove: null,
      opponentMoves: repNode.replies.map((r) => ({ san: r.san, uci: r.uci, games: r.games, share: r.share })),
      leafReason: null,
    };
  }
  const leafReason = games < minGames ? 'insufficient-total' : (repNode.sideToMove === color ? 'no-qualifying-move' : 'no-qualifying-reply');
  return { games, myMove: null, alternates: [], opponentMoves: null, leafReason };
}

/**
 * Local-data counterpart to explorer.js's getPosition(): loads (or reuses
 * the in-memory) whole-tree checkpoint for `color`, then walks straight to
 * uciPath -- no network cost beyond the one whole-file fetch, which only
 * happens once per color per (session, localDataUrl) until
 * refreshLocalRepertoire() is called.
 *
 * @param {string[]} uciPath
 * @param {'white'|'black'} color
 * @param {object} settings
 * @param {{onBeforeFetch?: () => void, onFetchProgress?: ({completed,total}) => void}} opts
 * @returns {Promise<{node, cacheHit: boolean, fetchedAt: string|null}>}
 */
export async function getLocalPosition(uciPath, color, settings, opts = {}) {
  const maxPlies = Number.isFinite(settings.maxPlies) ? settings.maxPlies : Infinity;
  if (uciPath.length >= maxPlies) {
    return { node: { games: 0, myMove: null, opponentMoves: null, leafReason: 'max-depth' }, cacheHit: true, fetchedAt: null };
  }

  const wasLoaded = state.has(color);
  const { root, minGames, generatedAt } = await ensureLoaded(color, settings, opts);
  const found = findNode(root, uciPath);
  const node = found
    ? translateNode(found, minGames, color)
    : { games: 0, myMove: null, opponentMoves: null, leafReason: 'insufficient-total' };
  node.windowInfo = null; // no history-window concept for a precomputed snapshot
  return { node, cacheHit: wasLoaded, fetchedAt: generatedAt };
}

/**
 * Browse's read-only counterpart, matching peekPosition's signature. Unlike
 * the live source, "peek" and "get" cost the same here (both are a
 * synchronous tree walk once the file's loaded) -- so this loads on demand
 * too, rather than only reading whatever's already resident, since there's
 * no live-network-cost reason to hold Browse back the way peekPosition does.
 *
 * @param {string[]} uciPath
 * @param {'white'|'black'} color
 * @param {object} settings
 */
export async function peekLocalPosition(uciPath, color, settings) {
  const { node, fetchedAt } = await getLocalPosition(uciPath, color, settings, {});
  return { node, cached: true, fetchedAt };
}

/**
 * Forces the next lookup for `color` to re-fetch localDataUrl's file rather
 * than reuse whatever's already in memory -- for a "refresh" action in
 * Setup, since a long-running ingestion keeps overwriting the checkpoint
 * file in place and nothing else would otherwise notice a newer one exists.
 */
export function forgetLocalRepertoire(color) {
  state.delete(color);
}

/** Whatever's currently held in memory for `color`, or null if nothing's been loaded yet. */
export function peekLoadedMeta(color) {
  const entry = state.get(color);
  return entry ? { url: entry.url, minGames: entry.minGames, generatedAt: entry.generatedAt } : null;
}
