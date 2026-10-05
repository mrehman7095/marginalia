/* Marginalia in-page UI. Inert until chrome.storage.local says a session is active:
 * no DOM work, no observers, no timers. All UI lives in one shadow root.
 */
(() => {
  if (window.top !== window || window.__marginalia) return;
  window.__marginalia = true;

  const TAGS = ['bug', 'ux', 'copy', 'question', 'idea'];
  const TOOLS = [['pen', 'Pen'], ['highlighter', 'Highlight'], ['arrow', 'Arrow'], ['rect', 'Rect'],
    ['ellipse', 'Ellipse'], ['text', 'Text'], ['redact', 'Redact']];
  const DRAG_PX = 6;

  let session = null;
  let ui = null;

  const send = (type, data = {}) =>
    chrome.runtime.sendMessage({ type, ...data }).then((r) => {
      if (!r?.ok) throw new Error(r?.error || 'Marginalia: no response');
      return r.result;
    });

  chrome.storage.local.get('activeSession').then(({ activeSession }) => setSession(activeSession));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'activeSession' in changes) setSession(changes.activeSession.newValue);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'hide-ui') {
      if (!ui) return reply({});
      ui.host.style.display = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => reply({})));
      return true;
    }
    if (msg.type === 'show-ui') {
      if (ui) ui.host.style.display = '';
      reply({});
    }
    if (msg.type === 'mode') {
      if (!ui) return reply({ ok: false });
      ui.toggleMode(msg.mode);
      reply({ ok: true });
    }
    return false;
  });

  function setSession(next) {
    session = next || null;
    if (session && !ui) ui = createUi();
    else if (!session && ui) {
      ui.destroy();
      ui = null;
    } else if (ui) ui.refresh();
  }

  /* ---------- anchors ---------- */

  const STABLE_ID = (id) => id && !/\d{3,}|^(ng|mat|cdk|mui|react)-/i.test(id);
  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const fingerprint = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  function selectorFor(el) {
    if (STABLE_ID(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'formcontrolname', 'title']) {
      const v = el.getAttribute(attr);
      const sel = v && `${el.localName}[${attr}="${CSS.escape(v)}"]`;
      if (sel && unique(sel)) return sel;
    }
    const parts = [];
    for (let cur = el; cur && cur !== document.body && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur !== el && STABLE_ID(cur.id) && unique('#' + CSS.escape(cur.id))) {
        parts.unshift('#' + CSS.escape(cur.id));
        return parts.join(' > ');
      }
      const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.localName === cur.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return ['body', ...parts].join(' > ');
  }

  function domPath(el) {
    const path = [];
    for (let cur = el; cur && cur !== document.body && cur.parentElement; cur = cur.parentElement) {
      path.unshift([...cur.parentElement.children].indexOf(cur));
    }
    return path.join('/');
  }

  function anchorFor(el) {
    const r = el.getBoundingClientRect();
    return {
      selector: selectorFor(el), tag: el.localName, text: fingerprint(el), path: domPath(el),
      docRect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
    };
  }

  function resolveAnchor(a) {
    if (!a?.selector) return null;
    try {
      const els = document.querySelectorAll(a.selector);
      if (els.length === 1) return els[0];
    } catch { /* stored selector may be invalid on this page */ }
    if (a.text && a.text.length > 1) {
      for (const el of document.getElementsByTagName(a.tag)) if (fingerprint(el) === a.text) return el;
    }
    let cur = document.body;
    for (const i of a.path ? a.path.split('/') : []) cur = cur?.children[+i];
    return cur && cur !== document.body && cur.localName === a.tag ? cur : null;
  }

  const pageKey = (u) => { const x = new URL(u); return x.origin + x.pathname + x.search; };
  const pageState = () => ({
    url: location.href, title: document.title, scrollX, scrollY,
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
  });
  const viewRect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- UI ---------- */

  function createUi() {
    const host = document.createElement('marginalia-root');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS_TEXT}</style>
      <div class="pins"></div>
      <div class="hover"></div><div class="region"></div><div class="flash"></div>
      <div class="panel">
        <div class="list" hidden></div>
        <div class="bar">
          <span class="brand" title="Marginalia">M</span>
          <span class="name"></span>
          <button data-act="list">Notes <b class="count">0</b></button>
          <button data-act="pins">Hide pins</button>
          <button data-act="annotate">Annotate</button>
          <button data-act="draw">Draw</button>
        </div>
      </div>
      <div class="toast" hidden></div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const pinsEl = $('.pins'), hoverEl = $('.hover'), regionEl = $('.region'), flashEl = $('.flash');
    const listEl = $('.list'), toastEl = $('.toast');
    let notes = [];
    const resolved = new Map();
    let pinsHidden = false;
    let mode = null;
    let editor = null;
    let draw = null;
    let url = location.href;
    let raf = 0;

    for (const k of ['keydown', 'keyup', 'keypress']) root.addEventListener(k, (e) => e.stopPropagation());

    $('.bar').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'list') listEl.hidden = !listEl.hidden;
      if (act === 'pins') {
        pinsHidden = !pinsHidden;
        e.target.closest('button').textContent = pinsHidden ? 'Show pins' : 'Hide pins';
        pinsEl.hidden = pinsHidden;
      }
      if (act === 'annotate' || act === 'draw') toggleMode(act);
    });

    function toast(text) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      clearTimeout(toast.t);
      toast.t = setTimeout(() => (toastEl.hidden = true), 1800);
    }

    function refresh() {
      $('.name').textContent = session.name;
      loadNotes();
    }

    async function loadNotes() {
      try {
        notes = await send('pageNotes', { url: location.href });
      } catch {
        notes = [];
      }
      resolved.clear();
      renderPins();
    }

    function resolveNote(n) {
      if (n.kind === 'region') return null;
      let el = resolved.get(n.id);
      if (!el || !el.isConnected) {
        el = resolveAnchor(n.anchor);
        resolved.set(n.id, el);
      }
      return el;
    }

    function rectOf(n) {
      if (n.kind === 'region') {
        const d = n.anchor.docRect;
        return { x: d.x - scrollX, y: d.y - scrollY, w: d.w, h: d.h };
      }
      const el = resolveNote(n);
      return el ? viewRect(el.getBoundingClientRect()) : null;
    }

    function renderPins() {
      pinsEl.innerHTML = notes.map((n) =>
        `<button class="pin tag-${n.tag}${n.status === 'resolved' ? ' resolved' : ''}" data-id="${n.id}" title="${esc(n.text)}">${n.number}</button>`,
      ).join('');
      $('.count').textContent = notes.length;
      position();
    }

    function position() {
      raf = 0;
      let orphans = false;
      for (const pin of pinsEl.children) {
        const n = notes.find((x) => x.id === pin.dataset.id);
        const r = n && rectOf(n);
        const gone = n && n.kind === 'element' && !resolved.get(n.id);
        n.orphaned = gone;
        orphans ||= gone;
        const visible = r && (r.w > 0 || r.h > 0);
        pin.style.display = visible ? '' : 'none';
        if (visible) pin.style.transform = `translate(${Math.max(0, r.x - 10)}px, ${Math.max(0, r.y - 10)}px)`;
      }
      renderList();
    }

    function renderList() {
      const html = notes.map((n) =>
        `<div class="item" data-id="${n.id}"><span class="num tag-${n.tag}">${n.number}</span>` +
        `<span class="tag">${n.tag}</span>${n.orphaned ? '<span class="orphan">orphaned</span>' : ''}` +
        `${n.status === 'resolved' ? '<span class="done">resolved</span>' : ''}<span class="text">${esc(n.text)}</span></div>`,
      ).join('') || '<div class="empty">No notes on this page.</div>';
      if (listEl.innerHTML !== html) listEl.innerHTML = html;
    }

    const schedule = () => { raf ||= requestAnimationFrame(() => { position(); draw?.redraw(); }); };

    listEl.addEventListener('click', (e) => {
      const n = notes.find((x) => x.id === e.target.closest('.item')?.dataset.id);
      if (!n) return;
      const el = resolveNote(n);
      if (n.kind === 'region') scrollTo({ top: n.anchor.docRect.y - innerHeight / 3, behavior: 'instant' });
      else if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      else return openEditor({ note: n });
      requestAnimationFrame(() => {
        const r = rectOf(n);
        if (!r) return;
        Object.assign(flashEl.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        flashEl.classList.remove('on');
        void flashEl.offsetWidth;
        flashEl.classList.add('on');
      });
    });

    pinsEl.addEventListener('click', (e) => {
      const n = notes.find((x) => x.id === e.target.closest('.pin')?.dataset.id);
      if (n) openEditor({ note: n });
    });

    /* ----- editor ----- */

    function openEditor({ note, kind, element, rect }) {
      closeEditor();
      const r = note ? rectOf(note) || note.rect : rect;
      const box = document.createElement('div');
      box.className = 'editor';
      box.innerHTML = `
        <div class="head">${note ? `Note ${note.number}` : 'New note'} <span>${note?.kind || kind}${note?.orphaned ? ' · orphaned' : ''}</span></div>
        <textarea placeholder="What is wrong or worth noting?"></textarea>
        <div class="row">
          <select>${TAGS.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
          ${note ? `<label><input type="checkbox" class="resolved"> Resolved</label>` : ''}
        </div>
        <div class="row end">
          ${note ? '<button class="del">Delete</button>' : ''}
          <button class="cancel">Cancel</button>
          <button class="save primary">Save</button>
        </div>`;
      root.appendChild(box);
      const ta = box.querySelector('textarea');
      const sel = box.querySelector('select');
      ta.value = note?.text || '';
      sel.value = note?.tag || 'bug';
      if (note) box.querySelector('.resolved').checked = note.status === 'resolved';
      const left = Math.min(Math.max(8, r.x), innerWidth - 300);
      const below = r.y + r.h + 8;
      box.style.left = left + 'px';
      box.style.top = (below + 190 < innerHeight ? below : Math.max(8, r.y - 198)) + 'px';
      setTimeout(() => ta.focus(), 0);

      const save = async () => {
        const payload = note
          ? { id: note.id, kind: note.kind, rect: note.rect, anchor: note.anchor }
          : { kind, rect, anchor: element ? anchorFor(element) : regionAnchor(rect) };
        if (note) {
          const el = note.kind === 'element' ? resolveNote(note) : null;
          if (el) Object.assign(payload, { rect: viewRect(el.getBoundingClientRect()), anchor: anchorFor(el) });
          if (note.kind === 'region') payload.rect = rectOf(note);
        }
        Object.assign(payload, {
          text: ta.value.trim(), tag: sel.value,
          status: note && box.querySelector('.resolved').checked ? 'resolved' : 'open',
        });
        closeEditor();
        try {
          await send('saveNote', { note: payload, page: pageState() });
          toast('Note saved');
        } catch (err) {
          toast(err.message);
        }
        loadNotes();
      };
      box.querySelector('.save').onclick = save;
      box.querySelector('.cancel').onclick = closeEditor;
      if (note) {
        box.querySelector('.del').onclick = async () => {
          closeEditor();
          await send('deleteNote', { id: note.id });
          loadNotes();
        };
      }
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
      editor = box;
    }

    function closeEditor() {
      editor?.remove();
      editor = null;
      regionEl.style.display = 'none';
    }

    const regionAnchor = (r) => ({
      selector: '', tag: '', text: '', path: '', docRect: { x: r.x + scrollX, y: r.y + scrollY, w: r.w, h: r.h },
    });

    /* ----- annotate mode ----- */

    let press = null;
    const ours = (e) => e.composedPath().includes(host);
    const BLOCK = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerup', 'touchstart'];

    function block(e) {
      if (ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onMove(e) {
      if (ours(e)) return hoverEl.style.display = 'none';
      if (editor) return;
      if (press) {
        const x = Math.min(press.x, e.clientX), y = Math.min(press.y, e.clientY);
        const w = Math.abs(e.clientX - press.x), h = Math.abs(e.clientY - press.y);
        press.dragging ||= w > DRAG_PX || h > DRAG_PX;
        if (press.dragging) {
          hoverEl.style.display = 'none';
          Object.assign(regionEl.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        }
        return;
      }
      const r = e.target.getBoundingClientRect();
      Object.assign(hoverEl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      hoverEl.dataset.label = e.target.localName;
    }

    function onDown(e) {
      if (ours(e)) return;
      block(e);
      if (editor) return closeEditor();
      if (e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, target: e.target, dragging: false };
    }

    function onUp(e) {
      if (!press) return;
      block(e);
      const p = press;
      press = null;
      hoverEl.style.display = 'none';
      if (p.dragging) {
        const rect = {
          x: Math.min(p.x, e.clientX), y: Math.min(p.y, e.clientY),
          w: Math.abs(e.clientX - p.x), h: Math.abs(e.clientY - p.y),
        };
        openEditor({ kind: 'region', rect });
      } else {
        const element = p.target;
        openEditor({ kind: 'element', element, rect: viewRect(element.getBoundingClientRect()) });
      }
    }

    function setAnnotate(on) {
      const opts = { capture: true };
      if (on) {
        addEventListener('pointermove', onMove, opts);
        addEventListener('pointerdown', onDown, opts);
        addEventListener('pointerup', onUp, opts);
        BLOCK.forEach((t) => t !== 'pointerup' && addEventListener(t, block, opts));
      } else {
        removeEventListener('pointermove', onMove, opts);
        removeEventListener('pointerdown', onDown, opts);
        removeEventListener('pointerup', onUp, opts);
        BLOCK.forEach((t) => t !== 'pointerup' && removeEventListener(t, block, opts));
        hoverEl.style.display = 'none';
        press = null;
      }
    }

    /* ----- draw mode ----- */

    function startDraw() {
      const layer = document.createElement('div');
      layer.className = 'draw';
      layer.innerHTML = `<canvas></canvas>
        <div class="tools">
          ${TOOLS.map(([t, label]) => `<button data-tool="${t}">${label}</button>`).join('')}
          <input type="color" value="#e5484d" title="Color">
          <input type="range" min="1" max="12" value="3" title="Width">
          <button data-act="undo" title="Ctrl+Z">Undo</button>
          <button data-act="redo" title="Ctrl+Shift+Z">Redo</button>
          <button data-act="cancel">Cancel</button>
          <button data-act="done" class="primary">Done</button>
        </div>`;
      root.appendChild(layer);
      const canvas = layer.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const color = layer.querySelector('input[type=color]');
      const width = layer.querySelector('input[type=range]');
      const strokes = [];
      const redo = [];
      let tool = 'pen';
      let cur = null;

      const selectTool = (t) => {
        tool = t;
        layer.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      };
      selectTool('pen');

      function resize() {
        canvas.width = innerWidth * devicePixelRatio;
        canvas.height = innerHeight * devicePixelRatio;
        redraw();
      }

      function redraw() {
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, -scrollX * devicePixelRatio, -scrollY * devicePixelRatio);
        ctx.clearRect(scrollX, scrollY, innerWidth, innerHeight);
        for (const s of cur ? [...strokes, cur] : strokes) paint(ctx, s);
      }

      const pt = (e) => ({ x: e.clientX + scrollX, y: e.clientY + scrollY });
      canvas.addEventListener('pointerdown', (e) => {
        if (tool === 'text') {
          const text = prompt('Label text');
          if (text) push({ tool, color: color.value, width: +width.value, points: [pt(e)], text });
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        cur = { tool, color: color.value, width: +width.value, points: [pt(e), pt(e)] };
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!cur) return;
        if (cur.tool === 'pen' || cur.tool === 'highlighter') cur.points.push(pt(e));
        else cur.points[1] = pt(e);
        redraw();
      });
      canvas.addEventListener('pointerup', () => {
        if (!cur) return;
        const s = cur;
        cur = null;
        const [a, b] = [s.points[0], s.points[s.points.length - 1]];
        if (s.points.length > 2 || Math.hypot(b.x - a.x, b.y - a.y) > 3) push(s);
        else redraw();
      });

      function push(s) {
        strokes.push(s);
        redo.length = 0;
        redraw();
      }

      function undoRedo(back) {
        const [from, to] = back ? [strokes, redo] : [redo, strokes];
        if (from.length) to.push(from.pop());
        redraw();
      }

      async function finish(save) {
        removeEventListener('resize', resize);
        layer.remove();
        draw = null;
        mode = null;
        updateModeButtons();
        if (!save || !strokes.length) return;
        const page = pageState();
        const out = strokes.map((s) => ({
          ...s, rel: s.points.map((p) => ({ x: p.x - page.scrollX, y: p.y - page.scrollY })),
        }));
        toast('Saving drawing...');
        try {
          await send('saveDrawing', { strokes: out, page });
          toast('Drawing saved');
        } catch (err) {
          toast(err.message);
        }
      }

      layer.querySelector('.tools').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tool) selectTool(b.dataset.tool);
        if (b.dataset.act === 'undo') undoRedo(true);
        if (b.dataset.act === 'redo') undoRedo(false);
        if (b.dataset.act === 'cancel') finish(false);
        if (b.dataset.act === 'done') finish(true);
      });
      addEventListener('resize', resize);
      resize();
      return { redraw, finish, undoRedo, strokes };
    }

    function paint(c, s) {
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      c.save();
      c.strokeStyle = c.fillStyle = s.color;
      c.lineWidth = s.width;
      c.lineCap = c.lineJoin = 'round';
      if (s.tool === 'pen' || s.tool === 'highlighter') {
        if (s.tool === 'highlighter') {
          c.globalAlpha = 0.35;
          c.lineWidth = s.width * 4;
        }
        c.beginPath();
        s.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.stroke();
      } else if (s.tool === 'arrow') {
        const head = Math.max(10, s.width * 4);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x - Math.cos(ang) * head * 0.6, b.y - Math.sin(ang) * head * 0.6);
        c.stroke();
        c.beginPath();
        c.moveTo(b.x, b.y);
        c.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
        c.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
        c.closePath();
        c.fill();
      } else if (s.tool === 'rect') {
        c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      } else if (s.tool === 'ellipse') {
        c.beginPath();
        c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        c.stroke();
      } else if (s.tool === 'text') {
        c.font = `600 ${14 + s.width * 2}px system-ui, sans-serif`;
        c.textBaseline = 'top';
        c.lineWidth = 3;
        c.strokeStyle = 'rgba(255,255,255,.85)';
        c.strokeText(s.text, a.x, a.y);
        c.fillText(s.text, a.x, a.y);
      } else if (s.tool === 'redact') {
        c.fillStyle = 'rgba(40,40,48,.55)';
        c.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        c.setLineDash([6, 4]);
        c.lineWidth = 1.5;
        c.strokeStyle = '#fff';
        c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      }
      c.restore();
    }

    /* ----- modes and lifecycle ----- */

    function updateModeButtons() {
      root.querySelectorAll('.bar [data-act=annotate], .bar [data-act=draw]').forEach((b) =>
        b.classList.toggle('on', b.dataset.act === mode));
    }

    function toggleMode(next) {
      const prev = mode;
      if (prev === 'annotate') setAnnotate(false);
      if (prev === 'draw') draw?.finish(true);
      closeEditor();
      mode = prev === next ? null : next;
      if (mode === 'annotate') setAnnotate(true);
      if (mode === 'draw') draw = startDraw();
      updateModeButtons();
      if (mode) toast(mode === 'annotate' ? 'Annotate: click an element or drag a region. Esc exits.' : 'Draw: Esc saves and exits.');
    }

    function onKey(e) {
      if (!mode && !editor) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (editor) closeEditor();
        else toggleMode(mode);
      } else if (mode === 'draw' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        draw.undoRedo(!e.shiftKey);
      }
    }

    const observer = new MutationObserver((records) => {
      if (records.every((r) => r.target === host || host.contains(r.target))) return;
      clearTimeout(observer.t);
      observer.t = setTimeout(() => {
        for (const n of notes) if (!resolved.get(n.id)?.isConnected) resolved.delete(n.id);
        schedule();
      }, 200);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    function checkUrl() {
      if (!host.isConnected) document.documentElement.appendChild(host);
      if (location.href !== url) {
        const keyChanged = pageKey(location.href) !== pageKey(url);
        url = location.href;
        if (keyChanged) {
          if (draw) draw.finish(false);
          closeEditor();
          loadNotes();
        }
      } else if (notes.length) schedule();
    }
    const tick = setInterval(checkUrl, 500);

    addEventListener('scroll', schedule, { capture: true, passive: true });
    addEventListener('resize', schedule, { passive: true });
    addEventListener('popstate', checkUrl);
    addEventListener('keydown', onKey, true);

    function destroy() {
      if (mode === 'annotate') setAnnotate(false);
      draw?.finish(false);
      clearInterval(tick);
      observer.disconnect();
      removeEventListener('scroll', schedule, { capture: true });
      removeEventListener('resize', schedule);
      removeEventListener('keydown', onKey, true);
      removeEventListener('popstate', checkUrl);
      host.remove();
    }

    refresh();
    return { host, toggleMode, refresh, destroy };
  }

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    button { cursor: pointer; border: 1px solid #d0d4dc; background: #fff; color: #1d2330; border-radius: 6px; padding: 4px 9px; }
    button:hover { background: #f1f3f7; }
    button.on, button.primary { background: #3451d1; border-color: #3451d1; color: #fff; }
    .tag-bug { --c: #e5484d; } .tag-ux { --c: #8e4ec6; } .tag-copy { --c: #e2a336; }
    .tag-question { --c: #3e7bfa; } .tag-idea { --c: #30a46c; }
    .pins { position: fixed; inset: 0; pointer-events: none; }
    .pin { position: fixed; top: 0; left: 0; pointer-events: auto; width: 22px; height: 22px; padding: 0; border-radius: 50%;
      background: var(--c); border: 2px solid #fff; color: #fff; font-weight: 700; font-size: 11px;
      box-shadow: 0 1px 4px rgba(0,0,0,.35); }
    .pin.resolved { opacity: .55; }
    .hover, .region, .flash { position: fixed; display: none; pointer-events: none; }
    .hover { outline: 2px solid #3e7bfa; background: rgba(62,123,250,.12); }
    .hover::after { content: attr(data-label); position: absolute; top: -20px; left: 0; background: #3e7bfa; color: #fff;
      font-size: 11px; padding: 1px 5px; border-radius: 3px; }
    .region { border: 2px dashed #3451d1; background: rgba(52,81,209,.10); }
    .flash { display: block; opacity: 0; border: 3px solid #e2a336; border-radius: 4px; }
    .flash.on { animation: flash 1.4s ease-out; }
    @keyframes flash { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
    .panel { position: fixed; right: 12px; bottom: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .bar, .list, .editor, .tools, .toast { background: #fff; color: #1d2330; border: 1px solid #d0d4dc; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(15,20,40,.18); }
    .bar { display: flex; align-items: center; gap: 6px; padding: 6px; }
    .brand { width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; color: #fff; font-weight: 700;
      background: linear-gradient(135deg, #3451d1, #6b46c1); }
    .name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5b6475; padding: 0 4px; }
    .list { width: 320px; max-height: 50vh; overflow: auto; padding: 4px; }
    .item { display: flex; gap: 6px; align-items: baseline; padding: 6px; border-radius: 6px; cursor: pointer; }
    .item:hover { background: #f1f3f7; }
    .num { flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--c); color: #fff; font-size: 11px;
      font-weight: 700; display: grid; place-items: center; }
    .tag { color: #5b6475; font-size: 11px; text-transform: uppercase; }
    .orphan, .done { font-size: 11px; padding: 0 5px; border-radius: 4px; background: #fdecec; color: #b42318; }
    .done { background: #e8f5ee; color: #1f7a4d; }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 8px; color: #5b6475; }
    .editor { position: fixed; width: 290px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .head { font-weight: 600; } .head span { color: #5b6475; font-weight: 400; }
    textarea { width: 100%; min-height: 80px; resize: vertical; border: 1px solid #d0d4dc; border-radius: 6px; padding: 6px; }
    select { border: 1px solid #d0d4dc; border-radius: 6px; padding: 3px 6px; background: #fff; color: #1d2330; }
    .row { display: flex; gap: 8px; align-items: center; } .row.end { justify-content: flex-end; }
    .del { margin-right: auto; color: #b42318; }
    .draw canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; cursor: crosshair; }
    .tools { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); display: flex; gap: 4px; padding: 6px; align-items: center; }
    .tools input[type=color] { width: 30px; height: 26px; border: none; padding: 0; background: none; }
    .tools input[type=range] { width: 80px; }
    .toast { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); padding: 7px 12px; }
    @media (prefers-color-scheme: dark) {
      button, select, textarea, .bar, .list, .editor, .tools, .toast { background: #1d2230; color: #e6e9ef; border-color: #3a4152; }
      button:hover, .item:hover { background: #2a3142; }
      .name, .tag, .empty, .head span { color: #9aa3b5; }
    }`;
})();
