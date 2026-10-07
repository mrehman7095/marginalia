// Records docs/demo.mp4 and docs/demo.gif. Needs Playwright's Chromium and ffmpeg:
//   NODE_PATH=/path/to/node_modules node dev/record-demo.mjs   (node_modules must contain @playwright/test)
// The bridge needs 127.0.0.1:47321. If /marginalia already holds it, run inside a private network:
//   unshare -rn sh -c 'ip link set lo up && NODE_PATH=... node dev/record-demo.mjs'
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('@playwright/test');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const DOCS = join(ROOT, 'docs');
const W = 1280, H = 800, FPS = 25;
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']
  .find(existsSync);

const work = mkdtempSync(join(tmpdir(), 'marginalia-demo-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = {};
const mark = (name) => (marks[name] = Date.now());

/* ---------- static server for dev/demo and the bridge ---------- */

const demoHtml = readFileSync(join(ROOT, 'dev/demo/index.html'));
const site = createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/' ? demoHtml : '');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const demoUrl = `http://localhost:${site.address().port}/`;

if (await fetch('http://127.0.0.1:47321/ping').then(() => true, () => false)) {
  console.error('127.0.0.1:47321 is in use (a /marginalia receiver?). See the header for how to run isolated.');
  process.exit(1);
}
const received = [];
const bridge = spawn(process.execPath, [join(ROOT, 'claude-mod/bridge/server.mjs'), '47321', join(work, 'inbox')]);
bridge.stdout.setEncoding('utf8').on('data', (chunk) => {
  for (const line of chunk.split('\n').filter(Boolean)) received.push({ t: Date.now(), ...JSON.parse(line) });
});
while (!received.some((e) => e.type === 'listening')) await sleep(50);

/* ---------- browser ---------- */

// Video has no pointer, so draw one. It hides with Marginalia's UI so it never lands in a capture.
const fakeCursor = () => {
  if (window.top !== window) return;
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;left:-40px;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transition:transform .08s';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.4L9 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX - 4 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
    addEventListener('mousedown', () => (c.style.transform = 'scale(.8)'), true);
    addEventListener('mouseup', () => (c.style.transform = ''), true);
    const watch = setInterval(() => {
      const host = document.querySelector('marginalia-root');
      if (!host) return;
      clearInterval(watch);
      document.documentElement.appendChild(c);
      new MutationObserver(() => (c.style.visibility = host.style.display === 'none' ? 'hidden' : ''))
        .observe(host, { attributes: true, attributeFilter: ['style'] });
    }, 200);
  });
};

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: W, height: H },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.addInitScript(fakeCursor);
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extId = new URL(worker.url()).host;

// CDP screencast: sharper than recordVideo, and frames carry wall-clock times.
async function screencast(page, tag) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(work, `${tag}-${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp * 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const start = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H });
  await start();
  return { frames, start };
}

// Moves the pointer in visible steps, then clicks.
let pointer = { x: W / 2, y: H / 2 };
async function moveTo(page, x, y, steps = 18) {
  await page.mouse.move(x, y, { steps });
  pointer = { x, y };
}
async function center(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}
async function clickOn(page, locator, pause = 250) {
  const { x, y } = await center(locator);
  await moveTo(page, x, y);
  await sleep(pause);
  await page.mouse.click(x, y);
}
async function drag(page, from, to, steps = 28) {
  await moveTo(page, from.x, from.y);
  await sleep(200);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await sleep(150);
  await page.mouse.up();
  pointer = to;
}
const toast = (page, text) => page.locator('.toast', { hasText: text }).waitFor({ timeout: 10000 });

/* ---------- the flow ---------- */

const demo = context.pages()[0] || (await context.newPage());
await demo.goto(demoUrl);
const demoCast = await screencast(demo, 'demo');
await demo.mouse.move(pointer.x, pointer.y);
await sleep(400);
mark('intro');
await moveTo(demo, 700, 420, 30);
await sleep(900);

// The toolbar popup, opened as a page; it is laid over the video top right.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.bringToFront();
const popupCast = await screencast(popup, 'popup');
await popup.mouse.move(150, 300);
await sleep(300);
mark('popup');
await clickOn(popup, popup.locator('#name'));
await popup.keyboard.press('Control+A');
await popup.keyboard.type('Acme settings review', { delay: 45 });
await sleep(300);
await clickOn(popup, popup.locator('#start'));
await sleep(900);
await clickOn(popup, popup.locator('#live'));
await popup.locator('#liveState', { hasText: 'Each saved note' }).waitFor();
mark('live');
await sleep(1700);
const popupBox = await popup.evaluate(() => {
  const r = document.body.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(document.querySelector('footer').getBoundingClientRect().bottom + 10) };
});
const { session } = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }))).result;
mark('popupEnd');
await popup.close();
await demo.bringToFront();

// Annotate an element.
const bar = (act) => demo.locator(`marginalia-root button[data-act="${act}"]`);
await demo.mouse.move(pointer.x, pointer.y);
mark('annotate');
await clickOn(demo, bar('annotate'));
await sleep(700);
for (const sel of ['.stat.plan .label', '#ws', '#owner']) {
  const { x, y } = await center(demo.locator(sel));
  await moveTo(demo, x, y, 14);
  await sleep(350);
}
await clickOn(demo, demo.locator('#save'), 500);
await sleep(500);
await demo.keyboard.type('Save button sits lower than Cancel, and the label has a typo: "chanegs".', { delay: 28 });
await sleep(500);
await clickOn(demo, demo.locator('marginalia-root .editor .save'));
await toast(demo, 'Note saved');
await sleep(1300);

// Mark a region.
mark('region');
const plan = (await demo.locator('.stat.plan').boundingBox());
await drag(demo, { x: plan.x + 8, y: plan.y + 30 }, { x: plan.x + plan.width - 10, y: plan.y + 78 });
await sleep(500);
await demo.keyboard.type('Plan name and price overlap.', { delay: 32 });
await demo.locator('marginalia-root .editor select').selectOption('ux');
await sleep(500);
await clickOn(demo, demo.locator('marginalia-root .editor .save'));
await toast(demo, 'Note saved');
await sleep(1200);

// Draw an arrow and redact the owner's email.
mark('draw');
await clickOn(demo, bar('draw'));
await sleep(800);
await clickOn(demo, demo.locator('marginalia-root .tools [data-tool="arrow"]'));
const pill = await demo.locator('.pill.pending').boundingBox();
await drag(demo, { x: pill.x - 150, y: pill.y + 95 }, { x: pill.x - 6, y: pill.y + pill.height / 2 + 2 });
await sleep(500);
await clickOn(demo, demo.locator('marginalia-root .tools [data-tool="redact"]'));
const owner = await demo.locator('#owner').boundingBox();
await drag(demo, { x: owner.x + 4, y: owner.y + 3 }, { x: owner.x + 190, y: owner.y + owner.height - 3 });
await sleep(900);
await clickOn(demo, demo.locator('marginalia-root .tools [data-act="done"]'));
await toast(demo, 'Drawing saved');
await sleep(1000);

// The notes list.
mark('list');
await clickOn(demo, bar('list'));
await sleep(1200);
for (const n of [0, 1]) {
  await clickOn(demo, demo.locator('marginalia-root .list .item').nth(n));
  await sleep(1200);
}
const deadline = Date.now() + 10000;
while (received.filter((e) => e.type === 'note').length < 3 && Date.now() < deadline) await sleep(200);
await sleep(800);

// History shows the stored, annotated screenshots with the redaction burned in.
mark('history');
await demo.goto(`chrome-extension://${extId}/history.html?session=${session.id}`);
await demoCast.start().catch(() => {});
await demo.locator('#report img, #report canvas').first().waitFor({ timeout: 10000 }).catch(() => {});
await demo.mouse.move(1180, 600);
await sleep(1500);
for (let i = 0; i < 6; i++) {
  await demo.mouse.wheel(0, 70);
  await sleep(120);
}
await sleep(2500);
mark('end');

await context.close();
bridge.kill();
site.close();

/* ---------- compose ---------- */

const t0 = marks.intro, t1 = marks.end;
const sec = (t) => ((t - t0) / 1000).toFixed(2);

// One concat list per page, covering [t0, t1]; before its first frame a page shows that frame.
function concatList(frames, name) {
  const lines = [];
  const inRange = frames.filter((f) => f.t < t1);
  const startIdx = Math.max(0, inRange.findLastIndex((f) => f.t <= t0));
  const used = inRange.slice(startIdx);
  used.forEach((f, i) => {
    const from = Math.max(t0, i === 0 ? t0 : f.t);
    const to = i + 1 < used.length ? Math.max(t0, used[i + 1].t) : t1;
    if (to <= from && i + 1 < used.length) return;
    lines.push(`file '${f.file}'`, `duration ${((to - from) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${used.at(-1).file}'`);
  const path = join(work, `${name}.txt`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const fontArg = FONT ? `fontfile=${FONT}` : 'font=Sans';
let textN = 0;
function text(str, x, y, from, to, size = 18, color = 'white', box = '') {
  const file = join(work, `text-${textN++}.txt`);
  writeFileSync(file, str);
  return `drawtext=${fontArg}:textfile=${file}:x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${box}` +
    `:enable='between(t,${sec(from)},${sec(to)})'`;
}

const captions = [
  ['intro', 'popup', 'Marginalia: notes and drawings on any page, for Claude Code'],
  ['popup', 'annotate', 'Start a session and switch on Live to Claude'],
  ['annotate', 'region', 'Annotate: click an element and describe the problem'],
  ['region', 'draw', 'Drag to mark a region'],
  ['draw', 'list', 'Draw: arrow, shapes and redact'],
  ['list', 'history', 'The notes list jumps to each pin'],
  ['history', 'end', 'History: the stored screenshots, redaction burned in'],
];
const filters = [];
const captionBox = ':box=1:boxcolor=0x111827@0.88:boxborderw=12';
for (const [a, b, str] of captions) filters.push(text(str, 32, H - 54, marks[a], marks[b], 20, 'white', captionBox));

// The receiver panel: what the bridge printed, line by line, at the time it printed it.
const notesIn = received.filter((e) => e.type === 'note').slice(0, 4);
const panel = { x: 252, y: H - 214, w: 560, h: 46 + notesIn.length * 24 };
const shownFrom = notesIn[0]?.t ?? marks.history, shownUntil = marks.history;
filters.push(`drawbox=x=${panel.x}:y=${panel.y}:w=${panel.w}:h=${panel.h}:color=0x0b1220@0.92:t=fill:enable='between(t,${sec(shownFrom)},${sec(shownUntil)})'`);
filters.push(text('Claude Code receiver  127.0.0.1:47321  listening', panel.x + 14, panel.y + 12, shownFrom, shownUntil, 15, '0x7dd3fc'));
notesIn.forEach((e, i) => {
  const what = e.kind === 'drawing' ? 'drawing' : `note ${e.number}`;
  const line = `received ${what.padEnd(8)} ${basename(e.image || '')}`;
  filters.push(text(line, panel.x + 14, panel.y + 42 + i * 24, e.t, shownUntil, 15, '0xe5e7eb'));
});

const cast = (list) => ['-f', 'concat', '-safe', '0', '-i', list];
const pop = { w: popupBox.w + 8, h: popupBox.h + 8 };
const graph = [
  `[0:v]fps=${FPS},format=yuv420p[m]`,
  `[1:v]fps=${FPS},crop=${pop.w}:${pop.h}:0:0,pad=${pop.w + 2}:${pop.h + 2}:1:1:color=0x9aa3b5[p]`,
  `[m][p]overlay=x=${W - pop.w - 40}:y=16:enable='between(t,${sec(marks.popup) - 0.3},${sec(marks.popupEnd)})'[o]`,
  `[o]${filters.join(',')}[v]`,
].join(';');
const mp4 = join(DOCS, 'demo.mp4');
const gif = join(DOCS, 'demo.gif');
const run = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
run([...cast(concatList(demoCast.frames, 'demo')), ...cast(concatList(popupCast.frames, 'popup')),
  '-filter_complex', graph, '-map', '[v]', '-t', sec(t1),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
run(['-i', mp4, '-filter_complex',
  'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  gif]);

for (const [name, t] of Object.entries(marks)) console.log(`${sec(t).padStart(6)} s  ${name}`);
for (const f of [mp4, gif]) console.log(`${(statSync(f).size / 1e6).toFixed(2)} MB  ${f}`);
console.log(`bridge received ${received.filter((e) => e.type === 'note').length} items`);
rmSync(work, { recursive: true, force: true });
