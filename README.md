# Opening Drill

A verbally-quizzed chess opening repertoire trainer. Static PWA, no backend,
no accounts, no build step — open `index.html` (served over http/https; it
won't work from `file://` because ES modules and the service worker both
require a real origin).

## How it works

1. **Setup** pulls move-frequency data live from the
   [Lichess Opening Explorer](https://lichess.org/api#tag/Opening-Explorer)
   for whichever colors/rating bands/time controls you pick, and builds a
   repertoire tree:
   - On *your* moves, it always takes whichever legal reply scored highest
     in those real games, with draws counted as a loss.
   - On the *opponent's* moves, it keeps every reply that's actually common
     (configurable thresholds) — you need to be ready for whichever one
     shows up.
2. **Browse** lets you step through the resulting tree with a board, to
   sanity-check what it picked before you trust it.
3. **Quiz** plays it verbally: the opponent's move is sampled live, weighted
   by how often it's actually played; you answer by voice. A wrong move
   stops that attempt, the correct move is read back, and the exact same
   line is immediately replayed once for memorization before moving on to a
   freshly-sampled line. Say **"Analyze"** any time to pause and ask a local
   Stockfish about the position by voice; say **"Quiz"** to resume exactly
   where you left off.

## Known platform limits (read before assuming a bug)

- **The window is a calendar month, not a rolling 30 days.** Lichess's
  explorer API only accepts `since`/`until` as `YYYY-MM`. There's no way to
  get a true day-by-day rolling window without ingesting and storing raw
  games ourselves, which isn't practical for a personal app. Instead the
  repertoire is scoped to the current calendar month and switches over to
  the next month's data on the 1st — so it changes once a month, not daily.
- **The screen never actually turns off.** iOS/Android suspend JavaScript
  (and the microphone) the instant the screen truly locks — no web app can
  listen through that. Instead, quiz mode keeps the screen *on* via the Wake
  Lock API but drives it fully black, which gets you the same practical
  result (no glow, battery mostly saved, mic and TTS keep working) without
  promising something the platform can't deliver. Tap the screen during a
  quiz to peek at the caption log if you want to confirm it's alive.
- **Analysis mode is engine narration, not a chatbot.** It runs Stockfish
  locally (free, no API key, no server) and recognizes a handful of question
  intents ("best move", "what's the eval", "what's the threat", "give me a
  line") by keyword, then reads back the numbers. It can't hold an
  open-ended conversation — that would require routing through an LLM,
  which needs an API key and a backend to keep that key secret.
- **Voice recognition is the browser's built-in Web Speech API**, for zero
  cost and zero backend. It's solid on Android Chrome; iOS Safari's
  `continuous` mode is unreliable, so listening is implemented as
  back-to-back one-shot passes that restart automatically — expect
  occasional half-second gaps rather than a perfectly seamless stream.

## Testing notes

This was built and tested in a sandboxed dev environment whose egress policy
blocks `lichess.org` outright, so the Lichess explorer integration could be
exercised against synthetic data (see the scoring/pruning logic) and a real
headless-browser smoke test (Stockfish WASM load + eval, tab navigation,
voice-transcript matching, board rendering) — but not a live end-to-end fetch
against the real API, and obviously not real screen-off/mic-through-lock
behavior on a physical phone. Test the live app on your own device before
trusting it for real study time.
