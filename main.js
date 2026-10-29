"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  MarkdownView,
  Component,
  editorInfoField,
  setIcon,
  debounce,
} = require("obsidian");
const { ViewPlugin } = require("@codemirror/view");

const VIEW_TYPE = "mermaid-walkthrough";

const clean = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .trim();

// ---- Parsing: the subset of Mermaid sequenceDiagram that matters for stepping ----

const MSG_RE =
  /^(.+?)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?\s*([^:]+?)\s*(?::\s*(.*))?$/;
const NOTE_RE = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i;
const PART_RE = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/;
const BLOCK_RE = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/;
const BRANCH_RE = /^(else|and|option)\b\s*(.*)$/;
const IGNORE_RE =
  /^(sequenceDiagram|autonumber|activate|deactivate|destroy|title|accTitle|accDescr|links?|properties|details)\b/;

function splitBoxColor(rest) {
  rest = rest.trim();
  const fn = rest.match(/^((?:rgba?|hsla?)\([^)]*\))\s*(.*)$/i);
  if (fn) return { color: fn[1], label: fn[2] };
  const [first, ...others] = rest.split(/\s+/);
  if (
    first &&
    others.length &&
    typeof CSS !== "undefined" &&
    CSS.supports("color", first)
  )
    return { color: first, label: others.join(" ") };
  return { color: null, label: rest };
}

function parse(src) {
  const m = {
    participants: [],
    idx: new Map(),
    boxes: [],
    items: [],
    steps: [],
    skipped: [],
  };
  const stack = [];
  let box = null;
  const ensure = (id, label, kind) => {
    id = id.trim();
    if (!m.idx.has(id)) {
      m.idx.set(id, m.participants.length);
      m.participants.push({
        id,
        label: label ? clean(label) : id,
        kind: kind || "participant",
      });
      if (box) box.members.push(id);
    } else if (label) {
      m.participants[m.idx.get(id)].label = clean(label);
    }
    return id;
  };

  let unnamedRect = null; // a rect waiting for a %% comment to name it
  src
    .replace(/\r/g, "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      let r;
      if (!line) return;
      if (line.startsWith("%%")) {
        // Mermaid ignores comments, so "%% Prefunding" straight after a rect names the phase
        // without changing how the diagram renders.
        if (unnamedRect && !line.startsWith("%%{"))
          unnamedRect.text = clean(line.slice(2));
        unnamedRect = null;
        return;
      }
      unnamedRect = null;
      if ((r = line.match(/^box\b(.*)$/))) {
        const { color, label } = splitBoxColor(r[1]);
        box = { label, color, members: [] };
        m.boxes.push(box);
        stack.push("box");
        return;
      }
      if (line === "end") {
        const closed = stack.pop();
        if (closed === "box") box = null;
        else if (closed) m.items.push({ type: "end" });
        return;
      }
      if (IGNORE_RE.test(line)) return;
      if ((r = line.match(PART_RE))) {
        ensure(r[2], r[3], r[1]);
        return;
      }
      if ((r = line.match(NOTE_RE))) {
        const ids = r[2].split(",").map((s) => ensure(s));
        m.items.push({
          type: "note",
          pos: r[1].toLowerCase(),
          ids,
          text: clean(r[3]),
        });
        return;
      }
      if ((r = line.match(BLOCK_RE))) {
        stack.push("block");
        // A rect is how a diagram marks a phase: it becomes a heading, named by a %% comment on the next line.
        if (r[1] === "rect") {
          unnamedRect = { type: "section", text: "" };
          m.items.push(unnamedRect);
        } else m.items.push({ type: "block", kind: r[1], text: clean(r[2]) });
        return;
      }
      if ((r = line.match(BRANCH_RE))) {
        m.items.push({
          type: "block",
          kind: r[1],
          text: clean(r[2]),
          branch: true,
        });
        return;
      }
      if ((r = line.match(MSG_RE))) {
        const arrow = r[2];
        m.items.push({
          type: "msg",
          from: ensure(r[1]),
          to: ensure(r[3]),
          text: clean(r[4] || ""),
          dashed: arrow.startsWith("--") || arrow.startsWith("<<--"),
          head: /x$/.test(arrow)
            ? "cross"
            : /\)$/.test(arrow)
              ? "open"
              : />>$/.test(arrow)
                ? "arrow"
                : "none",
        });
        return;
      }
      m.skipped.push(`line ${i + 1}: ${line}`);
    });

  // A note that stretches from the first participant to the last heads a sub-flow, like a rect.
  // It runs until the next such note in the same block, or until that block ends.
  const last = m.participants.length - 1;
  const spansAll = (it) => {
    if (it.type !== "note" || last < 1) return false;
    const at = it.ids.map((id) => m.idx.get(id));
    return Math.min(...at) === 0 && Math.max(...at) === last;
  };

  // Every message and other note is a step. Each step remembers the innermost heading around it,
  // and each heading remembers the item that closes it (`close`).
  const open = []; // {ii, note}: open rects, blocks and note-headed sub-flows, innermost last
  let at = 0;
  const pop = () => {
    const o = open.pop();
    if (o) m.items[o.ii].close = at;
  };
  const closeNotes = () => {
    while (open.length && open[open.length - 1].note) pop();
  };
  m.items.forEach((it, ii) => {
    at = ii;
    if (it.type === "end") {
      closeNotes();
      pop();
      return;
    }
    if (spansAll(it)) {
      Object.assign(it, { type: "section", note: true });
      closeNotes();
      open.push({ ii, note: true });
      return;
    }
    if (it.type === "section" || it.type === "block") {
      if (it.branch) {
        closeNotes();
        pop();
      } // else/and/option replaces the branch it follows
      open.push({ ii, note: false });
      return;
    }
    it.step = m.steps.length;
    it.section = open.length ? open[open.length - 1].ii : null;
    // The innermost rect or spanning note around it, even when an alt or loop sits in between.
    const pi = open.map((o) => m.items[o.ii].type).lastIndexOf("section");
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
// Every fenced block is tracked, so a `# comment` inside a bash or python block isn't read as a heading.
function splitDiagrams(md) {
  const out = [];
  let heading = null,
    fence = null; // fence: { mark, buf, start }, where buf collects lines only for mermaid
  md.replace(/\r/g, "")
    .split("\n")
    .forEach((line, ln) => {
      const t = line.trim();
      if (fence) {
        // A fence closes on a run of the same character at least as long as the one that opened it.
        if (
          t.startsWith(fence.mark) &&
          new RegExp(`^${fence.mark[0]}+$`).test(t)
        ) {
          if (fence.buf) {
            const src = fence.buf.join("\n");
            if (/^\s*sequenceDiagram\b/m.test(src))
              out.push({ name: heading, src, start: fence.start, end: ln });
            heading = null;
          }
          fence = null;
        } else if (fence.buf) fence.buf.push(line);
        return;
      }
      const open = t.match(/^(`{3,}|~{3,})\s*(\S*)/);
      if (open)
        fence = {
          mark: open[1],
          buf: /^mermaid$/i.test(open[2]) ? [] : null,
          start: ln,
        };
      else if (/^#{1,6}\s+/.test(t)) heading = t.replace(/^#{1,6}\s+/, "");
    });
  return out.map((d, i) => ({ ...d, name: d.name || `Diagram ${i + 1}` }));
}

// ---- Rendering ----

// Mermaid box colours tend to be pale pastels, so each box takes our stronger palette
// colour nearest in hue: purples and blues, greens, or warm colours.
function toneFor(color, bi) {
  let rgb = null;
  const fn = color && color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  const hex =
    color && color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (fn) rgb = fn.slice(1, 4).map(Number);
  else if (hex) rgb = hex.slice(1, 4).map((v) => parseInt(v, 16));
  if (!rgb) return "mw-b" + ((bi % 3) + 1);
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  if (!d) return "mw-b" + ((bi % 3) + 1);
  const h =
    60 *
    (max === r
      ? ((g - b) / d + 6) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4);
  return h >= 200 && h < 330 ? "mw-b1" : h >= 90 && h < 200 ? "mw-b2" : "mw-b3";
}

// Splits "a b c" into the class list createEl expects.
const classes = (s) => s.split(" ").filter(Boolean);

// "kind text", the way a block names itself: `alt` in a quieter weight, then its condition.
function appendBlockName(el, b, sep = "") {
  el.createSpan({ cls: "mw-kind", text: b.kind });
  if (b.text) el.appendText(sep + b.text);
}

const TIPS = {
  arrow: { d: "M0 0 L10 5 L0 10 Z", fill: "currentColor" },
  open: {
    d: "M1 1 L9 5 L1 9",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
  },
  cross: {
    d: "M1 1 L9 9 M9 1 L1 9",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
  },
};

function appendTip(el, head) {
  if (!TIPS[head]) return;
  el.createSvg("svg", {
    attr: {
      class: "mw-tip",
      width: "10",
      height: "10",
      viewBox: "0 0 10 10",
      "aria-hidden": "true",
    },
  }).createSvg("path", { attr: TIPS[head] });
}

function renderDiagram(model, el) {
  const P = model.participants;
  const n = P.length;
  const col = (id) => model.idx.get(id) + 1;
  const span = (ids) => {
    const cs = ids.map(col);
    const lo = Math.min(...cs),
      hi = Math.max(...cs);
    return { lo, hi, k: hi - lo + 1 };
  };

  const actorRow = model.boxes.some((b) => b.members.length) ? 2 : 1;
  const cls = P.map((_, i) => (i === 0 ? " mw-first" : ""));
  const grid = el.createDiv("mw-head").createDiv("mw-grid");
  model.boxes.forEach((b, bi) => {
    if (!b.members.length) return;
    const { lo, hi } = span(b.members);
    const tone = toneFor(b.color, bi);
    for (let c = lo; c <= hi; c++) cls[c - 1] += " mw-in-box";
    cls[lo - 1] += " mw-box-start";
    cls[hi - 1] += " mw-box-end";
    grid.createDiv({
      cls: ["mw-boxband", tone],
      attr: { "data-box": bi },
      text: b.label,
    }).style.gridColumn = `${lo}/${hi + 1}`;
    grid.createDiv({
      cls: ["mw-boxframe", tone],
      attr: { "data-box": bi, "aria-hidden": "true" },
    }).style.gridColumn = `${lo}/${hi + 1}`;
  });
  P.forEach((p, i) => {
    const actor = grid.createDiv({
      cls: classes(`mw-participant mw-actor${cls[i]}`),
      attr: { "data-i": i },
      text: p.label,
    });
    Object.assign(actor.style, {
      gridColumn: String(i + 1),
      gridRow: String(actorRow),
    });
  });

  const body = el.createDiv("mw-body");
  body.createDiv("mw-hl").hidden = true;
  const lifelines = body.createDiv({
    cls: ["mw-grid", "mw-lifelines"],
    attr: { "aria-hidden": "true" },
  });
  P.forEach((_, i) =>
    lifelines.createDiv({ cls: "mw-ll", attr: { "data-i": i } }),
  );

  // Each heading and the rows under it share a wrapper, so the pinned heading lets go where its
  // phase or block ends instead of lingering over the steps that follow.
  const scopes = []; // {close, el} of each open wrapper, innermost last
  const parent = () => (scopes.length ? scopes[scopes.length - 1].el : body);
  model.items.forEach((it, ii) => {
    while (scopes.length && scopes[scopes.length - 1].close <= ii) scopes.pop();
    if (it.type === "section" || it.type === "block")
      scopes.push({ close: it.close, el: parent().createDiv("mw-scope") });
    if (it.type === "end") return;
    if (it.type === "section") {
      parent()
        .createDiv({ cls: ["mw-row", "mw-section"], attr: { "data-item": ii } })
        .createDiv({ cls: "mw-band", text: it.text });
    } else if (it.type === "block") {
      appendBlockName(
        parent()
          .createDiv({ cls: ["mw-row", "mw-block"], attr: { "data-item": ii } })
          .createDiv("mw-band"),
        it,
      );
    } else if (it.type === "msg") {
      let { lo, hi, k } = span([it.from, it.to]);
      const a = col(it.from),
        b = col(it.to);
      const dir = b > a ? "r" : b < a ? "l" : "self";
      // A self-message borrows a neighbouring column so its label has room; --off puts the loop on its own lifeline.
      let off = "";
      if (dir === "self" && n > 1) {
        if (a < n) {
          hi = a + 1;
          off = "0.25";
        } else {
          lo = a - 1;
          off = "0.75";
        }
        k = 2;
      }
      const row = parent().createDiv({
        cls: classes(
          `mw-row mw-step mw-msg mw-dir-${dir}${it.dashed ? " mw-dashed" : ""}`,
        ),
        attr: { "data-step": it.step, "data-item": ii },
      });
      const sp = spanEl(row, lo, hi, k);
      if (off) sp.style.setProperty("--off", off);
      appendStepLabel(sp.createDiv("mw-label"), it);
      appendTip(sp.createDiv("mw-wire"), it.head);
    } else {
      const { lo, hi, k } = span(it.ids);
      const row = parent().createDiv({
        cls: ["mw-row", "mw-step", "mw-note"],
        attr: { "data-step": it.step, "data-item": ii },
      });
      appendStepLabel(spanEl(row, lo, hi, k).createDiv("mw-notecard"), it);
    }
  });
  // Room for even the last step to scroll up under the header. It is a spacer inside the content,
  // not padding, because the sticky header only stays pinned within its parent's content box.
  el.createDiv("mw-tail");
}

// The cell a step's label sits in, stretched across the columns it joins.
function spanEl(row, lo, hi, k) {
  const sp = row.createDiv("mw-span");
  sp.style.gridColumn = `${lo}/${hi + 1}`;
  sp.style.setProperty("--k", String(k));
  return sp;
}

function appendStepLabel(el, it) {
  el.createSpan({ cls: "mw-num", text: String(it.step + 1) });
  el.createSpan({ text: it.text });
}

// ---- Map: boxes and participant cards you arrange yourself, with elbow arrows between them ----

const NODE_W = 170,
  NODE_H = 50,
  GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;
const boxKey = (b, bi) => b.label || `box-${bi}`;

// Boxes side by side, each with its participants in a grid. Used for anything not yet arranged.
function defaultLayout(model) {
  const L = { boxes: {}, nodes: {} };
  const top = 60;
  let x = 40,
    bottom = top;
  model.boxes.forEach((b, bi) => {
    if (!b.members.length) return;
    const cols = b.members.length > 2 ? 2 : 1,
      rows = Math.ceil(b.members.length / cols);
    const w = cols * NODE_W + (cols - 1) * 50 + 80,
      h = rows * NODE_H + (rows - 1) * 60 + 80;
    L.boxes[boxKey(b, bi)] = { x, y: top, w, h };
    b.members.forEach((id, k) => {
      L.nodes[id] = {
        x: x + 40 + (k % cols) * (NODE_W + 50),
        y: top + 40 + Math.floor(k / cols) * (NODE_H + 60),
      };
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
    if (def.boxes[k])
      L.boxes[k] = {
        ...def.boxes[k],
        ...((saved && saved.boxes && saved.boxes[k]) || {}),
      };
  });
  model.participants.forEach((p) => {
    L.nodes[p.id] = {
      ...def.nodes[p.id],
      ...((saved && saved.nodes && saved.nodes[p.id]) || {}),
    };
  });
  return L;
}

function renderMap(model, L, el) {
  const canvas = el.createDiv("mw-mapwrap").createDiv("mw-canvas");
  canvas.style.setProperty("--mw-node-w", NODE_W + "px");
  canvas.style.setProperty("--mw-node-h", NODE_H + "px");
  model.boxes.forEach((b, bi) => {
    const r = L.boxes[boxKey(b, bi)];
    if (!r) return;
    const box = canvas.createDiv({
      cls: ["mw-mbox", toneFor(b.color, bi)],
      attr: { "data-box": bi },
    });
    Object.assign(box.style, {
      left: r.x + "px",
      top: r.y + "px",
      width: r.w + "px",
      height: r.h + "px",
    });
    box.createDiv({ cls: "mw-mbox-label", text: b.label });
    box.createDiv({ cls: "mw-mhandle", attr: { title: "Drag to resize" } });
  });
  canvas.createSvg("svg", {
    attr: { class: "mw-medges", "aria-hidden": "true" },
  });
  model.participants.forEach((p, i) => {
    const r = L.nodes[p.id];
    const node = canvas.createDiv({
      cls: ["mw-participant", "mw-mnode"],
      attr: { "data-i": i },
      text: p.label,
    });
    Object.assign(node.style, { left: r.x + "px", top: r.y + "px" });
  });
  canvas.createDiv("mw-mcard").hidden = true;
}

// An elbow route from one card to another: out of the facing sides, across, and in.
// `off` shifts a two-way pair apart so both arrows stay visible.
function route(A, B, off) {
  const hgap = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w));
  const vgap = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
  const ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 },
    bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
  let pts;
  if (hgap >= vgap && hgap > 0) {
    const right = bc.x > ac.x;
    const sx = right ? A.x + A.w : A.x,
      ex = right ? B.x : B.x + B.w;
    const sy = ac.y + off,
      ey = bc.y + off,
      mx = snap((sx + ex) / 2) + off;
    pts = [
      [sx, sy],
      [mx, sy],
      [mx, ey],
      [ex, ey],
    ];
  } else if (vgap > 0) {
    const down = bc.y > ac.y;
    const sy = down ? A.y + A.h : A.y,
      ey = down ? B.y : B.y + B.h;
    const sx = ac.x + off,
      ex = bc.x + off,
      my = snap((sy + ey) / 2) + off;
    pts = [
      [sx, sy],
      [sx, my],
      [ex, my],
      [ex, ey],
    ];
  } else {
    pts = [
      [ac.x, ac.y],
      [bc.x, bc.y],
    ]; // overlapping cards: a straight line is the best we can do
  }
  const a = pts[Math.floor((pts.length - 1) / 2)],
    b = pts[Math.floor((pts.length - 1) / 2) + 1];
  return {
    d: "M " + pts.map((pt) => pt.join(" ")).join(" L "),
    mid: {
      x: (a[0] + b[0]) / 2,
      y: (a[1] + b[1]) / 2,
      horizontal: a[1] === b[1],
    },
  };
}

// ---- The walkthrough: toolbar, tabs and stage, shown in the side pane or inline in a note ----

class Walkthrough extends Component {
  // opts.inline: one diagram in a note, with a close button; opts.title names it there.
  // opts.onTitle runs when the title changes; opts.onClose when the close button is pressed.
  constructor(plugin, root, opts = {}) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
    this.root = root;
    this.opts = opts;
    this.file = null;
    this.diagrams = [];
    this.active = 0;
    this.cur = -1;
    this.model = null;
    this.memory = new Map(); // file path -> { active, curs } so each note keeps its place
    this.mode = plugin.settings.mode === "map" ? "map" : "sequence";
    this.zoom = null; // map zoom; null means fit to the pane on first show
    this.uid = Math.random().toString(36).slice(2, 8); // keeps SVG marker ids unique per pane
    this.reloadSoon = debounce(() => this.reload(true), 250, true);
    this.saveViewSoon = debounce(() => this.saveView(), 400, true);
    this.build();
  }

  build() {
    const root = this.root;
    root.empty();
    root.addClass("mw-root");
    root.setAttr("tabindex", "0");
    const button = (parent, cls, attr, text) =>
      parent.createEl("button", { cls: ["mw-btn", ...cls], attr, text });

    const bar = root.createDiv("mw-bar");
    const brand = bar.createDiv("mw-brand");
    const controls = bar.createDiv("mw-controls");
    this.els = {
      title: brand.createDiv("mw-title"),
      readout: brand.createDiv({
        cls: "mw-readout",
        attr: { "aria-live": "polite" },
      }),
      warn: brand.createSpan("mw-warn"),
      prev: button(controls, ["mw-icon"], {
        "aria-label": "Previous step (←)",
      }),
      counter: controls.createSpan({ cls: "mw-counter", text: "– / 0" }),
      next: button(controls, ["mw-icon", "mw-primary"], {
        "aria-label": "Next step (→)",
      }),
      overview: button(
        controls,
        [],
        { "aria-pressed": "false", "aria-label": "Show all (Esc)" },
        "Show all",
      ),
    };
    const seg = controls.createDiv({
      cls: "mw-seg",
      attr: { role: "group", "aria-label": "Switch layout (M)" },
    });
    this.els.modes = [
      ["sequence", "Sequence"],
      ["map", "Map"],
    ].map(([mode, text]) => button(seg, [], { "data-mode": mode }, text));
    if (this.opts.inline) {
      const close = button(controls, ["mw-icon"], {
        "aria-label": "Close walkthrough",
      });
      setIcon(close, "x");
      this.registerDomEvent(
        close,
        "click",
        () => this.opts.onClose && this.opts.onClose(),
      );
    }
    this.els.tabs = root.createEl("nav", {
      cls: "mw-tabs",
      attr: { role: "tablist", "aria-label": "Diagrams" },
    });

    this.els.mapbar = root.createDiv("mw-mapbar");
    const tools = this.els.mapbar.createSpan("mw-mapbar-tools");
    const zoomOut = button(tools, ["mw-icon"], {
      "data-zoom": "out",
      "aria-label": "Zoom out",
    });
    this.els.zoomLabel = tools.createSpan({
      cls: "mw-zoom",
      text: "100%",
      attr: {
        "aria-label": "Pinch or Ctrl/⌘-scroll to zoom, drag empty space to pan",
      },
    });
    const zoomIn = button(tools, ["mw-icon"], {
      "data-zoom": "in",
      "aria-label": "Zoom in",
    });
    const fit = button(tools, [], { "data-zoom": "fit" }, "Fit");
    const reset = button(
      tools,
      [],
      { "aria-label": "Drag cards and boxes to arrange them" },
      "Reset layout",
    );

    this.els.stage = root.createDiv("mw-stage");
    this.els.diagram = this.els.stage.createDiv("mw-diagram");
    this.els.phase = root.createDiv({
      cls: "mw-phase",
      attr: { "aria-live": "polite" },
    });
    this.els.warn.hidden =
      this.els.tabs.hidden =
      this.els.mapbar.hidden =
      this.els.phase.hidden =
        true;

    setIcon(this.els.prev, "chevron-left");
    setIcon(this.els.next, "chevron-right");
    setIcon(zoomOut, "minus");
    setIcon(zoomIn, "plus");
    this.els.modes.forEach((b) =>
      this.registerDomEvent(b, "click", () => this.setMode(b.dataset.mode)),
    );
    [zoomOut, zoomIn, fit].forEach((b) =>
      this.registerDomEvent(b, "click", () => {
        const z = b.dataset.zoom;
        if (z === "fit") {
          this.setZoom(this.fitZoom());
          this.saveViewSoon();
          return;
        }
        const r = this.els.stage.getBoundingClientRect();
        this.zoomAt(
          (this.zoom || 1) * (z === "in" ? 1.2 : 1 / 1.2),
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
      }),
    );
    // Pinch on a trackpad arrives as a wheel event with ctrlKey set; Ctrl/⌘ + wheel zooms with a mouse.
    // A plain wheel or two-finger swipe keeps scrolling the canvas.
    this.registerDomEvent(
      this.els.stage,
      "wheel",
      (e) => {
        if (this.mode !== "map" || !this.model || !(e.ctrlKey || e.metaKey))
          return;
        e.preventDefault();
        // Pinches send many small deltas; a mouse notch sends one large one, so cap each step at about 25%.
        const delta = Math.max(
          -25,
          Math.min(25, e.deltaMode === 1 ? e.deltaY * 5 : e.deltaY),
        );
        this.zoomAt(this.zoom * Math.exp(-delta * 0.009), e.clientX, e.clientY);
      },
      { passive: false },
    );
    this.registerDomEvent(this.els.stage, "scroll", () => {
      if (this.mode === "map" && this.model) this.saveViewSoon();
    });
    this.registerDomEvent(reset, "click", () => this.resetLayout());
    this.registerDomEvent(this.els.diagram, "pointerdown", (e) =>
      this.dragStart(e),
    );
    this.registerDomEvent(this.els.diagram, "pointermove", (e) =>
      this.dragMove(e),
    );
    this.registerDomEvent(this.els.diagram, "pointerup", (e) =>
      this.dragEnd(e),
    );
    this.registerDomEvent(this.els.diagram, "pointercancel", (e) =>
      this.dragEnd(e),
    );
    this.syncModeButtons();

    this.registerDomEvent(this.els.prev, "click", () => this.go(this.cur - 1));
    this.registerDomEvent(this.els.next, "click", () =>
      this.go(this.cur < 0 ? 0 : this.cur + 1),
    );
    this.registerDomEvent(this.els.overview, "click", () => {
      if (this.cur >= 0) this.overview();
      else this.go(0);
    });
    this.registerDomEvent(this.els.diagram, "click", (e) => {
      const row = e.target.closest("[data-step]");
      if (row) this.go(+row.dataset.step, "nearest");
    });
    this.registerDomEvent(this.els.tabs, "click", (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) this.switchTo(+tab.dataset.tab);
    });
    this.registerDomEvent(root, "keydown", (e) => this.onKey(e));
  }

  onResize() {
    if (!this.model) return;
    if (this.mode === "map") this.sizeCanvas();
    this.apply(false);
  }

  syncModeButtons() {
    this.els.modes.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === this.mode)),
    );
    this.els.mapbar.hidden = this.mode !== "map" || !this.model;
    if (this.els.mapbar.hidden) this.els.phase.hidden = true;
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
    this.els.title.textContent =
      this.opts.title ||
      (this.file ? this.file.basename : "Mermaid Walkthrough");
    if (this.opts.onTitle) this.opts.onTitle();
  }

  saveMemory() {
    if (!this.file || !this.diagrams.length) return;
    this.diagrams[this.active].cur = this.cur;
    this.memory.set(this.file.path, {
      active: this.active,
      curs: this.diagrams.map((d) => d.cur),
    });
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
    this.setDiagrams(splitDiagrams(text), keepScroll);
  }

  // `list` is [{ name, src }]. File-less or not, the tabs, memory and warnings work the same.
  setDiagrams(list, keepScroll) {
    const file = this.file;
    const mem = file && this.memory.get(file.path);
    this.diagrams = list.map((d, i) => {
      const model = parse(d.src);
      const total = model.steps.length;
      const saved = mem ? mem.curs[i] : undefined;
      return {
        name: d.name,
        model,
        cur: saved != null ? Math.min(saved, total - 1) : total ? 0 : -1,
      };
    });
    if (!this.diagrams.length) {
      this.showEmpty(
        file
          ? `No Mermaid sequence diagrams in “${file.basename}”.`
          : "No Mermaid sequence diagram here.",
      );
      return;
    }
    this.active = mem && mem.active < this.diagrams.length ? mem.active : 0;
    this.renderTabs();
    this.show(this.active, keepScroll);

    const skipped = this.diagrams.flatMap((d) =>
      d.model.skipped.map(
        (s) => (this.diagrams.length > 1 ? `${d.name}, ` : "") + s,
      ),
    );
    this.els.warn.hidden = !skipped.length;
    this.els.warn.textContent = skipped.length
      ? `${skipped.length} line${skipped.length > 1 ? "s" : ""} not shown`
      : "";
    this.els.warn.title = skipped.length
      ? "Unsupported syntax:\n" + skipped.join("\n")
      : "";
  }

  showEmpty(message) {
    this.diagrams = [];
    this.model = null;
    this.cur = -1;
    this.els.tabs.hidden = true;
    this.els.warn.hidden = true;
    this.els.diagram.style.setProperty("--n", 1);
    this.els.diagram.empty();
    this.els.diagram.createDiv({ cls: "mw-empty", text: message });
    this.els.readout.textContent = "";
    this.els.phase.hidden = true;
    this.els.counter.textContent = "– / 0";
    this.els.prev.disabled =
      this.els.next.disabled =
      this.els.overview.disabled =
        true;
  }

  renderTabs() {
    const tabs = this.els.tabs;
    tabs.hidden = this.diagrams.length < 2;
    tabs.empty();
    this.diagrams.forEach((d, i) => {
      const attr = {
        role: "tab",
        "data-tab": i,
        "aria-selected": String(i === this.active),
      };
      if (i < 9) attr["aria-label"] = `${d.name} (${i + 1})`;
      const tab = tabs.createEl("button", {
        cls: "mw-tab",
        attr,
        text: d.name,
      });
      tab.createSpan({ cls: "mw-count", text: String(d.model.steps.length) });
    });
  }

  show(i, keepScroll) {
    const stage = this.els.stage;
    const top = stage.scrollTop;
    this.active = i;
    this.model = this.diagrams[i].model;
    this.cur = this.diagrams[i].cur;
    this.els.overview.disabled = false;
    this.els.diagram.empty();
    if (!this.model.participants.length) {
      this.els.diagram.createDiv({
        cls: "mw-empty",
        text: "This diagram has no participants yet.",
      });
    } else {
      this.els.diagram.style.setProperty(
        "--n",
        String(this.model.participants.length),
      );
      this.els.diagram.classList.toggle("mw-map-mode", this.mode === "map");
      if (this.mode === "map") this.renderMapView(keepScroll);
      else renderDiagram(this.model, this.els.diagram);
    }
    this.syncModeButtons();
    this.els.tabs
      .querySelectorAll("[data-tab]")
      .forEach((t) =>
        t.setAttribute("aria-selected", String(+t.dataset.tab === i)),
      );
    if (this.mode === "map") this.apply(false);
    else if (keepScroll) {
      stage.scrollTop = top;
      this.apply(false);
    } else {
      stage.scrollTop = 0;
      this.apply(this.cur > 0 ? "center" : false);
    }
  }

  switchTo(i) {
    if (i === this.active || !this.diagrams[i]) return;
    this.diagrams[this.active].cur = this.cur;
    this.show(i, false);
    this.saveMemory();
  }

  go(i, scroll = "center") {
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
    if (
      e.target.closest("input, textarea") ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      !this.model
    )
      return;
    // Inline, every key stays with the walkthrough rather than reaching the editor around it.
    if (this.opts.inline) e.stopPropagation();
    const total = this.model.steps.length;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "j":
        e.preventDefault();
        this.go(this.cur < 0 ? 0 : this.cur + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "k":
        e.preventDefault();
        this.go(this.cur < 0 ? 0 : this.cur - 1);
        break;
      case "Home":
        e.preventDefault();
        this.go(0);
        break;
      case "End":
        e.preventDefault();
        this.go(total - 1);
        break;
      case "Escape":
        e.preventDefault();
        this.overview();
        break;
      case "m":
      case "M":
        e.preventDefault();
        this.setMode(this.mode === "map" ? "sequence" : "map");
        break;
      default:
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          this.switchTo(+e.key - 1);
        }
    }
  }

  participantName(id) {
    return this.model.participants[this.model.idx.get(id)].label;
  }

  apply(scroll) {
    const model = this.model;
    const dg = this.els.diagram;
    const steps = model.steps;
    const total = steps.length;
    const on = this.cur >= 0 && this.cur < total;
    dg.classList.toggle("mw-stepping", on);
    dg.querySelectorAll(
      ".mw-active, .mw-on, .mw-from, .mw-to, .mw-noteon, .mw-current",
    ).forEach((el) =>
      el.classList.remove(
        "mw-active",
        "mw-on",
        "mw-from",
        "mw-to",
        "mw-noteon",
        "mw-current",
      ),
    );

    if (this.mode === "map") {
      this.applyMap();
      this.applyReadout();
      return;
    }

    const head = dg.querySelector(".mw-head");
    dg.style.setProperty(
      "--head-h",
      head ? head.offsetHeight + 16 + "px" : "0px",
    );
    // Pin phase headings a pixel under the header's bottom edge, rounding down, so no sliver of the
    // steps scrolling past shows between them at fractional heights or zoom levels.
    dg.style.setProperty(
      "--head-top",
      head
        ? Math.max(0, Math.floor(head.getBoundingClientRect().height) - 1) +
            "px"
        : "0px",
    );
    this.stackHeadings();

    const hl = dg.querySelector(".mw-hl");
    if (on) {
      const st = steps[this.cur];
      const row = dg.querySelector(`[data-step="${this.cur}"]`);
      row.classList.add("mw-active");
      const ids = st.type === "msg" ? [st.from, st.to] : st.ids;
      const onIdx = new Set(ids.map((id) => model.idx.get(id)));
      const actor = (i) => dg.querySelector(`.mw-actor[data-i="${i}"]`);
      onIdx.forEach((i) => {
        actor(i).classList.add("mw-on");
        dg.querySelector(`.mw-ll[data-i="${i}"]`).classList.add("mw-on");
      });
      if (st.type === "msg") {
        actor(model.idx.get(st.from)).classList.add("mw-from");
        actor(model.idx.get(st.to)).classList.add("mw-to");
      } else {
        onIdx.forEach((i) => actor(i).classList.add("mw-noteon"));
      }
      model.boxes.forEach((b, bi) => {
        if (b.members.some((id) => onIdx.has(model.idx.get(id)))) {
          dg.querySelectorAll(`[data-box="${bi}"]`).forEach((el) =>
            el.classList.add("mw-on"),
          );
        }
      });
      if (st.section != null) {
        const secRow = dg.querySelector(`[data-item="${st.section}"]`);
        if (secRow) secRow.classList.add("mw-current");
      }
      if (hl) {
        hl.hidden = false;
        hl.style.transform = `translateY(${row.offsetTop}px)`;
        hl.style.height = row.offsetHeight + "px";
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
    this.els.diagram
      .querySelectorAll(".mw-scope > .mw-row:first-child")
      .forEach((row) => {
        let offset = 0;
        for (
          let s = row.parentElement.parentElement.closest(".mw-scope");
          s;
          s = s.parentElement.closest(".mw-scope")
        ) {
          offset +=
            Math.floor(s.firstElementChild.getBoundingClientRect().height) - 1;
        }
        row.dataset.stack = offset;
        row.style.top = `calc(var(--head-top, 0px) + ${offset}px)`;
      });
  }

  // Puts the current step right under the pinned participant header (and its pinned phase heading),
  // so the participants it involves sit as close to it as possible.
  scrollStepToTop(row, st) {
    const stage = this.els.stage;
    const dg = this.els.diagram;
    const head = dg.querySelector(".mw-head");
    const sec =
      st.section != null
        ? dg.querySelector(`[data-item="${st.section}"]`)
        : null;
    const pinned =
      (head ? head.offsetHeight : 0) +
      (sec ? +sec.dataset.stack + sec.offsetHeight : 0) +
      4;
    const top =
      stage.scrollTop +
      row.getBoundingClientRect().top -
      stage.getBoundingClientRect().top -
      pinned;
    stage.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  // Toolbar readout, counter and buttons, shared by both layouts.
  applyReadout() {
    const model = this.model;
    const total = model.steps.length;
    const on = this.cur >= 0 && this.cur < total;
    // While stepping, the phase and the step already show on the diagram, so the toolbar keeps to the counter.
    this.els.readout.empty();
    if (!on)
      this.els.readout.createSpan({
        cls: "mw-what",
        text: `${total} steps · ${model.participants.length} participants`,
      });

    this.els.counter.textContent = on
      ? `${this.cur + 1} / ${total}`
      : `– / ${total}`;
    this.els.prev.disabled = !total || this.cur <= 0;
    this.els.next.disabled = !total || this.cur >= total - 1;
    this.els.overview.setAttribute("aria-pressed", String(!on));
  }

  // ---- Map layout ----

  layoutKey() {
    return `${this.file ? this.file.path : ""}::${this.diagrams[this.active].name}`;
  }

  // keepView holds the current zoom and scroll (a re-render after an edit); otherwise the diagram
  // opens where it was last left, or fitted to the pane the first time.
  renderMapView(keepView) {
    const stage = this.els.stage;
    const left = stage.scrollLeft,
      top = stage.scrollTop;
    const view = keepView ? null : this.plugin.settings.views[this.layoutKey()];
    if (!keepView) this.zoom = view ? view.zoom : null;
    this.layout = mergeLayout(
      this.model,
      this.plugin.settings.layouts[this.layoutKey()],
    );
    renderMap(this.model, this.layout, this.els.diagram);
    this.mapPairs = new Map();
    this.model.steps.forEach((st) => {
      if (st.type !== "msg") return;
      const a = this.model.idx.get(st.from),
        b = this.model.idx.get(st.to);
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
    if (this.mode !== "map" || !this.model) return;
    const stage = this.els.stage;
    const view = {
      zoom: Math.round(this.zoom * 1000) / 1000,
      x: Math.round(stage.scrollLeft),
      y: Math.round(stage.scrollTop),
    };
    const views = this.plugin.settings.views,
      key = this.layoutKey(),
      old = views[key];
    if (old && old.zoom === view.zoom && old.x === view.x && old.y === view.y)
      return;
    views[key] = view;
    this.plugin.saveSettings();
  }

  nodeRect(i) {
    const r = this.layout.nodes[this.model.participants[i].id];
    return { x: r.x, y: r.y, w: NODE_W, h: NODE_H };
  }

  // The right and bottom edges of everything placed on the map.
  contentExtent() {
    const rects = [
      ...Object.values(this.layout.boxes),
      ...Object.values(this.layout.nodes).map((n) => ({
        ...n,
        w: NODE_W,
        h: NODE_H,
      })),
    ];
    return {
      w: Math.max(...rects.map((r) => r.x + r.w)),
      h: Math.max(...rects.map((r) => r.y + r.h)),
    };
  }

  // The canvas fills the pane at the current zoom, with room to spare past the content. It only
  // grows while the map is open, so moving a box never makes it jump or shrink under the pointer.
  sizeCanvas() {
    const canvas = this.els.diagram.querySelector(".mw-canvas");
    const wrap = this.els.diagram.querySelector(".mw-mapwrap");
    if (!canvas || !wrap) return;
    const { w, h } = this.contentExtent();
    const stage = this.els.stage;
    this.canvasW = Math.max(
      this.canvasW || 0,
      w + 400,
      Math.ceil(stage.clientWidth / this.zoom),
    );
    this.canvasH = Math.max(
      this.canvasH || 0,
      h + 400,
      Math.ceil(stage.clientHeight / this.zoom),
    );
    canvas.style.width = this.canvasW + "px";
    canvas.style.height = this.canvasH + "px";
    canvas.style.transform = `scale(${this.zoom})`;
    wrap.style.width = this.canvasW * this.zoom + "px";
    wrap.style.height = this.canvasH * this.zoom + "px";
    const svg = this.els.diagram.querySelector(".mw-medges");
    if (svg) {
      svg.setAttribute("width", String(this.canvasW));
      svg.setAttribute("height", String(this.canvasH));
    }
  }

  fitZoom() {
    const { w, h } = this.contentExtent();
    const stage = this.els.stage;
    return Math.max(
      0.3,
      Math.min(
        1,
        (stage.clientWidth - 24) / (w + 40),
        (stage.clientHeight - 24) / (h + 40),
      ),
    );
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(2, z));
    this.sizeCanvas();
    this.els.zoomLabel.textContent = Math.round(this.zoom * 100) + "%";
  }

  drawMapEdges() {
    const svg = this.els.diagram.querySelector(".mw-medges");
    if (!svg) return;
    this.edgeMid = new Map();
    svg.empty();
    svg.setAttribute("width", String(this.canvasW));
    svg.setAttribute("height", String(this.canvasH));
    const defs = svg.createSvg("defs");
    const marker = (id, cls) =>
      defs
        .createSvg("marker", {
          attr: {
            id,
            viewBox: "0 0 10 10",
            refX: "9",
            refY: "5",
            markerUnits: "userSpaceOnUse",
            markerWidth: "9",
            markerHeight: "9",
            orient: "auto",
          },
        })
        .createSvg("path", { attr: { class: cls, d: "M0 0 L10 5 L0 10 Z" } });
    marker(`mw-tip-${this.uid}`, "mw-marker");
    marker(`mw-tip-on-${this.uid}`, "mw-marker-on");
    this.mapPairs.forEach((pair, key) => {
      const A = this.nodeRect(pair.a);
      let geo;
      if (pair.a === pair.b) {
        const x = A.x + A.w,
          y = A.y + A.h / 2;
        geo = {
          d: `M ${x} ${y - 12} L ${x + 26} ${y - 12} L ${x + 26} ${y + 12} L ${x} ${y + 12}`,
          mid: { x: x + 26, y, horizontal: false },
        };
      } else {
        const off = this.mapPairs.has(`${pair.b}>${pair.a}`)
          ? pair.a < pair.b
            ? -6
            : 6
          : 0;
        geo = route(A, this.nodeRect(pair.b), off);
      }
      this.edgeMid.set(key, geo.mid);
      svg.createSvg("path", {
        attr: {
          class: `mw-medge${pair.dashed ? " mw-dashed" : ""}`,
          "data-edge": key,
          d: geo.d,
          "marker-end": `url(#mw-tip-${this.uid})`,
        },
      });
    });
  }

  applyMap() {
    const dg = this.els.diagram;
    const model = this.model;
    const on = this.cur >= 0 && this.cur < model.steps.length;
    dg.classList.toggle("mw-mapping", on);
    // The phase name, then any alt/opt/loop it is in, the way the sequence headings show them.
    const st = on ? model.steps[this.cur] : null;
    const phase = this.els.phase;
    phase.empty();
    const sep = () => {
      if (phase.childElementCount)
        phase.createSpan({ cls: "mw-phase-sep", text: "›" });
    };
    if (st && st.phase != null)
      phase.createSpan({
        cls: "mw-phase-name",
        text: model.items[st.phase].text,
      });
    if (st)
      st.blocks.forEach((bi) => {
        sep();
        appendBlockName(
          phase.createSpan("mw-phase-block"),
          model.items[bi],
          " ",
        );
      });
    phase.hidden = !phase.childElementCount;
    const card = dg.querySelector(".mw-mcard");
    if (!card) return;
    if (!on) {
      card.hidden = true;
      return;
    }

    const ids = st.type === "msg" ? [st.from, st.to] : st.ids;
    ids.forEach((id) =>
      dg
        .querySelector(`.mw-mnode[data-i="${model.idx.get(id)}"]`)
        .classList.add("mw-on"),
    );
    if (st.type === "msg") {
      dg.querySelector(
        `.mw-mnode[data-i="${model.idx.get(st.from)}"]`,
      ).classList.add("mw-from");
      dg.querySelector(
        `.mw-mnode[data-i="${model.idx.get(st.to)}"]`,
      ).classList.add("mw-to");
    }
    model.boxes.forEach((b, bi) => {
      if (b.members.some((id) => ids.includes(id))) {
        const el = dg.querySelector(`.mw-mbox[data-box="${bi}"]`);
        if (el) el.classList.add("mw-on");
      }
    });

    let at = null;
    if (st.type === "msg") {
      const key = `${model.idx.get(st.from)}>${model.idx.get(st.to)}`;
      const edge = dg.querySelector(`.mw-medge[data-edge="${key}"]`);
      if (edge) {
        edge.classList.add("mw-active");
        edge.setAttribute("marker-end", `url(#mw-tip-on-${this.uid})`);
        edge.parentNode.appendChild(edge); // draw the active arrow above the others
      }
      at = this.edgeMid.get(key);
    } else {
      const rects = ids.map((id) => this.nodeRect(model.idx.get(id)));
      const left = Math.min(...rects.map((r) => r.x)),
        right = Math.max(...rects.map((r) => r.x + r.w));
      at = {
        x: (left + right) / 2,
        y: Math.min(...rects.map((r) => r.y)) - 30,
        horizontal: true,
      };
    }
    card.hidden = false;
    // The same numbered label the sequence uses, placed on the arrow.
    // Any alt/opt/loop the step sits in rides on top of its box as a tab, apart from the step's own text.
    card.empty();
    if (st.blocks.length) {
      const cond = card.createDiv("mw-cond");
      st.blocks.forEach((bi, k) => {
        if (k) cond.appendText(" › ");
        appendBlockName(cond, model.items[bi], " ");
      });
    }
    appendStepLabel(card.createDiv({ cls: ["mw-label", "mw-label-on"] }), st);
    this.placeCard(card, at);
  }

  // Puts the step card on the arrow's middle segment, or beside it when that covers fewer cards.
  placeCard(card, at) {
    const w = card.offsetWidth,
      h = card.offsetHeight;
    const nodes = this.model.participants.map((_, i) => this.nodeRect(i));
    const overlap = (c) =>
      nodes.reduce((sum, n) => {
        const x = Math.min(c.x + w / 2, n.x + n.w) - Math.max(c.x - w / 2, n.x);
        const y = Math.min(c.y + h / 2, n.y + n.h) - Math.max(c.y - h / 2, n.y);
        return sum + (x > 0 && y > 0 ? x * y : 0);
      }, 0);
    const shift = at.horizontal
      ? { x: 0, y: h / 2 + 10 }
      : { x: w / 2 + 12, y: 0 };
    const candidates = [
      { x: at.x - shift.x, y: at.y - shift.y },
      { x: at.x + shift.x, y: at.y + shift.y },
      at,
    ];
    let best = candidates[0],
      score = overlap(best);
    candidates.slice(1).forEach((c) => {
      const s = overlap(c);
      if (s < score - 1) {
        best = c;
        score = s;
      }
    });
    card.style.left = best.x - w / 2 + "px";
    card.style.top = best.y - h / 2 + "px";

    // Bring the card into view if stepping moved it off screen (but not mid-drag).
    if (this.drag) return;
    const stage = this.els.stage;
    const cx = best.x * this.zoom,
      cy = best.y * this.zoom;
    if (
      cx < stage.scrollLeft ||
      cx > stage.scrollLeft + stage.clientWidth ||
      cy < stage.scrollTop ||
      cy > stage.scrollTop + stage.clientHeight
    ) {
      stage.scrollTo({
        left: cx - stage.clientWidth / 2,
        top: cy - stage.clientHeight / 2,
        behavior: "smooth",
      });
    }
  }

  // Zooms to `z` while keeping the canvas point under the pointer where it is.
  zoomAt(z, clientX, clientY) {
    const stage = this.els.stage;
    const r = stage.getBoundingClientRect();
    const mx = clientX - r.left,
      my = clientY - r.top;
    const px = (stage.scrollLeft + mx) / this.zoom,
      py = (stage.scrollTop + my) / this.zoom;
    this.setZoom(z);
    stage.scrollLeft = px * this.zoom - mx;
    stage.scrollTop = py * this.zoom - my;
    this.saveViewSoon();
  }

  dragStart(e) {
    if (this.mode !== "map" || !this.model) return;
    if (e.button !== 0 && e.button !== 1) return;
    const handle = e.target.closest(".mw-mhandle");
    const node = e.target.closest(".mw-mnode");
    const box = e.target.closest(".mw-mbox");
    e.preventDefault();
    this.root.focus(); // keep arrow keys working after a drag
    // Empty space, or the middle button anywhere, pans the canvas.
    if (e.button === 1 || (!handle && !node && !box)) {
      const stage = this.els.stage;
      this.drag = {
        kind: "pan",
        x0: e.clientX,
        y0: e.clientY,
        left: stage.scrollLeft,
        top: stage.scrollTop,
        el: e.target,
      };
      e.target.setPointerCapture(e.pointerId);
      this.root.addClass("mw-panning");
      return;
    }
    const d = {
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      el: handle || node || box,
    };
    if (node) {
      d.kind = "node";
      d.id = this.model.participants[+node.dataset.i].id;
      d.start = { ...this.layout.nodes[d.id] };
    } else {
      const bi = +(box || handle.closest(".mw-mbox")).dataset.box;
      d.kind = handle ? "resize" : "box";
      d.box = box || handle.closest(".mw-mbox");
      d.key = boxKey(this.model.boxes[bi], bi);
      d.start = { ...this.layout.boxes[d.key] };
      // Moving a box carries its participants with it.
      d.members = this.model.boxes[bi].members.map((id) => ({
        id,
        ...this.layout.nodes[id],
      }));
    }
    d.el.setPointerCapture(e.pointerId);
    this.drag = d;
  }

  dragMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === "pan") {
      this.els.stage.scrollLeft = d.left - (e.clientX - d.x0);
      this.els.stage.scrollTop = d.top - (e.clientY - d.y0);
      return;
    }
    const dx = (e.clientX - d.x0) / this.zoom,
      dy = (e.clientY - d.y0) / this.zoom;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    const dg = this.els.diagram;
    if (d.kind === "node") {
      const n = { x: snap(d.start.x + dx), y: snap(d.start.y + dy) };
      this.layout.nodes[d.id] = n;
      Object.assign(d.el.style, { left: n.x + "px", top: n.y + "px" });
    } else if (d.kind === "resize") {
      const b = this.layout.boxes[d.key];
      b.w = Math.max(120, snap(d.start.w + dx));
      b.h = Math.max(80, snap(d.start.h + dy));
      Object.assign(d.box.style, { width: b.w + "px", height: b.h + "px" });
    } else {
      const mx = snap(d.start.x + dx) - d.start.x,
        my = snap(d.start.y + dy) - d.start.y;
      const b = this.layout.boxes[d.key];
      b.x = d.start.x + mx;
      b.y = d.start.y + my;
      Object.assign(d.box.style, { left: b.x + "px", top: b.y + "px" });
      d.members.forEach((m) => {
        const n = { x: m.x + mx, y: m.y + my };
        this.layout.nodes[m.id] = n;
        const el = dg.querySelector(
          `.mw-mnode[data-i="${this.model.idx.get(m.id)}"]`,
        );
        Object.assign(el.style, { left: n.x + "px", top: n.y + "px" });
      });
    }
    this.drawMapEdges();
    this.clearMarks();
    this.applyMap();
  }

  dragEnd() {
    const d = this.drag;
    this.drag = null;
    this.root.removeClass("mw-panning");
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
    this.els.diagram
      .querySelectorAll(
        ".mw-active, .mw-on, .mw-from, .mw-to, .mw-noteon, .mw-current",
      )
      .forEach((el) =>
        el.classList.remove(
          "mw-active",
          "mw-on",
          "mw-from",
          "mw-to",
          "mw-noteon",
          "mw-current",
        ),
      );
  }
}

// ---- The pane: a walkthrough that follows whichever note is open ----

class WalkthroughView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.wt = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.wt && this.wt.file
      ? `Steps: ${this.wt.file.basename}`
      : "Mermaid Walkthrough";
  }
  getIcon() {
    return "workflow";
  }

  async onOpen() {
    this.wt = this.addChild(
      new Walkthrough(this.plugin, this.contentEl, {
        onTitle: () => {
          if (this.leaf.updateHeader) this.leaf.updateHeader();
        },
      }),
    );
    const wt = this.wt;

    // Follow whichever note is open, and re-read it when it changes.
    const follow = (file) => {
      if (file && file.extension === "md") wt.setFile(file);
    };
    this.registerEvent(this.app.workspace.on("file-open", follow));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) follow(leaf.view.file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (wt.file && f.path === wt.file.path) wt.reloadSoon();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f) => {
        if (f === wt.file) wt.refreshTitle();
      }),
    );

    const start = this.plugin.lastFile;
    if (start) await wt.setFile(start);
    else
      wt.showEmpty(
        "Open a note with Mermaid sequence diagrams to step through them.",
      );
  }

  onResize() {
    if (this.wt) this.wt.onResize();
  }
}

// ---- Inline: a "View walkthrough" button on a rendered sequence diagram, opening the walkthrough in its place ----

// The sequence diagram whose fence covers `line` (0-based) of `text`, named the way its pane tab is.
function diagramAt(text, line) {
  return (
    splitDiagrams(text).find((d) => d.start <= line && line <= d.end) || null
  );
}

class InlineWalkthrough extends Component {
  // `host` holds Obsidian's rendered diagram; `locate` returns { diagram, file } for it, or null.
  constructor(plugin, host, locate) {
    super();
    this.plugin = plugin;
    this.host = host;
    this.locate = locate;
    this.wt = null;
  }

  onload() {
    this.host.addClass("mw-host");
    this.btn = createEl("button", {
      cls: "mw-step-btn",
      attr: { "aria-label": "View walkthrough for this diagram" },
    });
    setIcon(this.btn.createSpan("mw-step-icon"), "workflow");
    this.btn.createSpan({ text: "View walkthrough" });
    // Clicks here shouldn't reach the editor, which would move the cursor into the block's source.
    this.registerDomEvent(this.btn, "mousedown", (e) => e.stopPropagation());
    this.registerDomEvent(this.btn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.open();
    });
    this.ensure();
    this.plugin.inlines.add(this);
    if (this.plugin.settings.inline) this.open(false);
  }

  // Obsidian may re-render the block's contents after we attach, so put our parts back if they went missing.
  ensure() {
    if (this.btn.parentElement !== this.host) this.host.appendChild(this.btn);
    if (this.wrap && this.wrap.parentElement !== this.host)
      this.host.appendChild(this.wrap);
  }

  // `focus` is false when the setting opens it as the note renders, so it doesn't take the cursor.
  open(focus = true) {
    const found = this.locate();
    if (!found) return;
    this.close();
    const wrap = (this.wrap = this.host.createDiv("mw-inline"));
    this.host.addClass("mw-inline-open");
    const wt = (this.wt = this.addChild(
      new Walkthrough(this.plugin, wrap, {
        inline: true,
        title: found.diagram.name,
        onClose: () => this.close(),
      }),
    ));
    wt.registerDomEvent(wrap, "mousedown", (e) => e.stopPropagation());
    wt.file = found.file || null;
    wt.refreshTitle();
    wt.setDiagrams([found.diagram], false);
    const ro = new ResizeObserver(() => wt.onResize());
    ro.observe(wrap);
    wt.register(() => ro.disconnect());
    if (focus) wrap.focus({ preventScroll: true });
  }

  close() {
    if (!this.wt) return;
    this.removeChild(this.wt);
    this.wt = null;
    this.wrap.remove();
    this.wrap = null;
    this.host.removeClass("mw-inline-open");
  }

  onunload() {
    this.plugin.inlines.delete(this);
    this.close();
    this.btn.remove();
    this.host.removeClass("mw-host");
  }
}

// Live Preview draws Mermaid itself, without running markdown post-processors, so each editor
// watches its own DOM for rendered mermaid blocks instead.
function livePreviewButtons(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.inlines = new Map(); // host element -> InlineWalkthrough
        this.observer = new MutationObserver(() => this.scan());
        this.observer.observe(view.contentDOM, {
          childList: true,
          subtree: true,
        });
        this.scan();
      }

      scan() {
        this.inlines.forEach((inline, host) => {
          if (host.isConnected) {
            inline.ensure();
            return;
          }
          inline.unload();
          this.inlines.delete(host);
        });
        this.view.contentDOM
          .querySelectorAll(".cm-preview-code-block.cm-lang-mermaid")
          .forEach((host) => {
            if (this.inlines.has(host) || !this.locate(host)) return;
            const inline = new InlineWalkthrough(plugin, host, () =>
              this.locate(host),
            );
            this.inlines.set(host, inline);
            inline.load();
          });
      }

      locate(host) {
        const doc = this.view.state.doc;
        let line;
        try {
          line = doc.lineAt(this.view.posAtDOM(host)).number - 1;
        } catch (e) {
          return null;
        }
        const diagram = diagramAt(doc.toString(), line);
        if (!diagram) return null;
        const info = this.view.state.field(editorInfoField, false);
        return { diagram, file: info && info.file };
      }

      destroy() {
        this.observer.disconnect();
        this.inlines.forEach((inline) => inline.unload());
        this.inlines.clear();
      }
    },
  );
}

// ---- Settings ----

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Render sequence diagram walkthrough inline")
      .setDesc(
        "Show the walkthrough in place of each Mermaid sequence diagram in your notes. When off, hover a diagram and click View walkthrough to open it.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.inline)
          .onChange((v) => this.plugin.setInline(v)),
      );
  }
}

// ---- Plugin ----

module.exports = class MermaidWalkthroughPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(
      { mode: "sequence", inline: false, layouts: {}, views: {} },
      await this.loadData(),
    );
    this.inlines = new Set(); // every rendered sequence diagram with a View walkthrough button
    this.addSettingTab(new SettingsTab(this.app, this));
    this.lastFile = this.app.workspace.getActiveFile();
    this.registerView(VIEW_TYPE, (leaf) => new WalkthroughView(leaf, this));

    this.addRibbonIcon("workflow", "Open Mermaid Walkthrough", () =>
      this.activate(),
    );
    this.addCommand({
      id: "open",
      name: "Open for current note",
      callback: () => this.activate(),
    });
    this.addCommand({
      id: "toggle-inline",
      name: "Toggle inline walkthroughs",
      callback: () => this.setInline(!this.settings.inline),
    });
    this.addCommand({
      id: "next-step",
      name: "Next step",
      checkCallback: (checking) =>
        this.withView(checking, (v) => v.go(v.cur < 0 ? 0 : v.cur + 1)),
    });
    this.addCommand({
      id: "previous-step",
      name: "Previous step",
      checkCallback: (checking) =>
        this.withView(checking, (v) => v.go(v.cur - 1)),
    });

    this.registerEvent(
      this.app.workspace.on("file-open", (f) => {
        if (f && f.extension === "md") this.lastFile = f;
      }),
    );

    // Reading view: the block is still a <pre> here; Obsidian swaps it for the rendered diagram
    // inside the same parent, which is where the button goes.
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll("pre > code.language-mermaid").forEach((code) => {
        const host = code.parentElement.parentElement;
        const src = code.textContent || "";
        if (!host || !/^\s*sequenceDiagram\b/m.test(src)) return;
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        ctx.addChild(
          new InlineWalkthrough(this, host, () => {
            const info = ctx.getSectionInfo(host);
            const diagram = (info && diagramAt(info.text, info.lineStart)) || {
              name: "Diagram",
              src,
            };
            return { diagram, file };
          }),
        );
      });
    });
    this.registerEditorExtension(livePreviewButtons(this));
  }

  saveSettings() {
    return this.saveData(this.settings);
  }

  // Opens or closes the walkthrough on every sequence diagram already on screen.
  setInline(on) {
    this.settings.inline = on;
    this.saveSettings();
    this.inlines.forEach((inline) => {
      if (on) {
        if (!inline.wt) inline.open(false);
      } else inline.close();
    });
  }

  withView(checking, fn) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf && leaf.view;
    if (!(view instanceof WalkthroughView) || !view.wt || !view.wt.model)
      return false;
    if (!checking) fn(view.wt);
    return true;
  }

  async activate() {
    const file = this.app.workspace.getActiveFile() || this.lastFile;
    if (file) this.lastFile = file;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    // Since Obsidian 1.7.2 a restored leaf may still be deferred; revealing it loads the real view.
    await this.app.workspace.revealLeaf(leaf);
    if (file && leaf.view instanceof WalkthroughView)
      await leaf.view.wt.setFile(file);
    leaf.view.contentEl.focus();
  }
};

module.exports.parse = parse;
module.exports.splitDiagrams = splitDiagrams;
module.exports.renderDiagram = renderDiagram;
module.exports.renderMap = renderMap;
module.exports.defaultLayout = defaultLayout;
module.exports.route = route;
