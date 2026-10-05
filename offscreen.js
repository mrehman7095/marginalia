/* Builds export files as Blobs. A service worker has no URL.createObjectURL, and a
 * data: URL would sit in download history and can exceed the maximum string length.
 */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'build') return false;
  build(msg)
    .then((url) => reply({ ok: true, url }))
    .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function build({ id, endedAt }) {
  const data = await db.sessionData(id);
  if (!data.session) throw new Error('Session not found');
  if (endedAt) Object.assign(data.session, { status: 'ended', endedAt });
  const [css, js] = await Promise.all(['report.css', 'renderer.js'].map((f) => fetch(f).then((r) => r.text())));
  const blob = new Blob(MarginaliaReport.standaloneParts(data, css, js), { type: 'text/html' });
  return URL.createObjectURL(blob);
}
