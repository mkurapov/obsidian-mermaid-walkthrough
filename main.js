'use strict';

const { Plugin, ItemView, MarkdownView, setIcon, debounce } = require('obsidian');

const VIEW_TYPE = 'mermaid-walkthrough';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/#(\d+);/g, (_, c) => String.fromCharCode(+c)).trim();

// ---- Parsing: the subset of Mermaid sequenceDiagram that matters for stepping ----

const MSG_RE = /^(.+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*([^:]+?)\s*(?::\s*(.*))?$/;
const NOTE_RE = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i;
const PART_RE = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/;
const BLOCK_RE = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/;
const BRANCH_RE = /^(else|and|option)\b\s*(.*)$/;
const IGNORE_RE = /^(sequenceDiagram|autonumber|activate|deactivate|destroy|title|accTitle|accDescr|links?|properties|details)\b/;

function splitBoxColor(rest) {
  rest = rest.trim();
  const fn = rest.match(/^((?:rgba?|hsla?)\([^)]*\))\s*(.*)$/i);
  if (fn) return { color: fn[1], label: fn[2] };
  const [first, ...others] = rest.split(/\s+/);
  if (first && others.length && typeof CSS !== 'undefined' && CSS.supports('color', first)) return { color: first, label: others.join(' ') };
  return { color: null, label: rest };
}

function parse(src) {
  const m = { participants: [], idx: new Map(), boxes: [], items: [], steps: [], skipped: [] };
  const stack = [];
  let box = null;
  const ensure = (id, label, kind) => {
    id = id.trim();
    if (!m.idx.has(id)) {
      m.idx.set(id, m.participants.length);
      m.participants.push({ id, label: label ? clean(label) : id, kind: kind || 'participant' });
      if (box) box.members.push(id);
    } else if (label) {
      m.participants[m.idx.get(id)].label = clean(label);
    }
    return id;
  };

  let unnamedRect = null; // a rect waiting for a %% comment to name it
  src.replace(/\r/g, '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    let r;
    if (!line) return;
    if (line.startsWith('%%')) {
      // Mermaid ignores comments, so "%% Prefunding" straight after a rect names the phase
      // without changing how the diagram renders.
      if (unnamedRect && !line.startsWith('%%{')) unnamedRect.text = clean(line.slice(2));
      unnamedRect = null;
      return;
    }
    unnamedRect = null;
    if ((r = line.match(/^box\b(.*)$/))) {
      const { color, label } = splitBoxColor(r[1]);
      box = { label, color, members: [] };
      m.boxes.push(box);
      stack.push('box');
      return;
    }
    if (line === 'end') {
      const closed = stack.pop();
      if (closed === 'box') box = null;
      else if (closed) m.items.push({ type: 'end' });
      return;
    }
    if (IGNORE_RE.test(line)) return;
    if ((r = line.match(PART_RE))) { ensure(r[2], r[3], r[1]); return; }
    if ((r = line.match(NOTE_RE))) {
      const ids = r[2].split(',').map((s) => ensure(s));
      m.items.push({ type: 'note', pos: r[1].toLowerCase(), ids, text: clean(r[3]) });
      return;
    }
    if ((r = line.match(BLOCK_RE))) {
      stack.push('block');
      // A rect is how a diagram marks a phase: it becomes a heading, named by a %% comment on the next line.
      if (r[1] === 'rect') { unnamedRect = { type: 'section', text: '' }; m.items.push(unnamedRect); }
      else m.items.push({ type: 'block', kind: r[1], text: clean(r[2]) });
      return;
    }
    if ((r = line.match(BRANCH_RE))) { m.items.push({ type: 'block', kind: r[1], text: clean(r[2]), branch: true }); return; }
    if ((r = line.match(MSG_RE))) {
      const arrow = r[2];
      m.items.push({
        type: 'msg',
        from: ensure(r[1]),
        to: ensure(r[3]),
        text: clean(r[4] || ''),
        dashed: arrow.startsWith('--') || arrow.startsWith('<<--'),
        head: /x$/.test(arrow) ? 'cross' : /\)$/.test(arrow) ? 'open' : />>$/.test(arrow) ? 'arrow' : 'none',
      });
      return;
    }
    m.skipped.push(`line ${i + 1}: ${line}`);
  });

  // A note that stretches from the first participant to the last heads a sub-flow, like a rect.
  // It runs until the next such note in the same block, or until that block ends.
  const last = m.participants.length - 1;
  const spansAll = (it) => {
    if (it.type !== 'note' || last < 1) return false;
    const at = it.ids.map((id) => m.idx.get(id));
    return Math.min(...at) === 0 && Math.max(...at) === last;
  };

  // Every message and other note is a step. Each step remembers the innermost heading around it,
  // and each heading remembers the item that closes it (`close`).
  const open = []; // {ii, note}: open rects, blocks and note-headed sub-flows, innermost last
  let at = 0;
  const pop = () => { const o = open.pop(); if (o) m.items[o.ii].close = at; };
  const closeNotes = () => { while (open.length && open[open.length - 1].note) pop(); };
  m.items.forEach((it, ii) => {
    at = ii;
    if (it.type === 'end') { closeNotes(); pop(); return; }
    if (spansAll(it)) {
      Object.assign(it, { type: 'section', note: true });
      closeNotes();
      open.push({ ii, note: true });
      return;
    }
    if (it.type === 'section' || it.type === 'block') {
      if (it.branch) { closeNotes(); pop(); } // else/and/option replaces the branch it follows
      open.push({ ii, note: false });
      return;
    }
    it.step = m.steps.length;
    it.section = open.length ? open[open.length - 1].ii : null;
    // The innermost rect or spanning note around it, even when an alt or loop sits in between.
    const pi = open.map((o) => m.items[o.ii].type).lastIndexOf('section');
    it.phase = pi >= 0 ? open[pi].ii : null;
    // The alt, opt, loop and other blocks it sits in within that phase, outermost first.
    it.blocks = open.slice(pi + 1).map((o) => o.ii);
    m.steps.push(it);
  });
  at = m.items.length;
  while (open.length) pop();
  return m;
}

// Each ```mermaid block holding a sequenceDiagram becomes a tab, named by the heading above it.
function splitDiagrams(md) {
  const out = [];
  let heading = null, buf = null;
  md.replace(/\r/g, '').split('\n').forEach((line) => {
    const t = line.trim();
    if (buf) {
      if (t.startsWith('```')) {
        if (/^\s*sequenceDiagram\b/m.test(buf.join('\n'))) out.push({ name: heading, src: buf.join('\n') });
        buf = null;
        heading = null;
      } else buf.push(line);
    } else if (/^```\s*mermaid\b/i.test(t)) buf = [];
    else if (/^#{1,6}\s+/.test(t)) heading = t.replace(/^#{1,6}\s+/, '');
  });
  return out.map((d, i) => ({ ...d, name: d.name || `Diagram ${i + 1}` }));
}

// ---- Rendering ----

// Mermaid box colours tend to be pale pastels, so each box takes our stronger palette
// colour nearest in hue: purples and blues, greens, or warm colours.
function toneFor(color, bi) {
  let rgb = null;
  const fn = color && color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  const hex = color && color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (fn) rgb = fn.slice(1, 4).map(Number);
  else if (hex) rgb = hex.slice(1, 4).map((v) => parseInt(v, 16));
  if (!rgb) return 'mw-b' + ((bi % 3) + 1);
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (!d) return 'mw-b' + ((bi % 3) + 1);
  const h = 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h >= 200 && h < 330 ? 'mw-b1' : h >= 90 && h < 200 ? 'mw-b2' : 'mw-b3';
}

const TIPS = {
  arrow: '<svg class="mw-tip" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0 L10 5 L0 10 Z" fill="currentColor"/></svg>',
  open: '<svg class="mw-tip" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  cross: '<svg class="mw-tip" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 9 M9 1 L1 9" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  none: '',
};

function renderDiagram(model) {
  const P = model.participants;
  const n = P.length;
  const col = (id) => model.idx.get(id) + 1;
  const span = (ids) => {
    const cs = ids.map(col);
    const lo = Math.min(...cs), hi = Math.max(...cs);
    return { lo, hi, k: hi - lo + 1 };
  };

  const actorRow = model.boxes.some((b) => b.members.length) ? 2 : 1;
  const cls = P.map((_, i) => (i === 0 ? ' mw-first' : ''));
  let h = '<div class="mw-head"><div class="mw-grid">';
  model.boxes.forEach((b, bi) => {
    if (!b.members.length) return;
    const { lo, hi } = span(b.members);
    const tone = toneFor(b.color, bi);
    for (let c = lo; c <= hi; c++) cls[c - 1] += ' mw-in-box';
    cls[lo - 1] += ' mw-box-start';
    cls[hi - 1] += ' mw-box-end';
    h += `<div class="mw-boxband ${tone}" data-box="${bi}" style="grid-column:${lo}/${hi + 1};grid-row:1">${esc(b.label)}</div>`;
    h += `<div class="mw-boxframe ${tone}" data-box="${bi}" style="grid-column:${lo}/${hi + 1};grid-row:1/3" aria-hidden="true"></div>`;
  });
  P.forEach((p, i) => { h += `<div class="mw-participant mw-actor${cls[i]}" data-i="${i}" style="grid-column:${i + 1};grid-row:${actorRow}">${esc(p.label)}</div>`; });
  h += '</div></div>';

  h += '<div class="mw-body"><div class="mw-hl" hidden></div><div class="mw-grid mw-lifelines" aria-hidden="true">';
  P.forEach((_, i) => { h += `<div class="mw-ll" data-i="${i}"></div>`; });
  h += '</div>';

  // Each heading and the rows under it share a wrapper, so the pinned heading lets go where its
  // phase or block ends instead of lingering over the steps that follow.
  const scopes = []; // close index of each open wrapper, innermost last
  model.items.forEach((it, ii) => {
    while (scopes.length && scopes[scopes.length - 1] <= ii) { scopes.pop(); h += '</div>'; }
    if (it.type === 'section' || it.type === 'block') { scopes.push(it.close); h += '<div class="mw-scope">'; }
    if (it.type === 'end') return;
    if (it.type === 'section') {
      h += `<div class="mw-row mw-section" data-item="${ii}"><div class="mw-band" style="grid-column:1/-1">${esc(it.text)}</div></div>`;
    } else if (it.type === 'block') {
      h += `<div class="mw-row mw-block" data-item="${ii}"><div class="mw-band" style="grid-column:1/-1"><span class="mw-kind">${esc(it.kind)}</span>${esc(it.text)}</div></div>`;
    } else if (it.type === 'msg') {
      let { lo, hi, k } = span([it.from, it.to]);
      const a = col(it.from), b = col(it.to);
      const dir = b > a ? 'r' : b < a ? 'l' : 'self';
      // A self-message borrows a neighbouring column so its label has room; --off puts the loop on its own lifeline.
      let off = '';
      if (dir === 'self' && n > 1) {
        if (a < n) { hi = a + 1; off = '0.25'; } else { lo = a - 1; off = '0.75'; }
        k = 2;
      }
      h += `<div class="mw-row mw-step mw-msg mw-dir-${dir}${it.dashed ? ' mw-dashed' : ''}" data-step="${it.step}" data-item="${ii}">` +
        `<div class="mw-span" style="grid-column:${lo}/${hi + 1};--k:${k}${off ? `;--off:${off}` : ''}">` +
        `<div class="mw-label"><span class="mw-num">${it.step + 1}</span><span>${esc(it.text)}</span></div>` +
        `<div class="mw-wire">${TIPS[it.head]}</div></div></div>`;
    } else {
      const { lo, hi, k } = span(it.ids);
      h += `<div class="mw-row mw-step mw-note" data-step="${it.step}" data-item="${ii}">` +
        `<div class="mw-span" style="grid-column:${lo}/${hi + 1};--k:${k}">` +
        `<div class="mw-notecard"><span class="mw-num">${it.step + 1}</span><span>${esc(it.text)}</span></div></div></div>`;
    }
  });
  return h + '</div>'.repeat(scopes.length) + '</div>';
}

// ---- Map: boxes and participant cards you arrange yourself, with elbow arrows between them ----

const NODE_W = 170, NODE_H = 50, GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;
const boxKey = (b, bi) => b.label || `box-${bi}`;

// Boxes side by side, each with its participants in a grid. Used for anything not yet arranged.
function defaultLayout(model) {
  const L = { boxes: {}, nodes: {} };
  const top = 60;
  let x = 40, bottom = top;
  model.boxes.forEach((b, bi) => {
    if (!b.members.length) return;
    const cols = b.members.length > 2 ? 2 : 1, rows = Math.ceil(b.members.length / cols);
    const w = cols * NODE_W + (cols - 1) * 50 + 80, h = rows * NODE_H + (rows - 1) * 60 + 80;
    L.boxes[boxKey(b, bi)] = { x, y: top, w, h };
    b.members.forEach((id, k) => {
      L.nodes[id] = { x: x + 40 + (k % cols) * (NODE_W + 50), y: top + 40 + Math.floor(k / cols) * (NODE_H + 60) };
    });
    x += w + 120;
    bottom = Math.max(bottom, top + h);
  });
  let lx = 40;
  model.participants.forEach((p) => {
    if (L.nodes[p.id]) return;
    L.nodes[p.id] = { x: lx, y: bottom + 80 };
    lx += NODE_W + 50;
  });
  return L;
}

// Saved positions win; anything new in the diagram falls back to the default layout.
function mergeLayout(model, saved) {
  const def = defaultLayout(model);
  const L = { boxes: {}, nodes: {} };
  model.boxes.forEach((b, bi) => {
    const k = boxKey(b, bi);
    if (def.boxes[k]) L.boxes[k] = { ...def.boxes[k], ...((saved && saved.boxes && saved.boxes[k]) || {}) };
  });
  model.participants.forEach((p) => { L.nodes[p.id] = { ...def.nodes[p.id], ...((saved && saved.nodes && saved.nodes[p.id]) || {}) }; });
  return L;
}

function renderMap(model, L) {
  let h = '<div class="mw-mapwrap"><div class="mw-canvas">';
  model.boxes.forEach((b, bi) => {
    const r = L.boxes[boxKey(b, bi)];
    if (!r) return;
    h += `<div class="mw-mbox ${toneFor(b.color, bi)}" data-box="${bi}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">` +
      `<div class="mw-mbox-label">${esc(b.label)}</div><div class="mw-mhandle" title="Drag to resize"></div></div>`;
  });
  h += '<svg class="mw-medges" aria-hidden="true"></svg>';
  model.participants.forEach((p, i) => {
    const r = L.nodes[p.id];
    h += `<div class="mw-participant mw-mnode" data-i="${i}" style="left:${r.x}px;top:${r.y}px;width:${NODE_W}px;height:${NODE_H}px">${esc(p.label)}</div>`;
  });
  return h + '<div class="mw-mcard" hidden></div></div></div>';
}

// An elbow route from one card to another: out of the facing sides, across, and in.
// `off` shifts a two-way pair apart so both arrows stay visible.
function route(A, B, off) {
  const hgap = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w));
  const vgap = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
  const ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
  let pts;
  if (hgap >= vgap && hgap > 0) {
    const right = bc.x > ac.x;
    const sx = right ? A.x + A.w : A.x, ex = right ? B.x : B.x + B.w;
    const sy = ac.y + off, ey = bc.y + off, mx = snap((sx + ex) / 2) + off;
    pts = [[sx, sy], [mx, sy], [mx, ey], [ex, ey]];
  } else if (vgap > 0) {
    const down = bc.y > ac.y;
    const sy = down ? A.y + A.h : A.y, ey = down ? B.y : B.y + B.h;
    const sx = ac.x + off, ex = bc.x + off, my = snap((sy + ey) / 2) + off;
    pts = [[sx, sy], [sx, my], [ex, my], [ex, ey]];
  } else {
    pts = [[ac.x, ac.y], [bc.x, bc.y]]; // overlapping cards: a straight line is the best we can do
  }
  const a = pts[Math.floor((pts.length - 1) / 2)], b = pts[Math.floor((pts.length - 1) / 2) + 1];
  return {
    d: 'M ' + pts.map((pt) => pt.join(' ')).join(' L '),
    mid: { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, horizontal: a[1] === b[1] },
  };
}

// ---- The pane ----

class WalkthroughView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.diagrams = [];
    this.active = 0;
    this.cur = -1;
    this.model = null;
    this.memory = new Map(); // file path -> { active, curs } so each note keeps its place
    this.mode = plugin.settings.mode === 'map' ? 'map' : 'sequence';
    this.zoom = null; // map zoom; null means fit to the pane on first show
    this.uid = Math.random().toString(36).slice(2, 8); // keeps SVG marker ids unique per pane
    this.reloadSoon = debounce(() => this.reload(true), 250, true);
    this.saveViewSoon = debounce(() => this.saveView(), 400, true);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? `Steps: ${this.file.basename}` : 'Mermaid Walkthrough'; }
  getIcon() { return 'list-ordered'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mw-root');
    root.setAttr('tabindex', '0');
    root.innerHTML =
      '<div class="mw-bar">' +
        '<div class="mw-brand"><div class="mw-title"></div><div class="mw-readout" aria-live="polite"></div><span class="mw-warn" hidden></span></div>' +
        '<div class="mw-controls">' +
          '<button class="mw-btn mw-icon" data-act="prev" aria-label="Previous step (←)"></button>' +
          '<span class="mw-counter">– / 0</span>' +
          '<button class="mw-btn mw-icon mw-primary" data-act="next" aria-label="Next step (→)"></button>' +
          '<button class="mw-btn" data-act="overview" aria-pressed="false" aria-label="Show all (Esc)">Show all</button>' +
          '<div class="mw-seg" role="group" aria-label="Switch layout (M)">' +
            '<button class="mw-btn" data-mode="sequence">Sequence</button>' +
            '<button class="mw-btn" data-mode="map">Map</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<nav class="mw-tabs" role="tablist" aria-label="Diagrams" hidden></nav>' +
      '<div class="mw-mapbar" hidden>' +
        '<span class="mw-phase" aria-live="polite" hidden></span>' +
        '<span class="mw-mapbar-tools">' +
          '<button class="mw-btn mw-icon" data-zoom="out" aria-label="Zoom out"></button>' +
          '<span class="mw-zoom" aria-label="Pinch or Ctrl/⌘-scroll to zoom, drag empty space to pan">100%</span>' +
          '<button class="mw-btn mw-icon" data-zoom="in" aria-label="Zoom in"></button>' +
          '<button class="mw-btn" data-zoom="fit">Fit</button>' +
          '<button class="mw-btn" data-act="reset" aria-label="Drag cards and boxes to arrange them">Reset layout</button>' +
        '</span>' +
      '</div>' +
      '<div class="mw-stage"><div class="mw-diagram"></div></div>';

    const q = (s) => root.querySelector(s);
    this.els = {
      title: q('.mw-title'), readout: q('.mw-readout'), counter: q('.mw-counter'),
      prev: q('[data-act="prev"]'), next: q('[data-act="next"]'), overview: q('[data-act="overview"]'),
      tabs: q('.mw-tabs'), stage: q('.mw-stage'), diagram: q('.mw-diagram'), warn: q('.mw-warn'),
    };
    setIcon(this.els.prev, 'chevron-left');
    setIcon(this.els.next, 'chevron-right');

    this.els.modes = root.querySelectorAll('[data-mode]');
    this.els.mapbar = q('.mw-mapbar');
    this.els.phase = q('.mw-phase');
    this.els.zoomLabel = q('.mw-zoom');
    setIcon(q('[data-zoom="out"]'), 'minus');
    setIcon(q('[data-zoom="in"]'), 'plus');
    this.els.modes.forEach((b) => this.registerDomEvent(b, 'click', () => this.setMode(b.dataset.mode)));
    root.querySelectorAll('[data-zoom]').forEach((b) => this.registerDomEvent(b, 'click', () => {
      const z = b.dataset.zoom;
      if (z === 'fit') { this.setZoom(this.fitZoom()); this.saveViewSoon(); return; }
      const r = this.els.stage.getBoundingClientRect();
      this.zoomAt((this.zoom || 1) * (z === 'in' ? 1.2 : 1 / 1.2), r.left + r.width / 2, r.top + r.height / 2);
    }));
    // Pinch on a trackpad arrives as a wheel event with ctrlKey set; Ctrl/⌘ + wheel zooms with a mouse.
    // A plain wheel or two-finger swipe keeps scrolling the canvas.
    this.registerDomEvent(this.els.stage, 'wheel', (e) => {
      if (this.mode !== 'map' || !this.model || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // Pinches send many small deltas; a mouse notch sends one large one, so cap each step at about 25%.
      const delta = Math.max(-25, Math.min(25, e.deltaMode === 1 ? e.deltaY * 5 : e.deltaY));
      this.zoomAt(this.zoom * Math.exp(-delta * 0.009), e.clientX, e.clientY);
    }, { passive: false });
    this.registerDomEvent(this.els.stage, 'scroll', () => { if (this.mode === 'map' && this.model) this.saveViewSoon(); });
    this.registerDomEvent(q('[data-act="reset"]'), 'click', () => this.resetLayout());
    this.registerDomEvent(this.els.diagram, 'pointerdown', (e) => this.dragStart(e));
    this.registerDomEvent(this.els.diagram, 'pointermove', (e) => this.dragMove(e));
    this.registerDomEvent(this.els.diagram, 'pointerup', (e) => this.dragEnd(e));
    this.registerDomEvent(this.els.diagram, 'pointercancel', (e) => this.dragEnd(e));
    this.syncModeButtons();

    this.registerDomEvent(this.els.prev, 'click', () => this.go(this.cur - 1));
    this.registerDomEvent(this.els.next, 'click', () => this.go(this.cur < 0 ? 0 : this.cur + 1));
    this.registerDomEvent(this.els.overview, 'click', () => {
      if (this.cur >= 0) this.overview(); else this.go(0);
    });
    this.registerDomEvent(this.els.diagram, 'click', (e) => {
      const row = e.target.closest('[data-step]');
      if (row) this.go(+row.dataset.step, 'nearest');
    });
    this.registerDomEvent(this.els.tabs, 'click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) this.switchTo(+tab.dataset.tab);
    });
    this.registerDomEvent(root, 'keydown', (e) => this.onKey(e));

    // Follow whichever note is open, and re-read it when it changes.
    const follow = (file) => { if (file && file.extension === 'md') this.setFile(file); };
    this.registerEvent(this.app.workspace.on('file-open', follow));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && leaf.view instanceof MarkdownView) follow(leaf.view.file);
    }));
    this.registerEvent(this.app.vault.on('modify', (f) => { if (this.file && f.path === this.file.path) this.reloadSoon(); }));
    this.registerEvent(this.app.vault.on('rename', (f) => { if (f === this.file) this.refreshTitle(); }));

    const start = this.plugin.lastFile;
    if (start) await this.setFile(start);
    else this.showEmpty('Open a note with Mermaid sequence diagrams to step through them.');
  }

  onResize() {
    if (!this.model) return;
    if (this.mode === 'map') this.sizeCanvas();
    this.apply(false);
  }

  syncModeButtons() {
    this.els.modes.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode)));
    this.els.mapbar.hidden = this.mode !== 'map' || !this.model;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.diagrams.length) this.show(this.active, false);
    this.syncModeButtons();
    this.plugin.settings.mode = mode;
    this.plugin.saveSettings();
  }

  refreshTitle() {
    this.els.title.textContent = this.file ? this.file.basename : 'Mermaid Walkthrough';
    if (this.leaf.updateHeader) this.leaf.updateHeader();
  }

  saveMemory() {
    if (!this.file || !this.diagrams.length) return;
    this.diagrams[this.active].cur = this.cur;
    this.memory.set(this.file.path, { active: this.active, curs: this.diagrams.map((d) => d.cur) });
  }

  async setFile(file) {
    if (this.file && file.path === this.file.path) return;
    this.saveMemory();
    this.file = file;
    this.refreshTitle();
    await this.reload(false);
  }

  async reload(keepScroll) {
    const file = this.file;
    if (!file) return;
    this.saveMemory();
    const text = await this.app.vault.cachedRead(file);
    if (file !== this.file) return;
    const mem = this.memory.get(file.path);
    this.diagrams = splitDiagrams(text).map((d, i) => {
      const model = parse(d.src);
      const total = model.steps.length;
      const saved = mem ? mem.curs[i] : undefined;
      return { name: d.name, model, cur: saved != null ? Math.min(saved, total - 1) : (total ? 0 : -1) };
    });
    if (!this.diagrams.length) {
      this.showEmpty(`No Mermaid sequence diagrams in “${file.basename}”.`);
      return;
    }
    this.active = mem && mem.active < this.diagrams.length ? mem.active : 0;
    this.renderTabs();
    this.show(this.active, keepScroll);

    const skipped = this.diagrams.flatMap((d) => d.model.skipped.map((s) => (this.diagrams.length > 1 ? `${d.name}, ` : '') + s));
    this.els.warn.hidden = !skipped.length;
    this.els.warn.textContent = skipped.length ? `${skipped.length} line${skipped.length > 1 ? 's' : ''} not shown` : '';
    this.els.warn.title = skipped.length ? 'Unsupported syntax:\n' + skipped.join('\n') : '';
  }

  showEmpty(message) {
    this.diagrams = [];
    this.model = null;
    this.cur = -1;
    this.els.tabs.hidden = true;
    this.els.warn.hidden = true;
    this.els.diagram.style.setProperty('--n', 1);
    this.els.diagram.innerHTML = `<div class="mw-empty">${esc(message)}</div>`;
    this.els.readout.textContent = '';
    this.els.phase.hidden = true;
    this.els.counter.textContent = '– / 0';
    this.els.prev.disabled = this.els.next.disabled = this.els.overview.disabled = true;
  }

  renderTabs() {
    const tabs = this.els.tabs;
    tabs.hidden = this.diagrams.length < 2;
    tabs.innerHTML = this.diagrams.map((d, i) =>
      `<button class="mw-tab" role="tab" data-tab="${i}" aria-selected="${i === this.active}"${i < 9 ? ` aria-label="${esc(d.name)} (${i + 1})"` : ''}>${esc(d.name)}<span class="mw-count">${d.model.steps.length}</span></button>`
    ).join('');
  }

  show(i, keepScroll) {
    const stage = this.els.stage;
    const top = stage.scrollTop;
    this.active = i;
    this.model = this.diagrams[i].model;
    this.cur = this.diagrams[i].cur;
    this.els.overview.disabled = false;
    if (!this.model.participants.length) {
      this.els.diagram.innerHTML = '<div class="mw-empty">This diagram has no participants yet.</div>';
    } else {
      this.els.diagram.style.setProperty('--n', this.model.participants.length);
      this.els.diagram.classList.toggle('mw-map-mode', this.mode === 'map');
      if (this.mode === 'map') this.renderMapView(keepScroll);
      else this.els.diagram.innerHTML = renderDiagram(this.model);
    }
    this.syncModeButtons();
    this.els.tabs.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(+t.dataset.tab === i)));
    if (this.mode === 'map') this.apply(false);
    else if (keepScroll) { stage.scrollTop = top; this.apply(false); }
    else { stage.scrollTop = 0; this.apply(this.cur > 0 ? 'center' : false); }
  }

  switchTo(i) {
    if (i === this.active || !this.diagrams[i]) return;
    this.diagrams[this.active].cur = this.cur;
    this.show(i, false);
    this.saveMemory();
  }

  go(i, scroll = 'center') {
    if (!this.model) return;
    const total = this.model.steps.length;
    if (!total) return;
    this.cur = Math.max(0, Math.min(total - 1, i));
    this.apply(scroll);
    this.saveMemory();
  }

  overview() {
    if (!this.model) return;
    this.cur = -1;
    this.apply(false);
    this.saveMemory();
  }

  onKey(e) {
    if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey || !this.model) return;
    const total = this.model.steps.length;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'j':
        e.preventDefault(); this.go(this.cur < 0 ? 0 : this.cur + 1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'k':
        e.preventDefault(); this.go(this.cur < 0 ? 0 : this.cur - 1); break;
      case 'Home': e.preventDefault(); this.go(0); break;
      case 'End': e.preventDefault(); this.go(total - 1); break;
      case 'Escape': e.preventDefault(); this.overview(); break;
      case 'm': case 'M': e.preventDefault(); this.setMode(this.mode === 'map' ? 'sequence' : 'map'); break;
      default:
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); this.switchTo(+e.key - 1); }
    }
  }

  participantName(id) { return this.model.participants[this.model.idx.get(id)].label; }

  apply(scroll) {
    const model = this.model;
    const dg = this.els.diagram;
    const steps = model.steps;
    const total = steps.length;
    const on = this.cur >= 0 && this.cur < total;
    dg.classList.toggle('mw-stepping', on);
    dg.querySelectorAll('.mw-active, .mw-on, .mw-from, .mw-to, .mw-noteon, .mw-current')
      .forEach((el) => el.classList.remove('mw-active', 'mw-on', 'mw-from', 'mw-to', 'mw-noteon', 'mw-current'));

    if (this.mode === 'map') { this.applyMap(); this.applyReadout(); return; }

    const head = dg.querySelector('.mw-head');
    dg.style.setProperty('--head-h', head ? head.offsetHeight + 16 + 'px' : '0px');
    // Pin phase headings a pixel under the header's bottom edge, rounding down, so no sliver of the
    // steps scrolling past shows between them at fractional heights or zoom levels.
    dg.style.setProperty('--head-top', head ? Math.max(0, Math.floor(head.getBoundingClientRect().height) - 1) + 'px' : '0px');
    this.stackHeadings();

    const hl = dg.querySelector('.mw-hl');
    if (on) {
      const st = steps[this.cur];
      const row = dg.querySelector(`[data-step="${this.cur}"]`);
      row.classList.add('mw-active');
      const ids = st.type === 'msg' ? [st.from, st.to] : st.ids;
      const onIdx = new Set(ids.map((id) => model.idx.get(id)));
      const actor = (i) => dg.querySelector(`.mw-actor[data-i="${i}"]`);
      onIdx.forEach((i) => {
        actor(i).classList.add('mw-on');
        dg.querySelector(`.mw-ll[data-i="${i}"]`).classList.add('mw-on');
      });
      if (st.type === 'msg') {
        actor(model.idx.get(st.from)).classList.add('mw-from');
        actor(model.idx.get(st.to)).classList.add('mw-to');
      } else {
        onIdx.forEach((i) => actor(i).classList.add('mw-noteon'));
      }
      model.boxes.forEach((b, bi) => {
        if (b.members.some((id) => onIdx.has(model.idx.get(id)))) {
          dg.querySelectorAll(`[data-box="${bi}"]`).forEach((el) => el.classList.add('mw-on'));
        }
      });
      if (st.section != null) {
        const secRow = dg.querySelector(`[data-item="${st.section}"]`);
        if (secRow) secRow.classList.add('mw-current');
      }
      if (hl) {
        hl.hidden = false;
        hl.style.transform = `translateY(${row.offsetTop}px)`;
        hl.style.height = row.offsetHeight + 'px';
      }
      if (scroll) this.scrollStepToTop(row, st);
    } else if (hl) {
      hl.hidden = true;
    }
    this.applyReadout();
  }

  // Pins each heading under the ones around it (an alt under its phase, say) instead of over them.
  // An inner heading sits lower in the stack, so when its own rows run out it slides away beneath
  // the outer one. Overlapping by a pixel per level keeps slivers of the rows from showing between.
  stackHeadings() {
    this.els.diagram.querySelectorAll('.mw-scope > .mw-row:first-child').forEach((row) => {
      let offset = 0, depth = 0;
      for (let s = row.parentElement.parentElement.closest('.mw-scope'); s; s = s.parentElement.closest('.mw-scope')) {
        offset += Math.floor(s.firstElementChild.getBoundingClientRect().height) - 1;
        depth++;
      }
      row.dataset.stack = offset;
      row.style.top = `calc(var(--head-top, 0px) + ${offset}px)`;
      row.style.zIndex = depth ? 3 : 4;
    });
  }

  // Puts the current step right under the pinned participant header (and its pinned phase heading),
  // so the participants it involves sit as close to it as possible.
  scrollStepToTop(row, st) {
    const stage = this.els.stage;
    const dg = this.els.diagram;
    const head = dg.querySelector('.mw-head');
    const sec = st.section != null ? dg.querySelector(`[data-item="${st.section}"]`) : null;
    const pinned = (head ? head.offsetHeight : 0) + (sec ? +sec.dataset.stack + sec.offsetHeight : 0) + 4;
    const top = stage.scrollTop + row.getBoundingClientRect().top - stage.getBoundingClientRect().top - pinned;
    stage.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // Toolbar readout, counter and buttons, shared by both layouts.
  applyReadout() {
    const model = this.model;
    const total = model.steps.length;
    const on = this.cur >= 0 && this.cur < total;
    // While stepping, the phase and the step already show on the diagram, so the toolbar keeps to the counter.
    this.els.readout.innerHTML = on ? '' : `<span class="mw-what">${total} steps · ${model.participants.length} participants</span>`;

    this.els.counter.textContent = on ? `${this.cur + 1} / ${total}` : `– / ${total}`;
    this.els.prev.disabled = !total || this.cur <= 0;
    this.els.next.disabled = !total || this.cur >= total - 1;
    this.els.overview.setAttribute('aria-pressed', String(!on));
  }

  // ---- Map layout ----

  layoutKey() { return `${this.file ? this.file.path : ''}::${this.diagrams[this.active].name}`; }

  // keepView holds the current zoom and scroll (a re-render after an edit); otherwise the diagram
  // opens where it was last left, or fitted to the pane the first time.
  renderMapView(keepView) {
    const stage = this.els.stage;
    const left = stage.scrollLeft, top = stage.scrollTop;
    const view = keepView ? null : this.plugin.settings.views[this.layoutKey()];
    if (!keepView) this.zoom = view ? view.zoom : null;
    this.layout = mergeLayout(this.model, this.plugin.settings.layouts[this.layoutKey()]);
    this.els.diagram.innerHTML = renderMap(this.model, this.layout);
    this.mapPairs = new Map();
    this.model.steps.forEach((st) => {
      if (st.type !== 'msg') return;
      const a = this.model.idx.get(st.from), b = this.model.idx.get(st.to);
      const key = `${a}>${b}`;
      const pair = this.mapPairs.get(key) || { a, b, dashed: true };
      pair.dashed = pair.dashed && st.dashed;
      this.mapPairs.set(key, pair);
    });
    this.canvasW = this.canvasH = 0;
    this.setZoom(this.zoom == null ? this.fitZoom() : this.zoom);
    this.drawMapEdges();
    stage.scrollLeft = keepView ? left : view ? view.x : 0;
    stage.scrollTop = keepView ? top : view ? view.y : 0;
  }

  // Remembers the map's zoom and scroll position for this diagram.
  saveView() {
    if (this.mode !== 'map' || !this.model) return;
    const stage = this.els.stage;
    const view = { zoom: Math.round(this.zoom * 1000) / 1000, x: Math.round(stage.scrollLeft), y: Math.round(stage.scrollTop) };
    const views = this.plugin.settings.views, key = this.layoutKey(), old = views[key];
    if (old && old.zoom === view.zoom && old.x === view.x && old.y === view.y) return;
    views[key] = view;
    this.plugin.saveSettings();
  }

  nodeRect(i) {
    const r = this.layout.nodes[this.model.participants[i].id];
    return { x: r.x, y: r.y, w: NODE_W, h: NODE_H };
  }

  // The right and bottom edges of everything placed on the map.
  contentExtent() {
    const rects = [...Object.values(this.layout.boxes), ...Object.values(this.layout.nodes).map((n) => ({ ...n, w: NODE_W, h: NODE_H }))];
    return { w: Math.max(...rects.map((r) => r.x + r.w)), h: Math.max(...rects.map((r) => r.y + r.h)) };
  }

  // The canvas fills the pane at the current zoom, with room to spare past the content. It only
  // grows while the map is open, so moving a box never makes it jump or shrink under the pointer.
  sizeCanvas() {
    const canvas = this.els.diagram.querySelector('.mw-canvas');
    const wrap = this.els.diagram.querySelector('.mw-mapwrap');
    if (!canvas || !wrap) return;
    const { w, h } = this.contentExtent();
    const stage = this.els.stage;
    this.canvasW = Math.max(this.canvasW || 0, w + 400, Math.ceil(stage.clientWidth / this.zoom));
    this.canvasH = Math.max(this.canvasH || 0, h + 400, Math.ceil(stage.clientHeight / this.zoom));
    canvas.style.width = this.canvasW + 'px';
    canvas.style.height = this.canvasH + 'px';
    canvas.style.transform = `scale(${this.zoom})`;
    wrap.style.width = this.canvasW * this.zoom + 'px';
    wrap.style.height = this.canvasH * this.zoom + 'px';
    const svg = this.els.diagram.querySelector('.mw-medges');
    if (svg) {
      svg.setAttribute('width', String(this.canvasW));
      svg.setAttribute('height', String(this.canvasH));
    }
  }

  fitZoom() {
    const { w, h } = this.contentExtent();
    const stage = this.els.stage;
    return Math.max(0.3, Math.min(1, (stage.clientWidth - 24) / (w + 40), (stage.clientHeight - 24) / (h + 40)));
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(2, z));
    this.sizeCanvas();
    this.els.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
  }

  drawMapEdges() {
    const svg = this.els.diagram.querySelector('.mw-medges');
    if (!svg) return;
    this.edgeMid = new Map();
    let paths = '';
    this.mapPairs.forEach((pair, key) => {
      const A = this.nodeRect(pair.a);
      let geo;
      if (pair.a === pair.b) {
        const x = A.x + A.w, y = A.y + A.h / 2;
        geo = { d: `M ${x} ${y - 12} L ${x + 26} ${y - 12} L ${x + 26} ${y + 12} L ${x} ${y + 12}`, mid: { x: x + 26, y, horizontal: false } };
      } else {
        const off = this.mapPairs.has(`${pair.b}>${pair.a}`) ? (pair.a < pair.b ? -6 : 6) : 0;
        geo = route(A, this.nodeRect(pair.b), off);
      }
      this.edgeMid.set(key, geo.mid);
      paths += `<path class="mw-medge${pair.dashed ? ' mw-dashed' : ''}" data-edge="${key}" d="${geo.d}" marker-end="url(#mw-tip-${this.uid})"/>`;
    });
    const marker = (id, cls) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="${cls}" d="M0 0 L10 5 L0 10 Z"/></marker>`;
    svg.setAttribute('width', String(this.canvasW));
    svg.setAttribute('height', String(this.canvasH));
    svg.innerHTML = `<defs>${marker(`mw-tip-${this.uid}`, 'mw-marker')}${marker(`mw-tip-on-${this.uid}`, 'mw-marker-on')}</defs>${paths}`;
  }

  applyMap() {
    const dg = this.els.diagram;
    const model = this.model;
    const on = this.cur >= 0 && this.cur < model.steps.length;
    dg.classList.toggle('mw-mapping', on);
    // The phase name, then any alt/opt/loop it is in, the way the sequence headings show them.
    const st = on ? model.steps[this.cur] : null;
    const parts = [];
    if (st && st.phase != null) parts.push(`<span class="mw-phase-name">${esc(model.items[st.phase].text)}</span>`);
    if (st) st.blocks.forEach((bi) => {
      const b = model.items[bi];
      parts.push(`<span class="mw-phase-block"><span class="mw-kind">${esc(b.kind)}</span>${b.text ? ' ' + esc(b.text) : ''}</span>`);
    });
    this.els.phase.innerHTML = parts.join('<span class="mw-phase-sep">›</span>');
    this.els.phase.hidden = !parts.length;
    const card = dg.querySelector('.mw-mcard');
    if (!card) return;
    if (!on) { card.hidden = true; return; }

    const ids = st.type === 'msg' ? [st.from, st.to] : st.ids;
    ids.forEach((id) => dg.querySelector(`.mw-mnode[data-i="${model.idx.get(id)}"]`).classList.add('mw-on'));
    if (st.type === 'msg') {
      dg.querySelector(`.mw-mnode[data-i="${model.idx.get(st.from)}"]`).classList.add('mw-from');
      dg.querySelector(`.mw-mnode[data-i="${model.idx.get(st.to)}"]`).classList.add('mw-to');
    }
    model.boxes.forEach((b, bi) => {
      if (b.members.some((id) => ids.includes(id))) {
        const el = dg.querySelector(`.mw-mbox[data-box="${bi}"]`);
        if (el) el.classList.add('mw-on');
      }
    });

    let at = null;
    if (st.type === 'msg') {
      const key = `${model.idx.get(st.from)}>${model.idx.get(st.to)}`;
      const edge = dg.querySelector(`.mw-medge[data-edge="${key}"]`);
      if (edge) {
        edge.classList.add('mw-active');
        edge.setAttribute('marker-end', `url(#mw-tip-on-${this.uid})`);
        edge.parentNode.appendChild(edge); // draw the active arrow above the others
      }
      at = this.edgeMid.get(key);
    } else {
      const rects = ids.map((id) => this.nodeRect(model.idx.get(id)));
      const left = Math.min(...rects.map((r) => r.x)), right = Math.max(...rects.map((r) => r.x + r.w));
      at = { x: (left + right) / 2, y: Math.min(...rects.map((r) => r.y)) - 30, horizontal: true };
    }
    card.hidden = false;
    // The same numbered label the sequence uses, placed on the arrow.
    // Any alt/opt/loop the step sits in rides on top of its box as a tab, apart from the step's own text.
    const cond = st.blocks.map((bi) => {
      const b = model.items[bi];
      return `<span class="mw-kind">${esc(b.kind)}</span>${b.text ? ' ' + esc(b.text) : ''}`;
    }).join(' › ');
    card.innerHTML = (cond ? `<div class="mw-cond">${cond}</div>` : '') +
      `<div class="mw-label mw-label-on"><span class="mw-num">${this.cur + 1}</span><span>${esc(st.text)}</span></div>`;
    this.placeCard(card, at);
  }

  // Puts the step card on the arrow's middle segment, or beside it when that covers fewer cards.
  placeCard(card, at) {
    const w = card.offsetWidth, h = card.offsetHeight;
    const nodes = this.model.participants.map((_, i) => this.nodeRect(i));
    const overlap = (c) => nodes.reduce((sum, n) => {
      const x = Math.min(c.x + w / 2, n.x + n.w) - Math.max(c.x - w / 2, n.x);
      const y = Math.min(c.y + h / 2, n.y + n.h) - Math.max(c.y - h / 2, n.y);
      return sum + (x > 0 && y > 0 ? x * y : 0);
    }, 0);
    const shift = at.horizontal ? { x: 0, y: h / 2 + 10 } : { x: w / 2 + 12, y: 0 };
    const candidates = [
      { x: at.x - shift.x, y: at.y - shift.y },
      { x: at.x + shift.x, y: at.y + shift.y },
      at,
    ];
    let best = candidates[0], score = overlap(best);
    candidates.slice(1).forEach((c) => { const s = overlap(c); if (s < score - 1) { best = c; score = s; } });
    card.style.left = best.x - w / 2 + 'px';
    card.style.top = best.y - h / 2 + 'px';

    // Bring the card into view if stepping moved it off screen (but not mid-drag).
    if (this.drag) return;
    const stage = this.els.stage;
    const cx = best.x * this.zoom, cy = best.y * this.zoom;
    if (cx < stage.scrollLeft || cx > stage.scrollLeft + stage.clientWidth || cy < stage.scrollTop || cy > stage.scrollTop + stage.clientHeight) {
      stage.scrollTo({ left: cx - stage.clientWidth / 2, top: cy - stage.clientHeight / 2, behavior: 'smooth' });
    }
  }

  // Zooms to `z` while keeping the canvas point under the pointer where it is.
  zoomAt(z, clientX, clientY) {
    const stage = this.els.stage;
    const r = stage.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const px = (stage.scrollLeft + mx) / this.zoom, py = (stage.scrollTop + my) / this.zoom;
    this.setZoom(z);
    stage.scrollLeft = px * this.zoom - mx;
    stage.scrollTop = py * this.zoom - my;
    this.saveViewSoon();
  }

  dragStart(e) {
    if (this.mode !== 'map' || !this.model) return;
    if (e.button !== 0 && e.button !== 1) return;
    const handle = e.target.closest('.mw-mhandle');
    const node = e.target.closest('.mw-mnode');
    const box = e.target.closest('.mw-mbox');
    e.preventDefault();
    this.contentEl.focus(); // keep arrow keys working after a drag
    // Empty space, or the middle button anywhere, pans the canvas.
    if (e.button === 1 || (!handle && !node && !box)) {
      const stage = this.els.stage;
      this.drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, el: e.target };
      e.target.setPointerCapture(e.pointerId);
      this.contentEl.addClass('mw-panning');
      return;
    }
    const d = { x0: e.clientX, y0: e.clientY, moved: false, el: handle || node || box };
    if (node) {
      d.kind = 'node';
      d.id = this.model.participants[+node.dataset.i].id;
      d.start = { ...this.layout.nodes[d.id] };
    } else {
      const bi = +(box || handle.closest('.mw-mbox')).dataset.box;
      d.kind = handle ? 'resize' : 'box';
      d.box = box || handle.closest('.mw-mbox');
      d.key = boxKey(this.model.boxes[bi], bi);
      d.start = { ...this.layout.boxes[d.key] };
      // Moving a box carries its participants with it.
      d.members = this.model.boxes[bi].members.map((id) => ({ id, ...this.layout.nodes[id] }));
    }
    d.el.setPointerCapture(e.pointerId);
    this.drag = d;
  }

  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pan') {
      this.els.stage.scrollLeft = d.left - (e.clientX - d.x0);
      this.els.stage.scrollTop = d.top - (e.clientY - d.y0);
      return;
    }
    const dx = (e.clientX - d.x0) / this.zoom, dy = (e.clientY - d.y0) / this.zoom;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    const dg = this.els.diagram;
    if (d.kind === 'node') {
      const n = { x: snap(d.start.x + dx), y: snap(d.start.y + dy) };
      this.layout.nodes[d.id] = n;
      Object.assign(d.el.style, { left: n.x + 'px', top: n.y + 'px' });
    } else if (d.kind === 'resize') {
      const b = this.layout.boxes[d.key];
      b.w = Math.max(120, snap(d.start.w + dx));
      b.h = Math.max(80, snap(d.start.h + dy));
      Object.assign(d.box.style, { width: b.w + 'px', height: b.h + 'px' });
    } else {
      const mx = snap(d.start.x + dx) - d.start.x, my = snap(d.start.y + dy) - d.start.y;
      const b = this.layout.boxes[d.key];
      b.x = d.start.x + mx;
      b.y = d.start.y + my;
      Object.assign(d.box.style, { left: b.x + 'px', top: b.y + 'px' });
      d.members.forEach((m) => {
        const n = { x: m.x + mx, y: m.y + my };
        this.layout.nodes[m.id] = n;
        const el = dg.querySelector(`.mw-mnode[data-i="${this.model.idx.get(m.id)}"]`);
        Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px' });
      });
    }
    this.drawMapEdges();
    this.clearMarks();
    this.applyMap();
  }

  dragEnd() {
    const d = this.drag;
    this.drag = null;
    this.contentEl.removeClass('mw-panning');
    if (!d || !d.moved) return;
    this.sizeCanvas();
    this.plugin.settings.layouts[this.layoutKey()] = this.layout;
    this.plugin.saveSettings();
  }

  resetLayout() {
    if (!this.model) return;
    delete this.plugin.settings.layouts[this.layoutKey()];
    delete this.plugin.settings.views[this.layoutKey()];
    this.plugin.saveSettings();
    this.show(this.active, false);
  }

  clearMarks() {
    this.els.diagram.querySelectorAll('.mw-active, .mw-on, .mw-from, .mw-to, .mw-noteon, .mw-current')
      .forEach((el) => el.classList.remove('mw-active', 'mw-on', 'mw-from', 'mw-to', 'mw-noteon', 'mw-current'));
  }
}

// ---- Plugin ----

module.exports = class MermaidWalkthroughPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ mode: 'sequence', layouts: {}, views: {} }, await this.loadData());
    this.lastFile = this.app.workspace.getActiveFile();
    this.registerView(VIEW_TYPE, (leaf) => new WalkthroughView(leaf, this));

    this.addRibbonIcon('list-ordered', 'Open Mermaid Walkthrough', () => this.activate());
    this.addCommand({ id: 'open', name: 'Open for current note', callback: () => this.activate() });
    this.addCommand({
      id: 'next-step', name: 'Next step',
      checkCallback: (checking) => this.withView(checking, (v) => v.go(v.cur < 0 ? 0 : v.cur + 1)),
    });
    this.addCommand({
      id: 'previous-step', name: 'Previous step',
      checkCallback: (checking) => this.withView(checking, (v) => v.go(v.cur - 1)),
    });

    this.registerEvent(this.app.workspace.on('file-open', (f) => { if (f && f.extension === 'md') this.lastFile = f; }));
  }

  saveSettings() { return this.saveData(this.settings); }

  withView(checking, fn) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf && leaf.view;
    if (!(view instanceof WalkthroughView) || !view.model) return false;
    if (!checking) fn(view);
    return true;
  }

  async activate() {
    const file = this.app.workspace.getActiveFile() || this.lastFile;
    if (file) this.lastFile = file;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('split', 'vertical');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (file && leaf.view instanceof WalkthroughView) await leaf.view.setFile(file);
    leaf.view.contentEl.focus();
  }
};

module.exports.parse = parse;
module.exports.splitDiagrams = splitDiagrams;
module.exports.renderDiagram = renderDiagram;
module.exports.renderMap = renderMap;
module.exports.defaultLayout = defaultLayout;
module.exports.route = route;
