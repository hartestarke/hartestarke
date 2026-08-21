#!/usr/bin/env node
// Animated ASCII-plasma banner for the GitHub profile README, baked into a
// self-contained SVG. Offline port of catc_hub's canvas AsciiField: the same
// travelling sine waves pushed through a glyph ramp, but precomputed into a
// CSS frame-flip loop, because README images allow no JS.
//
// Output: banner.svg next to the repo root. Usage: node scripts/gen-banner.mjs

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- knobs -----------------------------------------------------------------
const W = 880; // viewBox size; README scales it down responsively
const H = 240;
const ACCENT = "#E62D42";
const CANVAS = "#07080A"; // catc_hub page canvas
const TAGLINES = [
  "any problem, given time",
  "exploring the edge of the possible",
  "in search of new stars",
  "teaching metal to dream",
]; // rotation order; [] for a pure field, no overlay
// Decode rotation: each line spends DECODE_T cycling through field glyphs,
// locks in left to right, holds for HOLD_T, then the next line starts
// cycling. Scrambled positions wear the accent, locked ones the name white.
// The text loop is TAGLINES.length slots long and free-runs against the
// field loop — the two never need to sync.
const DECODE_T = 2.2; // seconds of glyph-cycling before a line settles
const HOLD_T = 5.8; // seconds a settled line stays before the next one cycles in
const TFPS = 20; // decode flip rate, independent of the field FPS; reads as noise below ~15
// Palette shape: how much of the accent survives at the bottom of the ramp
// (base), how hard the top lifts towards white (lift), and the opacity ramp.
// catc_hub ran 0.55/0.5/0.14+0.5t as a faint backdrop behind product shots;
// here the field IS the artwork, so it gets more pigment.
const SAT = { base: 0.8, lift: 0.35, alpha0: 0.4, alpha1: 0.45 };
// Liquid-gradient field, after the user's reference (liquid_gradient.jpg):
// a few plane waves, each under one period across the banner and pointed in
// different directions, interfere into one or two giant soft lobes with
// curved boundaries. The glyph ramp plus jitter dithering supplies the grain.
// fx/fy are cycles per banner WIDTH on both axes (pixel-isotropic — per-axis
// normalization on a 4:1 banner squashes the lobes flat); k is integer cycles
// per loop, which keeps the seam exact. |[fx,fy]| ~1 = lobe about a banner
// width across; directions spread ~60° apart so the boundary curves. Every
// k is distinct — components sharing a speed keep a constant relative
// phase, and their interference freezes into a shape that merely translates.
// k=0 is a legal speed: the two movers morph against the frozen one, and the
// fastest anything moves is one cycle per DUR.
const FIELD = [
  { fx: 0.75, fy: 0.55, k: 1 },
  { fx: -0.35, fy: 0.95, k: -1 },
  { fx: 0.95, fy: -0.4, k: 0 },
];
const GAMMA = 1.35; // >1 deepens the dark side of the gradient
const DRIVE = 2.4; // sum of 3 sines rarely hits ±3; dividing by less than 3
// (with a clamp) restores saturated highlights and deep troughs

// Dev override for comparing variants side by side:
//   node scripts/gen-banner.mjs [out.svg]
const [, , argOut] = process.argv;
const FONT = 14; // glyph font-size, px
const PX = FONT * 0.6; // column pitch = monospace advance (0.6em), enforced via textLength
const PY = 16; // row pitch
const FPS = 10; // flipbook rate; 10 steps the field about half a glyph column per
// flip — the finest motion the character grid can express, and the ceiling the
// 1 MB raw budget allows at this height
const DUR = 20; // loop seconds — wave speeds are integer cycles per DUR, so the seam is exact
// FPS*DUR is the DOM cost every profile visitor pays (frames × ~40 text nodes
// each, alive for the lifetime of the tab) — keep the product modest.
const STILL_T = 7; // prefers-reduced-motion shows this moment (same pick as app.js)

// Brightness ramp from app.js: heavier glyph = brighter spot, variants per
// level so bands don't degrade into rings of one character. Level 0 is empty.
const RAMP = [
  [],
  [":", "."],
  ["!", "/"],
  ["\\", "|"],
  ["1", "?"],
  ["7", "*"],
  ["2", "5"],
  ["%", "0"],
  ["&", "#"],
  ["8", "@"],
];

// Ten palette levels collapse into three fill classes: glyph weight already
// carries most of the gradient, and per-run <tspan>s would triple the size.
const BANDS = [
  { lo: 1, hi: 3, rep: 2 },
  { lo: 4, hi: 6, rep: 5 },
  { lo: 7, hi: 9, rep: 8 },
];

// ---- field model (verbatim from app.js) ------------------------------------
const jitter = (i) => {
  let x = (i + 1) * 2654435761;
  x = (x ^ (x >>> 13)) * 1274126177;
  return (((x ^ (x >>> 16)) >>> 0) % 1024) / 1024;
};

// x, y in units of banner width, t in [0,1) across the loop.
const TAU = Math.PI * 2;
const wave = (x, y, t) => {
  let v = 0;
  for (const { fx, fy, k } of FIELD) v += Math.sin(TAU * (fx * x + fy * y + k * t));
  return Math.pow(Math.min(1, Math.max(0, (v / DRIVE + 1) / 2)), GAMMA);
};

// Palette from app.js, reshaped by SAT: accent translucent at the bottom of
// the ramp, lifted towards white at the top.
const palette = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return RAMP.map((_, i) => {
    const t = i / (RAMP.length - 1);
    const ch = (v) => Math.round(v * SAT.base + t * (v * (1 - SAT.base) + (255 - v) * SAT.lift));
    return `rgb(${ch(c[0])} ${ch(c[1])} ${ch(c[2])} / ${(SAT.alpha0 + SAT.alpha1 * t).toFixed(2)})`;
  });
};

// ---- bake ------------------------------------------------------------------
// Rows are plain text: within one monospace font every row lines up on its
// own, so nothing pins the pitch (textLength did once — its per-glyph spacing
// re-layout on every frame was a real CPU/RAM tax on visitors). The advance
// just varies by viewer font, so overscan the columns for the narrowest
// mainstream mono (0.55em, Consolas) and let the SVG viewport clip the rest.
const COLS = Math.ceil(W / (FONT * 0.55));
const ROWS = Math.floor(H / PY);
const NF = FPS * DUR;
const STILL = Math.round(STILL_T * FPS) % NF;
const y0 = (H - ROWS * PY) / 2;
const esc = (s) => s.replace(/&/g, "&amp;");
// Attribute bytes repeat per text node (thousands of them), so every one is
// trimmed: x defaults to 0, xml:space is inherited from the root svg, and y
// keeps its decimal only when the grid doesn't land on a whole pixel.
const fy = (v) => (v % 1 ? v.toFixed(1) : String(v));

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
          const variants = RAMP[lv];
          s += variants[Math.floor(jitter((row * COLS + col) * 3 + 1) * variants.length)];
        } else s += " ";
      }
      s = s.replace(/\s+$/, "");
      if (!s) continue;
      const y = fy(y0 + row * PY + PY / 2);
      rows.push(`<text class="b${bi}" y="${y}">${esc(s)}</text>`);
    }
  }
  const still = f === STILL ? " f-still" : "";
  frames.push(
    `<g class="f${still}" style="animation-delay:${(f / FPS).toFixed(4)}s">${rows.join("")}</g>`,
  );
}

const pal = palette(ACCENT);
const bandFills = BANDS.map((b, i) => `.b${i}{fill:${pal[b.rep]}}`).join("");
const slot = ((100 / NF).toFixed(4) * 1).toString();

// Scramble pool = the field's own ramp, so the decode looks native to the
// artwork. A line's length never changes mid-decode (unresolved positions
// hold a random glyph), so text-anchor:middle keeps it pinned in place; the
// cut between lines of different lengths is the classic decoder-board look.
const POOL = RAMP.flat();
const NT = Math.round(DECODE_T * TFPS);
const SLOT_T = DECODE_T + HOLD_T;
const TDUR = TAGLINES.length * SLOT_T || DUR; // fallback only guards the pure-field keyframe math
const overlay = TAGLINES.map((line, p) => {
  const N = line.length;
  const parts = [];
  for (let f = 0; f < NT; f++) {
    const L = Math.floor((f / NT) * N);
    let tail = "";
    for (let i = L; i < N; i++)
      tail += line[i] === " " ? " " : POOL[Math.floor(jitter(i * 131 + f * 7 + p * 977 + 3) * POOL.length)];
    parts.push(
      `<text class="name tf" x="${W / 2}" y="${H / 2}" style="animation-delay:${(p * SLOT_T + f / TFPS).toFixed(2)}s">${esc(line.slice(0, L))}<tspan class="sc">${esc(tail)}</tspan></text>`,
    );
  }
  // The settled line; the first one doubles as the prefers-reduced-motion still.
  parts.push(
    `<text class="name th${p === 0 ? " t-still" : ""}" x="${W / 2}" y="${H / 2}" style="animation-delay:${(p * SLOT_T + DECODE_T).toFixed(2)}s">${esc(line)}</text>`,
  );
  return parts.join("");
}).join("");

const LABEL = TAGLINES[0] || "ASCII plasma field";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xml:space="preserve" role="img" aria-label="${LABEL}">
<title>${LABEL}</title>
<style>
text{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-rendering:optimizeSpeed;white-space:pre}
.f text{font-size:${FONT}px;dominant-baseline:central}
${bandFills}
.f{visibility:hidden;animation:k ${DUR}s step-end infinite}
@keyframes k{0%{visibility:visible}${slot}%{visibility:hidden}100%{visibility:hidden}}
.name{font-size:30px;fill:#F5F6F8;dominant-baseline:central;text-anchor:middle;letter-spacing:1.5px}
.sc{fill:${ACCENT}}
.tf{visibility:hidden;animation:tk ${TDUR}s step-end infinite}
@keyframes tk{0%{visibility:visible}${(100 / (TDUR * TFPS)).toFixed(4)}%{visibility:hidden}100%{visibility:hidden}}
.th{visibility:hidden;animation:th ${TDUR}s step-end infinite}
@keyframes th{0%{visibility:visible}${((HOLD_T / TDUR) * 100).toFixed(4)}%{visibility:hidden}100%{visibility:hidden}}
@media (prefers-reduced-motion:reduce){.f,.tf,.th{animation:none}.f-still,.t-still{visibility:visible}}
</style>
<rect width="${W}" height="${H}" rx="12" fill="${CANVAS}"/>
${frames.join("\n")}
${overlay}
</svg>
`;

const out = argOut ?? join(dirname(fileURLToPath(import.meta.url)), "..", "banner.svg");
writeFileSync(out, svg);
const raw = Buffer.byteLength(svg);
console.log(
  `banner.svg: ${(raw / 1024).toFixed(0)} KB raw, ${(gzipSync(Buffer.from(svg)).length / 1024).toFixed(0)} KB gzip — ${NF} frames, ${COLS}x${ROWS} cells`,
);
