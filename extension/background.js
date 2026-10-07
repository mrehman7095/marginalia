/* Marginalia service worker: owns the IndexedDB data, screenshots and exports.
 * Content scripts read only `activeSession` from chrome.storage.local so they stay
 * inert without waking this worker; everything else goes through messages.
 */
importScripts('db.js');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CAPTURE_GAP_MS = 600; // captureVisibleTab allows about 2 calls per second
const REDACT_FILL = '#1f2330';
const HIDE_UI_TIMEOUT_MS = 1500;

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

// Exports first: if the export fails the session stays active and the caller sees the error.
async function endSession(id, download = true) {
  const session = await db.get('sessions', id);
  if (!session) return null;
  const endedAt = now();
  if (download) await exportSession(id, endedAt);
  session.status = 'ended';
  session.endedAt = endedAt;
  await db.put('sessions', session);
  const active = await activeSession();
  if (!active || active.id === id) await setActive(null);
  return session;
}

async function resumeSession(id) {
  const session = await db.get('sessions', id);
  if (!session) throw new Error('Session not found');
  const current = await activeSession();
  if (current && current.id !== id) await endSession(current.id, false);
  session.status = 'active';
  session.endedAt = null;
  await db.put('sessions', session);
  await setActive(session);
  return session;
}

/* ---------- snapshots and capture ---------- */

// Hash routes (#/ or #!/) are separate pages; plain anchors are not.
const pageKey = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search + (/^#!?\//.test(u.hash) ? u.hash : '');
  } catch {
    return url;
  }
};

const stateKey = (s) =>
  [pageKey(s.url), Math.round(s.scrollX), Math.round(s.scrollY), s.vw, s.vh, s.dpr].join('|');

// A snapshot with redactions is locked: it is never found again, so it is never
// recaptured; a later save in the same state starts a new snapshot.
async function findOrCreateSnapshot(sessionId, page) {
  const snaps = await db.bySession('snapshots', sessionId);
  const hit = snaps.find((s) => !s.locked && stateKey(s) === stateKey(page));
  if (hit) return hit;
  const host = new URL(page.url).hostname;
  const snap = {
    id: uid(), sessionId, url: page.url, title: page.title, host,
    nonLocal: !LOCAL_HOSTS.has(host),
    scrollX: page.scrollX, scrollY: page.scrollY, vw: page.vw, vh: page.vh, dpr: page.dpr,
    image: null, imageBytes: 0, locked: false, redacted: false, createdAt: now(), updatedAt: now(),
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
  captureChain = job.catch(() => {});
  pending.set(snapshotId, job);
  return job;
}

const withTimeout = (promise, ms, message) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

async function assertActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('The tab is no longer in front, so no screenshot was taken.');
  return tab;
}

// captureVisibleTab takes whatever tab is in front, so check ours is, right before.
async function grab(tabId, snap) {
  await assertActive(tabId);
  try {
    const reply = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'hide-ui' }), HIDE_UI_TIMEOUT_MS, 'The page did not respond.');
    const page = reply?.page;
    if (!page) throw new Error('The page did not report its state.');
    if (page.zoom !== 1) throw new Error('Pinch zoom is active. Reset it and save again.');
    if (stateKey(page) !== stateKey(snap)) throw new Error('The page moved before the screenshot. Save again.');
    const tab = await assertActive(tabId);
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    chrome.tabs.sendMessage(tabId, { type: 'show-ui' }).catch(() => {});
  }
}

async function capture(tab, snapshotId) {
  const before = await db.get('snapshots', snapshotId);
  if (!before) return;
  let image = null;
  let error = null;
  if (!before.redacted) {
    try {
      image = await grab(tab.id, before);
    } catch (e) {
      error = e;
    }
  }
  const drawings = (await db.bySession('drawings', before.sessionId)).filter((d) => d.snapshotId === snapshotId);
  const redactions = drawings.flatMap((d) => d.strokes).filter((s) => s.tool === 'redact');
  let patch;
  if (redactions.length) {
    // Never keep a raw image once redactions exist: burn them into the new capture or,
    // if that failed, into the stored image of the same state; otherwise drop it.
    try {
      const burned = await burnRedactions(image || before.image, redactions, before.vw);
      patch = { image: burned, redacted: !!burned };
    } catch (e) {
      error ||= e;
      patch = { image: null, redacted: false };
    }
  } else if (image) {
    patch = { image };
  }
  if (patch) {
    await db.patchIfSession('snapshots', snapshotId, () => ({
      ...patch, imageBytes: patch.image?.length || 0, updatedAt: now(),
    }));
  }
  if (error) throw error;
}

async function burnRedactions(dataUrl, rects, cssWidth) {
  if (!dataUrl) return null;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bitmap.width / cssWidth;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  // Solid fill: pixelation over known fonts can be reversed.
  ctx.fillStyle = REDACT_FILL;
  for (const s of rects) {
    const [a, b] = s.rel;
    const x = Math.max(0, Math.floor(Math.min(a.x, b.x) * scale));
    const y = Math.max(0, Math.floor(Math.min(a.y, b.y) * scale));
    const w = Math.min(bitmap.width, Math.ceil(Math.max(a.x, b.x) * scale)) - x;
    const h = Math.min(bitmap.height, Math.ceil(Math.max(a.y, b.y) * scale)) - y;
    if (w > 0 && h > 0) ctx.fillRect(x, y, w, h);
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
  let captureError = null;
  if (recapture) await queueCapture(tab, snap.id).catch((e) => (captureError = String(e?.message || e)));
  sendLive({ kind: 'note', sessionId: session.id, id: record.id });
  return { record, captureError };
}

async function saveDrawing(tab, { strokes, page }) {
  const session = await activeSession();
  if (!session || !strokes.length) return null;
  const snap = await findOrCreateSnapshot(session.id, page);
  const drawing = { id: uid(), sessionId: session.id, snapshotId: snap.id, url: page.url, strokes, createdAt: now() };
  await db.put('drawings', drawing);
  if (strokes.some((s) => s.tool === 'redact')) await db.patchIfSession('snapshots', snap.id, () => ({ locked: true }));
  await queueCapture(tab, snap.id);
  sendLive({ kind: 'drawing', sessionId: session.id, id: drawing.id });
  return drawing;
}

/* ---------- sessions list, report data, export ---------- */

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

let offscreenReady = null;
let exportsBuilding = 0;
const exportsInFlight = new Set();

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenReady ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Build export files as Blobs' })
    .finally(() => (offscreenReady = null));
  await offscreenReady;
}

// Closing the offscreen document revokes its blob URLs, so wait until every download finishes.
function closeOffscreenWhenIdle() {
  if (!exportsBuilding && !exportsInFlight.size) chrome.offscreen.closeDocument().catch(() => {});
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!exportsInFlight.has(id) || !state || state.current === 'in_progress') return;
  exportsInFlight.delete(id);
  closeOffscreenWhenIdle();
});

// Builds files in the offscreen document and downloads them; returns the folder or file name.
async function download(id, type, extra, filesFor) {
  const session = await db.get('sessions', id);
  if (!session) throw new Error('Session not found');
  const base = `marginalia-${session.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'}`;
  exportsBuilding++;
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type, id, ...extra });
    if (!r?.ok) throw new Error(r?.error || 'Export failed');
    for (const f of filesFor(r, base)) {
      exportsInFlight.add(await chrome.downloads.download({ saveAs: false, ...f }));
    }
    return base;
  } finally {
    exportsBuilding--;
    closeOffscreenWhenIdle();
  }
}

const exportSession = (id, endedAt = null) =>
  download(id, 'build', { endedAt }, (r, base) => [{ url: r.url, filename: `${base}.html` }]);

const exportForAgent = (id) =>
  download(id, 'agent', {}, (r, base) =>
    r.files.map((f) => ({ url: f.url, filename: `${base}/${f.name}`, conflictAction: 'overwrite' })));

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

/* ---------- live to Claude ---------- */

// The /marginalia command in one Claude Code session listens here (WSL forwards localhost).
const LIVE_URL = 'http://127.0.0.1:47321';
const LIVE_ALARM = 'live-sync';
const liveEnabled = async () => (await chrome.storage.local.get('liveToClaude')).liveToClaude === true;

async function updateUnsent(fn) {
  const { liveUnsent = [] } = await chrome.storage.local.get('liveUnsent');
  const next = fn(liveUnsent);
  await chrome.storage.local.set({ liveUnsent: next });
  return next;
}

// Sends one note or drawing ({ kind, sessionId, id }). Never blocks a save: a send that
// fails waits in liveUnsent until a Claude session listens again.
async function pushLive(item) {
  exportsBuilding++;
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'live', id: item.sessionId, kind: item.kind, itemId: item.id,
    });
    if (!r?.ok) {
      // Deleted since it was queued, or its session is gone: nothing left to send.
      await updateUnsent((list) => list.filter((u) => u.id !== item.id));
      await chrome.storage.local.set({ liveError: `Could not build ${item.kind} for Claude: ${r?.error || 'no reply'}` });
      return false;
    }
    const note = item.kind === 'note' ? await db.get('notes', item.id) : null;
    const res = await fetch(`${LIVE_URL}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: item.kind, session: r.session, md: r.md, png: r.png,
        note: { id: item.id, number: note?.number ?? 0, status: note?.status },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Claude receiver answered ${res.status}`);
    await updateUnsent((list) => list.filter((u) => u.id !== item.id));
    await chrome.storage.local.set({ liveError: null });
    return true;
  } catch (e) {
    const waiting = await updateUnsent((list) => [...list.filter((u) => u.id !== item.id), item]);
    const offline = e?.name === 'TypeError' || e?.name === 'TimeoutError';
    await chrome.storage.local.set({
      liveError: offline
        ? `${waiting.length} waiting: no Claude session is listening. Run /marginalia in one; they send on their own.`
        : String(e?.message || e),
    });
    return false;
  } finally {
    exportsBuilding--;
    closeOffscreenWhenIdle();
  }
}

// Pulls the resolves Claude made, then sends anything that waited. One run at a time.
let syncing = null;
const syncLive = () => (syncing ??= doSyncLive().finally(() => (syncing = null)));

async function doSyncLive() {
  if (!(await liveEnabled())) return;
  const { liveUnsent = [] } = await chrome.storage.local.get('liveUnsent');
  for (const item of liveUnsent) if (!(await pushLive(item))) return;
  const { liveCursor = {} } = await chrome.storage.local.get('liveCursor');
  const q = new URLSearchParams({ since: liveCursor.seq || 0, boot: liveCursor.boot || '' });
  const r = await fetch(`${LIVE_URL}/updates?${q}`, { signal: AbortSignal.timeout(3000) })
    .then((res) => res.json(), () => null);
  if (!r?.ok || !Array.isArray(r.updates)) return;
  for (const u of r.updates) {
    await db.patchIfSession('notes', u.noteId, () => ({
      status: u.status, resolution: u.comment, resolvedBy: 'claude', updatedAt: now(),
    }));
  }
  await chrome.storage.local.set({ liveCursor: { boot: r.boot, seq: r.seq } });
  if (r.updates.length) await chrome.storage.local.set({ notesChangedAt: Date.now() });
}

const sendLive = async (item) => {
  if (await liveEnabled()) await pushLive(item).then((ok) => ok && syncLive());
};

async function scheduleLive() {
  if (await liveEnabled()) await chrome.alarms.create(LIVE_ALARM, { periodInMinutes: 0.5 });
  else await chrome.alarms.clear(LIVE_ALARM);
}
chrome.alarms.onAlarm.addListener((a) => a.name === LIVE_ALARM && syncLive());
chrome.runtime.onStartup.addListener(scheduleLive);
chrome.runtime.onInstalled.addListener(scheduleLive);

async function liveStatus() {
  const { liveToClaude, liveError, liveUnsent = [] } = await chrome.storage.local.get(['liveToClaude', 'liveError', 'liveUnsent']);
  if (liveToClaude !== true) return { enabled: false };
  const connected = await fetch(`${LIVE_URL}/ping`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  if (connected && liveUnsent.length) syncLive();
  return { enabled: true, connected, waiting: liveUnsent.length, error: liveError || null };
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
  sessionData: (m) => db.sessionData(m.id),
  renameSession: async (m) => {
    const s = await db.get('sessions', m.id);
    if (!s) throw new Error('Session not found');
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
  exportForAgent: async (m) => {
    const id = m.id || (await activeSession())?.id;
    if (!id) throw new Error('No active session');
    return exportForAgent(id);
  },
  markOrphaned: (m) => db.patchIfSession('notes', m.id, () => ({ orphaned: m.orphaned })),
  pruneOlderThan: (m) => pruneOlderThan(m.days),
  liveStatus: () => liveStatus(),
  setLive: async (m) => {
    await chrome.storage.local.set({ liveToClaude: !!m.enabled, liveError: null });
    await scheduleLive();
    return liveStatus();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = !msg?.target && handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'annotate' || command === 'draw') sendMode(command);
});
