// Helpers that sit between chess.js and the speech layer: turning a SAN move
// into something worth saying out loud, and turning a rough voice transcript
// back into a legal move.

const PIECE_WORDS = { N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
const PIECE_LETTERS = Object.fromEntries(Object.entries(PIECE_WORDS).map(([l, w]) => [w, l]));

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
