import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './storage.js';
import { getPosition, peekPosition } from './explorer.js';
import { getCacheStats, clearCache } from './positionCache.js';
import { renderBoard } from './board.js';
import * as speech from './speech.js';
import { matchSpokenMove, sanToSpeech, findClickedMove } from './chessUtil.js';
import { QuizSession, ABORT, QuizAbort } from './quiz.js';
import { Engine } from './engine.js';
import { AnalysisSession } from './analysis.js';
import * as wakelock from './wakelock.js';
import { Chess } from './vendor/chess.esm.js';

// Bump this on every deploy — it's the only way to confirm a phone without
// devtools is actually running the latest code, and it also drives the
// service worker's cache name (see sw.js) so updates actually take effect
// instead of being served stale from the offline cache.
export const APP_VERSION = 32;

const COLOR_OPTIONS = ['white', 'black'];
const RATING_OPTIONS = ['1000', '1200', '1400', '1600', '1800', '2000', '2200', '2500'];
const SPEED_OPTIONS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = loadSettings();

// ---------- debug / caption log ----------
const logEntries = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEntries.push(line);
  if (logEntries.length > 500) logEntries.shift();
  const text = logEntries.slice(-60).join('\n');
  for (const id of ['#debug-log-static', '#debug-log-setup']) {
    const el = $(id);
    if (el) { el.textContent = text; el.scrollTop = el.scrollHeight; }
  }
  const caption = $('#quiz-caption');
  if (caption) caption.textContent = msg;
}

async function copyLog(button) {
  const fullText = logEntries.join('\n');
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(fullText);
    } else {
      // Fallback for contexts without the async Clipboard API.
      const ta = document.createElement('textarea');
      ta.value = fullText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    button.textContent = 'Copied!';
  } catch (err) {
    button.textContent = 'Copy failed';
    console.error('copy log failed', err);
  }
  setTimeout(() => { button.textContent = original; }, 1500);
}

for (const id of ['#copy-log-quiz', '#copy-log-setup']) {
  $(id)?.addEventListener('click', (e) => copyLog(e.currentTarget));
}

// ---------- nav ----------
$$('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'browse') renderBrowse();
    if (btn.dataset.view === 'setup') renderCacheStatus();
  });
});

// ---------- settings form ----------
function chip(name, value, checked, type = 'checkbox') {
  const label = document.createElement('label');
  label.className = 'chip';
  label.innerHTML = `<input type="${type}" name="${name}" value="${value}" ${checked ? 'checked' : ''}> ${value}`;
  return label;
}

function buildChipRows() {
  const colorsRow = $('#colors-row');
  colorsRow.innerHTML = '';
  COLOR_OPTIONS.forEach((c) => colorsRow.appendChild(chip('colors', c, settings.colors.includes(c))));

  const ratingsRow = $('#ratings-row');
  ratingsRow.innerHTML = '';
  RATING_OPTIONS.forEach((r) => ratingsRow.appendChild(chip('ratings', r, settings.ratingBands.includes(r))));

  const speedsRow = $('#speeds-row');
  speedsRow.innerHTML = '';
  SPEED_OPTIONS.forEach((s) => speedsRow.appendChild(chip('speeds', s, settings.speeds.includes(s))));
}

function fillSettingsForm() {
  buildChipRows();
  $('#lichessToken').value = settings.lichessToken || '';
  $('#minSampleSize').value = settings.minSampleSize;
  $('#opponentBranchMinShare').value = Math.round(settings.opponentBranchMinShare * 100);
  $('#opponentBranchMinGames').value = settings.opponentBranchMinGames;
  $('#maxPlies').value = Number.isFinite(settings.maxPlies) ? settings.maxPlies : '';
  $('#repertoireMaxAgeMonths').value = settings.repertoireMaxAgeMonths;
  $('#targetGamesPerPosition').value = settings.targetGamesPerPosition;
  $('#alwaysReplayOnSuccess').checked = settings.alwaysReplayOnSuccess;
  $('#dimScreenDuringQuiz').checked = settings.dimScreenDuringQuiz;
  $('#showDebugLog').checked = readDebugPref();
  $('#speechRate').value = settings.speechRate;
  $('#speechRateVal').textContent = settings.speechRate.toFixed(2);
  populateVoices();

  if (!speech.support.stt || !speech.support.tts) {
    $('#voice-support-warn').textContent =
      (!speech.support.stt ? 'This browser has no speech recognition — quizzing by voice will not work. ' : '') +
      (!speech.support.tts ? 'This browser has no speech synthesis — the app cannot speak moves.' : '');
  }
}

function populateVoices() {
  const sel = $('#voiceSelect');
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  sel.innerHTML = '<option value="">(default)</option>' +
    voices.map((v) => `<option value="${v.voiceURI}" ${v.voiceURI === settings.voiceURI ? 'selected' : ''}>${v.name} (${v.lang})</option>`).join('');
}
if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = populateVoices;

function readDebugPref() {
  return localStorage.getItem('chessrep.showDebug') !== '0';
}

function readSettingsForm() {
  return {
    ...settings,
    lichessToken: $('#lichessToken').value.trim(),
    colors: $$('input[name=colors]:checked').map((i) => i.value),
    ratingBands: $$('input[name=ratings]:checked').map((i) => i.value),
    speeds: $$('input[name=speeds]:checked').map((i) => i.value),
    minSampleSize: Number($('#minSampleSize').value) || DEFAULT_SETTINGS.minSampleSize,
    opponentBranchMinShare: (Number($('#opponentBranchMinShare').value) || 0) / 100,
    opponentBranchMinGames: Number($('#opponentBranchMinGames').value) || 0,
    // Blank genuinely means "no ply cap" here, not "use the default".
    maxPlies: $('#maxPlies').value.trim() === '' ? Infinity : Number($('#maxPlies').value),
    repertoireMaxAgeMonths: Number($('#repertoireMaxAgeMonths').value) || DEFAULT_SETTINGS.repertoireMaxAgeMonths,
    targetGamesPerPosition: Number($('#targetGamesPerPosition').value) || DEFAULT_SETTINGS.targetGamesPerPosition,
    alwaysReplayOnSuccess: $('#alwaysReplayOnSuccess').checked,
    dimScreenDuringQuiz: $('#dimScreenDuringQuiz').checked,
    voiceURI: $('#voiceSelect').value || null,
    speechRate: Number($('#speechRate').value),
  };
}

$('#speechRate').addEventListener('input', () => { $('#speechRateVal').textContent = Number($('#speechRate').value).toFixed(2); });

$('#save-settings').addEventListener('click', () => {
  settings = readSettingsForm();
  saveSettings(settings);
  localStorage.setItem('chessrep.showDebug', $('#showDebugLog').checked ? '1' : '0');
  log('Settings saved.');
});

function cap(s) { return s[0].toUpperCase() + s.slice(1); }

// Shared by both quiz modes: what to say when a line ends not because it
// was missed, but because the position doesn't offer a confident pick to
// keep quizzing. leafReason (see explorer.js's computeNodeFromRaw doc)
// distinguishes *why* — critically, "plenty of total games here" and
// "confident pick available" are NOT the same thing: a position can clear
// minSampleSize in aggregate while every individual move/reply stays under
// it (e.g. 22 games split 8/7/7 against a 20 threshold), which used to get
// reported with the same "not enough games" wording as genuine data
// scarcity even though the total shown was already >= the threshold quoted
// right next to it — confusing and, read literally, just wrong.
function leafGamesMessage(leafGames, leafReason, settings) {
  if (leafReason === 'max-depth') {
    return "Reached the max depth limit set in Setup — not that the line necessarily ends here.";
  }
  if (leafReason === 'no-qualifying-move') {
    return `${leafGames} games here, but no single move individually has ${settings.minSampleSize}+ of them — too split up to trust any one pick.`;
  }
  if (leafReason === 'no-qualifying-reply') {
    const sharePct = Math.round(settings.opponentBranchMinShare * 100);
    return `${leafGames} games here, but no single opponent reply is common enough to prepare for (need ${sharePct}%+ share or ${settings.opponentBranchMinGames}+ games).`;
  }
  // 'insufficient-total', or an older/unrecognized reason — genuine data scarcity.
  if (!leafGames) return "No games recorded at this position — you've reached the edge of known theory.";
  return `Only ${leafGames} game${leafGames === 1 ? '' : 's'} here — not enough to trust (need ${settings.minSampleSize}+).`;
}

function formatWindowSize(months) {
  if (months == null) return 'unknown';
  return months === 'full' ? 'full history' : `${months} month${months === 1 ? '' : 's'}`;
}

// Testing/debugging detail about the adaptive history window (see
// explorer.js's header comment) behind a leaf: how much history this
// position's data actually came from, and what the next fetch would try —
// separate from leafGamesMessage since it's not something worth reading
// aloud in voice mode, only logging.
function windowInfoDebugText(windowInfo) {
  if (!windowInfo) return null;
  return `window: fetched ${formatWindowSize(windowInfo.windowMonths)} (${windowInfo.totalGames} games); next fetch will try ${formatWindowSize(windowInfo.nextWindowMonths)}.`;
}

// ---------- position cache status ----------
async function renderCacheStatus() {
  const el = $('#cache-stats');
  const errBox = $('#cache-error');
  errBox.style.display = 'none';
  try {
    const stats = await getCacheStats();
    el.textContent = stats.count
      ? `${stats.count} position(s) cached — oldest fetched ${new Date(stats.oldest).toLocaleString()}, newest ${new Date(stats.newest).toLocaleString()}.`
      : 'No positions cached yet — they get fetched and stored the first time Browse or Quiz actually reach them.';
  } catch (err) {
    errBox.style.display = 'block';
    errBox.textContent = `Could not read the position cache: ${err.message}`;
  }
}

$('#clear-cache').addEventListener('click', async () => {
  await clearCache();
  log('Position cache cleared.');
  await renderCacheStatus();
});

// ---------- browse view ----------
let browseColor = 'white';
let browsePath = []; // array of {uci, san}
let browseLegalMoves = [];
let browseSelectedSquare = null;
let browseCurrentNode = null;
let browseCurrentCached = false;
$$('input[name=browse-color]').forEach((r) => r.addEventListener('change', () => {
  browseColor = r.value; browsePath = []; browseSelectedSquare = null; renderBrowse();
}));

// Browse only ever shows what's already cached — it never talks to
// Lichess itself; only quizzing does that (see explorer.js's header
// comment on the Browse/quiz split). A monotonic request id still guards
// against a slow IndexedDB read landing after the user has already
// navigated elsewhere.
let browseRequestId = 0;

// Click-to-move on the Browse board, for either side: click a piece, then
// a destination square. Unlike the manual quiz (where every legal move is
// fair game), Browse is walking a specific cached repertoire, so the two
// sides behave differently:
//  - on the repertoire's own move (browseColor to move), only the exact
//    cached myMove actually navigates — this isn't a quiz, but there's
//    still only one "right" move to explore *as the repertoire*, so an
//    off-book click is rejected rather than pretending it's part of it.
//  - on the opponent's move, any legal reply can be explored, but only
//    navigates if it's actually cached (met the threshold and got kept in
//    opponentMoves); otherwise Browse says so by name rather than
//    silently doing nothing or fetching (which it never does).
function handleBrowseSquareClick(square) {
  if (browseSelectedSquare) {
    if (square === browseSelectedSquare) { browseSelectedSquare = null; renderBrowse(); return; }
    const move = findClickedMove(browseLegalMoves, browseSelectedSquare, square);
    if (move) {
      browseSelectedSquare = null;
      attemptBrowseMove(move);
      return;
    }
  }
  const hasMovesFrom = browseLegalMoves.some((m) => m.from === square);
  browseSelectedSquare = hasMovesFrom ? square : null;
  renderBrowse();
}

async function attemptBrowseMove(move) {
  // chess.js's verbose move objects carry {from, to, promotion}, not a
  // combined uci string — build the same uci format the cached data uses
  // (see explorer.js) so the two can be compared.
  const moveUci = move.from + move.to + (move.promotion || '');
  const isMyMoveNow = (browsePath.length % 2 === 0) === (browseColor === 'white');
  const chess = new Chess();
  for (const step of browsePath) chess.move(step.san);
  const moveNumber = Math.floor(browsePath.length / 2) + 1;
  const numberPrefix = chess.turn() === 'w' ? `${moveNumber}.` : `${moveNumber}...`;

  if (isMyMoveNow) {
    if (browseCurrentCached && browseCurrentNode?.myMove?.uci === moveUci) {
      browsePath = [...browsePath, browseCurrentNode.myMove];
      await renderBrowse();
      return;
    }
    await renderBrowse(); // re-renders the same position, clearing the selection
    $('#browse-feedback').textContent = `${numberPrefix} ${move.san} isn't this repertoire's move here.`;
    return;
  }

  const cachedMatch = browseCurrentCached && browseCurrentNode?.opponentMoves?.find((m) => m.uci === moveUci);
  if (cachedMatch) {
    browsePath = [...browsePath, cachedMatch];
    await renderBrowse();
    return;
  }
  await renderBrowse();
  $('#browse-feedback').textContent = `${numberPrefix} ${move.san} not in cache.`;
}

async function renderBrowse() {
  const boardWrap = $('#board-wrap');
  const breadcrumb = $('#browse-breadcrumb');
  const movelist = $('#browse-movelist');
  const myRequestId = ++browseRequestId;
  $('#browse-feedback').textContent = '';

  const chess = new Chess();
  for (const step of browsePath) chess.move(step.san);
  browseLegalMoves = chess.moves({ verbose: true });
  // Deliberately NOT resetting browseSelectedSquare here — renderBrowse()
  // also runs to redraw an in-place selection (handleBrowseSquareClick
  // calls it after setting browseSelectedSquare). Every call site that
  // actually changes browsePath/browseColor resets the selection itself.
  renderBoard(boardWrap, chess.fen(), {
    orientation: browseColor,
    lastMove: browsePath.length ? { from: browsePath[browsePath.length - 1].uci.slice(0, 2), to: browsePath[browsePath.length - 1].uci.slice(2, 4) } : null,
    interactive: { legalMoves: browseLegalMoves, selectedSquare: browseSelectedSquare, onSquareClick: handleBrowseSquareClick },
  });

  breadcrumb.innerHTML = browsePath.length
    ? browsePath.map((s, i) => `<span class="san" data-idx="${i}">${s.san}</span>`).join(' ')
    : '(start position)';
  breadcrumb.querySelectorAll('.san').forEach((el) => {
    el.addEventListener('click', () => { browsePath = browsePath.slice(0, Number(el.dataset.idx) + 1); browseSelectedSquare = null; renderBrowse(); });
  });

  movelist.innerHTML = '';
  if (browsePath.length > 0) {
    const back = document.createElement('button');
    back.className = 'movebtn';
    back.textContent = '← Back';
    back.addEventListener('click', () => { browsePath = browsePath.slice(0, -1); browseSelectedSquare = null; renderBrowse(); });
    movelist.appendChild(back);
  }

  const { node, cached } = await peekPosition(browsePath.map((s) => s.uci), browseColor, settings);
  if (myRequestId !== browseRequestId) return;
  browseCurrentNode = node;
  browseCurrentCached = cached;

  if (!cached) {
    movelist.insertAdjacentHTML('beforeend', `<div class="hint">Not fetched yet. Positions are only fetched while quizzing — run a quiz with these rating/speed filters to reach and cache this one.</div>`);
    return;
  }

  if (node.myMove) {
    const btn = document.createElement('button');
    btn.className = 'movebtn mine';
    btn.innerHTML = `<span>My move: ${node.myMove.san}</span><span class="pct">${node.myMove.games} games, ${(node.myMove.score * 100).toFixed(0)}% score</span>`;
    btn.addEventListener('click', () => { browsePath = [...browsePath, node.myMove]; browseSelectedSquare = null; renderBrowse(); });
    movelist.appendChild(btn);

    if (node.alternates && node.alternates.length > 0) {
      const label = document.createElement('div');
      label.className = 'hint';
      label.style.marginTop = '8px';
      label.textContent = 'Other candidates (not the repertoire pick, shown for reference):';
      movelist.appendChild(label);
      for (const alt of node.alternates) {
        const altBtn = document.createElement('button');
        altBtn.className = 'movebtn alt';
        altBtn.innerHTML = `<span>${alt.san}</span><span class="pct">${alt.games} games, ${(alt.score * 100).toFixed(0)}% score</span>`;
        altBtn.addEventListener('click', () => { browsePath = [...browsePath, alt]; browseSelectedSquare = null; renderBrowse(); });
        movelist.appendChild(altBtn);
      }
    }
  } else if (node.opponentMoves) {
    for (const m of node.opponentMoves) {
      const btn = document.createElement('button');
      btn.className = 'movebtn';
      btn.innerHTML = `<span>${m.san}</span><span class="pct">${(m.share * 100).toFixed(0)}% · ${m.games} games</span>`;
      btn.addEventListener('click', () => { browsePath = [...browsePath, m]; browseSelectedSquare = null; renderBrowse(); });
      movelist.appendChild(btn);
    }
    if (node.opponentMoves.length === 0) movelist.insertAdjacentHTML('beforeend', `<div class="hint">End of prepared theory for this line.</div>`);
  } else {
    movelist.insertAdjacentHTML('beforeend', `<div class="hint">End of prepared theory for this line.</div>`);
  }
}

// ---------- quiz + analysis ----------
const quizColorRadios = $$('input[name=quiz-color]');
const quizInputRadios = $$('input[name=quiz-input]');
const quizLive = $('#quiz-live');
const quizModeLabel = $('#quiz-mode-label');

// Default the Quiz tab's options to whatever was picked last time a quiz
// was actually started, rather than always resetting to White/Voice.
const savedColorRadio = quizColorRadios.find((r) => r.value === settings.lastQuizColor);
if (savedColorRadio) quizColorRadios.forEach((r) => { r.checked = r === savedColorRadio; });
const savedInputRadio = quizInputRadios.find((r) => r.value === settings.lastQuizInputMethod);
if (savedInputRadio) quizInputRadios.forEach((r) => { r.checked = r === savedInputRadio; });

function updateQuizInputHint() {
  const val = quizInputRadios.find((r) => r.checked).value;
  $('#quiz-input-hint').textContent = val === 'manual'
    ? 'Click a piece, then click where it goes. Tap "Analyze" any time to check the engine\'s opinion on the position without leaving the quiz — no mic or speaker involved.'
    : 'Say "Analyze" any time during the quiz to pause and ask the engine about the position. Say "Quiz" to resume. The screen will go black and stay awake — tap it to peek at the caption log.';
}
quizInputRadios.forEach((r) => r.addEventListener('change', updateQuizInputHint));
updateQuizInputHint();

let mode = 'idle'; // 'idle' | 'quiz' | 'analysis'
let listenHandle = null;
let listeningEnabled = false;
let pendingMoveResolve = null;
let pendingLegalMoves = [];
let pendingContinueResolve = null; // set while paused for a wrong-move correction or a low-confidence leaf, waiting for "ready"
let inReplay = false; // true for the whole duration of a memorization replay, so the mode label survives an Analyze/Quiz detour mid-replay
let noMatchStreak = 0;
let currentFen = new Chess().fen();
let engine = null;
let analysisSession = null;
let quizRunning = false;

quizLive.addEventListener('click', () => {
  quizLive.classList.add('peek');
  clearTimeout(quizLive._peekTimer);
  quizLive._peekTimer = setTimeout(() => quizLive.classList.remove('peek'), 4000);
});

async function speakGuarded(text) {
  log(`Speaking: ${text}`);
  pauseListening();
  await speech.speak(text, { rate: settings.speechRate, voiceURI: settings.voiceURI });
  if (listeningEnabled) resumeListening();
}

function pauseListening() {
  listenHandle?.stop();
  listenHandle = null;
}

function resumeListening() {
  if (listenHandle) return;
  listenHandle = speech.listenLoop({
    onTranscript: (text, isFinal) => {
      if (!isFinal) { $('#quiz-caption').textContent = text; return; }
      routeTranscript(text);
    },
    onError: (err) => {
      log(`Speech error: ${err.message}`);
      $('#quiz-mic-warn').textContent = err.message;
    },
    onStateChange: () => {},
  });
}

function routeTranscript(text) {
  log(`Heard: "${text}"`);
  const lower = text.toLowerCase();
  if (mode === 'quiz' && /\banalyze\b/.test(lower)) { enterAnalysis(); return; }
  if (mode === 'analysis' && /\bquiz\b/.test(lower)) { enterQuiz(); return; }
  if (mode === 'analysis') { handleAnalysisQuestion(text); return; }
  if (mode === 'quiz' && pendingContinueResolve && /\b(ready|next|continue)\b/.test(lower)) {
    const resolve = pendingContinueResolve;
    pendingContinueResolve = null;
    resolve();
    return;
  }
  if (mode === 'quiz') { handleQuizTranscript(text); return; }
}

// Pauses the quiz until "ready" (or "next"/"continue") is heard — used both
// after a wrong-guess correction and after a line ends on a low-confidence
// leaf, so the user decides when they're done (and done with any Analyze
// detour) rather than a fixed timer moving on regardless.
function waitForVoiceContinue() {
  return new Promise((resolve) => {
    pendingContinueResolve = () => resolve();
    if (!quizRunning) { pendingContinueResolve(); pendingContinueResolve = null; }
  });
}

function handleQuizTranscript(text) {
  if (!pendingMoveResolve) return; // opponent is "moving" / between plies, nothing to match yet
  const match = matchSpokenMove(text, pendingLegalMoves);
  if (match) {
    noMatchStreak = 0;
    const resolve = pendingMoveResolve;
    pendingMoveResolve = null;
    resolve(match.san);
  } else {
    noMatchStreak++;
    if (noMatchStreak >= 2) {
      noMatchStreak = 0;
      speakGuarded("I didn't recognize that move, please say it again.");
    }
  }
}

async function handleAnalysisQuestion(text) {
  if (!analysisSession) return;
  const answer = await analysisSession.answer(text, currentFen);
  await speakGuarded(answer);
}

async function enterAnalysis() {
  mode = 'analysis';
  quizModeLabel.textContent = 'Analysis';
  log('Entering analysis mode.');
  if (!engine) engine = new Engine();
  if (!analysisSession) analysisSession = new AnalysisSession(engine);
  await speakGuarded('Analysis. Ask about the position, or say quiz to resume.');
}

async function enterQuiz() {
  mode = 'quiz';
  quizModeLabel.textContent = inReplay ? 'Replay' : 'Quiz'; // an Analyze detour mid-replay shouldn't lose the replay indicator on return
  log('Resuming quiz.');
  await speakGuarded('Quiz.');
}

// Positions are fetched lazily, straight from Lichess, as the quiz reaches
// them — there's no pre-built repertoire to check for existence up front
// any more, just whether we're able to talk to Lichess at all.
function makeGetNode(color, onFetching) {
  return async (uciPath) => {
    const { node } = await getPosition(uciPath, color, settings, { onBeforeFetch: onFetching });
    return node;
  };
}

$('#start-quiz').addEventListener('click', async () => {
  const quizMode = quizColorRadios.find((r) => r.checked).value; // 'white' | 'black' | 'both'
  const inputMethod = quizInputRadios.find((r) => r.checked).value; // 'voice' | 'manual'

  if (!settings.lichessToken) {
    $('#quiz-mic-warn').textContent = 'No Lichess API token set — add one in Setup first.';
    return;
  }

  settings = { ...settings, lastQuizColor: quizMode, lastQuizInputMethod: inputMethod };
  saveSettings(settings);

  if (inputMethod === 'manual') {
    $('#quiz-mic-warn').textContent = '';
    await startManualQuiz(quizMode);
    return;
  }

  if (!speech.support.stt) {
    $('#quiz-mic-warn').textContent = 'This browser has no speech recognition support — switch to Manual mode above.';
    return;
  }
  $('#quiz-mic-warn').textContent = '';
  await startVoiceQuiz(quizMode);
});

async function startVoiceQuiz(quizMode) {
  quizLive.classList.add('active');
  if (settings.dimScreenDuringQuiz) {
    quizLive.classList.add('blackout');
    await wakelock.enableBlackout(quizLive);
  }
  listeningEnabled = true;
  mode = 'quiz';
  inReplay = false;
  quizModeLabel.textContent = 'Quiz';
  quizRunning = true;
  resumeListening();
  engine = engine || new Engine();
  engine.init().catch((err) => log(`Engine init failed (analysis mode will be unavailable): ${err.message}`));

  const handlers = {
    onLineStart: async ({ color }) => {
      if (quizMode === 'both') await speakGuarded(color === 'white' ? 'White.' : 'Black.');
    },
    onOpponentMove: async ({ san, fen }) => {
      currentFen = fen;
      log(`Opponent plays ${san}`);
      await speakGuarded(`They play ${sanSpoken(san)}.`);
    },
    onAwaitingUserMove: ({ fen, legalMoves }) => {
      currentFen = fen;
      pendingLegalMoves = legalMoves;
      return new Promise((resolve) => {
        pendingMoveResolve = (san) => resolve(san);
        if (!quizRunning) resolve(ABORT);
      });
    },
    onResult: async ({ correct, correctSan }) => {
      if (correct) {
        log(`Correct: ${correctSan}`);
        return;
      }
      log(`Missed. Correct was ${correctSan}.`);
      await speakGuarded(`Not quite. The move was ${sanSpoken(correctSan)}. Say ready when you want to continue.`);
      await waitForVoiceContinue();
    },
    onLineEnd: async ({ missed, leafGames, leafReason, leafWindowInfo }) => {
      if (missed) return;
      // The window/next-fetch detail is logged (visible in the debug log
      // panel) rather than spoken — useful for troubleshooting without
      // making the spoken message wordy.
      const debugText = windowInfoDebugText(leafWindowInfo);
      if (debugText) log(debugText);
      await speakGuarded(`${leafGamesMessage(leafGames, leafReason, settings)} Say ready to continue, or analyze to ask the engine.`);
      await waitForVoiceContinue();
    },
    onReplayStart: async () => {
      inReplay = true;
      quizModeLabel.textContent = 'Replay';
      await speakGuarded("Let's run through that line again.");
    },
    onReplayEnd: async () => {
      inReplay = false;
      quizModeLabel.textContent = 'Quiz';
      log('Replay complete.');
      await speakGuarded('Replay complete. Say ready when you want the next line.');
      await waitForVoiceContinue();
    },
  };

  const onFetching = () => {
    log('Fetching next position from Lichess…');
    speakGuarded('One moment.');
  };

  try {
    while (quizRunning) {
      const color = quizMode === 'both' ? (Math.random() < 0.5 ? 'white' : 'black') : quizMode;
      const session = new QuizSession({ getNode: makeGetNode(color, onFetching), settings, color, handlers });
      await session.playNextLine();
    }
  } catch (err) {
    if (!(err instanceof QuizAbort)) {
      log(`Quiz error: ${err.message}`);
      console.error(err);
    }
  }
}

function sanSpoken(san) {
  return sanToSpeech(san);
}

$('#stop-quiz').addEventListener('click', async () => {
  quizRunning = false;
  listeningEnabled = false;
  if (pendingMoveResolve) { const r = pendingMoveResolve; pendingMoveResolve = null; r(ABORT); }
  if (pendingContinueResolve) { const r = pendingContinueResolve; pendingContinueResolve = null; r(); }
  inReplay = false;
  pauseListening();
  quizLive.classList.remove('active', 'blackout', 'peek');
  await wakelock.disableBlackout(quizLive);
  mode = 'idle';
  log('Quiz stopped.');
});

// ---------- manual (no-audio) quiz ----------
// Full functionality without audio: opponent moves render on the board and
// as text instead of being spoken, and the user answers by tapping a legal
// move instead of speaking one. Analysis mode becomes a tap-to-ask panel
// (quick-question buttons plus free text) with a text answer, no mic or TTS
// anywhere in the loop. Shares the same QuizSession/Engine/AnalysisSession
// as voice mode — only the handlers differ.
let manualRunning = false;
let manualPendingResolve = null;
let manualCurrentFen = new Chess().fen();
let manualOrientation = 'white';
let manualLegalMoves = [];   // legal moves for the position currently awaiting an answer, or [] otherwise
let manualSelectedSquare = null;
let manualLastMove = null;   // {from, to} to highlight, independent of click-to-move selection

// Click-to-move: click a square with one of your pieces to select it (and
// see its legal destinations marked), then click a destination square to
// play it. Clicking the selected square again deselects; clicking another
// of your own pieces re-selects instead of failing silently.
function handleManualSquareClick(square) {
  if (!manualPendingResolve) return; // not currently awaiting a move
  if (manualSelectedSquare) {
    if (square === manualSelectedSquare) {
      manualSelectedSquare = null;
      renderManualBoard(manualCurrentFen);
      return;
    }
    const move = findClickedMove(manualLegalMoves, manualSelectedSquare, square);
    if (move) {
      const resolve = manualPendingResolve;
      manualPendingResolve = null;
      manualSelectedSquare = null;
      resolve(move.san);
      return;
    }
  }
  const hasMovesFrom = manualLegalMoves.some((m) => m.from === square);
  manualSelectedSquare = hasMovesFrom ? square : null;
  renderManualBoard(manualCurrentFen);
}

function renderManualBoard(fen, lastMove) {
  if (lastMove !== undefined) manualLastMove = lastMove;
  const interactive = manualPendingResolve
    ? { legalMoves: manualLegalMoves, selectedSquare: manualSelectedSquare, onSquareClick: handleManualSquareClick }
    : null;
  renderBoard($('#manual-board-wrap'), fen, { orientation: manualOrientation, lastMove: manualLastMove, interactive });
}

// Pauses the quiz until the user taps Continue — used both after a wrong
// guess (once the correction is shown) and after a line ends on a
// low-confidence leaf, replacing any fixed-delay auto-advance: the user
// decides when they're done reading (or done consulting Analyze) rather
// than a timer deciding for them.
let manualContinueResolve = null;
function waitForManualContinue() {
  const btn = $('#manual-continue-btn');
  btn.style.display = 'block';
  return new Promise((resolve) => {
    manualContinueResolve = () => { btn.style.display = 'none'; manualContinueResolve = null; resolve(); };
    if (!manualRunning) manualContinueResolve();
  });
}
$('#manual-continue-btn').addEventListener('click', () => manualContinueResolve?.());

async function startManualQuiz(quizMode) {
  manualRunning = true;
  $('#manual-quiz-panel').style.display = 'block';
  $('#manual-analysis-panel').style.display = 'none';
  $('#manual-replay-badge').style.display = 'none';
  $('#manual-continue-btn').style.display = 'none';
  $('#manual-status').textContent = 'Starting…';
  engine = engine || new Engine();
  if (!analysisSession) analysisSession = new AnalysisSession(engine);
  engine.init().catch((err) => log(`Engine init failed (analysis will be unavailable): ${err.message}`));

  const handlers = {
    onLineStart: async ({ color }) => {
      manualOrientation = color;
      manualLegalMoves = [];
      manualSelectedSquare = null;
      manualLastMove = null;
      $('#manual-status').textContent = quizMode === 'both' ? `New line — ${cap(color)} to move first.` : 'New line.';
    },
    onOpponentMove: async ({ san, uci, fen }) => {
      manualCurrentFen = fen;
      manualLegalMoves = [];
      manualSelectedSquare = null;
      renderManualBoard(fen, { from: uci.slice(0, 2), to: uci.slice(2, 4) });
      $('#manual-status').textContent = `Opponent played ${san}. Your move.`;
    },
    onAwaitingUserMove: ({ fen, legalMoves }) => {
      manualCurrentFen = fen;
      manualLegalMoves = legalMoves;
      manualSelectedSquare = null;
      // A live fetch for this position may have left the status stuck on
      // "Fetching…" — the fetch is done now, so replace it, but leave any
      // more specific text (e.g. "Opponent played e5. Your move.") alone if
      // the fetch was already served from cache and never touched it.
      const statusEl = $('#manual-status');
      if (statusEl.textContent === 'Fetching from Lichess…') statusEl.textContent = 'Your move.';
      return new Promise((resolve) => {
        manualPendingResolve = (san) => resolve(san);
        renderManualBoard(manualCurrentFen); // now interactive, since manualPendingResolve is set
        if (!manualRunning) resolve(ABORT);
      });
    },
    onResult: async ({ correct, correctSan, correctUci, fen }) => {
      manualLegalMoves = [];
      manualSelectedSquare = null;
      const lastMove = { from: correctUci.slice(0, 2), to: correctUci.slice(2, 4) };
      if (correct) {
        manualCurrentFen = fen;
        renderManualBoard(fen, lastMove);
        $('#manual-status').textContent = `Correct — ${correctSan}.`;
        return;
      }
      // fen here is the pre-move position (quiz.js's contract on a miss).
      // Play the correct move out on the board so the correction is
      // concrete, not just named in text, and hold on it long enough to
      // actually read it — the forced replay that follows immediately after
      // would otherwise yank the board back to the start before anyone
      // could see this.
      const corrected = new Chess(fen);
      corrected.move({ from: lastMove.from, to: lastMove.to, promotion: correctUci.length > 4 ? correctUci[4] : undefined });
      manualCurrentFen = corrected.fen();
      renderManualBoard(manualCurrentFen, lastMove);
      $('#manual-status').textContent = `Not quite — the move was ${correctSan}. Tap Continue when ready.`;
      await waitForManualContinue();
    },
    onLineEnd: async ({ missed, leafGames, leafReason, leafWindowInfo }) => {
      if (missed) return;
      renderManualBoard(manualCurrentFen, null); // the line is done — clear the last-move highlight rather than leaving it up through the whole pause
      const debugText = windowInfoDebugText(leafWindowInfo);
      $('#manual-status').textContent = `${leafGamesMessage(leafGames, leafReason, settings)} Look around, ask Analyze, or tap Continue when ready.${debugText ? ` (${debugText})` : ''}`;
      await waitForManualContinue();
    },
    onReplayStart: async () => {
      manualLastMove = null; // clear the previous attempt's correction highlight before the replay's own first move renders
      $('#manual-replay-badge').style.display = 'inline-block';
      $('#manual-status').textContent = "Replaying that line for memorization…";
    },
    onReplayEnd: async () => {
      $('#manual-replay-badge').style.display = 'none';
      $('#manual-status').textContent = 'Replay complete. Tap Continue when ready for the next line.';
      await waitForManualContinue();
    },
  };

  const onFetching = () => { $('#manual-status').textContent = 'Fetching from Lichess…'; };

  try {
    while (manualRunning) {
      const color = quizMode === 'both' ? (Math.random() < 0.5 ? 'white' : 'black') : quizMode;
      const session = new QuizSession({ getNode: makeGetNode(color, onFetching), settings, color, handlers });
      await session.playNextLine();
    }
  } catch (err) {
    if (!(err instanceof QuizAbort)) {
      log(`Quiz error: ${err.message}`);
      console.error(err);
    }
  }
}

$('#manual-stop-btn').addEventListener('click', () => {
  manualRunning = false;
  if (manualPendingResolve) { const r = manualPendingResolve; manualPendingResolve = null; r(ABORT); }
  manualContinueResolve?.(); // unblock a pending "insufficient games" / correction pause so the session can actually stop
  manualLegalMoves = [];
  manualSelectedSquare = null;
  $('#manual-quiz-panel').style.display = 'none';
  $('#manual-analysis-panel').style.display = 'none';
  log('Quiz stopped.');
});

$('#manual-analyze-btn').addEventListener('click', () => {
  $('#manual-analysis-panel').style.display = 'block';
  $('#manual-answer').textContent = '';
});

$('#manual-resume-btn').addEventListener('click', () => {
  $('#manual-analysis-panel').style.display = 'none';
});

async function manualAsk(questionText) {
  if (!analysisSession) return;
  $('#manual-answer').textContent = 'Thinking…';
  try {
    const answer = await analysisSession.answer(questionText, manualCurrentFen);
    $('#manual-answer').textContent = answer;
  } catch (err) {
    $('#manual-answer').textContent = `Error: ${err.message}`;
  }
}

$$('#manual-analysis-panel [data-q]').forEach((btn) => {
  const canned = { best: 'best move', eval: "what's the eval", threat: "what's the threat", line: 'give me a line' };
  btn.addEventListener('click', () => manualAsk(canned[btn.dataset.q]));
});
$('#manual-ask-btn').addEventListener('click', () => {
  const q = $('#manual-question-input').value.trim();
  if (q) manualAsk(q);
});

// ---------- init ----------
$('#app-version').textContent = `v${APP_VERSION}`;
fillSettingsForm();
renderCacheStatus();
log(`App ready (v${APP_VERSION}).`);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => log(`Service worker registration failed: ${err.message}`));
  });
  // A new deploy ships a new sw.js with a new cache name (see APP_VERSION
  // above); once the browser notices and the new worker takes over, force
  // a reload so the page itself — not just future fetches — is running the
  // new code. Without this, a phone with no devtools has no way to tell
  // it's still running a stale cached version.
  //
  // clients.claim() in sw.js also fires this same event on a first-ever
  // visit (no controller -> first controller), which is not an update and
  // must NOT trigger a reload — that would silently reload the page out
  // from under whatever the user was doing moments after every fresh load.
  // Only reload once an *existing* controller is replaced by a new one.
  let hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    window.location.reload();
  });
}
