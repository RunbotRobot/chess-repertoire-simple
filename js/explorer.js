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
// History window: a single calendar month of games is plenty of sample size
// for a heavily-played position, but nowhere near enough for an obscure
// one. Rather than a single fixed window, or a formula trying to predict
// the "right" size up front, a position is tried at three fixed tiers —
// 1 month, then 12 months, then all-time (no since/until at all) — moving
// to the next tier only when the current one actually produces a leaf for
// lack of data (see computeNodeFromRaw's leafReason: 'insufficient-total',
// 'no-qualifying-move', or 'no-qualifying-reply' — NOT 'max-depth', which
// has nothing to do with data volume). A well-covered position almost
// always resolves at 1 month and never pays for the wider tiers at all.
// This all happens synchronously within one getPosition() call — a
// position genuinely obscure enough to need it costs a handful of extra
// requests on that one lazy lookup, but the result is that a leaf is never
// shown to the user as "not enough games" until all-time history has
// actually been tried and still wasn't enough. (An earlier version tried
// to predict window size proportionally from the previous fetch's
// game density, persisted across sessions via positionCache.js's
// windowHints store — the predicted size only ever took effect on a
// *separate*, *later* real fetch, gated behind repertoireMaxAgeMonths
// cache staleness. In practice that meant re-quizzing the same obscure
// position within that freshness window kept re-showing the same small
// window's leaf every time, never actually growing — the escalation
// existed on paper but essentially never fired. Doing it inline, reactively,
// within the lookup that needs it fixes that outright.)
//
// Since a single query can only ever cover one calendar month (see below),
// the 12-month tier is built by querying 12 consecutive months separately
// and summing them — there's no other way to ask Lichess for more than one
// month at a time.
import { getCached, putCached } from './positionCache.js';
import { loadResolvedMonth, saveResolvedMonth } from './storage.js';
import { normalizeLichessUci } from './chessUtil.js';

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
    // Genuine data scarcity: the position itself doesn't have enough games,
    // full stop — leafReason lets the UI say exactly that rather than
    // guessing (see the other two leafReason cases below, where totalGames
    // alone clearing the bar does NOT imply a leaf below was avoidable).
    return { games: totalGames, myMove: null, opponentMoves: null, leafReason: 'insufficient-total' };
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
      candidates.push({ uci: normalizeLichessUci(m.uci), san: m.san, games: n, score: wins / n });
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
    if (!best) {
      // totalGames cleared minSampleSize, but it was spread thin enough
      // across moves that no single one did on its own — e.g. 22 games
      // split 8/7/7 against a 20 threshold. Distinct from
      // 'insufficient-total': the position isn't obscure, no candidate move
      // individually is.
      return { games: totalGames, myMove: null, alternates: [], opponentMoves: null, leafReason: 'no-qualifying-move' };
    }
    // The other candidates aren't part of the repertoire (only one move is
    // ever quizzed per position), but Browse shows them for reference —
    // sorted the same way, highest-scoring first.
    const alternates = candidates.filter((c) => c !== best);
    return { games: totalGames, myMove: best, alternates, opponentMoves: null, leafReason: null };
  }

  // Keep every reply that's genuinely common; I need to be ready for it.
  const kept = moves
    .map((m) => ({ uci: normalizeLichessUci(m.uci), san: m.san, games: (m.white || 0) + (m.draws || 0) + (m.black || 0) }))
    .filter((m) => m.games > 0)
    .map((m) => ({ ...m, share: m.games / totalGames }))
    .filter((m) => m.share >= settings.opponentBranchMinShare || m.games >= settings.opponentBranchMinGames)
    .sort((a, b) => b.games - a.games);
  if (kept.length === 0) {
    // Same idea on the opponent side: plenty of total games, but scattered
    // across replies too thin/rare to individually clear the "worth
    // preparing for" bar. Returning opponentMoves: null (not []) here also
    // matters mechanically — an empty array is truthy in JS, so quiz.js's
    // `while (node.myMove || node.opponentMoves)` wouldn't otherwise
    // recognize this as the leaf it actually is.
    return { games: totalGames, myMove: null, opponentMoves: null, leafReason: 'no-qualifying-reply' };
  }
  return { games: totalGames, myMove: null, opponentMoves: kept, leafReason: null };
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

// The three fixed window tiers (see header comment). YEAR_TIER_MONTHS is
// the second tier's size; the first is always exactly 1 month, inline
// below, so it doesn't need its own named constant.
const YEAR_TIER_MONTHS = 12;

// A sentinel window "size" meaning "don't filter by date at all — ask for
// this position's entire indexed history in one request." This omits
// *both* since and until — what the explorer's own docs describe as the
// actual no-filter default, and a materially different request than the
// single-month-omitted case documented above (confirmed live to return 0
// games).
const FULL_HISTORY = 'full';

// Which leafReasons mean "this leaf is purely a data-volume problem, and a
// wider window might fix it" — worth escalating the window tier for.
// 'max-depth' is deliberately excluded: that's a ply-count cap, unrelated
// to how much history was fetched, and widening the window can't change it.
const LEAF_REASONS_NEEDING_MORE_HISTORY = new Set(['insufficient-total', 'no-qualifying-move', 'no-qualifying-reply']);

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

// Fetches `count` consecutive months, starting `monthsBack` months before
// now, sequentially rather than in parallel — gentler on Lichess's server
// for the (rare) obscure position that ends up needing the wider tiers, in
// keeping with the whole lazy-fetch design's goal of minimizing server
// strain over raw speed.
async function fetchMonths(queryParams, uciPath, monthsBack, count, token, opts, tick) {
  const perMonth = [];
  for (let i = 0; i < count; i++) {
    const monthToFetch = monthString(-(monthsBack + i));
    const url = buildExplorerUrl({ ...queryParams, since: monthToFetch, until: monthToFetch, play: uciPath.join(',') });
    perMonth.push(await fetchExplorerRaw(url, { signal: opts.signal, token }));
    tick?.();
  }
  return perMonth;
}

async function fetchFullHistory(queryParams, uciPath, token, opts, tick) {
  const url = buildExplorerUrl({ ...queryParams, play: uciPath.join(',') }); // no since/until at all
  const result = [await fetchExplorerRaw(url, { signal: opts.signal, token })];
  tick?.();
  return result;
}

// Given a position's data at whatever tier it's currently at (1 month, 12
// months, or already all-time), escalates it further if it's still a leaf
// for lack of data and there's a wider tier left to try. Deliberately
// applies the SAME regardless of whether that starting data came from a
// fresh tier-1 fetch or a cache hit — a cached "not enough yet" result
// isn't actually done just because it's still within its freshness window;
// caching exists to skip redundant requests for data that's good, not to
// lock in an under-resourced leaf until the cache happens to go stale.
// (windowMonths is always exactly 1, YEAR_TIER_MONTHS, or FULL_HISTORY
// here — those are the only values getPosition ever writes back out, so
// there's no intermediate case to handle.)
async function escalateIfNeeded(raw, windowMonths, { queryParams, uciPath, monthsBack, color, settings, token, opts, onEscalating, tick, bumpTotal }) {
  let escalated = false;
  const isLeafForLackOfData = (r) => LEAF_REASONS_NEEDING_MORE_HISTORY.has(computeNodeFromRaw(r, color, uciPath.length, settings).leafReason);

  if (windowMonths === 1 && isLeafForLackOfData(raw)) {
    onEscalating();
    bumpTotal(YEAR_TIER_MONTHS - 1); // about to make this many more requests
    const rest = await fetchMonths(queryParams, uciPath, monthsBack + 1, YEAR_TIER_MONTHS - 1, token, opts, tick);
    raw = mergeMovesData([raw, ...rest]);
    windowMonths = YEAR_TIER_MONTHS;
    escalated = true;
  }
  if (windowMonths === YEAR_TIER_MONTHS && isLeafForLackOfData(raw)) {
    onEscalating();
    bumpTotal(1);
    raw = mergeMovesData(await fetchFullHistory(queryParams, uciPath, token, opts, tick));
    windowMonths = FULL_HISTORY;
    escalated = true;
  }
  return { raw, windowMonths, escalated };
}

/**
 * Fetches (or serves from cache) one position and returns it as a
 * repertoire node: { games, myMove, alternates, opponentMoves, leafReason,
 * windowInfo }. windowInfo ({windowMonths, totalGames}, windowMonths either
 * a number of months or the FULL_HISTORY sentinel 'full') is debug/UI info
 * about which history tier this position's data actually came from, not
 * used by scoring. leafReason is null unless this is a leaf (myMove and
 * opponentMoves both null), in which case it's one of 'insufficient-total'
 * (games < minSampleSize — genuine data scarcity), 'no-qualifying-move'
 * (enough total games, but no single candidate move individually reached
 * minSampleSize), or 'no-qualifying-reply' (same idea for opponent replies
 * against opponentBranchMinShare/opponentBranchMinGames) — see
 * computeNodeFromRaw. Any of those three leafReasons triggers escalating to
 * the next history tier before giving up — see the header comment — so a
 * leaf reaching the caller with one of those reasons means all-time
 * history has already been tried and still wasn't enough, not just
 * whatever the first tier happened to find. Critically, this escalation
 * check runs even on a cache hit: a cached entry that's still a leaf and
 * hasn't yet been tried at every tier gets escalated right now rather than
 * served as-is just because it's within its freshness window — otherwise a
 * position that was insufficient at 1 month the first time it was ever
 * fetched would keep re-showing that same stale, un-escalated leaf on
 * every read until the cache happened to go stale, which could be a long
 * wait (repertoireMaxAgeMonths defaults to a full month).
 * Lazy — this is the only place a network request for opening data
 * happens; quiz/browse call it exactly when they navigate to a position,
 * not ahead of time.
 *
 * @param {string[]} uciPath moves from the start position, in UCI form
 * @param {'white'|'black'} color which repertoire this is for
 * @param {object} settings
 * @param {{signal?: AbortSignal, onBeforeFetch?: () => void, onFetchProgress?: ({completed:number,total:number}) => void, cache?: {getCached, putCached}}} opts
 *   onBeforeFetch fires synchronously, only when a real network request is
 *   about to happen — including when a cache hit turns out to need
 *   escalating — the hook for "hold on, fetching…" UX. onFetchProgress
 *   fires after each individual request completes, `total` starting at 1
 *   (the common case: just the tier-1 request) and growing to 12 or 13 if
 *   escalation actually kicks in — for a progress bar that reflects
 *   however many requests THIS lookup ends up actually needing, not a
 *   fixed worst-case estimate. Never fires on a pure cache hit. cache
 *   defaults to the real IndexedDB-backed one; tests inject a fake
 *   in-memory implementation instead.
 */
export async function getPosition(uciPath, color, settings, opts = {}) {
  const cache = opts.cache || { getCached, putCached };
  const maxPlies = Number.isFinite(settings.maxPlies) ? settings.maxPlies : Infinity;
  if (uciPath.length >= maxPlies) {
    return { node: { games: 0, myMove: null, opponentMoves: null, leafReason: 'max-depth' }, cacheHit: true, fetchedAt: null, cacheKey: null };
  }

  const queryParams = explorerQueryParams(settings);
  const { month, monthsBack } = await resolveMonthCached(queryParams, settings.lichessToken, opts);
  const key = cacheKeyFor(queryParams, month, uciPath);
  const token = settings.lichessToken;

  const cachedEntry = await cache.getCached(key);
  const maxAgeMs = (settings.repertoireMaxAgeMonths || 1) * MS_PER_MONTH;
  const cacheIsFresh = !!cachedEntry && Date.now() - cachedEntry.fetchedAt < maxAgeMs;

  let raw, windowMonths;
  let firedBeforeFetch = false;
  const fireBeforeFetchOnce = () => { if (!firedBeforeFetch) { firedBeforeFetch = true; opts.onBeforeFetch?.(); } };

  const progress = { completed: 0, total: 1 };
  const tick = () => { progress.completed++; opts.onFetchProgress?.({ completed: progress.completed, total: progress.total }); };
  const bumpTotal = (delta) => { progress.total += delta; opts.onFetchProgress?.({ completed: progress.completed, total: progress.total }); };

  if (cacheIsFresh) {
    raw = cachedEntry.data;
    // windowMonths rides along inside the cached data itself — ?? 1 covers
    // a cache entry written before this field existed.
    windowMonths = raw.windowMonths ?? 1;
  } else {
    fireBeforeFetchOnce();
    raw = mergeMovesData(await fetchMonths(queryParams, uciPath, monthsBack, 1, token, opts, tick));
    windowMonths = 1;
  }

  const escalation = await escalateIfNeeded(raw, windowMonths, {
    queryParams, uciPath, monthsBack, color, settings, token, opts, onEscalating: fireBeforeFetchOnce, tick, bumpTotal,
  });
  raw = escalation.raw;
  windowMonths = escalation.windowMonths;

  // A cache hit that needed escalating did real network work, so it isn't
  // really a "hit" anymore in the sense callers care about (whether a
  // fetch happened) — and either way, freshly-grown data is worth writing
  // back so the next read doesn't have to redo it.
  const cacheHit = cacheIsFresh && !escalation.escalated;
  const fetchedAt = cacheHit ? cachedEntry.fetchedAt : Date.now();
  if (!cacheHit) await cache.putCached(key, { ...raw, windowMonths });

  const node = computeNodeFromRaw(raw, color, uciPath.length, settings);
  const totalGames = raw.moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
  // Debug/UI info: which tier this position's data actually came from, and
  // how many games it found there. Attached to the node (rather than a
  // separate return field) so it rides along wherever a node does, e.g.
  // through quiz.js's getNode without that needing its own plumbing.
  node.windowInfo = { windowMonths, totalGames };
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
