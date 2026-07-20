// Talks to the Lichess Opening Explorer API and turns raw game-frequency data
// into a repertoire tree.
//
// Core rule, per spec: at *my* move, always take the single reply that scored
// best in real games (draws count as a loss). At the *opponent's* move, keep
// every reply that's actually common — I need to be ready for whichever one
// they play, weighted by how often it's actually played.
//
// Data-source caveat: Lichess's explorer only filters by month (`since`/`until`
// are YYYY-MM), not by day. Rather than approximate a rolling 30-day window,
// the repertoire is simply scoped to the current calendar month and switches
// over to the next month's data on the 1st — see monthWindow().

const EXPLORER_URL = 'https://explorer.lichess.org/lichess';

export function monthWindow() {
  const now = new Date();
  const m = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return { since: m, until: m };
}

class RateLimiter {
  constructor(maxConcurrent = 4, minGapMs = 60) {
    this.maxConcurrent = maxConcurrent;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._pump();
    });
  }
  _pump() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.lastStart + this.minGapMs - now);
    setTimeout(() => {
      const item = this.queue.shift();
      if (!item) return;
      this.active++;
      this.lastStart = Date.now();
      item.fn().then(item.resolve, item.reject).finally(() => {
        this.active--;
        this._pump();
      });
      this._pump();
    }, wait);
  }
}

async function fetchExplorerRaw(params, { signal } = {}) {
  const url = new URL(EXPLORER_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { signal });
    if (res.status === 429) {
      attempt++;
      if (attempt > 5) throw new Error('Lichess explorer rate-limited us repeatedly (429).');
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Lichess explorer request failed: HTTP ${res.status}`);
    }
    const text = await res.text();
    // The endpoint returns a single JSON object for position queries; guard
    // against stray newline-delimited framing just in case.
    const line = text.trim().split('\n')[0];
    return JSON.parse(line);
  }
}

/**
 * Build a repertoire tree for one color.
 * @param {'white'|'black'} color
 * @param {object} settings
 * @param {{onProgress?: (n:{nodesFetched:number})=>void, signal?: AbortSignal}} opts
 */
export async function buildRepertoire(color, settings, opts = {}) {
  const { since, until } = monthWindow();
  const limiter = new RateLimiter(4, 60);
  let nodesFetched = 0;
  let nodesCapped = false;
  const maxNodes = settings.maxNodes || 300;

  const baseParams = {
    variant: 'standard',
    speeds: settings.speeds.join(','),
    ratings: settings.ratingBands.join(','),
    since,
    until,
    moves: 12, // ask lichess for up to 12 candidate moves per position
    topGames: 0,
    recentGames: 0,
  };

  async function fetchNode(uciPath) {
    return limiter.run(() =>
      fetchExplorerRaw({ ...baseParams, play: uciPath.join(',') }, { signal: opts.signal })
    );
  }

  const root = { uci: null, san: null, ply: 0, games: 0, myMove: null, opponentMoves: null, children: {} };

  async function expand(node, uciPath) {
    if (opts.signal?.aborted) return;
    if (nodesFetched >= maxNodes) { nodesCapped = true; return; }
    if (node.ply >= settings.maxPlies) return;

    let data;
    try {
      data = await fetchNode(uciPath);
    } catch (err) {
      node.fetchError = String(err.message || err);
      return;
    }
    nodesFetched++;
    opts.onProgress?.({ nodesFetched, nodesCapped });

    const moves = Array.isArray(data.moves) ? data.moves : [];
    const totalGames = moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
    node.games = totalGames;
    if (totalGames < settings.minSampleSize || moves.length === 0) {
      return; // not enough data to trust this position further; it's a leaf
    }

    const isMyMove = (node.ply % 2 === 0) === (color === 'white');

    if (isMyMove) {
      // Score every candidate by MY win rate from this position, draws = loss.
      let best = null;
      for (const m of moves) {
        const n = (m.white || 0) + (m.draws || 0) + (m.black || 0);
        if (n < settings.minSampleSize) continue;
        const wins = color === 'white' ? (m.white || 0) : (m.black || 0);
        const score = wins / n;
        if (!best || score > best.score) best = { uci: m.uci, san: m.san, games: n, score };
      }
      if (!best) return;
      node.myMove = best;
      const childPath = [...uciPath, best.uci];
      const child = { uci: best.uci, san: best.san, ply: node.ply + 1, games: 0, myMove: null, opponentMoves: null, children: {} };
      node.children[best.uci] = child;
      await expand(child, childPath);
    } else {
      // Keep every reply that's genuinely common; I need to be ready for it.
      const kept = moves
        .map((m) => ({ uci: m.uci, san: m.san, games: (m.white || 0) + (m.draws || 0) + (m.black || 0) }))
        .filter((m) => m.games > 0)
        .map((m) => ({ ...m, share: m.games / totalGames }))
        .filter((m) => m.share >= settings.opponentBranchMinShare || m.games >= settings.opponentBranchMinGames)
        .sort((a, b) => b.games - a.games);
      node.opponentMoves = kept;
      for (const m of kept) {
        if (nodesFetched >= maxNodes) { nodesCapped = true; break; }
        const childPath = [...uciPath, m.uci];
        const child = { uci: m.uci, san: m.san, ply: node.ply + 1, games: 0, myMove: null, opponentMoves: null, children: {} };
        node.children[m.uci] = child;
        await expand(child, childPath);
      }
    }
  }

  await expand(root, []);

  return {
    color,
    computedAt: Date.now(),
    monthWindow: { since, until },
    params: { ...baseParams, moves: undefined },
    nodesFetched,
    nodesCapped,
    root,
  };
}

export function isStale(repertoire, maxAgeHours) {
  if (!repertoire) return true;
  const ageMs = Date.now() - repertoire.computedAt;
  if (ageMs > maxAgeHours * 3600 * 1000) return true;
  const { since, until } = monthWindow();
  return repertoire.monthWindow?.since !== since || repertoire.monthWindow?.until !== until;
}
