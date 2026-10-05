/* IndexedDB access for the service worker. Pages never open this database. */
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
