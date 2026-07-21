import { DEFAULT_SETTINGS, loadSettings, saveSettings, loadRepertoire, saveRepertoire } from './storage.js';
import { buildRepertoire, isStale } from './explorer.js';
import { renderBoard } from './board.js';
import * as speech from './speech.js';
import { matchSpokenMove, sanToSpeech } from './chessUtil.js';
import { QuizSession, ABORT, QuizAbort } from './quiz.js';
import { Engine } from './engine.js';
import { AnalysisSession } from './analysis.js';
import * as wakelock from './wakelock.js';
import { Chess } from './vendor/chess.esm.js';

// Bump this on every deploy — it's the only way to confirm a phone without
// devtools is actually running the latest code, and it also drives the
// service worker's cache name (see sw.js) so updates actually take effect
// instead of being served stale from the offline cache.
export const APP_VERSION = 15;

const COLOR_OPTIONS = ['white', 'black'];
const RATING_OPTIONS = ['1000', '1200', '1400', '1600', '1800', '2000', '2200', '2500'];
const SPEED_OPTIONS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let settings = loadSettings();
const repertoires = { white: loadRepertoire('white'), black: loadRepertoire('black') };

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
  $('#maxPlies').value = settings.maxPlies;
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
    maxPlies: Number($('#maxPlies').value) || DEFAULT_SETTINGS.maxPlies,
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
  renderRepStatus();
});

// ---------- repertoire building ----------
function renderRepStatus() {
  const wrap = $('#rep-cards');
  wrap.innerHTML = '';
  for (const color of COLOR_OPTIONS) {
    const rep = repertoires[color];
    const div = document.createElement('div');
    div.className = 'repcard';
    if (!rep) {
      div.innerHTML = `<span>${cap(color)}: not built yet</span>`;
    } else {
      const stale = isStale(rep, settings.repertoireMaxAgeHours);
      const lines = countLines(rep.root);
      const failNote = rep.nodesFailed ? ` — ${rep.nodesFailed} position(s) failed to fetch` : '';
      div.innerHTML = `<span>${cap(color)}: ${lines} line(s), ${rep.nodesFetched} positions fetched${rep.nodesCapped ? ' (capped)' : ''}${failNote}</span>
        <span class="meta">${stale ? 'stale — ' : ''}window ${windowLabel(rep.monthWindow)}</span>`;
    }
    wrap.appendChild(div);
  }
}

function countLines(node) {
  if (!node.myMove && !node.opponentMoves) return 1;
  if (node.myMove) {
    const child = node.children[node.myMove.uci];
    return child ? countLines(child) : 1;
  }
  let total = 0;
  for (const m of node.opponentMoves || []) {
    const child = node.children[m.uci];
    total += child ? countLines(child) : 1;
  }
  return total || 1;
}

function cap(s) { return s[0].toUpperCase() + s.slice(1); }

function windowLabel(monthWindow) {
  return monthWindow.since === monthWindow.until ? monthWindow.since : `${monthWindow.since}→${monthWindow.until}`;
}

$('#build-both').addEventListener('click', async () => {
  settings = readSettingsForm();
  saveSettings(settings);
  const buildBtn = $('#build-both');
  const progressWrap = $('#build-progress-wrap');
  const progressBar = $('#build-progress-bar');
  const progressText = $('#build-progress-text');
  const errBox = $('#build-error');
  errBox.style.display = 'none';

  if (!settings.lichessToken) {
    errBox.style.display = 'block';
    errBox.textContent = 'No Lichess API token set. Lichess now requires one for the opening explorer — create a free token (no scopes needed) at lichess.org/account/oauth/token/create and paste it into the "Lichess account" field above.';
    return;
  }

  // Fetches happen off-screen at the bottom of a long settings page, so
  // clicking Build gave no feedback near the button itself — it just looked
  // frozen. Disable the button, scroll the status card into view, and show
  // motion immediately (before the first position even comes back) instead
  // of a static 0% bar.
  buildBtn.disabled = true;
  const originalBtnLabel = buildBtn.textContent;
  buildBtn.textContent = 'Building…';
  progressWrap.style.display = 'block';
  progressWrap.classList.add('indeterminate');
  $('#repertoire-status').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    for (const color of settings.colors) {
      progressText.textContent = `Building ${color} repertoire…`;
      progressBar.style.width = '0%';
      try {
        const rep = await buildRepertoire(color, settings, {
          onProgress: ({ nodesFetched }) => {
            progressWrap.classList.remove('indeterminate'); // first position landed — switch to a real percentage
            const pct = Math.min(100, Math.round((nodesFetched / (settings.maxNodes || 300)) * 100));
            progressBar.style.width = pct + '%';
            progressText.textContent = `Building ${color} repertoire… ${nodesFetched} positions fetched`;
          },
        });
        repertoires[color] = rep;
        saveRepertoire(color, rep);
        const failNote = rep.nodesFailed ? `, ${rep.nodesFailed} failed (first: ${rep.firstFailureMessage})` : '';
        log(`Built ${color} repertoire: ${rep.nodesFetched} positions${failNote}, window ${windowLabel(rep.monthWindow)}.`);
        if (!rep.root.myMove && !rep.root.opponentMoves && rep.rootDiagnostic) {
          const d = rep.rootDiagnostic;
          log(`  ${color} root came back empty — totalGames=${d.totalGames}, movesReturned=${d.movesReturned}, topLevel=${JSON.stringify(d.topLevel)}, url=${d.url}`);
          if (d.probeWithoutDateRange) {
            const p = d.probeWithoutDateRange;
            log(`  probe (same query, no since/until): ${p.error ? `error: ${p.error}` : `totalGames=${p.totalGames}, movesReturned=${p.movesReturned}`}, url=${p.url || '(n/a)'}`);
          }
        }
      } catch (err) {
        errBox.style.display = 'block';
        errBox.textContent = `Failed to build ${color} repertoire: ${err.message}`;
        log(`ERROR building ${color}: ${err.message}`);
      }
    }
  } finally {
    progressWrap.style.display = 'none';
    progressWrap.classList.remove('indeterminate');
    progressText.textContent = '';
    buildBtn.disabled = false;
    buildBtn.textContent = originalBtnLabel;
    renderRepStatus();
  }
});

// ---------- browse view ----------
let browseColor = 'white';
let browsePath = []; // array of {uci, san}
$$('input[name=browse-color]').forEach((r) => r.addEventListener('change', () => {
  browseColor = r.value; browsePath = []; renderBrowse();
}));

function currentBrowseNode() {
  const rep = repertoires[browseColor];
  if (!rep) return null;
  let node = rep.root;
  for (const step of browsePath) {
    node = node.children[step.uci];
    if (!node) break;
  }
  return node;
}

function renderBrowse() {
  const rep = repertoires[browseColor];
  const boardWrap = $('#board-wrap');
  const breadcrumb = $('#browse-breadcrumb');
  const movelist = $('#browse-movelist');
  if (!rep) {
    boardWrap.innerHTML = '';
    breadcrumb.textContent = '';
    movelist.innerHTML = `<div class="hint">No ${browseColor} repertoire built yet — go to Setup.</div>`;
    return;
  }
  const chess = new Chess();
  for (const step of browsePath) chess.move(step.san);
  renderBoard(boardWrap, chess.fen(), {
    orientation: browseColor,
    lastMove: browsePath.length ? { from: browsePath[browsePath.length - 1].uci.slice(0, 2), to: browsePath[browsePath.length - 1].uci.slice(2, 4) } : null,
  });

  breadcrumb.innerHTML = browsePath.length
    ? browsePath.map((s, i) => `<span class="san" data-idx="${i}">${s.san}</span>`).join(' ')
    : '(start position)';
  breadcrumb.querySelectorAll('.san').forEach((el) => {
    el.addEventListener('click', () => { browsePath = browsePath.slice(0, Number(el.dataset.idx) + 1); renderBrowse(); });
  });

  const node = currentBrowseNode();
  movelist.innerHTML = '';
  if (browsePath.length > 0) {
    const back = document.createElement('button');
    back.className = 'movebtn';
    back.textContent = '← Back';
    back.addEventListener('click', () => { browsePath = browsePath.slice(0, -1); renderBrowse(); });
    movelist.appendChild(back);
  }
  if (!node) return;
  if (node.myMove) {
    const btn = document.createElement('button');
    btn.className = 'movebtn mine';
    btn.innerHTML = `<span>My move: ${node.myMove.san}</span><span class="pct">${node.myMove.games} games, ${(node.myMove.score * 100).toFixed(0)}% score</span>`;
    btn.addEventListener('click', () => { browsePath = [...browsePath, node.myMove]; renderBrowse(); });
    movelist.appendChild(btn);
  } else if (node.opponentMoves) {
    for (const m of node.opponentMoves) {
      const btn = document.createElement('button');
      btn.className = 'movebtn';
      btn.innerHTML = `<span>${m.san}</span><span class="pct">${(m.share * 100).toFixed(0)}% · ${m.games} games</span>`;
      btn.addEventListener('click', () => { browsePath = [...browsePath, m]; renderBrowse(); });
      movelist.appendChild(btn);
    }
    if (node.opponentMoves.length === 0) movelist.innerHTML += '<div class="hint">No further data — this is the end of prepared theory.</div>';
  } else {
    movelist.innerHTML = '<div class="hint">End of prepared theory for this line.</div>';
  }
}

// ---------- quiz + analysis ----------
const quizColorRadios = $$('input[name=quiz-color]');
const quizInputRadios = $$('input[name=quiz-input]');
const quizLive = $('#quiz-live');
const quizModeLabel = $('#quiz-mode-label');

function updateQuizInputHint() {
  const val = quizInputRadios.find((r) => r.checked).value;
  $('#quiz-input-hint').textContent = val === 'manual'
    ? 'Tap a move to answer. Tap "Analyze" any time to check the engine\'s opinion on the position without leaving the quiz — no mic or speaker involved.'
    : 'Say "Analyze" any time during the quiz to pause and ask the engine about the position. Say "Quiz" to resume. The screen will go black and stay awake — tap it to peek at the caption log.';
}
quizInputRadios.forEach((r) => r.addEventListener('change', updateQuizInputHint));
updateQuizInputHint();

let mode = 'idle'; // 'idle' | 'quiz' | 'analysis'
let listenHandle = null;
let listeningEnabled = false;
let pendingMoveResolve = null;
let pendingLegalMoves = [];
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
  if (mode === 'quiz') { handleQuizTranscript(text); return; }
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
  quizModeLabel.textContent = 'Quiz';
  log('Resuming quiz.');
  await speakGuarded('Quiz.');
}

$('#start-quiz').addEventListener('click', async () => {
  const quizMode = quizColorRadios.find((r) => r.checked).value; // 'white' | 'black' | 'both'
  const inputMethod = quizInputRadios.find((r) => r.checked).value; // 'voice' | 'manual'
  const colorsNeeded = quizMode === 'both' ? ['white', 'black'] : [quizMode];
  for (const c of colorsNeeded) {
    const rep = repertoires[c];
    if (!rep || (!rep.root.myMove && !rep.root.opponentMoves)) {
      $('#quiz-mic-warn').textContent = quizMode === 'both'
        ? `No usable ${c} repertoire — build both colors in Setup first.`
        : `No usable ${c} repertoire — build one in Setup first.`;
      return;
    }
  }

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
      } else {
        log(`Missed. Correct was ${correctSan}.`);
        await speakGuarded(`Not quite. The move was ${sanSpoken(correctSan)}.`);
      }
    },
    onLineEnd: async ({ missed }) => {
      if (!missed) await speakGuarded('Line complete.');
    },
    onReplayStart: async () => {
      await speakGuarded("Let's run through that line again.");
    },
    onReplayEnd: async () => {
      log('Replay complete.');
    },
  };

  try {
    while (quizRunning) {
      const color = quizMode === 'both' ? (Math.random() < 0.5 ? 'white' : 'black') : quizMode;
      const session = new QuizSession({ repertoire: repertoires[color], settings, color, handlers });
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

function renderManualBoard(fen, lastMove) {
  renderBoard($('#manual-board-wrap'), fen, { orientation: manualOrientation, lastMove });
}

function renderManualMoveList(legalMoves) {
  const wrap = $('#manual-movelist');
  wrap.innerHTML = '';
  for (const m of legalMoves) {
    const btn = document.createElement('button');
    btn.className = 'movebtn';
    btn.textContent = m.san;
    btn.addEventListener('click', () => {
      if (!manualPendingResolve) return;
      const resolve = manualPendingResolve;
      manualPendingResolve = null;
      wrap.innerHTML = '';
      resolve(m.san);
    });
    wrap.appendChild(btn);
  }
}

async function startManualQuiz(quizMode) {
  manualRunning = true;
  $('#manual-quiz-panel').style.display = 'block';
  $('#manual-analysis-panel').style.display = 'none';
  $('#manual-status').textContent = 'Starting…';
  $('#manual-movelist').innerHTML = '';
  engine = engine || new Engine();
  if (!analysisSession) analysisSession = new AnalysisSession(engine);
  engine.init().catch((err) => log(`Engine init failed (analysis will be unavailable): ${err.message}`));

  const handlers = {
    onLineStart: async ({ color }) => {
      manualOrientation = color;
      $('#manual-status').textContent = quizMode === 'both' ? `New line — ${cap(color)} to move first.` : 'New line.';
    },
    onOpponentMove: async ({ san, uci, fen }) => {
      manualCurrentFen = fen;
      renderManualBoard(fen, { from: uci.slice(0, 2), to: uci.slice(2, 4) });
      $('#manual-status').textContent = `Opponent played ${san}. Your move.`;
      $('#manual-movelist').innerHTML = '';
    },
    onAwaitingUserMove: ({ fen, legalMoves }) => {
      manualCurrentFen = fen;
      renderManualMoveList(legalMoves);
      return new Promise((resolve) => {
        manualPendingResolve = (san) => resolve(san);
        if (!manualRunning) resolve(ABORT);
      });
    },
    onResult: async ({ correct, correctSan, correctUci, fen }) => {
      manualCurrentFen = fen;
      if (correct) {
        renderManualBoard(fen, { from: correctUci.slice(0, 2), to: correctUci.slice(2, 4) });
        $('#manual-status').textContent = `Correct — ${correctSan}.`;
      } else {
        $('#manual-status').textContent = `Not quite. The move was ${correctSan}.`;
      }
      $('#manual-movelist').innerHTML = '';
    },
    onLineEnd: async ({ missed }) => {
      if (!missed) $('#manual-status').textContent = 'Line complete.';
    },
    onReplayStart: async () => {
      $('#manual-status').textContent = "Replaying that line for memorization…";
    },
    onReplayEnd: async () => {},
  };

  try {
    while (manualRunning) {
      const color = quizMode === 'both' ? (Math.random() < 0.5 ? 'white' : 'black') : quizMode;
      const session = new QuizSession({ repertoire: repertoires[color], settings, color, handlers });
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
  $('#manual-quiz-panel').style.display = 'none';
  $('#manual-analysis-panel').style.display = 'none';
  $('#manual-movelist').innerHTML = '';
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
renderRepStatus();
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
