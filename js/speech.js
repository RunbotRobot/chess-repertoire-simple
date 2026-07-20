// Thin wrapper around the browser's built-in speech APIs.
//
// SpeechRecognition's "continuous" mode is unreliable on iOS Safari (it either
// stops silently or produces one runaway result — see the various open
// webkit/safari bugs on this). The robust workaround, used here, is to never
// rely on continuous mode: run short one-shot recognitions back-to-back,
// restarting automatically from `onend`. That's what listenLoop() does.

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

export const support = {
  tts: 'speechSynthesis' in window,
  stt: !!SpeechRecognitionImpl,
};

export function pickDefaultVoice(preferredURI) {
  const voices = window.speechSynthesis?.getVoices() || [];
  if (preferredURI) {
    const v = voices.find((v) => v.voiceURI === preferredURI);
    if (v) return v;
  }
  return voices.find((v) => v.lang?.startsWith('en')) || voices[0] || null;
}

let currentUtterance = null;

export function speak(text, { rate = 0.95, voiceURI = null } = {}) {
  if (!support.tts) return Promise.resolve();
  return new Promise((resolve) => {
    window.speechSynthesis.cancel(); // don't let utterances pile up
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    const voice = pickDefaultVoice(voiceURI);
    if (voice) utter.voice = voice;
    utter.onend = () => { currentUtterance = null; resolve(); };
    utter.onerror = () => { currentUtterance = null; resolve(); };
    currentUtterance = utter;
    window.speechSynthesis.speak(utter);
  });
}

export function stopSpeaking() {
  if (support.tts) window.speechSynthesis.cancel();
  currentUtterance = null;
}

/**
 * Runs one-shot recognition passes back to back until stop() is called.
 * onTranscript(text, isFinal) fires for each heard utterance.
 * onError(err) fires for fatal errors (e.g. permission denied); the loop
 * stops itself after a permission error but keeps going through transient
 * ones (no-speech, network blips), which are extremely common on mobile.
 */
export function listenLoop({ lang = 'en-US', onTranscript, onError, onStateChange } = {}) {
  if (!support.stt) {
    onError?.(new Error('Speech recognition is not supported in this browser.'));
    return { stop: () => {} };
  }
  let stopped = false;
  let recognizer = null;
  let consecutiveErrors = 0;

  function startPass() {
    if (stopped) return;
    recognizer = new SpeechRecognitionImpl();
    recognizer.lang = lang;
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 3;

    recognizer.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const text = result[0].transcript;
      consecutiveErrors = 0;
      onTranscript?.(text, result.isFinal);
    };
    recognizer.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopped = true;
        onError?.(new Error('Microphone permission denied.'));
        return;
      }
      consecutiveErrors++;
      // 'no-speech' and 'aborted' are routine on mobile; just keep looping.
    };
    recognizer.onstart = () => onStateChange?.('listening');
    recognizer.onend = () => {
      onStateChange?.('idle');
      if (stopped) return;
      const backoff = consecutiveErrors > 3 ? 800 : 60;
      setTimeout(startPass, backoff);
    };
    try {
      recognizer.start();
    } catch {
      // start() throws if called while already running; the pending onend
      // (if any) will schedule the next attempt.
    }
  }

  startPass();

  return {
    stop() {
      stopped = true;
      try { recognizer?.stop(); } catch { /* ignore */ }
    },
  };
}

// Listens indefinitely for one of a set of wake phrases (case-insensitive
// substring match, e.g. "analyze" / "quiz") and invokes onWake(word) each
// time one is heard in a final transcript.
export function listenForWakeWords(words, onWake, opts = {}) {
  const lowered = words.map((w) => w.toLowerCase());
  return listenLoop({
    ...opts,
    onTranscript: (text, isFinal) => {
      if (!isFinal) return;
      const lower = text.toLowerCase();
      const hit = lowered.find((w) => lower.includes(w));
      if (hit) onWake(hit);
    },
  });
}
