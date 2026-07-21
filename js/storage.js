// Local persistence: settings and per-line mastery stats live in
// localStorage. Cached opening positions live separately in IndexedDB (see
// positionCache.js) — there could be thousands of them over time, well
// past what localStorage's quota comfortably holds.

const NS = 'chessrep.';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch (err) {
    console.error('storage write failed', key, err);
  }
}

export const DEFAULT_SETTINGS = {
  colors: ['white', 'black'],
  ratingBands: ['1600', '1800', '2000'], // lichess explorer rating buckets to pool together
  speeds: ['blitz', 'rapid'],
  minSampleSize: 20,     // a node needs at least this many games to be trusted/expanded
  maxPlies: 40,          // hard safety cap on how deep a single quiz line can go; null/Infinity = no cap
  opponentBranchMinShare: 0.05, // ignore opponent replies played less than 5% of the time at a node
  opponentBranchMinGames: 15,   // ...unless they still clear this absolute game-count floor
  repertoireMaxAgeMonths: 1,    // a cached position older than this gets transparently refetched next time it's needed; decimals allowed (e.g. 0.5)
  alwaysReplayOnSuccess: false, // if true, drill every line twice, not just missed ones
  dimScreenDuringQuiz: true,
  voiceURI: null,        // chosen SpeechSynthesis voice, if any
  speechRate: 0.95,
  lichessToken: '',      // required as of the explorer API's OAuth requirement; see Setup
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON('settings', {}) };
}

export function saveSettings(settings) {
  writeJSON('settings', settings);
}

// Mastery stats keyed by a path id (sequence of UCI moves joined with space).
export function loadLineStats(color) {
  return readJSON('linestats.' + color, {});
}

export function saveLineStats(color, stats) {
  writeJSON('linestats.' + color, stats);
}

export function recordLineResult(color, pathId, missed) {
  const stats = loadLineStats(color);
  const s = stats[pathId] || { seen: 0, misses: 0, lastResult: null, lastSeenAt: null };
  s.seen += 1;
  if (missed) s.misses += 1;
  s.lastResult = missed ? 'miss' : 'clean';
  s.lastSeenAt = Date.now();
  stats[pathId] = s;
  saveLineStats(color, stats);
  return s;
}

// Which Lichess-indexed calendar month explorer.js last resolved to, per
// (ratings, speeds) query signature — persisted (not just kept in memory)
// so Browse can find previously-cached positions after a fresh page load
// without itself making a network call to re-resolve the month; quizzing is
// what actually (re)does that resolution and keeps this up to date.
export function loadResolvedMonth(signature) {
  return readJSON('resolvedMonths', {})[signature] || null;
}

export function saveResolvedMonth(signature, entry) {
  const all = readJSON('resolvedMonths', {});
  all[signature] = entry;
  writeJSON('resolvedMonths', all);
}
