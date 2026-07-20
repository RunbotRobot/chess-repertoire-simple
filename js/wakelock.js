// Keeps the screen on (so JS/mic keep running) but drives it fully black, so
// in practice it behaves like "screen off" — see the app README for why a
// truly-off screen isn't achievable from a web app. Wake Lock is released by
// the browser whenever the tab is hidden and must be re-acquired on visible.

let sentinel = null;
let active = false;

async function acquire() {
  if (!('wakeLock' in navigator)) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
    return true;
  } catch (err) {
    console.warn('wake lock request failed', err);
    return false;
  }
}

function onVisibilityChange() {
  if (active && document.visibilityState === 'visible' && sentinel === null) {
    acquire();
  }
}

export const wakeLockSupported = 'wakeLock' in navigator;

export async function enableBlackout(rootEl) {
  active = true;
  rootEl.classList.add('blackout');
  document.addEventListener('visibilitychange', onVisibilityChange);
  const got = await acquire();
  return got;
}

export async function disableBlackout(rootEl) {
  active = false;
  rootEl.classList.remove('blackout');
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (sentinel) {
    try { await sentinel.release(); } catch { /* ignore */ }
    sentinel = null;
  }
}
