// Helpers that sit between chess.js and the speech layer: turning a SAN move
// into something worth saying out loud, and turning a rough voice transcript
// back into a legal move. Also click-to-move's own from/to matching, shared
// by Browse and manual quiz so both get the same castling behavior.

const PIECE_WORDS = { N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
const PIECE_LETTERS = Object.fromEntries(Object.entries(PIECE_WORDS).map(([l, w]) => [w, l]));

// chess.js represents castling as the king's own two-square hop (e.g.
// e1->g1 for White kingside) — that's what a move's `to` actually is, and
// what the rest of the app (uci comparisons against cached Lichess data,
// applyUci in quiz.js) all key off. But several chess UIs, including
// lichess.org's own board, also accept "tap the king, then tap its own
// rook" as a castling gesture, since that's closer to the physical motion.
// This maps each castling destination to that rook's home square, purely so
// board taps can recognize the gesture — it never changes what move is
// actually played.
export const CASTLE_ROOK_SQUARE = { g1: 'h1', c1: 'a1', g8: 'h8', c8: 'a8' };

// Confirmed live against the real API (not just docs): Lichess's opening
// explorer represents a castling move's uci as the king "capturing" its own
// rook — e.g. e1h1 for White kingside — rather than chess.js's own
// two-square king hop (e1g1) that applyUci (quiz.js) and the from/to
// comparisons throughout this app all expect. Left unnormalized, every
// castling move sourced from Lichess data fails outright: chess.js rejects
// {from:'e1', to:'h1'} as an illegal king move (there's a friendly piece
// there), so both playing my own castling move and the opponent castling
// throw "Invalid move" mid-quiz. Standard (non-Chess960) chess always has
// the king on e1/e8 whenever it's legal to castle, so this mapping is exact
// and total — never a Chess960 wrinkle. Derived from CASTLE_ROOK_SQUARE
// (inverted) so the two tables can't drift apart.
const CASTLE_UCI_ROOK_TO_KING = Object.fromEntries(
  Object.entries(CASTLE_ROOK_SQUARE).map(([kingDest, rookSquare]) => {
    const from = rookSquare === 'h1' || rookSquare === 'a1' ? 'e1' : 'e8';
    return [`${from}${rookSquare}`, `${from}${kingDest}`];
  })
);

/**
 * Normalizes a uci string sourced from Lichess data into the form chess.js
 * (and the rest of this app) expects, fixing up the king-captures-rook
 * castling notation described above. A no-op for every non-castling move.
 * @param {string} uci
 * @returns {string}
 */
export function normalizeLichessUci(uci) {
  return CASTLE_UCI_ROOK_TO_KING[uci] || uci;
}

/**
 * Resolves which legal move (if any) a click/tap on `to` means, given a
 * piece already selected on `from`. Prefers a direct destination match;
 * falls back to the king-taps-its-rook castling gesture (see
 * CASTLE_ROOK_SQUARE) when `to` is a rook's home square rather than the
 * king's own landing square. A pawn reaching the last rank offers one move
 * per promotion choice sharing the same from/to — always resolves to queen
 * rather than showing an underpromotion picker, which is fine for opening
 * drilling.
 * @param {Array<{from:string,to:string,promotion?:string,flags?:string}>} legalMoves
 * @param {string} from
 * @param {string} to
 * @returns {{from:string,to:string,san:string}|null}
 */
export function findClickedMove(legalMoves, from, to) {
  const direct = legalMoves.filter((m) => m.from === from && m.to === to);
  if (direct.length > 0) return direct.find((m) => m.promotion === 'q') || direct[0];
  const castleDest = Object.keys(CASTLE_ROOK_SQUARE).find((dest) => CASTLE_ROOK_SQUARE[dest] === to);
  if (!castleDest) return null;
  return legalMoves.find((m) => m.from === from && m.to === castleDest && (m.flags?.includes('k') || m.flags?.includes('q'))) || null;
}

export function sanToSpeech(san) {
  if (!san) return '';
  if (san.startsWith('O-O-O')) return 'castles queenside' + (san.includes('+') ? ', check' : '');
  if (san.startsWith('O-O')) return 'castles kingside' + (san.includes('+') ? ', check' : '');

  let s = san.replace(/[+#]$/, '');
  const isCheck = san.endsWith('+');
  const isMate = san.endsWith('#');

  let promo = '';
  const promoMatch = s.match(/=([QRBN])$/);
  if (promoMatch) {
    promo = `, promotes to ${PIECE_WORDS[promoMatch[1]]}`;
    s = s.slice(0, promoMatch.index);
  }

  const pieceMatch = s.match(/^([KQRBN])/);
  const piece = pieceMatch ? PIECE_WORDS[pieceMatch[1]] : 'pawn';
  let rest = pieceMatch ? s.slice(1) : s;

  const captures = rest.includes('x');
  rest = rest.replace('x', ' takes ');

  // Spell out the destination square letter-by-letter-ish so TTS doesn't
  // mangle e.g. "f3" into "f. three" oddly — spacing the file/rank helps.
  rest = rest.replace(/([a-h])(\d)/g, '$1 $2');

  let phrase = piece === 'pawn' && !captures ? rest : `${piece} ${rest}`;
  phrase = phrase.replace(/\s+/g, ' ').trim();
  if (promo) phrase += promo;
  if (isMate) phrase += ', checkmate';
  else if (isCheck) phrase += ', check';
  return phrase;
}

// Normalize a raw voice transcript into a compact token we can compare
// against normalized legal SAN moves, e.g. "knight takes f3, check" -> "nxf3".
export function normalizeSpokenMove(transcript) {
  let t = (transcript || '').toLowerCase().trim();
  t = t.replace(/[.,!?]/g, ' ');
  t = t.replace(/\bqueen side\b/g, 'queenside').replace(/\bking side\b/g, 'kingside');
  if (/\b(castles?|castling)\b.*\bqueenside\b|\blong castle\b/.test(t)) return 'o-o-o';
  if (/\b(castles?|castling)\b.*\bkingside\b|\bshort castle\b/.test(t) || /^castles?$/.test(t.trim())) return 'o-o';

  for (const [word, letter] of Object.entries(PIECE_LETTERS)) {
    t = t.replace(new RegExp('\\b' + word + '\\b', 'g'), letter.toLowerCase());
  }
  t = t.replace(/\bpawn\b/g, '');
  t = t.replace(/\b(takes|captures|capture)\b/g, 'x');
  t = t.replace(/\bcheck\b|\bcheckmate\b|\bmate\b/g, '');
  t = t.replace(/\bpromotes?\s*to\b/g, '=');
  t = t.replace(/\bequals\b/g, '=');
  t = t.replace(/\bto\b/g, '');
  // Keep file letters a-h, piece letters (n/b/r/q/k), digits, and move syntax.
  t = t.replace(/[^a-hnrqkox0-9=\-]/g, '');
  return t.trim();
}

function normalizeSan(san) {
  return san.toLowerCase().replace(/[+#]/g, '');
}

/**
 * Match a voice transcript to one of the currently-legal moves.
 * @param {string} transcript
 * @param {Array<{san:string}>} legalMoves
 * @returns {{san:string}|null}
 */
export function matchSpokenMove(transcript, legalMoves) {
  const spoken = normalizeSpokenMove(transcript);
  if (!spoken) return null;

  for (const m of legalMoves) {
    if (normalizeSan(m.san) === spoken) return m;
  }
  // Fall back to edit-distance in case of minor mis-hearings (e.g. "f3" vs "f three" quirks).
  let best = null;
  let bestDist = Infinity;
  for (const m of legalMoves) {
    const d = levenshtein(spoken, normalizeSan(m.san));
    if (d < bestDist) { bestDist = d; best = m; }
  }
  const threshold = Math.max(1, Math.floor(spoken.length * 0.3));
  return bestDist <= threshold ? best : null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
