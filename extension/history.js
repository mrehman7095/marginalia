const $ = (id) => document.getElementById(id);
const send = (type, data = {}) =>
  chrome.runtime.sendMessage({ type, ...data }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'No response');
    return r.result;
  });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
let selected = new URLSearchParams(location.search).get('session');
let sessions = [];

async function loadList() {
  sessions = await send('listSessions');
  $('sessions').innerHTML = sessions.map((s) => `
    <li data-id="${s.id}" class="${s.id === selected ? 'on' : ''}">
      <div class="title"><span>${esc(s.name)}</span><span class="badge ${s.status}">${s.status}</span></div>
      <div class="meta">${new Date(s.createdAt).toLocaleString()} · ${s.noteCount} notes · ~${size(s.bytes)}</div>
      <div class="meta">${esc(s.sites.join(', ') || 'No sites yet')}</div>
    </li>`).join('') || '<li class="muted">No sessions yet.</li>';
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  $('storage').textContent = `Storage used: ${size(usage)}`;
  $('meter').style.width = quota ? `${Math.min(100, (usage / quota) * 100)}%` : '0';
}

async function open(id) {
  selected = id;
  history.replaceState(null, '', id ? `?session=${id}` : location.pathname);
  document.querySelectorAll('#sessions li').forEach((li) => li.classList.toggle('on', li.dataset.id === id));
  $('actions').hidden = !id;
  if (!id) return ($('report').innerHTML = '<div class="placeholder">Select a session.</div>');
  const data = await send('sessionData', { id });
  if (!data.session) return open(null);
  $('resume').disabled = data.session.status === 'active';
  MarginaliaReport.mount($('report'), data);
}

$('sessions').onclick = (e) => {
  const id = e.target.closest('li[data-id]')?.dataset.id;
  if (id) open(id);
};
$('export').onclick = () => send('exportSession', { id: selected }).catch((e) => alert(e.message));
$('agent').onclick = () => send('exportForAgent', { id: selected }).catch((e) => alert(e.message));
$('resume').onclick = async () => {
  await send('resumeSession', { id: selected });
  await loadList();
  open(selected);
};
$('rename').onclick = async () => {
  const current = sessions.find((s) => s.id === selected);
  const name = prompt('Session name', current?.name);
  if (!name) return;
  await send('renameSession', { id: selected, name });
  await loadList();
  open(selected);
};
$('delete').onclick = async () => {
  if (!confirm('Delete this session and its screenshots?')) return;
  await send('deleteSession', { id: selected });
  await loadList();
  open(null);
};
$('prune').onclick = async () => {
  const days = +$('days').value;
  if (!(days > 0) || !confirm(`Delete all sessions older than ${days} days (except the active one)?`)) return;
  await send('pruneOlderThan', { days });
  await loadList();
  if (!sessions.some((s) => s.id === selected)) open(null);
};

loadList().then(() => open(selected));
