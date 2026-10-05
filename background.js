/* Marginalia service worker: owns the IndexedDB data, screenshots and exports.
 * Content scripts read only `activeSession` from chrome.storage.local so they stay
 * inert without waking this worker; everything else goes through messages.
 */
importScripts('db.js', 'renderer.js');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CAPTURE_GAP_MS = 600; // captureVisibleTab allows about 2 calls per second
const REDACT_BLOCK_CSS_PX = 16;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function activeSession() {
  const { activeSession } = await chrome.storage.local.get('activeSession');
  return activeSession ? db.get('sessions', activeSession.id) : null;
}

async function setActive(session) {
  await chrome.storage.local.set({
    activeSession: session ? { id: session.id, name: session.name } : null,
  });
}

async function startSession(name) {
  const current = await activeSession();
  if (current) await endSession(current.id, false);
  const session = { id: uid(), name: name || now().slice(0, 10), createdAt: now(), endedAt: null, status: 'active' };
  await db.put('sessions', session);
  await setActive(session);
  return session;
}

async function endSession(id, download = true) {
  const session = await db.get('sessions', id);
  if (!session) return null;
  session.status = 'ended';
  session.endedAt = now();
  await db.put('sessions', session);
  const active = await activeSession();
  if (!active || active.id === id) await setActive(null);
  if (download) await exportSession(id);
  return session;
}

async function resumeSession(id) {
  const current = await activeSession();
  if (current && current.id !== id) await endSession(current.id, false);
  const session = await db.get('sessions', id);
  session.status = 'active';
  session.endedAt = null;
  await db.put('sessions', session);
  await setActive(session);
  return session;
}

/* ---------- snapshots and capture ---------- */

const pageKey = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
};

const sameState = (snap, page) =>
  pageKey(snap.url) === pageKey(page.url) &&
  Math.round(snap.scrollX) === Math.round(page.scrollX) &&
  Math.round(snap.scrollY) === Math.round(page.scrollY) &&
  snap.vw === page.vw && snap.vh === page.vh;

async function findOrCreateSnapshot(sessionId, page) {
  const snaps = await db.bySession('snapshots', sessionId);
  const hit = snaps.find((s) => sameState(s, page));
  if (hit) return hit;
  const host = new URL(page.url).hostname;
  const snap = {
    id: uid(), sessionId, url: page.url, title: page.title, host,
    nonLocal: !LOCAL_HOSTS.has(host),
    scrollX: page.scrollX, scrollY: page.scrollY, vw: page.vw, vh: page.vh, dpr: page.dpr,
    image: null, imageBytes: 0, createdAt: now(), updatedAt: now(),
  };
  await db.put('snapshots', snap);
  return snap;
}

let captureChain = Promise.resolve();
let lastCaptureAt = 0;
const pending = new Map(); // snapshotId -> promise, so bursts collapse into one capture

function queueCapture(tab, snapshotId) {
  if (pending.has(snapshotId)) return pending.get(snapshotId);
  const job = captureChain.then(async () => {
    pending.delete(snapshotId);
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await capture(tab, snapshotId);
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureChain = job.catch((e) => console.warn('Marginalia capture failed', e));
  pending.set(snapshotId, job);
  return job;
}

async function capture(tab, snapshotId) {
  await chrome.tabs.sendMessage(tab.id, { type: 'hide-ui' });
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    chrome.tabs.sendMessage(tab.id, { type: 'show-ui' }).catch(() => {});
  }
  const snap = await db.get('snapshots', snapshotId);
  const drawings = (await db.bySession('drawings', snap.sessionId)).filter((d) => d.snapshotId === snapshotId);
  const redactions = drawings.flatMap((d) => d.strokes).filter((s) => s.tool === 'redact');
  snap.image = redactions.length ? await burnRedactions(dataUrl, redactions, snap.dpr) : dataUrl;
  snap.imageBytes = snap.image.length;
  snap.updatedAt = now();
  await db.put('snapshots', snap);
}

async function burnRedactions(dataUrl, rects, dpr) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const block = Math.max(4, Math.round(REDACT_BLOCK_CSS_PX * dpr));
  for (const s of rects) {
    const [a, b] = s.rel;
    const x = Math.max(0, Math.floor(Math.min(a.x, b.x) * dpr));
    const y = Math.max(0, Math.floor(Math.min(a.y, b.y) * dpr));
    const w = Math.min(bitmap.width, Math.ceil(Math.max(a.x, b.x) * dpr)) - x;
    const h = Math.min(bitmap.height, Math.ceil(Math.max(a.y, b.y) * dpr)) - y;
    if (w < 1 || h < 1) continue;
    const small = new OffscreenCanvas(Math.max(1, Math.ceil(w / block)), Math.max(1, Math.ceil(h / block)));
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return 'data:image/png;base64,' + base64(new Uint8Array(await blob.arrayBuffer()));
}

function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ---------- notes and drawings ---------- */

async function pageNotes(url) {
  const session = await activeSession();
  if (!session) return [];
  const notes = await db.bySession('notes', session.id);
  return notes.filter((n) => pageKey(n.url) === pageKey(url)).sort((a, b) => a.number - b.number);
}

async function saveNote(tab, { note, page }) {
  const session = await activeSession();
  if (!session) throw new Error('No active session');
  const snap = await findOrCreateSnapshot(session.id, page);
  let record = note.id ? await db.get('notes', note.id) : null;
  if (!record) {
    const notes = await db.bySession('notes', session.id);
    record = {
      id: uid(), sessionId: session.id, number: notes.reduce((m, n) => Math.max(m, n.number), 0) + 1,
      snapshotId: snap.id, url: page.url, kind: note.kind, status: 'open', createdAt: now(),
    };
  }
  const recapture = record.snapshotId === snap.id;
  Object.assign(record, {
    text: note.text, tag: note.tag, status: note.status || record.status, updatedAt: now(),
  });
  if (recapture) Object.assign(record, { rect: note.rect, anchor: note.anchor });
  await db.put('notes', record);
  if (recapture) queueCapture(tab, snap.id);
  return record;
}

async function saveDrawing(tab, { strokes, page }) {
  const session = await activeSession();
  if (!session || !strokes.length) return null;
  const snap = await findOrCreateSnapshot(session.id, page);
  const drawing = { id: uid(), sessionId: session.id, snapshotId: snap.id, url: page.url, strokes, createdAt: now() };
  await db.put('drawings', drawing);
  await queueCapture(tab, snap.id);
  return drawing;
}

/* ---------- sessions list, report data, export ---------- */

async function sessionData(id) {
  const [session, snapshots, notes, drawings] = await Promise.all([
    db.get('sessions', id), db.bySession('snapshots', id), db.bySession('notes', id), db.bySession('drawings', id),
  ]);
  const used = new Set([...notes, ...drawings].map((x) => x.snapshotId));
  return {
    session,
    snapshots: snapshots.filter((s) => used.has(s.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    notes: notes.sort((a, b) => a.number - b.number),
    drawings,
    generatedAt: now(),
  };
}

async function listSessions() {
  const [sessions, snapshots, notes] = await Promise.all([db.all('sessions'), db.all('snapshots'), db.all('notes')]);
  return sessions
    .map((s) => {
      const snaps = snapshots.filter((x) => x.sessionId === s.id);
      const own = notes.filter((n) => n.sessionId === s.id);
      return {
        ...s,
        noteCount: own.length,
        sites: [...new Set(snaps.map((x) => x.host))],
        bytes: snaps.reduce((t, x) => t + (x.imageBytes || 0), 0) + JSON.stringify(own).length,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneOlderThan(days) {
  const cutoff = Date.now() - days * 86400000;
  const active = await activeSession();
  let removed = 0;
  for (const s of await db.all('sessions')) {
    if (s.id !== active?.id && Date.parse(s.createdAt) < cutoff) {
      await db.deleteSession(s.id);
      removed++;
    }
  }
  return removed;
}

async function exportSession(id) {
  const data = await sessionData(id);
  const [css, js] = await Promise.all(
    ['report.css', 'renderer.js'].map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text())),
  );
  const html = MarginaliaReport.standalone(data, css, js);
  const url = 'data:text/html;base64,' + base64(new TextEncoder().encode(html));
  const safe = data.session.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
  return chrome.downloads.download({ url, filename: `marginalia-${safe}.html`, saveAs: false });
}

async function sendMode(mode) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { ok: false };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'mode', mode });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Reload the page to use Marginalia on it.' };
  }
}

/* ---------- wiring ---------- */

const handlers = {
  state: async () => {
    const session = await activeSession();
    const noteCount = session ? (await db.bySession('notes', session.id)).length : 0;
    return { session, noteCount };
  },
  startSession: (m) => startSession(m.name),
  endSession: async () => {
    const s = await activeSession();
    return s ? endSession(s.id) : null;
  },
  mode: (m) => sendMode(m.mode),
  pageNotes: (m) => pageNotes(m.url),
  saveNote: (m, sender) => saveNote(sender.tab, m),
  deleteNote: (m) => db.delete('notes', m.id),
  saveDrawing: (m, sender) => saveDrawing(sender.tab, m),
  listSessions: () => listSessions(),
  sessionData: (m) => sessionData(m.id),
  renameSession: async (m) => {
    const s = await db.get('sessions', m.id);
    s.name = m.name;
    await db.put('sessions', s);
    const active = await activeSession();
    if (active?.id === s.id) await setActive(s);
    return s;
  },
  deleteSession: async (m) => {
    const active = await activeSession();
    if (active?.id === m.id) await setActive(null);
    return db.deleteSession(m.id);
  },
  resumeSession: (m) => resumeSession(m.id),
  exportSession: (m) => exportSession(m.id),
  pruneOlderThan: (m) => pruneOlderThan(m.days),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'annotate' || command === 'draw') sendMode(command);
});
