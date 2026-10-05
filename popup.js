const $ = (id) => document.getElementById(id);
const send = (type, data = {}) =>
  chrome.runtime.sendMessage({ type, ...data }).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'No response');
    return r.result;
  });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const say = (text) => {
  $('msg').textContent = text;
  $('msg').hidden = !text;
};

async function render() {
  const { session, noteCount } = await send('state');
  $('idle').hidden = !!session;
  $('active').hidden = !session;
  if (session) {
    $('sessionName').textContent = session.name;
    $('noteCount').textContent = noteCount;
  } else {
    $('name').value ||= today();
  }
}

$('start').onclick = async () => {
  await send('startSession', { name: $('name').value.trim() || today() });
  render();
};
$('end').onclick = async () => {
  $('end').disabled = true;
  try {
    await send('endSession');
    say('Session ended. The report is downloading.');
  } catch (e) {
    say(e.message);
  }
  $('end').disabled = false;
  render();
};
for (const mode of ['annotate', 'draw']) {
  $(mode).onclick = async () => {
    const r = await send('mode', { mode });
    if (r.ok) window.close();
    else say(r.error || 'This page cannot be annotated.');
  };
}
$('history').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
render();
