// Talks to the Lichess Opening Explorer API and turns a raw game-frequency
// response into a repertoire node.
//
// Core rule, per spec: at *my* move, always take the single reply that scored
// best in real games (draws count as a loss). At the *opponent's* move, keep
// every reply that's actually common — I need to be ready for whichever one
// they play, weighted by how often it's actually played.
//
// Architecture note: this used to eagerly build a whole tree (up to a few
// hundred positions) before a quiz could start, which meant a multi-minute
// wait up front — the actual bottleneck turned out to be Lichess's own
// per-request response time (confirmed live via the timing instrumentation
// this replaced), not anything about how we called it. So instead of one
// big sync, positions are now fetched lazily, one at a time, exactly when
// something (quiz or browse) actually navigates to them, and cached in
// IndexedDB (see positionCache.js) keyed by the query params that affect
// the data (variant/speeds/ratings/month/move-sequence) — deliberately NOT
// by color, since the same position reached by transposition is identical
// data regardless of which repertoire found it, and NOT by scoring settings
// (minSampleSize etc.), which are applied fresh on every read instead.
// "Periodic re-fetching" falls out of this for free: a cached entry older
// than repertoireMaxAgeMonths is transparently refetched next time it's
// actually needed, rather than needing a separate background sweep.
//
// Data-source caveat: the repertoire is scoped to a single calendar
// month — the last one that's actually indexed, which isn't necessarily the
// last *completed* one — see resolveAvailableMonth()'s comment. Also,
// `since`/`until` must be sent as an identical single YYYY-MM value; two
// different months (or one omitted) reliably returns 0 games. Both findings
// came from live probing — see git history for the full trail.
//
// Browse vs. quiz split: quizzing (getPosition) is the only thing that ever
// talks to the network — it fetches, caches, and (re)resolves the queryable
// month. Browse (peekPosition) only ever reads what's already cached, using
// the last-resolved month persisted in localStorage (see
// storage.js's loadResolvedMonth) rather than re-resolving it itself, so
// opening the Browse tab never makes a request of its own.
//
// Adaptive history window: a single calendar month of games is plenty of
// sample size for a heavily-played position, but nowhere near enough for an
// obscure one — and conversely, a well-known position's single month is
// already *more* than enough, so padding it with a year of history would
// just be diluting "current knowledge" with stale games. Since a single
// query can only ever cover one calendar month (see above), a wider window
// is built by querying multiple consecutive months separately and summing
// them — there's no other way to ask Lichess for more than one month at a
// time. How many months to pull is decided adaptively per position: after
// each real fetch, the resulting {windowMonths, totalGames} is saved (via
// positionCache.js's windowHints store, keyed without the month so it
// survives month rollovers) and used to compute a new window size next time
// — scaled proportionally toward whatever would have hit
// targetGamesPerPosition (e.g. if 3 months yielded 300 games against a
// 1000 target, next time try roughly 3 * 1000/300 = 10 months), clamped to
// [1, MAX_WINDOW_MONTHS]. This converges in a step or two for most
// positions without needing to actually search within a single fetch,
// which would mean an unbounded number of requests (and an unbounded quiz-
// time wait) triggered by one lazy lookup. A position that's still short of
// target even at MAX_WINDOW_MONTHS escalates once more to FULL_HISTORY — a
// single request with no since/until at all, covering everything Lichess
// has indexed for it — since month-by-month clearly isn't going to get
// there no matter how far back it goes.
import { getCached, putCached, getWindowHint, putWindowHint } from './positionCache.js';
import { loadResolvedMonth, saveResolvedMonth } from './storage.js';

const EXPLORER_URL = 'https://explorer.lichess.org/lichess';

function monthString(monthOffset, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthOffset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The "preferred" month if everything were indexed instantly. What actually
// gets *queried* is resolved separately by resolveAvailableMonth(), which
// may fall back further back in time — exported purely as a building block
// / for display, not as a source of truth for freshness.
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

// Resolving the available month costs up to MAX_MONTHS_LOOKBACK requests —
// fine once, wasteful to repeat on every single lazy position fetch. Cached
// in memory per (ratings, speeds) signature for the life of the page;
// there's no need to persist it since re-resolving once per session is
// cheap and avoids any staleness edge cases around month boundaries.
const monthResolutionCache = new Map();

function monthSignature(probeParams) {
  return `${probeParams.ratings}|${probeParams.speeds}`;
}

async function resolveMonthCached(probeParams, token, opts = {}) {
  const key = monthSignature(probeParams);
  const cached = monthResolutionCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < 12 * 3600 * 1000) return cached;
  const resolved = await resolveAvailableMonth(probeParams, token, opts);
  if (!resolved.month) {
    const tried = resolved.attempts.map((a) => `${a.month} (${a.totalGames} games)`).join(', ');
    throw new Error(`No month in the last ${MAX_MONTHS_LOOKBACK} had any games for these filters — tried ${tried}. The filters (rating/speed) may be too narrow, or something is still wrong with the query.`);
  }
  const entry = { ...resolved, resolvedAt: Date.now() };
  monthResolutionCache.set(key, entry);
  saveResolvedMonth(key, { month: entry.month, resolvedAt: entry.resolvedAt });
  return entry;
}

// Browse's read-only counterpart to resolveMonthCached: never touches the
// network, just returns whichever month quizzing last resolved to (in
// memory if this page load has already done it, else whatever was
// persisted from a previous session), or null if nothing's been resolved
// yet at all — meaning nothing can possibly be cached yet either.
function peekResolvedMonth(probeParams) {
  const key = monthSignature(probeParams);
  const inMemory = monthResolutionCache.get(key);
  if (inMemory) return inMemory.month;
  const persisted = loadResolvedMonth(key);
  return persisted ? persisted.month : null;
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

// Pure function: turns one raw Lichess response into a repertoire node,
// given the color/ply context and current scoring settings. No I/O, so it's
// cheap to recompute on every read — meaning changing minSampleSize etc. in
// Settings takes effect immediately against already-cached data.
function computeNodeFromRaw(data, color, ply, settings) {
  const moves = Array.isArray(data.moves) ? data.moves : [];
  const totalGames = moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);

  if (totalGames < settings.minSampleSize || moves.length === 0) {
    return { games: totalGames, myMove: null, opponentMoves: null }; // not enough data to trust this position; it's a leaf
  }

  const isMyMove = (ply % 2 === 0) === (color === 'white');

  if (isMyMove) {
    // Score every candidate by MY win rate from this position, draws = loss.
    // Ties go to the move with more games (more real-world testing of that
    // line); if it's still tied after that, pick uniformly at random among
    // the tied candidates (reservoir sampling — each survives with
    // probability 1/(number of ties seen so far), which works out uniform
    // without needing to collect the whole tied group first).
    const candidates = [];
    for (const m of moves) {
      const n = (m.white || 0) + (m.draws || 0) + (m.black || 0);
      if (n < settings.minSampleSize) continue;
      const wins = color === 'white' ? (m.white || 0) : (m.black || 0);
      candidates.push({ uci: m.uci, san: m.san, games: n, score: wins / n });
    }
    candidates.sort((a, b) => b.score - a.score || b.games - a.games);

    let best = null;
    let tieCount = 0;
    for (const candidate of candidates) {
      if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.games > best.games)) {
        best = candidate;
        tieCount = 1;
      } else if (candidate.score === best.score && candidate.games === best.games) {
        tieCount++;
        if (Math.random() < 1 / tieCount) best = candidate;
      }
    }
    // The other candidates aren't part of the repertoire (only one move is
    // ever quizzed per position), but Browse shows them for reference —
    // sorted the same way, highest-scoring first.
    const alternates = candidates.filter((c) => c !== best);
    return { games: totalGames, myMove: best, alternates, opponentMoves: null };
  }

  // Keep every reply that's genuinely common; I need to be ready for it.
  const kept = moves
    .map((m) => ({ uci: m.uci, san: m.san, games: (m.white || 0) + (m.draws || 0) + (m.black || 0) }))
    .filter((m) => m.games > 0)
    .map((m) => ({ ...m, share: m.games / totalGames }))
    .filter((m) => m.share >= settings.opponentBranchMinShare || m.games >= settings.opponentBranchMinGames)
    .sort((a, b) => b.games - a.games);
  return { games: totalGames, myMove: null, opponentMoves: kept };
}

function explorerQueryParams(settings) {
  return {
    variant: 'standard',
    speeds: settings.speeds.join(','),
    ratings: settings.ratingBands.join(','),
    moves: 12, // ask lichess for up to 12 candidate moves per position
    // topGames/recentGames deliberately omitted (left at Lichess's default)
    // rather than forced to 0 — we never read that data, so there's no
    // reason to send a non-default value that could interact oddly with a
    // recently-changed, newly-authenticated endpoint.
  };
}

function cacheKeyFor(queryParams, month, uciPath) {
  return `${month}::${queryParams.variant}::${queryParams.speeds}::${queryParams.ratings}::${uciPath.join(',')}`;
}

// Unlike cacheKeyFor, deliberately excludes the month — this key tracks
// "how big a window did this position need," which should persist across
// month rollovers rather than resetting every time the queryable month
// (and therefore the main cache key) advances.
function windowHintKeyFor(queryParams, uciPath) {
  return `${queryParams.variant}::${queryParams.speeds}::${queryParams.ratings}::${uciPath.join(',')}`;
}

const DEFAULT_TARGET_GAMES = 1000;
// Hard cap on how many months one position's window can grow to via the
// month-by-month path, regardless of how far the games count remains under
// target — bounds the worst case of a single lazy fetch (a live quiz
// waiting on this) to a fixed number of sequential requests. Once a
// position is stuck at this cap and still short of target, the window
// escalates once more to FULL_HISTORY (see below) rather than growing
// month-by-month forever.
const MAX_WINDOW_MONTHS = 12;

// A sentinel window "size" meaning "don't filter by date at all — ask for
// this position's entire indexed history in one request." Reserved for
// positions so obscure that even MAX_WINDOW_MONTHS of monthly requests
// couldn't reach the target; there's nowhere further to grow from here, so
// (unlike the numeric sizes) this never shrinks back down once reached.
// Unlike the single-month-omitted case documented above (confirmed live to
// return 0 games), this omits *both* since and until — untested against the
// real API from this dev sandbox (network policy blocks lichess.org here),
// but is what the explorer's own docs describe as the actual no-filter
// default, and is a materially different request than the broken case.
const FULL_HISTORY = 'full';

// Proportionally scales the window toward whatever would have hit the
// target last time, based on the games-per-month density actually observed
// (totalGames / windowMonths) — a single step gets close for most
// positions rather than crawling one month at a time. No prior hint (a
// position's very first-ever fetch) starts at the cheapest possible probe,
// 1 month; a prior fetch that came back completely empty doubles the
// window rather than dividing by zero. Once already at FULL_HISTORY, or
// once the month-by-month window is maxed out and still short of target,
// escalates to (or stays at) FULL_HISTORY instead of continuing to grow
// (or re-probe) month by month.
function nextWindowMonths(hint, targetGames) {
  if (!hint || !hint.windowMonths) return 1;
  if (hint.windowMonths === FULL_HISTORY) return FULL_HISTORY;
  const atCap = hint.windowMonths >= MAX_WINDOW_MONTHS;
  if (!hint.totalGames || hint.totalGames <= 0) {
    return atCap ? FULL_HISTORY : Math.min(MAX_WINDOW_MONTHS, Math.max(hint.windowMonths * 2, 2));
  }
  if (hint.totalGames < targetGames && atCap) return FULL_HISTORY;
  const scaled = Math.round((hint.windowMonths * targetGames) / hint.totalGames);
  return Math.max(1, Math.min(MAX_WINDOW_MONTHS, scaled));
}

// Combines several months' raw explorer responses into one, summing game
// counts per move (uci) across all of them. A move missing from some
// months (e.g. it wasn't played that month) just contributes 0 for those.
function mergeMovesData(perMonthResponses) {
  const byUci = new Map();
  for (const data of perMonthResponses) {
    const moves = Array.isArray(data.moves) ? data.moves : [];
    for (const m of moves) {
      const existing = byUci.get(m.uci) || { uci: m.uci, san: m.san, white: 0, draws: 0, black: 0 };
      existing.white += m.white || 0;
      existing.draws += m.draws || 0;
      existing.black += m.black || 0;
      byUci.set(m.uci, existing);
    }
  }
  return { moves: [...byUci.values()] };
}

// Freshness is expressed in months (users think "refetch monthly", not
// "refetch every 720 hours") and decimals are expected (e.g. 0.5 for twice a
// month) — an average month length is precise enough for a staleness check.
const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

/**
 * Fetches (or serves from cache) one position and returns it as a
 * repertoire node: { games, myMove, alternates, opponentMoves }. Lazy —
 * this is the only place a network request for opening data happens;
 * quiz/browse call it exactly when they navigate to a position, not ahead
 * of time.
 *
 * @param {string[]} uciPath moves from the start position, in UCI form
 * @param {'white'|'black'} color which repertoire this is for
 * @param {object} settings
 * @param {{signal?: AbortSignal, onBeforeFetch?: () => void, cache?: {getCached, putCached, getWindowHint, putWindowHint}}} opts
 *   onBeforeFetch fires synchronously, only when a real network request is
 *   about to happen (not on a cache hit) — the hook for "hold on, fetching…"
 *   UX. cache defaults to the real IndexedDB-backed one; tests inject a
 *   fake in-memory implementation instead.
 */
export async function getPosition(uciPath, color, settings, opts = {}) {
  const cache = opts.cache || { getCached, putCached, getWindowHint, putWindowHint };
  const maxPlies = Number.isFinite(settings.maxPlies) ? settings.maxPlies : Infinity;
  if (uciPath.length >= maxPlies) {
    return { node: { games: 0, myMove: null, opponentMoves: null }, cacheHit: true, fetchedAt: null, cacheKey: null };
  }

  const queryParams = explorerQueryParams(settings);
  const { month, monthsBack } = await resolveMonthCached(queryParams, settings.lichessToken, opts);
  const key = cacheKeyFor(queryParams, month, uciPath);

  const cached = await cache.getCached(key);
  const maxAgeMs = (settings.repertoireMaxAgeMonths || 1) * MS_PER_MONTH;
  let raw, fetchedAt, cacheHit;
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    raw = cached.data;
    fetchedAt = cached.fetchedAt;
    cacheHit = true;
  } else {
    opts.onBeforeFetch?.();
    const targetGames = settings.targetGamesPerPosition || DEFAULT_TARGET_GAMES;
    const hintKey = windowHintKeyFor(queryParams, uciPath);
    const hint = await cache.getWindowHint(hintKey);
    const windowMonths = nextWindowMonths(hint, targetGames);

    let perMonth;
    if (windowMonths === FULL_HISTORY) {
      const url = buildExplorerUrl({ ...queryParams, play: uciPath.join(',') }); // no since/until at all
      perMonth = [await fetchExplorerRaw(url, { signal: opts.signal, token: settings.lichessToken })];
    } else {
      // One request per month, sequentially rather than in parallel —
      // gentler on Lichess's server for the (rare) obscure position whose
      // window has grown large, in keeping with the whole lazy-fetch
      // design's goal of minimizing server strain over raw speed.
      perMonth = [];
      for (let i = 0; i < windowMonths; i++) {
        const monthToFetch = monthString(-(monthsBack + i));
        const url = buildExplorerUrl({ ...queryParams, since: monthToFetch, until: monthToFetch, play: uciPath.join(',') });
        perMonth.push(await fetchExplorerRaw(url, { signal: opts.signal, token: settings.lichessToken }));
      }
    }
    raw = mergeMovesData(perMonth);
    const totalGames = raw.moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);

    await cache.putCached(key, raw);
    await cache.putWindowHint(hintKey, { windowMonths, totalGames });
    fetchedAt = Date.now();
    cacheHit = false;
  }

  const node = computeNodeFromRaw(raw, color, uciPath.length, settings);
  return { node, cacheHit, fetchedAt, cacheKey: key };
}

/**
 * Browse's read-only counterpart to getPosition(): looks at whatever's
 * already cached and never fetches, never resolves the month over the
 * network, never writes anything. Returns { node: null, cached: false }
 * when nothing's known yet for this position — the caller (Browse) is
 * expected to show that as "not fetched yet" rather than treating it the
 * same as a genuine end-of-theory leaf, which getPosition's node shape
 * can't distinguish (null myMove/opponentMoves there just means "no data").
 *
 * @param {string[]} uciPath
 * @param {'white'|'black'} color
 * @param {object} settings
 * @param {{cache?: {getCached, putCached}}} opts
 */
export async function peekPosition(uciPath, color, settings, opts = {}) {
  const cache = opts.cache || { getCached, putCached };
  const queryParams = explorerQueryParams(settings);
  const month = peekResolvedMonth(queryParams);
  if (!month) return { node: null, cached: false, fetchedAt: null };

  const key = cacheKeyFor(queryParams, month, uciPath);
  const cached = await cache.getCached(key);
  if (!cached) return { node: null, cached: false, fetchedAt: null };

  const node = computeNodeFromRaw(cached.data, color, uciPath.length, settings);
  return { node, cached: true, fetchedAt: cached.fetchedAt };
}
