import { Chess } from './vendor/chess.esm.js';
import { sanToSpeech } from './chessUtil.js';

// Analysis mode is engine narration, not an open-ended chatbot: Stockfish
// runs locally (free, no API key) and we recognize a handful of question
// intents by keyword, then read back its numbers in plain language. It can't
// improvise beyond that — see the settings screen for the LLM-chat tradeoff.

function scoreToWords(info, fenSideToMove) {
  if (info.scoreMate !== null && info.scoreMate !== undefined) {
    const mateSide = (info.scoreMate > 0) === (fenSideToMove === 'w') ? 'White' : 'Black';
    return `${mateSide} has a forced mate in ${Math.abs(info.scoreMate)}.`;
  }
  if (info.scoreCp === null || info.scoreCp === undefined) return "I don't have an evaluation yet.";
  const pawns = Math.abs(info.scoreCp) / 100;
  const favoring = (info.scoreCp > 0) === (fenSideToMove === 'w') ? 'White' : 'Black';
  if (pawns < 0.3) return "It's roughly equal.";
  const magnitude = pawns < 1 ? 'slightly better' : pawns < 2.5 ? 'clearly better' : pawns < 5 ? 'winning' : 'completely winning';
  return `${favoring} is ${magnitude}, about ${pawns.toFixed(1)} pawns.`;
}

function pvToSpeech(fen, pv, count = 3) {
  const chess = new Chess(fen);
  const sans = [];
  for (const uci of pv.slice(0, count)) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promotion = uci.length > 4 ? uci[4] : undefined;
    const move = chess.move({ from, to, promotion });
    if (!move) break;
    sans.push(sanToSpeech(move.san));
  }
  return sans;
}

const INTENTS = [
  { name: 'best-move', re: /best move|what should i play|what.?s the move|what do you (recommend|suggest)/ },
  { name: 'eval', re: /eval|who.?s better|who is winning|what.?s the score/ },
  { name: 'threat', re: /threat|what.?s (he|she|they|black|white) (doing|planning)|what am i missing/ },
  { name: 'line', re: /line|continuation|what happens next|play it out/ },
  { name: 'repeat', re: /repeat|say (that|it) again|what did you say/ },
];

export class AnalysisSession {
  constructor(engine, { movetimeMs = 1500 } = {}) {
    this.engine = engine;
    this.movetimeMs = movetimeMs;
    this.lastSpoken = "I haven't said anything yet.";
  }

  detectIntent(transcript) {
    const lower = (transcript || '').toLowerCase();
    for (const intent of INTENTS) if (intent.re.test(lower)) return intent.name;
    return 'best-move'; // sensible default when the phrasing doesn't match a known pattern
  }

  async answer(transcript, fen) {
    const intent = this.detectIntent(transcript);
    if (intent === 'repeat') return this.lastSpoken;

    const sideToMove = fen.split(' ')[1] || 'w';
    let analyzeFen = fen;
    if (intent === 'threat') {
      // "What's the threat" = what would the opponent do with an extra move.
      // Flipping side-to-move for a moment is the standard trick for this.
      const parts = fen.split(' ');
      parts[1] = parts[1] === 'w' ? 'b' : 'w';
      parts[3] = '-'; // drop en-passant target, it's meaningless after a hypothetical null move
      analyzeFen = parts.join(' ');
    }

    await this.engine.setPosition(analyzeFen);
    const { bestmove, info } = await this.engine.go({ movetimeMs: this.movetimeMs });

    let text;
    if (intent === 'eval') {
      text = scoreToWords(info, sideToMove);
    } else if (intent === 'threat') {
      const [first] = pvToSpeech(analyzeFen, info.pv, 1);
      text = first
        ? `If you passed, the threat is ${first}. ${scoreToWords(info, analyzeFen.split(' ')[1])}`
        : "I don't see a concrete threat right now.";
    } else if (intent === 'line') {
      const words = pvToSpeech(fen, info.pv, 4);
      text = words.length ? `A likely continuation is ${words.join(', then ')}.` : "I don't have a line for this yet.";
    } else {
      const [first] = pvToSpeech(fen, bestmove ? [bestmove] : [], 1);
      text = first ? `The best move is ${first}. ${scoreToWords(info, sideToMove)}` : "I couldn't find a move.";
    }

    this.lastSpoken = text;
    return text;
  }
}
