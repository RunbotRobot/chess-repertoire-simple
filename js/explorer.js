// Talks to the Lichess Opening Explorer API and turns raw game-frequency data
// into a repertoire tree.
//
// Core rule, per spec: at *my* move, always take the single reply that scored
// best in real games (draws count as a loss). At the *opponent's* move, keep
// every reply that's actually common — I need to be ready for whichever one
// they play, weighted by how often it's actually played.
//
// Data-source caveat: the repertoire is scoped to a single calendar
// month — the last fully-completed one — switching over on the 1st. Root
// cause, confirmed live across several rounds of probing (see git history
// for the full trail): `since`/`until` set to two *different* months
// returns 0 games, no matter which two months (including when `until` is
// merely omitted, which defaults to something far away — still "different"
// from `since`). `since === until` on one single, fully-completed month
// works correctly and returns real data. The obvious first guess — the
// *current*, still-in-progress month having no data yet — is a second, and
// entirely separate real issue, but it isn't the multi-month bug: pointing
// `since` (alone) at the current month also returned 0. So both months in
// use here must be identical, and neither can be the current one.
const EXPLORER_URL = 'https://explorer.lichess.org/lichess';

function monthString(monthOffset, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthOffset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The "preferred" month if everything were indexed instantly. What actually
// gets *queried* is resolved separately by resolveAvailableMonth(), which
// may fall back further back in time — isStale() deliberately does NOT
// compare against this (see its comment), so this is exported purely as a
// building block / for display, not as a source of truth for freshness.
export function monthWindow() {
  const lastCompletedMonth = monthString(-1);
  return { since: lastCompletedMonth, until: lastCompletedMonth };
}

const MAX_MONTHS_LOOKBACK = 4;

/**
 * Finds the most recent month that actually has queryable data, since a
 * freshly-completed calendar month isn't necessarily indexed yet (confirmed
 * live: one month back returned 0 games, two months back returned real
 * data — an indexing lag, not a bug in the query). Tries the last
 * completed month first, then progressively further back, so this adapts
 * automatically if that lag changes rather than relying on a guessed fixed
 * offset that could quietly break again later.
 */
async function resolveAvailableMonth(probeParams, token, opts = {}) {
  const attempts = [];
  for (let monthsBack = 1; monthsBack <= MAX_MONTHS_LOOKBACK; monthsBack++) {
    const month = monthString(-monthsBack);
    const url = buildExplorerUrl({ ...probeParams, since: month, until: month });
    const data = await fetchExplorerRaw(url, { signal: opts.signal, token });
    const moves = Array.isArray(data.moves) ? data.moves : [];
    const totalGames = moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
    attempts.push({ month, monthsBack, totalGames });
    if (totalGames > 0) return { month, monthsBack, attempts };
  }
  return { month: null, monthsBack: null, attempts };
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
      // The body almost always explains exactly what's wrong (e.g. a
      // rejected param format) — surfacing HTTP 400 without it was pure
      // guesswork. Every 4xx/5xx we haven't special-cased above lands here.
      let bodySnippet = '';
      try {
        bodySnippet = (await res.text()).slice(0, 300);
      } catch { /* body may already be consumed or unreadable; the status code alone still gets thrown below */ }
      throw new Error(`Lichess explorer request failed: HTTP ${res.status} for ${url}${bodySnippet ? ` — response: ${bodySnippet}` : ''}`);
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
  const limiter = new RateLimiter(4, 60);
  // "No depth limit" round-trips through JSON as null (Infinity isn't
  // JSON-safe), and `ply >= null` coerces null to 0 — silently terminating
  // the tree at the root instead of never terminating. Normalize once here.
  const maxPlies = Number.isFinite(settings.maxPlies) ? settings.maxPlies : Infinity;
  let nodesFetched = 0;
  let nodesCapped = false;
  let nodesFailed = 0;
  let firstFailureMessage = null;
  let rootDiagnostic = null;
  const maxNodes = settings.maxNodes || 300;

  const probeParams = {
    variant: 'standard',
    speeds: settings.speeds.join(','),
    ratings: settings.ratingBands.join(','),
    moves: 12, // ask lichess for up to 12 candidate moves per position
    // topGames/recentGames deliberately omitted (left at Lichess's default)
    // rather than forced to 0 — we never read that data, so there's no
    // reason to send a non-default value that could interact oddly with a
    // recently-changed, newly-authenticated endpoint.
  };

  const resolved = await resolveAvailableMonth(probeParams, settings.lichessToken, opts);
  if (!resolved.month) {
    const tried = resolved.attempts.map((a) => `${a.month} (${a.totalGames} games)`).join(', ');
    throw new Error(`No month in the last ${MAX_MONTHS_LOOKBACK} had any games for these filters — tried ${tried}. The filters (rating/speed) may be too narrow, or something is still wrong with the query.`);
  }
  const { since, until } = { since: resolved.month, until: resolved.month };

  const baseParams = { ...probeParams, since, until };

  async function fetchNode(uciPath) {
    const url = buildExplorerUrl({ ...baseParams, play: uciPath.join(',') });
    const data = await limiter.run(() => fetchExplorerRaw(url, { signal: opts.signal, token: settings.lichessToken }));
    return { data, url };
  }

  const root = { uci: null, san: null, ply: 0, games: 0, myMove: null, opponentMoves: null, children: {} };

  async function expand(node, uciPath) {
    if (opts.signal?.aborted) return;
    if (nodesFetched >= maxNodes) {
      // This node would have been expanded, but the position budget ran out
      // before we got to it — an artificial cutoff, not a real end of
      // theory. Distinct from a node we *did* fetch and found genuinely too
      // thin (see the minSampleSize check below) — quiz.js/app.js use this
      // to tell the user which one they actually hit.
      nodesCapped = true;
      node.truncatedByCap = true;
      return;
    }
    if (node.ply >= maxPlies) return;

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

      if (totalGames === 0) {
        // The mechanism is now understood (see the header comment) and the
        // primary query already uses the confirmed-working shape — a real
        // 0 here would mean something new. Two cheap sanity checks: the
        // month before this one (in case this specific month is somehow
        // still incomplete/unindexed), and no date filter at all (confirms
        // whether it's a date issue at all, vs. e.g. ratings/speed being
        // genuinely too narrow for this one month).
        const probeVariants = [
          { label: 'one month earlier still (same value)', overrides: { since: monthString(-2), until: monthString(-2) } },
          { label: 'no since, no until', overrides: { since: undefined, until: undefined } },
        ];
        rootDiagnostic.probes = [];
        for (const variant of probeVariants) {
          try {
            const probeUrl = buildExplorerUrl({ ...baseParams, ...variant.overrides });
            const probeData = await limiter.run(() => fetchExplorerRaw(probeUrl, { signal: opts.signal, token: settings.lichessToken }));
            const probeMoves = Array.isArray(probeData.moves) ? probeData.moves : [];
            const probeTotalGames = probeMoves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
            rootDiagnostic.probes.push({ label: variant.label, totalGames: probeTotalGames, movesReturned: probeMoves.length, url: probeUrl.toString() });
          } catch (err) {
            rootDiagnostic.probes.push({ label: variant.label, error: String(err.message || err) });
          }
        }
      }
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
        // No pre-check for the budget here — always create the child and
        // let expand()'s own top-of-function guard handle it. That's what
        // actually sets truncatedByCap; pre-checking here too would let
        // some cap-truncated branches vanish silently (no child node at
        // all) instead of being flagged like every other truncated leaf.
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
    monthsBack: resolved.monthsBack, // how far back we had to look to find an indexed month
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
  // Purely age-based now. It used to also compare the stored month against
  // today's "preferred" last-completed month, but that's actively wrong
  // now that the queried month can legitimately sit further back than
  // preferred (indexing lag) — a repertoire would look stale the instant
  // it finished building. A fresh build always re-resolves the available
  // month anyway, so age alone is enough to pick up a newer month once
  // Lichess actually has one indexed.
  const ageMs = Date.now() - repertoire.computedAt;
  return ageMs > maxAgeHours * 3600 * 1000;
}
