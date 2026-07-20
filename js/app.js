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
  if (logEntries.length > 300) logEntries.shift();
  const text = logEntries.slice(-60).join('\n');
  const el = $('#debug-log-static');
  if (el) { el.textContent = text; el.scrollTop = el.scrollHeight; }
  const caption = $('#quiz-caption');
  if (caption) caption.textContent = msg;
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
      div.innerHTML = `<span>${cap(color)}: ${lines} line(s), ${rep.nodesFetched} positions fetched${rep.nodesCapped ? ' (capped)' : ''}</span>
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
  const progressWrap = $('#build-progress-wrap');
  const progressBar = $('#build-progress-bar');
  const progressText = $('#build-progress-text');
  const errBox = $('#build-error');
  errBox.style.display = 'none';
  progressWrap.style.display = 'block';

  for (const color of settings.colors) {
    progressText.textContent = `Building ${color} repertoire…`;
    progressBar.style.width = '0%';
    try {
      const rep = await buildRepertoire(color, settings, {
        onProgress: ({ nodesFetched }) => {
          const pct = Math.min(100, Math.round((nodesFetched / (settings.maxNodes || 300)) * 100));
          progressBar.style.width = pct + '%';
          progressText.textContent = `Building ${color} repertoire… ${nodesFetched} positions fetched`;
        },
      });
      repertoires[color] = rep;
      saveRepertoire(color, rep);
      log(`Built ${color} repertoire: ${rep.nodesFetched} positions, window ${windowLabel(rep.monthWindow)}.`);
    } catch (err) {
      errBox.style.display = 'block';
      errBox.textContent = `Failed to build ${color} repertoire: ${err.message}`;
      log(`ERROR building ${color}: ${err.message}`);
    }
  }
  progressWrap.style.display = 'none';
  progressText.textContent = '';
  renderRepStatus();
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
const quizLive = $('#quiz-live');
const quizModeLabel = $('#quiz-mode-label');

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
  const color = quizColorRadios.find((r) => r.checked).value;
  const rep = repertoires[color];
  if (!rep || (!rep.root.myMove && !rep.root.opponentMoves)) {
    $('#quiz-mic-warn').textContent = `No usable ${color} repertoire — build one in Setup first.`;
    return;
  }
  if (!speech.support.stt) {
    $('#quiz-mic-warn').textContent = 'This browser has no speech recognition support.';
    return;
  }

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

  const session = new QuizSession({
    repertoire: rep,
    settings,
    color,
    handlers: {
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
    },
  });

  try {
    while (quizRunning) {
      await session.playNextLine();
    }
  } catch (err) {
    if (!(err instanceof QuizAbort)) {
      log(`Quiz error: ${err.message}`);
      console.error(err);
    }
  }
});

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

// ---------- init ----------
fillSettingsForm();
renderRepStatus();
log('App ready.');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => log(`Service worker registration failed: ${err.message}`));
  });
}
