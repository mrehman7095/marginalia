/* Marginalia measure mode: rulers and guides, box inspector, near-miss finder, font-size map.
 * Loaded before content.js. At load it only defines a factory; content.js calls it when the
 * mode starts and puts everything into its shadow root.
 */
(() => {
  const RULER = 20;
  const SPAN_AT = RULER + 60; // below the toolbar
  const SNAP = 4;
  const SCAN_CAP = 1500, WALK_CAP = 30000, FIND_CAP = 50, CHIP_CAP = 250;
  // DOM changes rescan 300 ms later, and at most once a second, so a ticking page cannot loop.
  const SETTLE = 300, MIN_GAP = 1000;
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open'] };
  // Near-miss: edges that differ by 0.5..3.5 px (shown as 1-3 px), on elements at most NEAR px apart.
  const MIN_D = 0.5, MAX_D = 3.5, NEAR = 40;
  // Font flags: a combination used by at most RARE_N elements, while one with the same weight and
  // family within RARE_PX is used by at least COMMON_N and RATIO times as often, on a page with at
  // least MIN_TEXT text elements.
  const RARE_N = 2, COMMON_N = 5, RATIO = 4, RARE_PX = 1, MIN_TEXT = 10;
  const DEFAULT = ['rulers', 'inspect'];
  const TOOLS = [['rulers', 'Rulers'], ['inspect', 'Inspect'], ['nearmiss', 'Near-miss'], ['fonts', 'Fonts']];
  const KINDS = ['left', 'right', 'top', 'bottom'];
  const PALETTE = ['#2563eb', '#d9480f', '#0f9d58', '#c2255c', '#7048e8', '#0b7285', '#5c940d', '#e03131',
    '#1864ab', '#a61e4d', '#087f5b', '#862e9c'];
  const REPLACED = new Set(['img', 'video', 'canvas', 'iframe', 'svg', 'input', 'button', 'select', 'textarea',
    'embed', 'object', 'progress', 'meter', 'hr']);
  const NOT_MAIN_FAMILY = /mono|code|consol|courier|menlo|icon|awesome|symbol/i;
  const FLAG_TITLES = {
    fractional: 'The size is not a whole pixel.',
    rare: `Used by ${RARE_N} or fewer elements, while a size within ${RARE_PX}px at the same weight and family is used ${RATIO} times as often.`,
    family: 'The family differs from the one most text on the page uses.',
  };

  const fmt = (n) => String(Math.round(n * 100) / 100);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  // Whole id and class names only, up to about 48 characters.
  const short = (el) => [el.id && '#' + el.id, ...[...el.classList].slice(0, 2).map((c) => '.' + c)].filter(Boolean)
    .reduce((s, p) => (s === el.localName || s.length + p.length <= 48 ? s + p : s), el.localName);
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const empty = (r) => r.right - r.left < 1 || r.bottom - r.top < 1;
  const shown = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const box = (cls, x, y, w, h, extra = '') =>
    `<div class="${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${extra}"></div>`;
  const rbox = (cls, r, extra) => box(cls, r.left, r.top, r.right - r.left, r.bottom - r.top, extra);
  const place = (node, x, y, w, h) =>
    Object.assign(node.style, { left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px' });
  // Open shadow roots included, so shadow DOM content can be measured.
  const deepHits = (x, y, skip, root = document) => root.elementsFromPoint(x, y).flatMap((el) =>
    el.shadowRoot && el !== skip && el.shadowRoot !== root ? [...deepHits(x, y, skip, el.shadowRoot), el] : [el]);

  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = c.match(/\/\s*([\d.]+)(%?)\s*\)$/) || (c.startsWith('rgba(') && c.match(/,\s*([\d.]+)()\s*\)$/));
    return m ? parseFloat(m[1]) / (m[2] ? 100 : 1) : 1;
  };

  function hasBox(el, cs) {
    if (REPLACED.has(el.localName)) return true;
    if (alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some((s) =>
      parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && alpha(cs[`border${s}Color`]) > 0);
  }

  // The edge the eye lines text up on. Inline elements start mid-line, so they have none.
  function textSide(el, cs) {
    if (cs.display === 'inline' || cs.display === 'contents') return null;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.data))) return null;
    const rtl = cs.direction === 'rtl';
    return { left: 'left', right: 'right', start: rtl ? 'right' : 'left', end: rtl ? 'left' : 'right',
      justify: rtl ? 'right' : 'left' }[cs.textAlign.replace('-webkit-', '')] || null;
  }

  /* Visible elements in the viewport: `v` is the rect cut by every clipping ancestor, `inner` the
   * clip its children get, `layer` the nearest fixed or sticky ancestor-or-self or scroll container
   * it moves with. Subtrees that are hidden, or clipped away entirely, are skipped. */
  function visibleElements() {
    const out = [], view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const stack = document.body ? [[document.body, view, document.body]] : [];
    for (let walked = 0; stack.length;) {
      if (out.length >= SCAN_CAP || walked++ >= WALK_CAP) return { out, truncated: true };
      const [el, clip, layer] = stack.pop();
      const r = el.getBoundingClientRect();
      const cs = el.firstElementChild || !empty(meet(r, clip)) ? getComputedStyle(el) : null;
      if (!cs || cs.display === 'none') continue;
      const own = cs.position === 'fixed' ? view : clip, v = meet(r, own);
      const clips = /auto|scroll|hidden|clip|overlay/.test(cs.overflowX + cs.overflowY);
      if (clips && empty(v)) continue;
      const self = /fixed|sticky/.test(cs.position) ? el : layer;
      if (!empty(v) && shown(el)) out.push({ el, cs, r, v, inner: clips ? v : own, layer: self });
      if (el.localName === 'svg') continue;
      const kids = /auto|scroll|overlay/.test(cs.overflowX + cs.overflowY) ? el : self;
      for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push([c, clips ? v : own, kids]);
    }
    return { out, truncated: false };
  }

  const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

  function findNearMisses(items, host) {
    const cands = [];
    const range = document.createRange();
    for (const { el, cs, r, v, inner, layer } of items) {
      // A rotated or skewed box has no straight edges to line up.
      const t = cs.transform;
      if (t.startsWith('matrix3d') || (t.startsWith('matrix(') && t.slice(7).split(',').slice(1, 3).some((n) => parseFloat(n)))) continue;
      let b = r, vis = v, kinds = KINDS;
      if (!hasBox(el, cs)) {
        const side = textSide(el, cs);
        if (!side) continue;
        range.selectNodeContents(el);
        b = range.getBoundingClientRect();
        vis = meet(b, inner);
        if (empty(vis)) continue;
        kinds = [side];
      }
      // A clipped edge is not on screen, so it cannot look misaligned.
      kinds = kinds.filter((k) => (k === 'left' || k === 'top' ? b[k] >= vis[k] - 0.5 : b[k] <= vis[k] + 0.5));
      if (kinds.length) cands.push({ el, layer, vis, kinds, left: b.left, right: b.right, top: b.top, bottom: b.bottom });
    }
    cands.forEach((c, i) => (c.i = i));

    // Per element and edge, keep only the nearest counterpart; the rarer edge value is the offender.
    const best = new Map();
    for (const kind of KINDS) {
      const vert = kind === 'left' || kind === 'right';
      const mid = (c) => (vert ? c.left + c.right : c.top + c.bottom) / 2;
      const list = cands.filter((c) => c.kinds.includes(kind)).sort((a, b) => a[kind] - b[kind]);
      const at = (c) => Math.round(c[kind] * 2) / 2;
      const count = new Map();
      for (const c of list) count.set(at(c), (count.get(at(c)) || 0) + 1);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j], d = b[kind] - a[kind];
          if (d >= MAX_D) break;
          if (d < MIN_D) continue;
          const gap = Math.max(0, vert
            ? Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)
            : Math.max(a.left, b.left) - Math.min(a.right, b.right));
          if (gap > NEAR || a.el.contains(b.el) || b.el.contains(a.el)) continue;
          // Vertical positions in different scroll layers line up only by accident of scrolling.
          if (!vert && a.layer !== b.layer) continue;
          // Centred boxes of different sizes.
          const opp = OPPOSITE[kind];
          if (a.kinds.includes(opp) && b.kinds.includes(opp) && Math.abs(mid(a) - mid(b)) < 0.5) continue;
          const ca = count.get(at(a)), cb = count.get(at(b));
          const [o, ref] = ca < cb || (ca === cb && a.i > b.i) ? [a, b] : [b, a];
          const key = `${o.i}|${kind}`, prev = best.get(key);
          if (!prev || gap < prev.gap || (gap === prev.gap && d < prev.d)) best.set(key, { o, ref, kind, d, gap });
        }
      }
    }
    const pairs = new Map();
    for (const m of best.values()) {
      const key = `${m.o.i}|${m.ref.i}`;
      let f = pairs.get(key);
      if (!f) pairs.set(key, (f = { o: m.o, ref: m.ref, edges: [], gap: m.gap, d: m.d }));
      f.edges.push({ kind: m.kind, d: m.d, ov: m.o[m.kind], rv: m.ref[m.kind] });
      f.gap = Math.min(f.gap, m.gap);
      f.d = Math.min(f.d, m.d);
    }
    const all = [...pairs.values()];
    // A shifted card shifts its content too: drop pairs with exactly one side inside a reported
    // offender and the same shift. Pairs fully inside it are measured against each other and stay.
    const echo = (f) => all.some((p) => p !== f && p.o.el !== f.o.el &&
      p.o.el.contains(f.o.el) !== p.o.el.contains(f.ref.el) &&
      f.edges.every((e) => p.edges.some((x) => x.kind === e.kind && Math.abs(x.d - e.d) < 0.1)));
    // An edge under another element (a fixed toolbar, a popup) is not what the user sees.
    const covered = (c, kind) => {
      const { vis } = c, x = kind === 'left' ? c.left + 1 : kind === 'right' ? c.right - 1 : (vis.left + vis.right) / 2;
      const y = kind === 'top' ? c.top + 1 : kind === 'bottom' ? c.bottom - 1 : (vis.top + vis.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && hit !== host && !c.el.contains(hit) && !hit.contains(c.el);
    };
    return all.filter((f) => !echo(f) && !f.edges.some((e) => covered(f.o, e.kind) || covered(f.ref, e.kind)))
      .sort((a, b) => a.gap - b.gap || a.d - b.d).slice(0, FIND_CAP);
  }

  function describeMiss(f) {
    const byD = new Map();
    for (const e of f.edges) byD.set(fmt(e.d), [...(byD.get(fmt(e.d)) || []), e.kind]);
    const parts = [...byD].map(([d, kinds]) => `${kinds.join(' and ')} edge${kinds.length > 1 ? 's' : ''} ${d} px`);
    return `${cap(parts.join(', '))} off — ${short(f.o.el)} vs ${short(f.ref.el)}`;
  }

  const missNote = (f, selectorFor) => f.edges.map((e, i) =>
    `${i ? e.kind : cap(e.kind)} edge ${fmt(e.d)} px off${i ? '' : ` from ${selectorFor(f.ref.el)}`} (${fmt(e.ov)} vs ${fmt(e.rv)})`).join('; ');

  function mapFonts(visible) {
    const items = [], byKey = new Map();
    const range = document.createRange();
    for (const { el, cs, inner } of visible) {
      const n = [...el.childNodes].find((t) => t.nodeType === 3 && /\S/.test(t.data));
      if (!n) continue;
      range.selectNodeContents(n);
      const line = [...range.getClientRects()].find((q) => !empty(meet(q, inner)));
      if (!line) continue;
      const size = parseFloat(cs.fontSize), weight = cs.fontWeight;
      const lh = cs.lineHeight === 'normal' ? 'normal' : `${fmt(parseFloat(cs.lineHeight))}px`;
      const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
      const key = [size, weight, lh, fam].join('|');
      let g = byKey.get(key);
      if (!g) byKey.set(key, (g = { key, size, weight, lh, fam, items: [] }));
      const it = { el, r: meet(range.getBoundingClientRect(), inner), line, g };
      g.items.push(it);
      items.push(it);
    }
    const groups = [...byKey.values()];
    const top = (f) => {
      const m = new Map();
      for (const g of groups) m.set(f(g), (m.get(f(g)) || 0) + g.items.length);
      return [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const mainSize = top((g) => g.size), mainFam = top((g) => g.fam);
    // Line height aside: rarity is about the size, weight and family.
    const uses = new Map();
    const face = (g) => [g.size, g.weight, g.fam].join('|');
    for (const g of groups) uses.set(face(g), (uses.get(face(g)) || 0) + g.items.length);
    const sizes = [...new Set(groups.map((g) => g.size))].sort((a, b) => b - a);
    groups.sort((a, b) => b.size - a.size || b.weight - a.weight || b.items.length - a.items.length);
    groups.forEach((g, i) => {
      const n = g.items.length, used = uses.get(face(g));
      g.i = i;
      g.color = PALETTE[sizes.indexOf(g.size) % PALETTE.length];
      g.label = `${fmt(g.size)} · ${g.weight}`;
      g.desc = `${fmt(g.size)}px / ${g.weight} / lh ${g.lh} · ${g.fam}`;
      g.flags = [];
      if (Math.abs(g.size - Math.round(g.size)) > 0.01) g.flags.push(['fractional', 'the size is fractional']);
      const common = items.length >= MIN_TEXT && used <= RARE_N && groups
        .filter((h) => h.size !== g.size && h.weight === g.weight && h.fam === g.fam && Math.abs(h.size - g.size) <= RARE_PX &&
          uses.get(face(h)) >= Math.max(COMMON_N, RATIO * used))
        .sort((a, b) => uses.get(face(b)) - uses.get(face(a)))[0];
      if (common) g.flags.push(['rare', `the page mostly uses ${fmt(common.size)}px`]);
      if (g.fam !== mainFam && !NOT_MAIN_FAMILY.test(g.fam)) g.flags.push(['family', `the page mostly uses ${mainFam}`]);
      const fam = g.flags.some((f) => f[0] === 'family') ? ` / ${g.fam}` : '';
      g.note = `Font ${fmt(g.size)}px / ${g.weight} / lh ${g.lh}${fam} used by ${n} element${n === 1 ? '' : 's'}; ` +
        g.flags.map((f) => f[1]).join('; ');
    });
    return { items, groups, mainSize, mainFam };
  }

  function drawRuler(canvas, horiz) {
    const len = horiz ? innerWidth : innerHeight, dpr = devicePixelRatio;
    const [w, h] = horiz ? [len, RULER] : [RULER, len];
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    Object.assign(canvas.style, { width: w + 'px', height: h + 'px' });
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = dark ? '#1d2230' : '#f6f7f9';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = g.fillStyle = dark ? '#9aa3b5' : '#5b6475';
    g.lineWidth = 1;
    g.font = '9px system-ui, sans-serif';
    g.beginPath();
    for (let p = 0; p <= len; p += 10) {
      const t = p % 100 === 0 ? RULER : p % 50 === 0 ? 9 : 5;
      if (horiz) g.moveTo(p + 0.5, RULER), g.lineTo(p + 0.5, RULER - t);
      else g.moveTo(RULER, p + 0.5), g.lineTo(RULER - t, p + 0.5);
    }
    if (horiz) g.moveTo(0, RULER - 0.5), g.lineTo(len, RULER - 0.5);
    else g.moveTo(RULER - 0.5, 0), g.lineTo(RULER - 0.5, len);
    g.stroke();
    for (let p = 100; p <= len; p += 100) {
      if (horiz) g.fillText(String(p), p + 3, 9);
      else {
        g.save();
        g.translate(3, p + 3);
        g.rotate(Math.PI / 2);
        g.fillText(String(p), 0, 0);
        g.restore();
      }
    }
  }

  // Figma-style distances from the pinned box a to the hovered box b.
  function gapSegments(a, b) {
    const segs = [];
    const mid = (a1, a2, b1, b2) => (Math.max(a1, b1) < Math.min(a2, b2) ? (Math.max(a1, b1) + Math.min(a2, b2)) / 2 : (b1 + b2) / 2);
    const axis = (lo1, hi1, lo2, hi2, at, dir) => {
      if (lo2 >= hi1) segs.push([dir, hi1, lo2, at]);
      else if (lo1 >= hi2) segs.push([dir, hi2, lo1, at]);
      else {
        if (lo1 !== lo2) segs.push([dir, Math.min(lo1, lo2), Math.max(lo1, lo2), at]);
        if (hi1 !== hi2) segs.push([dir, Math.min(hi1, hi2), Math.max(hi1, hi2), at]);
      }
    };
    axis(a.left, a.right, b.left, b.right, mid(a.top, a.bottom, b.top, b.bottom), 'h');
    axis(a.top, a.bottom, b.top, b.bottom, mid(a.left, a.right, b.left, b.right), 'v');
    return segs.filter((s) => s[2] - s[1] >= 0.5).map(([dir, from, to, at]) => {
      const len = to - from, c = from + len / 2;
      return (dir === 'h' ? box('m-gap h', from, at, len, 1) : box('m-gap v', at, from, 1, len)) +
        `<span class="m-gapl ${dir}" style="left:${dir === 'h' ? c : at + 4}px;top:${dir === 'h' ? at + 4 : c}px">${fmt(len)}</span>`;
    }).join('');
  }

  function measure({ root, host, guides, toast, openNote, dismissEditor, block, blocked, ours, exit, selectorFor }) {
    const layer = document.createElement('div');
    layer.className = 'measure';
    layer.innerHTML = `
      <div class="m-fonts"></div><div class="m-miss"></div>
      <div class="m-insp" hidden>
        <div class="m-edge v"></div><div class="m-edge v"></div><div class="m-edge h"></div><div class="m-edge h"></div>
        <div class="m-box m-margin"></div><div class="m-box m-border"></div><div class="m-box m-pad"></div>
        <div class="m-outline"></div><div class="m-label"></div>
      </div>
      <div class="m-pinned" hidden></div><div class="m-gaps"></div>
      <div class="m-rulers" hidden>
        <canvas class="m-ruler top"></canvas><canvas class="m-ruler left"></canvas><div class="m-corner"></div>
        <div class="m-guides"></div><div class="m-guidegaps"></div>
        <div class="m-cross" hidden><div class="v"></div><div class="h"></div><span class="x"></span><span class="y"></span></div>
      </div>
      <div class="tools m-tools">${TOOLS.map(([t, l]) => `<button data-tool="${t}">${l}</button>`).join('')}
        <button data-act="exit" title="Esc">Exit</button></div>
      <div class="m-side">
        <div class="m-panel" data-panel="nearmiss" hidden>
          <div class="m-head"><i></i><span>Near-misses</span><b></b><button data-act="rescan">Rescan</button></div>
          <div class="m-body"></div></div>
        <div class="m-panel" data-panel="fonts" hidden>
          <div class="m-head"><i></i><span>Fonts</span><b></b><button data-act="rescan">Rescan</button></div>
          <div class="m-body"></div></div>
      </div>
      <div class="flash"></div>`;
    root.appendChild(layer);

    const $ = (s) => layer.querySelector(s);
    const inspEl = $('.m-insp'), [edgeL, edgeR, edgeT, edgeB] = inspEl.querySelectorAll('.m-edge');
    const marginEl = $('.m-margin'), borderEl = $('.m-border'), padEl = $('.m-pad');
    const outlineEl = $('.m-outline'), labelEl = $('.m-label'), pinnedEl = $('.m-pinned'), gapsEl = $('.m-gaps');
    const rulersEl = $('.m-rulers'), guidesEl = $('.m-guides'), guideGapsEl = $('.m-guidegaps');
    const crossEl = $('.m-cross'), [crossV, crossH] = crossEl.querySelectorAll('div'), [crossX, crossY] = crossEl.querySelectorAll('span');
    const topRuler = $('.m-ruler.top'), leftRuler = $('.m-ruler.left');
    const missEl = $('.m-miss'), fontsEl = $('.m-fonts'), flashEl = $('.flash');
    const missPanel = $('[data-panel=nearmiss]'), fontPanel = $('[data-panel=fonts]');
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const on = new Set();
    const CAPTURE = { capture: true }, PASSIVE = { capture: true, passive: true };
    let stopped = false, raf = 0, scanTimer = 0, lastScan = 0, truncated = false;
    let pointer = null, hover = null, pinned = null, drawn = null, dirty = false, drag = null;
    let findings = [], fonts = { items: [], groups: [] }, focus = null;

    const schedule = () => { raf ||= requestAnimationFrame(frame); };

    function frame() {
      raf = 0;
      if (on.has('rulers') && pointer) cross(pointer);
      if (on.has('inspect') && (hover !== drawn || dirty)) inspect();
      dirty = false;
    }

    function onMove(e) {
      pointer = { x: e.clientX, y: e.clientY };
      hover = ours(e) ? null : e.composedPath()[0];
      schedule();
    }

    function onScroll(e) {
      if (ours(e)) return;
      flashEl.classList.remove('on');
      dirty = true;
      schedule();
      if (!on.has('nearmiss') && !on.has('fonts')) return;
      missEl.hidden = fontsEl.hidden = true;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(rescan, 250);
    }

    const later = () => { scanTimer ||= setTimeout(rescan, Math.max(SETTLE, lastScan + MIN_GAP - performance.now())); };
    const observer = new MutationObserver((records) => {
      if (records.every((r) => host.contains(r.target))) return;
      // Added or removed elements move things; text and attribute changes (a clock, a spinner) rarely do.
      if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1))) missEl.hidden = fontsEl.hidden = true;
      later();
    });

    function onResize(e) {
      if (on.has('rulers')) drawRulers();
      onScroll(e);
    }

    /* ----- rulers and guides ----- */

    function drawRulers() {
      drawRuler(topRuler, true);
      drawRuler(leftRuler, false);
    }

    function cross({ x, y }) {
      crossEl.hidden = false;
      crossV.style.left = x + 'px';
      crossH.style.top = y + 'px';
      crossX.textContent = fmt(x);
      crossX.style.left = x + 'px';
      crossY.textContent = fmt(y);
      crossY.style.top = y + 'px';
    }

    function renderGuides() {
      while (guidesEl.children.length > guides.length) guidesEl.lastChild.remove();
      while (guidesEl.children.length < guides.length) guidesEl.insertAdjacentHTML('beforeend', '<div class="m-guide"><span></span></div>');
      guides.forEach((g, i) => {
        const node = guidesEl.children[i];
        node.className = `m-guide ${g.axis}${g.snapped ? ' snap' : ''}`;
        node.dataset.i = i;
        node.hidden = g.pos <= RULER;
        node.style.left = g.axis === 'v' ? g.pos + 'px' : '';
        node.style.top = g.axis === 'h' ? g.pos + 'px' : '';
        node.firstChild.textContent = fmt(g.pos);
      });
      let html = '';
      for (const axis of ['v', 'h']) {
        const ps = guides.filter((g) => g.axis === axis && g.pos > RULER).map((g) => g.pos).sort((a, b) => a - b);
        for (let i = 1; i < ps.length; i++) {
          const len = ps[i] - ps[i - 1];
          if (len < 0.5) continue;
          html += axis === 'v'
            ? box('m-span v', ps[i - 1], SPAN_AT, len, 0) + `<span class="m-gapl g h" style="left:${ps[i - 1] + len / 2}px;top:${SPAN_AT + 3}px">${fmt(len)}</span>`
            : box('m-span h', SPAN_AT, ps[i - 1], 0, len) + `<span class="m-gapl g v" style="left:${SPAN_AT + 3}px;top:${ps[i - 1] + len / 2}px">${fmt(len)}</span>`;
        }
      }
      guideGapsEl.innerHTML = html;
    }

    function moveGuide(e) {
      const g = guides[drag.i], v = g.axis === 'v';
      let pos = v ? e.clientX : e.clientY, best = SNAP;
      g.snapped = false;
      if (!e.altKey && pos > RULER) {
        // Probing either side too catches an edge the pointer is just outside of.
        const els = new Set([0, -SNAP, SNAP].flatMap((o) =>
          deepHits(e.clientX + (v ? o : 0), e.clientY + (v ? 0 : o), host).slice(0, 12)));
        for (const el of els) {
          if (el === host || el === document.documentElement || el === document.body) continue;
          const r = el.getBoundingClientRect();
          for (const edge of v ? [r.left, r.right] : [r.top, r.bottom]) {
            const d = Math.abs(edge - (v ? e.clientX : e.clientY));
            if (d <= best) [best, pos, g.snapped] = [d, edge, true];
          }
        }
      }
      g.pos = pos;
      renderGuides();
    }

    function endDrag() {
      if (!drag) return;
      const g = guides[drag.i];
      drag = null;
      g.snapped = false;
      if (g.pos <= RULER) guides.splice(guides.indexOf(g), 1);
      renderGuides();
    }

    layer.addEventListener('pointerdown', (e) => {
      const guide = e.target.closest('.m-guide'), ruler = e.target.closest('.m-ruler');
      if ((!guide && !ruler) || e.button !== 0) return;
      e.preventDefault();
      if (ruler) guides.push({ axis: ruler.classList.contains('top') ? 'h' : 'v', pos: 0 });
      drag = { i: guide ? +guide.dataset.i : guides.length - 1 };
      e.target.setPointerCapture(e.pointerId);
      moveGuide(e);
    });
    layer.addEventListener('pointermove', (e) => drag && moveGuide(e));
    layer.addEventListener('pointerup', endDrag);
    layer.addEventListener('pointercancel', endDrag);
    layer.addEventListener('dblclick', (e) => {
      const guide = e.target.closest('.m-guide');
      if (!guide) return;
      guides.splice(+guide.dataset.i, 1);
      renderGuides();
    });

    /* ----- box inspector ----- */

    function frameBox(node, x, y, w, h, widths) {
      place(node, x, y, w, h);
      node.style.borderWidth = widths.map((v) => v + 'px').join(' ');
    }

    function inspect() {
      drawn = hover;
      if (pinned && !pinned.isConnected) pinned = null;
      const el = hover?.isConnected ? hover : null;
      inspEl.hidden = !el;
      pinnedEl.hidden = !pinned;
      const a = pinned?.getBoundingClientRect();
      if (a) place(pinnedEl, a.left, a.top, a.width, a.height);
      gapsEl.innerHTML = el && a && el !== pinned ? gapSegments(a, el.getBoundingClientRect()) : '';
      if (!el) return;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      // Computed sides ignore CSS zoom and transforms; the rect does not.
      const html = el instanceof HTMLElement;
      const kx = html && el.offsetWidth ? r.width / el.offsetWidth : 1, ky = html && el.offsetHeight ? r.height / el.offsetHeight : 1;
      const sides = (p) => ['Top', 'Right', 'Bottom', 'Left'].map((s, i) =>
        Math.max(0, parseFloat(cs[p.replace('*', s)]) || 0) * (i % 2 ? kx : ky));
      const m = sides('margin*'), b = sides('border*Width'), p = sides('padding*');
      frameBox(marginEl, r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2], m);
      frameBox(borderEl, r.left, r.top, r.width, r.height, b);
      frameBox(padEl, r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2], p);
      place(outlineEl, r.left, r.top, r.width, r.height);
      edgeL.style.left = r.left + 'px';
      edgeR.style.left = r.right - 1 + 'px';
      edgeT.style.top = r.top + 'px';
      edgeB.style.top = r.bottom - 1 + 'px';
      labelEl.textContent = `${short(el)}  ${fmt(r.width)} × ${fmt(r.height)}`;
      const above = r.top - m[0] - 22;
      labelEl.style.top = (above > RULER + 2 ? above : Math.min(r.bottom + m[2] + 4, innerHeight - 22)) + 'px';
      labelEl.style.left = Math.max(RULER + 2, Math.min(r.left - m[3], innerWidth - labelEl.offsetWidth - 4)) + 'px';
    }

    function onDown(e) {
      if (ours(e)) return;
      block(e);
      if (dismissEditor() || e.button !== 0) return;
      const target = e.composedPath()[0];
      pinned = pinned === target ? null : target;
      dirty = true;
      schedule();
    }

    function setInspect(enable) {
      const fn = (enable ? addEventListener : removeEventListener).bind(window);
      fn('pointerdown', onDown, CAPTURE);
      blocked.forEach((t) => fn(t, block, CAPTURE));
    }

    /* ----- near-miss finder and font map ----- */

    function rescan() {
      clearTimeout(scanTimer);
      scanTimer = 0;
      if (!on.has('nearmiss') && !on.has('fonts')) return;
      lastScan = performance.now();
      const scan = visibleElements();
      truncated = scan.truncated;
      if (on.has('nearmiss')) renderMiss((findings = findNearMisses(scan.out, host)));
      if (on.has('fonts')) {
        fonts = mapFonts(scan.out);
        if (focus && !fonts.groups.some((g) => g.key === focus)) focus = null;
        renderFonts();
      }
      missEl.hidden = fontsEl.hidden = false;
    }

    function renderMiss() {
      let html = '';
      const outlined = new Set();
      for (const f of findings) {
        for (const c of [f.o, f.ref]) {
          if (outlined.has(c)) continue;
          outlined.add(c);
          html += rbox('m-mo', c.vis);
        }
        const [a, b] = [f.o.vis, f.ref.vis];
        for (const { kind, ov, rv } of f.edges) {
          const shift = kind === 'right' || kind === 'bottom' ? 1 : 0;
          if (kind === 'left' || kind === 'right') {
            const y1 = Math.min(a.top, b.top) - 6, y2 = Math.max(a.bottom, b.bottom) + 6;
            for (const x of [ov, rv]) html += box('m-ml', x - shift, y1, 1, y2 - y1);
          } else {
            const x1 = Math.min(a.left, b.left) - 6, x2 = Math.max(a.right, b.right) + 6;
            for (const y of [ov, rv]) html += box('m-ml', x1, y - shift, x2 - x1, 1);
          }
        }
      }
      missEl.innerHTML = html;
      missPanel.querySelector('b').textContent = findings.length + (findings.length === FIND_CAP ? '+' : '');
      missPanel.querySelector('.m-body').innerHTML = truncation() + (findings.map((f, i) => {
        const text = describeMiss(f);
        return `<div class="m-row" data-i="${i}"><span class="m-txt" title="${esc(text)}">${esc(text)}</span><button data-note="${i}">Note</button></div>`;
      }).join('') || '<div class="m-empty">No near-misses in view.</div>');
    }

    const truncation = () => (truncated ? '<div class="m-empty">Scan truncated: the page has too many elements to check them all.</div>' : '');

    // A chip goes at the end of the first line, or just above it, never over text or another chip.
    function renderFonts() {
      const placed = [], taken = fonts.items.map((it) => it.r), h = 14;
      const free = (q) => q.left >= 0 && q.top >= 0 && q.right <= innerWidth && q.bottom <= innerHeight &&
        !taken.some((p) => q.left < p.right && q.right > p.left && q.top < p.bottom && q.bottom > p.top);
      let html = '';
      for (const { line, g } of fonts.items) {
        if (placed.length >= CHIP_CAP) break;
        const w = g.label.length * 6 + 8, x = line.right + 4, y = line.top + (line.height - h) / 2;
        const spot = [{ left: x, top: y, right: x + w, bottom: y + h },
          { left: line.left, top: line.top - h - 1, right: line.left + w, bottom: line.top - 1 }].find(free);
        if (!spot) continue;
        placed.push(spot);
        taken.push(spot);
        const dim = focus && g.key !== focus ? ' dim' : '';
        html += `<span class="m-chip${dim}" style="left:${spot.left}px;top:${spot.top}px;background:${g.color}">${g.label}</span>`;
      }
      const sel = fonts.groups.find((g) => g.key === focus);
      for (const it of sel ? sel.items : []) html += rbox('m-fo', it.r, `--c:${sel.color}`);
      fontsEl.innerHTML = html;
      fontPanel.querySelector('b').textContent = fonts.groups.length;
      fontPanel.querySelector('.m-body').innerHTML = truncation() + (fonts.groups.map((g) =>
        `<div class="m-row${g.key === focus ? ' on' : ''}" data-k="${g.i}" title="${esc(g.desc)}">` +
        `<span class="m-sw" style="background:${g.color}"></span><span class="m-txt">${esc(g.desc)}</span>` +
        g.flags.map(([f]) => `<span class="m-flag" title="${esc(FLAG_TITLES[f])}">${f}</span>`).join('') +
        `<span class="m-n">${g.items.length}</span>${g.flags.length ? `<button data-note="${g.i}">Note</button>` : ''}</div>`,
      ).join('') || '<div class="m-empty">No text in view.</div>');
    }

    function flashPair(f) {
      if (!f.o.el.isConnected || !f.ref.el.isConnected) return toast('That element is gone. Rescan and try again.');
      f.o.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      requestAnimationFrame(() => {
        const a = f.o.el.getBoundingClientRect(), b = f.ref.el.getBoundingClientRect();
        const x = Math.min(a.left, b.left), y = Math.min(a.top, b.top);
        place(flashEl, x - 4, y - 4, Math.max(a.right, b.right) - x + 8, Math.max(a.bottom, b.bottom) - y + 8);
        flashEl.classList.remove('on');
        void flashEl.offsetWidth;
        flashEl.classList.add('on');
      });
    }

    function note(panel, i) {
      const [el, text, tag] = panel === 'nearmiss'
        ? [findings[i].o.el, missNote(findings[i], selectorFor), 'bug']
        : [fonts.groups[i].items[0].el, fonts.groups[i].note, 'ux'];
      if (!el.isConnected) return toast('That element is gone. Rescan and try again.');
      openNote({ element: el, text, tag });
    }

    $('.m-side').addEventListener('click', (e) => {
      const panel = e.target.closest('.m-panel'), b = e.target.closest('button'), row = e.target.closest('.m-row');
      if (!panel) return;
      if (b?.dataset.act === 'rescan') return rescan();
      if (b?.dataset.note) return note(panel.dataset.panel, +b.dataset.note);
      if (row && panel === missPanel) return flashPair(findings[+row.dataset.i]);
      if (row && panel === fontPanel) {
        const key = fonts.groups[+row.dataset.k].key;
        focus = focus === key ? null : key;
        return renderFonts();
      }
      if (e.target.closest('.m-head')) panel.classList.toggle('closed');
    });

    /* ----- tools and lifecycle ----- */

    function toggle(t, enable) {
      if (t === 'rulers') {
        rulersEl.hidden = !enable;
        crossEl.hidden = true;
        if (enable) drawRulers(), renderGuides();
      }
      if (t === 'inspect') {
        setInspect(enable);
        if (!enable) pinned = hover = null;
        inspEl.hidden = pinnedEl.hidden = true;
        gapsEl.innerHTML = '';
        drawn = undefined;
      }
      if (t === 'nearmiss') {
        missPanel.hidden = !enable;
        if (!enable) missEl.innerHTML = '';
      }
      if (t === 'fonts') {
        fontPanel.hidden = !enable;
        if (!enable) fontsEl.innerHTML = '';
      }
      if (t !== 'nearmiss' && t !== 'fonts') return;
      if (on.has('nearmiss') || on.has('fonts')) observer.observe(document.body || document.documentElement, OBSERVE);
      else observer.disconnect();
      if (enable) rescan();
    }

    function setTools(list, save) {
      for (const [t] of TOOLS) {
        if (list.includes(t) === on.has(t)) continue;
        list.includes(t) ? on.add(t) : on.delete(t);
        toggle(t, on.has(t));
      }
      layer.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', on.has(b.dataset.tool)));
      if (save) chrome.storage.local.set({ measureTools: [...on] }).catch(() => {});
    }

    $('.m-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b?.dataset.tool) setTools(on.has(b.dataset.tool) ? [...on].filter((t) => t !== b.dataset.tool) : [...on, b.dataset.tool], true);
      if (b?.dataset.act === 'exit') exit();
    });

    chrome.storage.local.get('measureTools').then(({ measureTools }) => {
      if (!stopped) setTools(Array.isArray(measureTools) ? measureTools : DEFAULT, false);
    }, () => !stopped && setTools(DEFAULT, false));

    addEventListener('pointermove', onMove, PASSIVE);
    addEventListener('scroll', onScroll, PASSIVE);
    addEventListener('resize', onResize, { passive: true });
    scheme.addEventListener('change', onResize);

    function pageChanged() {
      pinned = hover = null;
      drawn = undefined;
      renderGuides();
      inspEl.hidden = pinnedEl.hidden = true;
      gapsEl.innerHTML = '';
      // The routed view may not have rendered yet.
      missEl.hidden = fontsEl.hidden = true;
      later();
    }

    function stop() {
      stopped = true;
      if (on.has('inspect')) setInspect(false);
      removeEventListener('pointermove', onMove, PASSIVE);
      removeEventListener('scroll', onScroll, PASSIVE);
      removeEventListener('resize', onResize, { passive: true });
      scheme.removeEventListener('change', onResize);
      cancelAnimationFrame(raf);
      clearTimeout(scanTimer);
      observer.disconnect();
      layer.remove();
    }

    return { stop, pageChanged, inspecting: () => on.has('inspect') };
  }

  measure.css = `
    .m-ruler, .m-corner { position: fixed; top: 0; left: 0; pointer-events: auto; }
    .m-ruler.top { cursor: row-resize; } .m-ruler.left { cursor: col-resize; }
    .m-corner { width: ${RULER}px; height: ${RULER}px; background: #f6f7f9; border: solid #5b6475; border-width: 0 1px 1px 0; }
    .m-cross > *, .m-edge, .m-box, .m-outline, .m-label, .m-pinned, .m-gap, .m-gapl, .m-span, .m-mo, .m-ml, .m-chip, .m-fo {
      position: fixed; pointer-events: none; }
    .m-cross .v { top: 0; bottom: 0; border-left: 1px solid rgba(100,116,139,.6); }
    .m-cross .h { left: 0; right: 0; border-top: 1px solid rgba(100,116,139,.6); }
    .m-cross span, .m-label, .m-gapl, .m-guide span { font: 600 10px/16px ui-monospace, Menlo, Consolas, monospace; color: #fff;
      padding: 0 5px; border-radius: 3px; white-space: nowrap; }
    .m-cross span { background: #1d2330; }
    .m-cross .x { top: 2px; transform: translateX(-50%); } .m-cross .y { left: 2px; transform: translateY(-50%); }
    .m-guide { position: fixed; pointer-events: auto; }
    .m-guide.v { top: 0; bottom: 0; width: 7px; margin-left: -3px; cursor: col-resize; }
    .m-guide.h { left: 0; right: 0; height: 7px; margin-top: -3px; cursor: row-resize; }
    .m-guide::before { content: ""; position: absolute; border: 0 solid #0ea5e9; }
    .m-guide.v::before { left: 3px; top: 0; bottom: 0; border-left-width: 1px; }
    .m-guide.h::before { top: 3px; left: 0; right: 0; border-top-width: 1px; }
    .m-guide.snap::before { border-color: #d6409f; }
    .m-guide span { position: absolute; background: #0ea5e9; }
    .m-guide.snap span { background: #d6409f; }
    .m-guide.v span { top: 2px; left: 6px; } .m-guide.h span { left: ${RULER + 2}px; top: 6px; }
    .m-span.v { border-top: 1px dashed #0ea5e9; } .m-span.h { border-left: 1px dashed #0ea5e9; }
    .m-gapl.h { transform: translateX(-50%); } .m-gapl.v { transform: translateY(-50%); }
    .m-gapl.g { background: #0ea5e9; }
    .m-edge.v { top: 0; bottom: 0; border-left: 1px dashed rgba(62,123,250,.75); }
    .m-edge.h { left: 0; right: 0; border-top: 1px dashed rgba(62,123,250,.75); }
    .m-box { border-style: solid; }
    .m-margin { border-color: rgba(246,178,107,.6); }
    .m-border { border-color: rgba(255,221,130,.7); }
    .m-pad { border-color: rgba(147,196,125,.6); }
    .m-outline { outline: 1px solid #3e7bfa; }
    .m-label { background: #3e7bfa; }
    .m-pinned { outline: 2px solid #d6409f; outline-offset: 1px; }
    .m-gap { background: #e5484d; }
    .m-gapl { background: #e5484d; }
    .m-mo { outline: 1px dashed #e5484d; }
    .m-ml { background: #e5484d; }
    .m-chip { font: 600 10px/14px system-ui, sans-serif; color: #fff; padding: 0 4px; border-radius: 3px; white-space: nowrap;
      box-shadow: 0 0 0 1px rgba(255,255,255,.85), 0 1px 3px rgba(0,0,0,.35); }
    .m-chip.dim { opacity: .15; }
    .m-fo { outline: 2px solid var(--c); outline-offset: 1px; }
    .m-tools { top: ${RULER + 8}px; }
    .m-side { position: fixed; top: ${RULER + 8}px; right: 12px; width: 360px; max-height: calc(100vh - 110px);
      display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
    .m-panel { display: flex; flex-direction: column; min-height: 0; background: #fff; color: #1d2330; border: 1px solid #d0d4dc;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(15,20,40,.18); overflow: hidden; }
    .m-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; }
    .m-head i::before { content: "▾"; font-style: normal; color: #5b6475; } .closed .m-head i::before { content: "▸"; }
    .m-head span { font-weight: 600; } .m-head b { flex: 1; color: #5b6475; font-weight: 400; }
    .m-head button, .m-row button { padding: 1px 7px; font-size: 12px; }
    .m-body { overflow: auto; padding: 0 4px 4px; }
    .m-panel.closed .m-body { display: none; }
    .m-row { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
    .m-row:hover, .m-row.on { background: #f1f3f7; }
    .m-txt { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
    .m-sw { flex: none; width: 10px; height: 10px; border-radius: 2px; }
    .m-n { color: #5b6475; font-size: 12px; font-variant-numeric: tabular-nums; }
    .m-flag { font-size: 10px; padding: 0 4px; border-radius: 4px; background: #fdecec; color: #b42318; }
    .m-empty { padding: 6px; color: #5b6475; }
    @media (prefers-color-scheme: dark) {
      .m-panel { background: #1d2230; color: #e6e9ef; border-color: #3a4152; }
      .m-row:hover, .m-row.on { background: #2a3142; }
      .m-head b, .m-n, .m-empty { color: #9aa3b5; }
      .m-flag { background: #4a1f22; color: #ffb4ab; }
      .m-corner { background: #1d2230; border-color: #9aa3b5; }
    }`;

  globalThis.__marginaliaMeasure = measure;
})();
