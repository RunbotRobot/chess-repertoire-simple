// Wrapper around the vendored single-threaded Stockfish WASM build (runs as
// a Web Worker, plain UCI protocol over postMessage). Deliberately using the
// "lite-single" build: single-threaded builds don't need SharedArrayBuffer,
// so they don't need cross-origin-isolation response headers — which static
// hosts like GitHub Pages can't set anyway.

export class Engine {
  constructor(scriptUrl = new URL('./vendor/stockfish/stockfish-18-lite-single.js', import.meta.url)) {
    this.scriptUrl = scriptUrl;
    this.worker = null;
    this.ready = null;
    this._infoLines = [];
    this._pendingGo = null;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.scriptUrl);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker.onmessage = (e) => this._handleLine(String(e.data), resolve);
      this.worker.onerror = (e) => {
        if (this._pendingGo) { this._pendingGo.reject(e); this._pendingGo = null; }
        reject(e);
      };
      this._send('uci');
    });
    return this.ready;
  }

  _send(cmd) {
    this.worker.postMessage(cmd);
  }

  _handleLine(line, onReady) {
    if (line === 'uciok') {
      this._send('isready');
    } else if (line === 'readyok') {
      onReady?.();
    } else if (line.startsWith('info')) {
      this._infoLines.push(line);
    } else if (line.startsWith('bestmove')) {
      const parts = line.split(' ');
      const bestmove = parts[1];
      const ponderIdx = parts.indexOf('ponder');
      const ponder = ponderIdx >= 0 ? parts[ponderIdx + 1] : null;
      const lastInfo = parseInfoLine(this._infoLines[this._infoLines.length - 1] || '');
      if (this._pendingGo) {
        this._pendingGo.resolve({ bestmove, ponder, info: lastInfo, infoLines: this._infoLines.slice() });
        this._pendingGo = null;
      }
    }
  }

  async setPosition(fen, moves = []) {
    await this.init();
    const cmd = moves.length
      ? `position fen ${fen} moves ${moves.join(' ')}`
      : `position fen ${fen}`;
    this._send(cmd);
  }

  /** Analyze the current position. Resolves with best move (UCI) + eval info. */
  async go({ movetimeMs = 1200, depth } = {}) {
    await this.init();
    this._infoLines = [];
    return new Promise((resolve, reject) => {
      this._pendingGo = { resolve, reject };
      this._send(depth ? `go depth ${depth}` : `go movetime ${movetimeMs}`);
    });
  }

  stop() {
    if (this.worker) this._send('stop');
  }

  quit() {
    if (this.worker) {
      try { this._send('quit'); } catch { /* ignore */ }
      this.worker.terminate();
      this.worker = null;
      this.ready = null;
    }
  }
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  const info = { depth: null, scoreCp: null, scoreMate: null, pv: [] };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'depth') info.depth = Number(tokens[i + 1]);
    if (tokens[i] === 'score' && tokens[i + 1] === 'cp') info.scoreCp = Number(tokens[i + 2]);
    if (tokens[i] === 'score' && tokens[i + 1] === 'mate') info.scoreMate = Number(tokens[i + 2]);
    if (tokens[i] === 'pv') { info.pv = tokens.slice(i + 1); break; }
  }
  return info;
}
