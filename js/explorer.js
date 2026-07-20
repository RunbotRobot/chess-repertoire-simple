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
// the repertoire is scoped to the last fully-completed month plus whatever's
// available of the current one, and switches over on the 1st — see
// monthWindow(). Deliberately NOT since === until === the current month:
// that returned zero games in practice (confirmed via rootDiagnostic), most
// likely because Lichess hasn't finished indexing an in-progress month yet
// — possibly compounded by `until` being an exclusive bound, which would
// make any since === until query a zero-width, always-empty range. Anchoring
// `since` to the previous month sidesteps both risks at once: it's always a
// genuinely non-degenerate two-value range, and it never depends solely on
// the still-accumulating current month having data yet.
const EXPLORER_URL = 'https://explorer.lichess.org/lichess';

export function monthWindow() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { since: fmt(prev), until: fmt(now) };
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

function buildExplorerUrl(params) {
  const url = new URL(EXPLORER_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return url;
}

async function fetchExplorerRaw(url, { signal, token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { signal, headers });
    } catch (err) {
      // fetch() throws an opaque TypeError for network failures *and* for
      // CORS rejections alike — the browser deliberately hides the real
      // reason from JS. Check the browser console (not this message) for
      // the actual "blocked by CORS policy" / DNS / offline detail.
      throw new Error(`Could not reach the Lichess explorer (${err.message}). Check the browser console for the real cause — this could be blocked by CORS, offline, or an ad/privacy blocker. URL: ${url}`);
    }
    if (res.status === 401) {
      throw new Error(
        token
          ? `Lichess rejected the API token (HTTP 401) — it may be wrong, expired, or revoked. Create a new one at lichess.org/account/oauth/token/create (no scopes needed) and update it in Settings.`
          : `Lichess now requires an API token to use the opening explorer (HTTP 401, no token was sent). Create a free one at lichess.org/account/oauth/token/create (no scopes needed) and paste it into Settings.`
      );
    }
    if (res.status === 429) {
      attempt++;
      if (attempt > 5) throw new Error('Lichess explorer rate-limited us repeatedly (429).');
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Lichess explorer request failed: HTTP ${res.status} for ${url}`);
    }
    const text = await res.text();
    // The endpoint returns a single JSON object for position queries; guard
    // against stray newline-delimited framing just in case.
    const line = text.trim().split('\n')[0];
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`Lichess explorer returned unparseable data: ${err.message}. First 200 chars: ${text.slice(0, 200)}`);
    }
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
  let nodesFailed = 0;
  let firstFailureMessage = null;
  let rootDiagnostic = null;
  const maxNodes = settings.maxNodes || 300;

  const baseParams = {
    variant: 'standard',
    speeds: settings.speeds.join(','),
    ratings: settings.ratingBands.join(','),
    since,
    until,
    moves: 12, // ask lichess for up to 12 candidate moves per position
    // topGames/recentGames deliberately omitted (left at Lichess's default)
    // rather than forced to 0 — we never read that data, so there's no
    // reason to send a non-default value that could interact oddly with a
    // recently-changed, newly-authenticated endpoint.
  };

  async function fetchNode(uciPath) {
    const url = buildExplorerUrl({ ...baseParams, play: uciPath.join(',') });
    const data = await limiter.run(() => fetchExplorerRaw(url, { signal: opts.signal, token: settings.lichessToken }));
    return { data, url };
  }

  const root = { uci: null, san: null, ply: 0, games: 0, myMove: null, opponentMoves: null, children: {} };

  async function expand(node, uciPath) {
    if (opts.signal?.aborted) return;
    if (nodesFetched >= maxNodes) { nodesCapped = true; return; }
    if (node.ply >= settings.maxPlies) return;

    let data, url;
    try {
      ({ data, url } = await fetchNode(uciPath));
    } catch (err) {
      node.fetchError = String(err.message || err);
      nodesFailed++;
      firstFailureMessage ??= node.fetchError;
      return;
    }
    nodesFetched++;
    opts.onProgress?.({ nodesFetched, nodesCapped });

    const moves = Array.isArray(data.moves) ? data.moves : [];
    const totalGames = moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
    node.games = totalGames;

    if (node === root) {
      // The single highest-value diagnostic point: the starting position
      // should always have a huge sample. If it doesn't, something is
      // wrong with the query itself (bad params, an API behavior change,
      // an unexpected response shape) rather than genuinely thin data —
      // capture enough here to tell the difference without live access to
      // the API ourselves.
      rootDiagnostic = {
        totalGames,
        movesReturned: moves.length,
        topLevel: { white: data.white, draws: data.draws, black: data.black },
        url: url.toString(),
      };
    }

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

  if (nodesFetched === 0 && root.fetchError) {
    // A failure at the root means nothing at all was fetched — surface it
    // as a real error instead of silently returning a hollow, empty tree.
    throw new Error(root.fetchError);
  }

  return {
    color,
    computedAt: Date.now(),
    monthWindow: { since, until },
    params: { ...baseParams, moves: undefined },
    nodesFetched,
    nodesCapped,
    nodesFailed,
    firstFailureMessage,
    rootDiagnostic,
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
