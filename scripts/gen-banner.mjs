#!/usr/bin/env node
// Animated ASCII banner for the GitHub profile README, baked into a
// self-contained SVG. Offline port of catc_hub's canvas AsciiField: travelling
// sine waves pushed through a glyph ramp, precomputed into a CSS frame-flip
// loop because README images allow no JS.
//
// Usage: node scripts/gen-banner.mjs [out.svg]   (default: ../banner.svg)
//
// Design notes, so the next edit doesn't relearn them:
//  - No background. GitHub's <picture>/prefers-color-scheme follows the OS,
//    not the GitHub theme setting, so a per-theme canvas is unreliable; a
//    transparent banner blends with every theme (incl. dark dimmed) instead.
//    The palette is therefore theme-neutral: accent hue only, glyph weight
//    plus alpha carry the gradient, no lift towards white.
//  - The font is embedded (JetBrains Mono subset, ~2 KB): identical rendering
//    everywhere and an exact column pitch, so no overscan columns. Layout
//    tables are stripped from the subset so the field's `//` `||` `??` runs
//    can never ligate. Recipe (fonttools, official OFL TTF from
//    github.com/JetBrains/JetBrainsMono):
//      pyftsubset JetBrainsMono-Regular.ttf --text=':.!/\|1?7*25%0&#8@ ═║╔╗╚╝▄█' \
//        --flavor=woff2 --no-hinting --layout-features='' --output-file=scripts/field.woff2
//  - Taglines are set in figlet "ANSI Shadow" (caps only; scripts/ansi-shadow.flf),
//    two-tone: solid blocks in the accent, the ═╝ shadow dimmer. Each line
//    decodes left to right behind a torn front: every figlet row has its own
//    clip windows, stepping in whole columns along a shared uneven pace plus
//    a bounded per-row wander. A band of cycling ramp glyphs (LEAD columns)
//    runs ahead of the settled text, so the scramble itself sweeps in rather
//    than standing there as a placeholder. Settled text, scramble band and
//    knockout all ride the same per-row keyframes; only their clip rects
//    differ. Firefox ignores CSS transforms on a clipPath's children, so the
//    clipped group moves and an inner group counter-moves the glyphs.
//  - Knockout: a mask clears the field around the letters (CUT px of stroke
//    dilation), which keeps the tagline legible on any page colour and over
//    the field's hot zones. It opens with the scramble front — opened up
//    front, the letter-shaped hole would give the line away before it decodes.
//  - Budget: keep banner.svg under 1 MiB raw. Raw ∝ frames × rows × columns;
//    gzip barely grows with frames. The cost visitors actually pay is DOM
//    (~8.5k text nodes) and repaint rate, so keep FPS × DUR modest.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , argOut] = process.argv;

// ---- knobs -----------------------------------------------------------------
const W = 880; // viewBox size; README scales it down responsively
const H = 240;
const ACCENT = "#E62D42";
const TAGLINES = [
  "hack them all",
  "let it exist",
  "make it work",
  "beyond the edge",
  "counting stars",
]; // rotation order; [] for a pure field
const FLF = join(HERE, "ansi-shadow.flf");
const FONT_FILE = join(HERE, "field.woff2");
const TAG_FILL = 0.92; // the widest tagline spans at most this fraction of W...
const TAG_MAX_H = 0.34; // ...and the letters at most this fraction of H — short
// lines would otherwise grow until the knockout swallows the field
const TAG_LH = 1.2; // tagline row pitch, em; █ spans -0.3..1.02em so ≤1.32 stays seamless
const SHADOW_A = 0.5; // alpha of the ═║╔╗╚╝ shadow strokes vs solid █ blocks
const NOISE_A = 0.65; // alpha of not-yet-decoded glyphs
const CUT = 6; // stroke px the field is cleared around the letters; 0 = off
const DECODE_T = 2.2; // seconds a line spends decoding
const HOLD_T = 5.8; // seconds a settled line holds before the next one starts
const TFPS = 20; // decode step rate; reads as noise below ~15
const NOISE_FRAMES = 6; // distinct scramble frames cycled during decode
const LEAD = 16; // tagline columns of scramble running ahead of the settled text
const LEAD_VAR = 0.35; // per-row spread of LEAD, as a fraction of it
const RAG = 3; // columns a row's front may stray either side of the mean front
const RAG_TICKS = 3; // decode ticks between a row's wander knots; lower = twitchier
const BURST = 0.85; // pace jitter of the mean front: 0 = even, 1 = from a stall to a double step
const FONT = 14; // field glyph font-size, px
const PX = FONT * 0.6; // column pitch = JetBrains Mono advance
const PY = 16; // row pitch
const FPS = 10; // flipbook rate; steps the field about half a column per flip,
// the finest motion the character grid can express
const DUR = 20; // loop seconds — wave speeds are integer cycles per DUR, so the seam is exact
const STILL_T = 7; // prefers-reduced-motion shows this moment
const ALPHA = { lo: 0.3, hi: 0.95 }; // field alpha across the ramp
// Liquid-gradient field: a few plane waves, each under one period across the
// banner and pointed in different directions, interfere into one or two giant
// soft lobes. fx/fy are cycles per banner WIDTH on both axes (pixel-isotropic —
// per-axis normalisation on a 4:1 banner squashes the lobes flat); k is integer
// cycles per loop, which keeps the seam exact. Every k is distinct — components
// sharing a speed freeze into a shape that merely translates; k=0 is legal.
const FIELD = [
  { fx: 0.75, fy: 0.55, k: 1 },
  { fx: -0.35, fy: 0.95, k: -1 },
  { fx: 0.95, fy: -0.4, k: 0 },
];
const GAMMA = 1.35; // >1 deepens the dark side of the gradient
const DRIVE = 2.4; // sum of 3 sines rarely hits ±3; dividing by less (with a
// clamp) restores saturated highlights and deep troughs

// Brightness ramp: heavier glyph = brighter spot, variants per level so bands
// don't degrade into rings of one character. Level 0 is empty.
const RAMP = [[], [":", "."], ["!", "/"], ["\\", "|"], ["1", "?"], ["7", "*"], ["2", "5"], ["%", "0"], ["&", "#"], ["8", "@"]];
// Ten levels collapse into three fill classes: glyph weight already carries
// most of the gradient, and per-run <tspan>s would triple the size.
const BANDS = [
  { lo: 1, hi: 3, rep: 2 },
  { lo: 4, hi: 6, rep: 5 },
  { lo: 7, hi: 9, rep: 8 },
];

// ---- helpers ---------------------------------------------------------------
const jitter = (i) => {
  let x = (i + 1) * 2654435761;
  x = (x ^ (x >>> 13)) * 1274126177;
  return (((x ^ (x >>> 16)) >>> 0) % 1024) / 1024;
};
const TAU = Math.PI * 2;
// x, y in units of banner width, t in [0,1) across the loop.
const wave = (x, y, t) => {
  let v = 0;
  for (const { fx, fy, k } of FIELD) v += Math.sin(TAU * (fx * x + fy * y + k * t));
  return Math.pow(Math.min(1, Math.max(0, (v / DRIVE + 1) / 2)), GAMMA);
};
const rgb = (() => {
  const n = parseInt(ACCENT.slice(1), 16);
  const c = `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  return (a) => `rgb(${c} / ${a.toFixed(2)})`;
})();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const num = (v) => (Math.round(v * 10) / 10).toString();
const num2 = (v) => +v.toFixed(2); // decode offsets: whole tagline columns, and that pitch carries two decimals

// figlet: header "flf2a$ height ... commentLines", then the printable ASCII
// glyphs as `height` lines each, '@' end-marks, hardblank '$' = a space that
// survives smushing.
const loadFlf = (path) => {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const hdr = lines[0].split(" ");
  const hard = hdr[0].slice(-1);
  const height = +hdr[1];
  const chars = new Map();
  let i = 1 + +hdr[5];
  for (let code = 32; code <= 126 && i + height <= lines.length; code++, i += height)
    chars.set(String.fromCharCode(code), lines.slice(i, i + height).map((l) => l.replace(/@+$/, "").replaceAll(hard, " ")));
  return { height, chars };
};
const figlet = (font, text) => {
  const rows = Array.from({ length: font.height }, () => "");
  for (const ch of text) {
    const g = font.chars.get(ch) ?? font.chars.get("?");
    for (let r = 0; r < font.height; r++) rows[r] += g[r];
  }
  while (rows.length && !rows.at(-1).trim()) rows.pop();
  const cols = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => r.padEnd(cols));
};

// ---- field bake ------------------------------------------------------------
const COLS = Math.ceil(W / PX);
const ROWS = Math.floor(H / PY);
const NF = FPS * DUR;
const STILL = Math.round(STILL_T * FPS) % NF;
const y0 = (H - ROWS * PY) / 2;
// Attribute bytes repeat per text node (thousands of them), so every one is
// trimmed: x defaults to 0, xml:space is inherited from the root svg, and y
// keeps its decimal only when the grid doesn't land on a whole pixel.
const frames = [];
for (let f = 0; f < NF; f++) {
  const t = f / NF;
  const rows = [];
  for (let row = 0; row < ROWS; row++) {
    const level = [];
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      const b = wave(((col + 0.5) * PX) / W, ((row + 0.5) * PY) / W, t) + jitter(i) * 0.1 - 0.05;
      level.push(Math.min(RAMP.length - 1, Math.max(0, Math.floor(b * RAMP.length))));
    }
    // One <text> per colour band per row: band glyphs in place, spaces
    // elsewhere; the monospace grid keeps the three layers in register.
    for (let bi = 0; bi < BANDS.length; bi++) {
      const { lo, hi } = BANDS[bi];
      let s = "";
      for (let col = 0; col < COLS; col++) {
        const lv = level[col];
        if (lv >= lo && lv <= hi) {
          const v = RAMP[lv];
          s += v[Math.floor(jitter((row * COLS + col) * 3 + 1) * v.length)];
        } else s += " ";
      }
      s = s.replace(/\s+$/, "");
      if (!s) continue;
      rows.push(`<text class="b${bi}" y="${num(y0 + row * PY + PY / 2)}">${esc(s)}</text>`);
    }
  }
  frames.push(`<g class="f${f === STILL ? " f-still" : ""}" style="animation-delay:${(f / FPS).toFixed(1)}s">${rows.join("")}</g>`);
}
const bandFills = BANDS.map((b, i) => `.b${i}{fill:${rgb(ALPHA.lo + (ALPHA.hi - ALPHA.lo) * (b.rep / (RAMP.length - 1)))}}`).join("");

// ---- tagline overlay -------------------------------------------------------
const flf = loadFlf(FLF);
const figs = TAGLINES.map((t) => figlet(flf, t));
const TROWS = figs[0]?.length ?? 0;
const maxCols = Math.max(0, ...figs.map((r) => r[0].length));
// Font size: fit the widest line, capped by the height budget; rounded to
// 0.1px because that is what the SVG carries, and the pitch derives from it.
const TFONT = +num(Math.min((W * TAG_FILL) / maxCols / 0.6, (H * TAG_MAX_H) / (TROWS * TAG_LH)));
const TPX = TFONT * 0.6;
const TPY = TFONT * TAG_LH;
const rowY = (r) => H / 2 - (TROWS * TPY) / 2 + TPY / 2 + r * TPY;
const SLOT_T = DECODE_T + HOLD_T;
const TDUR = TAGLINES.length * SLOT_T || DUR;
const NT = Math.round(DECODE_T * TFPS);
const pct = (s) => ((s / TDUR) * 100).toFixed(3);
const POOL = RAMP.flat();
const isShadow = (c) => "═║╔╗╚╝".includes(c);

// Decode geometry, in whole tagline columns so a window never slices a glyph.
// Each tagline sits in a wrapper translated to its own left edge, so text
// starts at local x=0 and one set of keyframes serves every line: a front
// travels TRAVEL columns from START_COLS left of the text (scramble band and
// knockout margin still off the letters) to the widest line's right edge.
// Shorter lines simply finish sooner — the pace per column is constant.
const leads = Array.from({ length: TROWS }, (_, i) => Math.max(1, Math.round(LEAD * (1 + LEAD_VAR * (2 * jitter(i * 61 + 7) - 1)))));
const START_COLS = Math.max(0, ...leads) + 2; // +1 column of knockout margin, +1 for its stroke
const TRAVEL = START_COLS + maxCols;
const START = START_COLS * TPX;
const END = TRAVEL * TPX;
const FAR = START + END; // left reach of the open-ended clips: covers the text at full travel
// Mean front: uneven pace, over-travelling by RAG at both ends so every row
// starts hidden and lands on its own tick instead of snapping on the last one.
const meanFront = (() => {
  const pace = Array.from({ length: NT }, (_, k) => 1 + BURST * (2 * jitter(k * 53 + 11) - 1));
  const total = pace.reduce((a, b) => a + b, 0);
  let acc = 0;
  return [-RAG, ...pace.map((v) => -RAG + ((acc += v) / total) * (TRAVEL + 2 * RAG))];
})();
// Row front per tick: the mean plus a wander interpolated between random
// knots, clamped to the travel; a row only ever advances.
const rowFront = (pattern) => {
  const knot = (j) => 2 * jitter(pattern * 4099 + j * 61 + 3) - 1;
  const out = [0];
  for (let k = 1; k <= NT; k++) {
    const j = Math.floor(k / RAG_TICKS);
    const u = (k % RAG_TICKS) / RAG_TICKS;
    const wander = RAG * (knot(j) * (1 - u) + knot(j + 1) * u);
    out.push(Math.min(TRAVEL, Math.max(out[k - 1], Math.round(meanFront[k] + wander))));
  }
  return out;
};
const fronts = Array.from({ length: TROWS }, (_, i) => rowFront(i));
// Keyframes hold (step-end) between stops, so ticks where the row stalls need
// none: decode, hold to the slot's end, snap back to hidden.
const frontKeyframes = (name, steps, sign) => {
  let css = `@keyframes ${name}{0%{transform:none}`;
  for (let k = 1; k <= NT; k++)
    if (steps[k] !== steps[k - 1]) css += `${pct(k / TFPS)}%{transform:translateX(${num2(sign * steps[k] * TPX)}px)}`;
  return `${css}${pct(SLOT_T)}%{transform:none}100%{transform:none}}`;
};
// Which front pattern each row rides is reshuffled per tagline, so the tear
// doesn't repeat line after line at no cost in keyframes.
const shuffled = (n, seed) => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(jitter(seed * 101 + i * 7 + 29) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
// Scramble frames sit in a vertical strip that steps behind the row's band
// clip: one animation per row instead of one per frame. Two row pitches keep
// the neighbouring frames' glyphs clear of the band.
const STRIP = Math.ceil(2 * TPY);
const BAND = 1.5 * TFONT; // band clip height; the em box spans 1.32em

// Row → runs: solid blocks as bare text, shadow strokes in a dim tspan.
// Spaces attach to the current run so they never open one of their own.
const runs = (row) => {
  let out = "", cur = "", shadow = null;
  const flush = () => {
    if (cur) out += shadow ? `<tspan class="s">${cur}</tspan>` : cur;
    cur = "";
  };
  for (const c of row) {
    const sh = c === " " ? shadow : isShadow(c);
    if (sh !== shadow) {
      if (cur.trim()) flush(); // a spaces-only cur stays as the new run's prefix
      shadow = sh;
    }
    cur += c;
  }
  flush();
  // The mask and the noise use the plain row; the settled line must land on
  // the same cells or the knockout drifts off the letters.
  if (out.replace(/<[^>]+>/g, "") !== row) throw new Error(`run split changed row: ${JSON.stringify(row)}`);
  return out;
};

const overlay = [];
const cuts = [];
figs.forEach((rows, p) => {
  const wrap = (body) => `<g transform="translate(${num((W - rows[0].length * TPX) / 2)})">${body}</g>`;
  const pattern = shuffled(TROWS, p);
  // Clip window: the clipped group slides (Firefox ignores transforms on the
  // clipPath's own children), the inner group counter-slides the glyphs.
  // d<p> delays the pair to the tagline's slot; e/ei pin the first tagline
  // open under prefers-reduced-motion.
  const win = (i, clip, body) =>
    `<g class="r${pattern[i]}${p ? ` d${p}` : " e"}" clip-path="url(#${clip})">` +
    `<g class="q${pattern[i]}${p ? ` d${p}` : " ei"}">${body}</g></g>`;
  const lines = [];
  const cutLines = [];
  rows.forEach((r, i) => {
    const row = r.trimEnd();
    if (!row) return;
    let strip = "";
    for (let k = 0; k < NOISE_FRAMES; k++) {
      let s = "";
      for (let c = 0; c < row.length; c++)
        s += row[c] === " " ? " " : POOL[Math.floor(jitter(p * 7919 + k * 131 + i * 977 + c * 31 + 5) * POOL.length)];
      strip += `<text class="tg nz" y="${num(rowY(i) + k * STRIP)}">${esc(s)}</text>`;
    }
    lines.push(
      win(i, `n${i}`, `<g class="st">${strip}</g>`) +
      win(i, "s", `<text class="tg tx" y="${num(rowY(i))}">${runs(row)}</text>`),
    );
    cutLines.push(win(i, `m${i}`, `<text class="tg" y="${num(rowY(i))}">${esc(row)}</text>`));
  });
  overlay.push(wrap(lines.join("")));
  if (CUT > 0) cuts.push(wrap(cutLines.join("")));
});
// Clip rects live in the sliding group's space, offset so that zero travel
// hides everything: settled text shows left of the front, the scramble in a
// band of the row's lead right of it, the knockout up to a column past the band.
const rect = (x, w, y = 0, h = H) => `<rect x="${num2(x)}"${y ? ` y="${num2(y)}"` : ""} width="${num2(w)}" height="${num2(h)}"/>`;
const clips = !TAGLINES.length ? "" :
  `<clipPath id="s">${rect(-FAR, FAR - START)}</clipPath>` +
  leads.map((lead, i) =>
    `<clipPath id="n${i}">${rect(-START, lead * TPX, rowY(i) - BAND / 2, BAND)}</clipPath>` +
    (CUT > 0 ? `<clipPath id="m${i}">${rect(-FAR, FAR - START + (lead + 1) * TPX)}</clipPath>` : ""),
  ).join("");

const font = readFileSync(FONT_FILE).toString("base64");
const LABEL = TAGLINES[0] ?? "ASCII field";
const mask = cuts.length
  ? `<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${cuts.join("")}</mask>`
  : "";
// Timelines: the field flips on DUR; every tagline window runs its row's front
// keyframes on TDUR with its slot's delay — no visibility toggles, so nested
// groups can't leak through a hidden parent. The d<p> rules must follow the
// r/q ones: the `animation` shorthand resets the delay.
const frontCss = fronts.map((steps, i) =>
  `.r${i}{animation:r${i} ${TDUR}s step-end infinite}.q${i}{animation:q${i} ${TDUR}s step-end infinite}` +
  frontKeyframes(`r${i}`, steps, 1) + frontKeyframes(`q${i}`, steps, -1),
).join("\n");
const delayCss = TAGLINES.slice(1).map((_, i) => `.d${i + 1}{animation-delay:${num2((i + 1) * SLOT_T)}s}`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xml:space="preserve" role="img" aria-label="${LABEL}">
<title>${LABEL}</title>
<style>
@font-face{font-family:B;src:url(data:font/woff2;base64,${font}) format('woff2')}
text{font-family:B,monospace;text-rendering:optimizeSpeed;font-variant-ligatures:none;white-space:pre;dominant-baseline:central}
.f text{font-size:${FONT}px}
${bandFills}
.f{visibility:hidden;animation:k ${DUR}s step-end infinite}
@keyframes k{0%{visibility:visible}${(100 / NF).toFixed(3)}%{visibility:hidden}100%{visibility:hidden}}
.tg{font-size:${TFONT}px}
.tx{fill:${ACCENT}}.s{fill:${rgb(SHADOW_A)}}.nz{fill:${rgb(NOISE_A)}}
${frontCss}
${delayCss}
.st{animation:nk ${num2(NOISE_FRAMES / TFPS)}s steps(${NOISE_FRAMES}) infinite}
@keyframes nk{to{transform:translateY(${-NOISE_FRAMES * STRIP}px)}}
mask text{fill:#000;stroke:#000;stroke-width:${CUT};stroke-linejoin:round}
@media (prefers-reduced-motion:reduce){.f,g[clip-path],g[clip-path]>g,.st{animation:none}.f-still{visibility:visible}.e{transform:translateX(${num2(END)}px)}.ei{transform:translateX(${num2(-END)}px)}}
</style>
<defs>${clips}${mask}</defs>
<g${mask ? ' mask="url(#cut)"' : ""}>
${frames.join("\n")}
</g>
${overlay.join("\n")}
</svg>
`;

const out = argOut ?? join(HERE, "..", "banner.svg");
writeFileSync(out, svg);
const raw = Buffer.byteLength(svg);
console.log(
  `${out}: ${(raw / 1024).toFixed(0)} KB raw, ${(gzipSync(Buffer.from(svg)).length / 1024).toFixed(0)} KB gzip — ${NF} frames, ${COLS}x${ROWS} cells; tagline ${maxCols} cols @ ${TFONT}px`,
);
