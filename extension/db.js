/* IndexedDB access for the service worker and the offscreen export document.
 * Web pages never see this database; content scripts go through messages. */
const DB_NAME = 'marginalia';
const STORES = ['sessions', 'snapshots', 'notes', 'drawings'];
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      for (const name of ['snapshots', 'notes', 'drawings']) {
        db.createObjectStore(name, { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

const db = {
  get: async (name, id) => done((await store(name)).get(id)),
  all: async (name) => done((await store(name)).getAll()),
  bySession: async (name, sessionId) =>
    done((await store(name)).index('sessionId').getAll(sessionId)),
  put: async (name, value) => done((await store(name, 'readwrite')).put(value)),
  delete: async (name, id) => done((await store(name, 'readwrite')).delete(id)),
  // Applies patch in one transaction, and only while the record and its session exist,
  // so a capture that finishes after a delete cannot leave an orphan row.
  async patchIfSession(name, id, patch) {
    const tx = (await openDb()).transaction(['sessions', name], 'readwrite');
    const record = await done(tx.objectStore(name).get(id));
    if (!record || !(await done(tx.objectStore('sessions').get(record.sessionId)))) return null;
    const next = { ...record, ...patch(record) };
    await done(tx.objectStore(name).put(next));
    return next;
  },
  async sessionData(id) {
    const [session, snapshots, notes, drawings] = await Promise.all([
      db.get('sessions', id), db.bySession('snapshots', id), db.bySession('notes', id), db.bySession('drawings', id),
    ]);
    const used = new Set([...notes, ...drawings].map((x) => x.snapshotId));
    return {
      session,
      snapshots: snapshots.filter((s) => used.has(s.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      notes: notes.sort((a, b) => a.number - b.number),
      drawings,
      generatedAt: new Date().toISOString(),
    };
  },
  async deleteSession(sessionId) {
    const tx = (await openDb()).transaction(STORES, 'readwrite');
    tx.objectStore('sessions').delete(sessionId);
    for (const name of ['snapshots', 'notes', 'drawings']) {
      const keys = await done(tx.objectStore(name).index('sessionId').getAllKeys(sessionId));
      for (const key of keys) tx.objectStore(name).delete(key);
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};
