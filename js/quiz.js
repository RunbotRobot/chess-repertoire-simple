import { Chess } from './vendor/chess.esm.js';
import { recordLineResult } from './storage.js';

export const ABORT = '__quiz_abort__';
export class QuizAbort extends Error {}

function weightedPick(candidates) {
  const total = candidates.reduce((s, c) => s + c.games, 0);
  if (total <= 0) return candidates[0] || null;
  let r = Math.random() * total;
  for (const c of candidates) {
    r -= c.games;
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

function applyUci(chess, uci) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  return chess.move({ from, to, promotion });
}

/**
 * Drives one quiz session against a prebuilt repertoire tree.
 *
 * Flow per "line": play from the root, opponent replies sampled live by
 * real game frequency, I supply my moves by voice. First wrong move stops
 * the attempt and reveals the correct one. If it was missed, the exact same
 * line (the opponent moves actually seen) is replayed once immediately for
 * memorization before moving on to a freshly-sampled next line.
 */
export class QuizSession {
  constructor({ repertoire, settings, color, handlers }) {
    this.repertoire = repertoire;
    this.settings = settings;
    this.color = color;
    this.handlers = handlers; // see method docs below for the shape
  }

  async runPlaythrough(forcedUciPath = null) {
    const chess = new Chess();
    let node = this.repertoire.root;
    const attemptPath = [];
    let missed = false;
    let idx = 0;

    while (node.myMove || node.opponentMoves) {
      const isMyMove = !!node.myMove;

      if (!isMyMove) {
        const options = node.opponentMoves
          .map((m) => ({ ...m, child: node.children[m.uci] }))
          .filter((m) => m.child);
        if (options.length === 0) break;
        const chosen = forcedUciPath ? options.find((o) => o.uci === forcedUciPath[idx]) : weightedPick(options);
        if (!chosen) break;
        const moveResult = applyUci(chess, chosen.uci);
        if (!moveResult) break; // shouldn't happen; defends against a corrupt tree
        attemptPath.push({ uci: chosen.uci, san: chosen.san, mover: 'opponent' });
        await this.handlers.onOpponentMove?.({ san: chosen.san, uci: chosen.uci, fen: chess.fen() });
        node = node.children[chosen.uci];
        idx++;
        continue;
      }

      const legalMoves = chess.moves({ verbose: true });
      const userSan = await this.handlers.onAwaitingUserMove?.({
        fen: chess.fen(),
        legalMoves,
        correctSan: node.myMove.san, // only used for hint/replay UI, not shown during the actual test
      });

      if (userSan === ABORT) throw new QuizAbort();
      const correct = userSan === node.myMove.san;

      if (correct) applyUci(chess, node.myMove.uci);
      await this.handlers.onResult?.({
        correct,
        correctSan: node.myMove.san,
        correctUci: node.myMove.uci,
        userSan,
        fen: chess.fen(), // post-move fen when correct; unchanged (pre-move) fen on a miss
      });

      if (!correct) {
        missed = true;
        break;
      }
      attemptPath.push({ uci: node.myMove.uci, san: node.myMove.san, mover: 'me' });
      node = node.children[node.myMove.uci];
      idx++;
    }

    return {
      missed,
      attemptPath,
      pathId: attemptPath.map((p) => p.uci).join(' '),
      // Only meaningful on a clean finish: whether the line ended here
      // because the position budget ran out (real theory may well
      // continue past this point) rather than genuinely running out of
      // common enough opponent replies / well-scoring options.
      truncated: !missed && !!node.truncatedByCap,
    };
  }

  /**
   * Plays one fresh line, then (if missed, or if alwaysReplayOnSuccess is
   * set) immediately replays that exact same line once for memorization.
   * Returns the outcome of the original attempt.
   */
  async playNextLine() {
    await this.handlers.onLineStart?.({ color: this.color });
    const result = await this.runPlaythrough(null);
    recordLineResult(this.color, result.pathId || '(root)', result.missed);
    await this.handlers.onLineEnd?.(result);

    if (result.attemptPath.length > 0 && (result.missed || this.settings.alwaysReplayOnSuccess)) {
      const forcedUci = result.attemptPath.map((p) => p.uci);
      await this.handlers.onReplayStart?.(result.attemptPath);
      const replay = await this.runPlaythrough(forcedUci);
      await this.handlers.onReplayEnd?.(replay);
    }

    return result;
  }
}

/*
handlers shape:
  onLineStart({color}) -> Promise<void>                fires once, before a fresh line begins (not before a
                                                        memorization replay); useful to announce the color
                                                        when quizzing "both" repertoires in one session
  onOpponentMove({san, uci, fen}) -> Promise<void>    announce the opponent's move (voice) or render it
                                                        (board/text), resolve when done. fen is the position
                                                        after this move; uci is handy for board highlighting.
  onAwaitingUserMove({fen, legalMoves, correctSan}) -> Promise<string san>
                                                        collect the user's move (voice or on-screen), resolve
                                                        with the SAN it matched (or a value that won't match
                                                        correctSan, e.g. '', on timeout/giveup)
  onResult({correct, correctSan, correctUci, userSan, fen}) -> Promise<void>
                                                        confirm / reveal the correct move. fen reflects the
                                                        position after the move when correct, or is unchanged
                                                        (pre-move) on a miss, so a board can be kept in sync.
  onLineEnd({missed, attemptPath, truncated}) -> Promise<void>
                                                        truncated is true only on a clean finish that hit the
                                                        position budget rather than a real end of theory
  onReplayStart(attemptPath) -> Promise<void>
  onReplayEnd({missed, attemptPath}) -> Promise<void>
*/
