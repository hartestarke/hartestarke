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
const H = 220;
const ACCENT = "#E62D42";
const CANVAS = "#07080A"; // catc_hub page canvas
const TAGLINE = "any problem, given time"; // set to "" for a pure field, no overlay
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
// width across; directions spread ~60° apart so the boundary curves.
const FIELD = [
  { fx: 0.75, fy: 0.55, k: 1 },
  { fx: -0.35, fy: 0.95, k: -1 },
  { fx: 0.95, fy: -0.4, k: 1 },
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
const FPS = 6; // flipbook rate; ASCII reads better chunky than smooth
const DUR = 16; // loop seconds — wave speeds are integer cycles per DUR, so the seam is exact
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
const COLS = Math.floor(W / PX);
const ROWS = Math.floor(H / PY);
const NF = FPS * DUR;
const STILL = Math.round(STILL_T * FPS) % NF;
const x0 = (W - COLS * PX) / 2;
const y0 = (H - ROWS * PY) / 2;
const esc = (s) => s.replace(/&/g, "&amp;");

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
      const y = (y0 + row * PY + PY / 2).toFixed(1);
      // textLength pins the column pitch even when the viewer's monospace
      // font has a different advance width.
      rows.push(
        `<text class="b${bi}" x="${x0.toFixed(1)}" y="${y}" textLength="${(s.length * PX).toFixed(1)}" lengthAdjust="spacing" xml:space="preserve">${esc(s)}</text>`,
      );
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

// Block caret, not underscore — the user's console/IDE taste. U+2588 is safe:
// every mainstream monospace ships it, and it is the last glyph anyway.
const overlay = TAGLINE
  ? `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W * 0.36}" ry="${H * 0.36}" fill="url(#scrim)"/>` +
    `<text class="name" x="${W / 2}" y="${H / 2}">${TAGLINE}<tspan class="cur">█</tspan></text>`
  : "";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${TAGLINE || "ASCII plasma field"}">
<title>${TAGLINE || "ASCII plasma field"}</title>
<style>
text{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-rendering:optimizeSpeed;white-space:pre}
.f text{font-size:${FONT}px;dominant-baseline:central}
${bandFills}
.f{visibility:hidden;animation:k ${DUR}s step-end infinite}
@keyframes k{0%{visibility:visible}${slot}%{visibility:hidden}100%{visibility:hidden}}
.name{font-size:30px;fill:#F5F6F8;dominant-baseline:central;text-anchor:middle;letter-spacing:1.5px}
.cur{fill:${ACCENT};animation:blink 1.1s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.f,.cur{animation:none}.f-still{visibility:visible}}
</style>
<defs><radialGradient id="scrim"><stop offset="0" stop-color="${CANVAS}" stop-opacity=".92"/><stop offset="1" stop-color="${CANVAS}" stop-opacity="0"/></radialGradient></defs>
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
