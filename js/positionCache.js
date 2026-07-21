// IndexedDB-backed cache of raw Lichess explorer responses, keyed by exactly
// the query params that affect what comes back (variant/speeds/ratings/
// month/move-sequence) — NOT by color or any of the scoring settings
// (minSampleSize etc.), since those are applied fresh on every read so
// tweaking them takes effect immediately without needing to refetch.
//
// localStorage was fine for a handful of settings but would be a poor fit
// here: potentially thousands of cached positions over time, well past
// what its ~5-10MB quota comfortably holds. IndexedDB has much more
// headroom and a real async API.
const DB_NAME = 'chessrep-positions';
const DB_VERSION = 1;
const STORE = 'positions';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// All functions degrade gracefully to "no cache" (null / no-op / zeroed
// stats) rather than throwing, so a browser without IndexedDB (or one that
// denies it, e.g. some private-browsing modes) still works — just always a
// cache miss, meaning every position gets fetched live every time.

export async function getCached(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCached(key, data) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ data, fetchedAt: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('position cache write failed', err);
  }
}

export async function getCacheStats() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      let oldest = null, newest = null;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const t = cursor.value.fetchedAt;
          if (oldest === null || t < oldest) oldest = t;
          if (newest === null || t > newest) newest = t;
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve({ count: countReq.result, oldest, newest });
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return { count: 0, oldest: null, newest: null };
  }
}

export async function clearCache() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('position cache clear failed', err);
  }
}
