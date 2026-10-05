/* Report renderer shared by history.html and the exported file. The export embeds
 * this exact source, so it must stay self-contained: no imports, no network,
 * and no DOM access at load time.
 */
(function (global) {
  const TAGS = ['bug', 'ux', 'copy', 'question', 'idea'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const pageKey = (u) => { try { const x = new URL(u); return x.host + x.pathname + x.search; } catch { return u; } };
  const count = (items, key) => items.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});

  function strokeSvg(s) {
    const pts = s.rel || [];
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (!a) return '';
    const c = esc(s.color);
    const w = s.width;
    if (s.tool === 'pen' || s.tool === 'highlighter') {
      const hl = s.tool === 'highlighter';
      return `<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${c}" stroke-width="${hl ? w * 4 : w}" stroke-linecap="round" stroke-linejoin="round"${hl ? ' opacity=".35"' : ''}/>`;
    }
    if (s.tool === 'arrow') {
      const head = Math.max(10, w * 4);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const p = (d, t) => `${b.x - d * Math.cos(ang + t)},${b.y - d * Math.sin(ang + t)}`;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x - Math.cos(ang) * head * 0.6}" y2="${b.y - Math.sin(ang) * head * 0.6}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>` +
        `<polygon points="${b.x},${b.y} ${p(head, -0.45)} ${p(head, 0.45)}" fill="${c}"/>`;
    }
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    if (s.tool === 'rect') return `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
    if (s.tool === 'ellipse') return `<ellipse cx="${x + rw / 2}" cy="${y + rh / 2}" rx="${rw / 2}" ry="${rh / 2}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
    if (s.tool === 'text') {
      return `<text x="${a.x}" y="${a.y}" dominant-baseline="hanging" font-size="${14 + w * 2}" font-weight="600" fill="${c}" stroke="rgba(255,255,255,.85)" stroke-width="3" paint-order="stroke">${esc(s.text)}</text>`;
    }
    return ''; // redactions are burned into the image pixels
  }

  function snapshotHtml(snap, notes, drawings) {
    const { vw, vh } = snap;
    const r = Math.max(10, vw / 64);
    const marks = notes.filter((n) => n.rect).map((n) => {
      const { x, y, w, h } = n.rect;
      const bx = Math.max(r, Math.min(vw - r, x)), by = Math.max(r, Math.min(vh - r, y));
      return `<g class="mg-mark tag-${esc(n.tag)}" data-note="${esc(n.id)}" data-tag="${esc(n.tag)}">` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" class="mg-box${n.kind === 'region' ? ' mg-region' : ''}"/>` +
        `<circle cx="${bx}" cy="${by}" r="${r}" class="mg-badge"/>` +
        `<text x="${bx}" y="${by}" font-size="${r * 1.1}" class="mg-badge-num">${n.number}</text></g>`;
    }).join('');
    const strokes = drawings.flatMap((d) => d.strokes).map(strokeSvg).join('');
    const cards = notes.map((n) => `
      <li class="mg-card tag-${esc(n.tag)}" data-note="${esc(n.id)}" data-tag="${esc(n.tag)}" tabindex="0">
        <div class="mg-card-head"><span class="mg-num">${n.number}</span><span class="mg-tag">${esc(n.tag)}</span>
          <span class="mg-status mg-${esc(n.status)}">${esc(n.status)}</span><span class="mg-kind">${esc(n.kind)}</span></div>
        <p>${esc(n.text) || '<em>No text</em>'}</p>
      </li>`).join('');
    const image = snap.image
      ? `<img src="${snap.image}" alt="Screenshot of ${esc(snap.title)}">`
      : '<div class="mg-missing">Screenshot not captured</div>';
    return `
      <section class="mg-snap" id="snap-${esc(snap.id)}">
        <header class="mg-snap-head">
          <h2>${esc(snap.title || snap.url)}</h2>
          <div class="mg-meta"><code>${esc(snap.url)}</code><span>${fmt(snap.updatedAt)}</span>
            ${snap.nonLocal ? '<span class="mg-flag">non-local host</span>' : ''}</div>
        </header>
        <div class="mg-body">
          <div class="mg-figure"><div class="mg-stage" style="aspect-ratio:${vw}/${vh}">
            ${image}
            <svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="none" class="mg-overlay">
              <g class="mg-drawings">${strokes}</g>${marks}
            </svg>
          </div></div>
          <ol class="mg-cards">${cards || '<li class="mg-empty">Drawings only</li>'}</ol>
        </div>
      </section>`;
  }

  function mount(container, data) {
    const { session, snapshots, notes, drawings } = data;
    const bySnap = (list, id) => list.filter((x) => x.snapshotId === id);
    const tagCounts = count(notes, (n) => n.tag);
    const snapHost = Object.fromEntries(snapshots.map((s) => [s.id, s.host]));
    const siteCounts = count(notes, (n) => snapHost[n.snapshotId] || 'unknown');
    const nonLocal = snapshots.some((s) => s.nonLocal);
    const sites = {};
    for (const s of snapshots) {
      const page = ((sites[s.host] ||= {})[pageKey(s.url)] ||= { title: s.title, snaps: [] });
      page.snaps.push(s);
    }
    const toc = Object.entries(sites).map(([host, pages]) => `
      <li><strong>${esc(host)}</strong><ul>${Object.values(pages).map((p) => `
        <li>${esc(p.title || 'Untitled')}: ${p.snaps.map((s, i) => `<a href="#snap-${esc(s.id)}">view ${i + 1} (${bySnap(notes, s.id).length} notes)</a>`).join(', ')}</li>`).join('')}
      </ul></li>`).join('');
    const end = session.endedAt || snapshots.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), session.createdAt);

    container.innerHTML = `
      <div class="mg-report">
        <header class="mg-hero">
          <div class="mg-brand">Marginalia report</div>
          <h1>${esc(session.name)}</h1>
          <p class="mg-range">${fmt(session.createdAt)} to ${fmt(end)} · ${notes.length} notes · ${snapshots.length} snapshots</p>
          ${nonLocal ? '<div class="mg-banner">This report contains screenshots from non-local hosts; they may include real member data. Do not attach it to tickets.</div>' : ''}
          <div class="mg-stats">
            <div><h3>By tag</h3>${TAGS.filter((t) => tagCounts[t]).map((t) => `<span class="mg-chip tag-${t}">${t} <b>${tagCounts[t]}</b></span>`).join('') || '<span class="mg-muted">No notes</span>'}</div>
            <div><h3>By site</h3>${Object.entries(siteCounts).map(([h, c]) => `<span class="mg-chip">${esc(h)} <b>${c}</b></span>`).join('') || '<span class="mg-muted">None</span>'}</div>
          </div>
        </header>
        <nav class="mg-controls">
          <span class="mg-filter">${TAGS.map((t) => `<button class="mg-chip tag-${t} on" data-tag="${t}">${t}</button>`).join('')}</span>
          <label><input type="checkbox" data-toggle="borders" checked> Borders</label>
          <label><input type="checkbox" data-toggle="drawings" checked> Drawings</label>
          <button class="mg-print">Print</button>
        </nav>
        <nav class="mg-toc"><h3>Contents</h3><ul>${toc || '<li class="mg-muted">No snapshots</li>'}</ul></nav>
        ${snapshots.map((s) => snapshotHtml(s, bySnap(notes, s.id), bySnap(drawings, s.id))).join('')}
        <footer class="mg-foot">Generated ${fmt(data.generatedAt)}</footer>
      </div>`;

    const root = container.querySelector('.mg-report');
    const hidden = new Set();
    root.querySelector('.mg-filter').addEventListener('click', (e) => {
      const tag = e.target.closest('[data-tag]')?.dataset.tag;
      if (!tag) return;
      hidden.has(tag) ? hidden.delete(tag) : hidden.add(tag);
      e.target.classList.toggle('on', !hidden.has(tag));
      root.querySelectorAll('.mg-snap [data-tag]').forEach((el) => el.classList.toggle('mg-hidden', hidden.has(el.dataset.tag)));
    });
    root.querySelectorAll('[data-toggle]').forEach((box) => box.addEventListener('change', () =>
      root.classList.toggle(`mg-no-${box.dataset.toggle}`, !box.checked)));
    root.querySelector('.mg-print').addEventListener('click', () => print());

    root.addEventListener('click', (e) => {
      const card = e.target.closest('.mg-card');
      if (card) return focusNote(card);
      const stage = e.target.closest('.mg-stage');
      if (stage) reset(stage.closest('.mg-snap'));
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('mg-card')) focusNote(e.target);
    });

    function reset(section) {
      const stage = section.querySelector('.mg-stage');
      stage.style.transform = '';
      section.querySelectorAll('.mg-selected').forEach((el) => el.classList.remove('mg-selected'));
      section.classList.remove('mg-focus');
    }

    function focusNote(card) {
      const section = card.closest('.mg-snap');
      const wasSelected = card.classList.contains('mg-selected');
      reset(section);
      if (wasSelected) return;
      const note = notes.find((n) => n.id === card.dataset.note);
      const snap = snapshots.find((s) => s.id === note?.snapshotId);
      if (!note?.rect || !snap) return;
      card.classList.add('mg-selected');
      section.querySelector(`.mg-mark[data-note="${CSS.escape(note.id)}"]`)?.classList.add('mg-selected');
      section.classList.add('mg-focus');
      const { x, y, w, h } = note.rect;
      const k = Math.min(2, Math.max(1, Math.min(snap.vw / (w * 3 || 1), snap.vh / (h * 3 || 1))));
      const stage = section.querySelector('.mg-stage');
      stage.style.transformOrigin = `${((x + w / 2) / snap.vw) * 100}% ${((y + h / 2) / snap.vh) * 100}%`;
      stage.style.transform = `scale(${k})`;
      section.querySelector('.mg-figure').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Returns Blob parts, one per snapshot, so no single string has to hold every image.
  function standaloneParts(data, css, js) {
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const { snapshots, ...rest } = data;
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>Marginalia - ${esc(data.session.name)}</title><style>`, css, '</style></head><body><div id="app"></div>',
      `<script>window.MARGINALIA_DATA=${json({ ...rest, snapshots: [] })};<\/script>`,
      ...snapshots.map((s) => `<script>MARGINALIA_DATA.snapshots.push(${json(s)});<\/script>`),
      '<script>', js, '<\/script>',
      '<script>MarginaliaReport.mount(document.getElementById("app"), window.MARGINALIA_DATA);<\/script>',
      '</body></html>',
    ];
  }

  global.MarginaliaReport = { mount, standaloneParts };
})(globalThis);
