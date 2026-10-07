/* Builds export files as Blobs. A service worker has no URL.createObjectURL, and a
 * data: URL would sit in download history and can exceed the maximum string length.
 */
const BUILDERS = { build: buildHtml, agent: buildAgent, live: buildLive };

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const builder = msg?.target === 'offscreen' && BUILDERS[msg.type];
  if (!builder) return false;
  builder(msg)
    .then((result) => reply({ ok: true, ...result }))
    .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function load(id) {
  const data = await db.sessionData(id);
  if (!data.session) throw new Error('Session not found');
  return data;
}

async function buildHtml({ id, endedAt }) {
  const data = await load(id);
  if (endedAt) Object.assign(data.session, { status: 'ended', endedAt });
  const [css, js] = await Promise.all(['report.css', 'renderer.js'].map((f) => fetch(f).then((r) => r.text())));
  const blob = new Blob(MarginaliaReport.standaloneParts(data, css, js), { type: 'text/html' });
  return { url: URL.createObjectURL(blob) };
}

/* ---------- export for agent: notes.md + one annotated PNG per snapshot ---------- */

const AGENT_BADGE_CSS_PX = 11;
const STROKE_ORDER = ['arrow', 'rect', 'ellipse', 'pen', 'highlighter'];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
const code = (s) => (String(s).includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
const quote = (text) => (text || '(no text)').split('\n').map((l) => `> ${l}`).join('\n');
const round = (v) => Math.round(v * 10) / 10;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Could not decode an image'));
  img.src = src;
});

async function annotatedPng(snap, notes, drawings) {
  const base = await loadImage(snap.image);
  const [w, h] = [base.naturalWidth, base.naturalHeight];
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(base, 0, 0);
  const svg = MarginaliaReport.overlaySvg(snap, notes, drawings, AGENT_BADGE_CSS_PX)
    .replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `);
  ctx.drawImage(await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)), 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function noteMd(n) {
  const a = n.anchor || {};
  const r = n.rect;
  const lines = [`### ${n.number}. [${n.tag}] [${n.status}]`, '', quote(n.text), '', `- kind: ${n.kind}`];
  if (n.kind === 'element') {
    lines.push(`- selector: ${code(a.selector || '')}`, `- text fingerprint: ${a.text ? code(a.text) : '(none)'}`,
      `- DOM path: ${code(a.path || '')}`);
  }
  if (r) lines.push(`- box: {x: ${round(r.x)}, y: ${round(r.y)}, w: ${round(r.w)}, h: ${round(r.h)}}`);
  if (n.orphaned) lines.push('- orphaned: the element was not found on the page at last check');
  return lines.join('\n');
}

function drawingsMd(drawings) {
  const strokes = drawings.flatMap((d) => d.strokes);
  if (!strokes.length) return '';
  const counts = STROKE_ORDER.map((t) => [t, strokes.filter((s) => s.tool === t).length]).filter(([, c]) => c);
  const labels = strokes.filter((s) => s.tool === 'text');
  const redacted = strokes.filter((s) => s.tool === 'redact').length;
  const lines = ['### Drawings', ''];
  for (const s of labels) lines.push(`- text label: ${code(s.text)}`);
  if (counts.length) lines.push(`- strokes: ${counts.map(([t, c]) => `${t} ${c}`).join(', ')}`);
  if (redacted) lines.push(`- redacted area: ${redacted}`);
  return lines.join('\n');
}

async function buildAgent({ id }) {
  const { session, snapshots, notes, drawings } = await load(id);
  const of = (list, snapId) => list.filter((x) => x.snapshotId === snapId);
  const tags = MarginaliaReport.TAGS.map((t) => [t, notes.filter((n) => n.tag === t).length]).filter(([, c]) => c);
  const end = session.endedAt || snapshots.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), session.createdAt);
  const md = [
    `# Marginalia session: ${session.name}`, '',
    `- time: ${session.createdAt} to ${end}`,
    `- notes: ${notes.length}${tags.length ? ` (${tags.map(([t, c]) => `${t} ${c}`).join(', ')})` : ''}`,
    `- snapshots: ${snapshots.length}`, '',
    'Numbers in the images match the note numbers below. Boxes are viewport CSS pixels at capture time, measured from the top-left of the viewport.',
  ];
  if (snapshots.some((s) => s.nonLocal)) {
    md.push('', 'Caution: some screenshots come from non-local hosts and may contain real member data.');
  }
  const files = [];
  for (const [i, snap] of snapshots.entries()) {
    const nn = String(i + 1).padStart(2, '0');
    const own = of(notes, snap.id);
    const strokes = of(drawings, snap.id);
    const name = `${nn}-${slug(snap.title || new URL(snap.url).pathname)}.png`;
    const png = snap.image ? await annotatedPng(snap, own, strokes) : null;
    if (png) files.push({ name, url: URL.createObjectURL(png) });
    md.push('', `## ${nn} — ${snap.title || 'Untitled'}`, '',
      `- URL: ${snap.url}`,
      `- viewport: ${snap.vw}x${snap.vh} @${snap.dpr}x`,
      `- scroll: ${round(snap.scrollX)}, ${round(snap.scrollY)}`,
      `- captured: ${snap.updatedAt}`,
      png ? `- image: ${name}` : '- image: none (the screenshot was not captured)');
    if (png) md.push('', `![${nn}](${name})`);
    for (const n of own) md.push('', noteMd(n));
    const dmd = drawingsMd(strokes);
    if (dmd) md.push('', dmd);
  }
  const notesMd = new Blob([md.join('\n') + '\n'], { type: 'text/markdown' });
  files.unshift({ name: 'notes.md', url: URL.createObjectURL(notesMd) });
  return { files };
}

/* ---------- live to Claude: one note, its page facts and its annotated snapshot ---------- */

const blobBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function buildLive({ id, kind, itemId }) {
  const { session, snapshots, notes, drawings } = await load(id);
  const item = (kind === 'drawing' ? drawings : notes).find((x) => x.id === itemId);
  if (!item) throw new Error(`${kind === 'drawing' ? 'Drawing' : 'Note'} not found`);
  const snap = snapshots.find((s) => s.id === item.snapshotId);
  const md = kind === 'drawing'
    ? [`### Drawing on ${snap?.title || 'Untitled'}`, '', drawingsMd([item]).replace(/^### Drawings\n\n/, '')]
    : [noteMd(item)];
  md.push('', `- page: ${snap?.title || 'Untitled'} — ${item.url}`);
  if (snap) md.push(`- viewport: ${snap.vw}x${snap.vh} @${snap.dpr}x, scroll ${round(snap.scrollX)}, ${round(snap.scrollY)}`);
  if (snap?.nonLocal) md.push('- caution: the screenshot comes from a non-local host and may contain real member data');
  const png = snap?.image
    ? await blobBase64(await annotatedPng(snap, notes.filter((n) => n.snapshotId === snap.id),
      drawings.filter((d) => d.snapshotId === snap.id)))
    : null;
  return { session: { id: session.id, name: session.name }, md: md.join('\n'), png };
}
