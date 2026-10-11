// ascii-banner config (https://github.com/hartestarke/ascii-banner). Every knob is listed with its default; delete any line
// to fall back to the default, or change it and rebuild:
//   npx --yes github:hartestarke/ascii-banner build
// Unknown keys are an error, so a typo can't silently do nothing.
export default {
  // viewBox size in px; the README <img> scales it down responsively.
  // Raw file size grows with width × height, so keep within the budget below.
  size: { width: 880, height: 240 },

  // The only hue. Field, taglines and shadows are all this colour at different
  // alphas, so the banner reads on light, dark and dimmed themes alike.
  accent: "#E62D42",

  // Lines decoded one after another, in this order. [] = pure field, no text.
  // The bundled font is caps only (lowercase renders as caps); characters it
  // lacks render as its "?" glyph and the build prints a warning.
  taglines: ["hack them all", "let it exist", "make it work", "beyond the edge", "counting stars"],

  tagline: {
    fill: 0.92, // the widest tagline spans at most this fraction of the width...
    maxHeight: 0.34, // ...and the letters at most this fraction of the height
    lineHeight: 1.2, // row pitch, em; block glyphs span -0.3..1.02em, so ≤ 1.32 stays seamless
    shadowAlpha: 0.5, // alpha of the shadow strokes vs the solid blocks
    knockout: 6, // px the field is cleared around the letters; 0 = off
    font: "ansi-shadow", // bundled figlet font, or a path to any .flf (relative to this file)
    shadowGlyphs: "═║╔╗╚╝", // figlet glyphs drawn at shadowAlpha; all others are solid
  },

  decode: {
    seconds: 2.2, // seconds a line spends decoding
    hold: 5.8, // seconds a settled line holds before the next one starts
    fps: 20, // decode step rate; reads as noise below ~15
    noiseFrames: 6, // distinct scramble frames cycled during decode
    lead: 16, // columns of scramble running ahead of the settled text
    leadVar: 0.35, // per-row spread of lead, as a fraction of it
    rag: 3, // columns a row's front may stray either side of the mean front
    ragTicks: 3, // decode ticks between a row's wander knots; lower = twitchier
    burst: 0.85, // pace jitter of the front: 0 = even, 1 = from a stall to a double step
    noiseAlpha: 0.65, // alpha of not-yet-decoded glyphs
  },

  field: {
    fontSize: 14, // field glyph size, px (bigger = fewer cells = smaller file)
    rowPitch: 16, // px between field rows
    fps: 10, // flipbook rate; ~half a column of motion per flip, the finest the grid shows
    loopSeconds: 20, // loop length; fps × loopSeconds frames, and file size scales with it
    stillAt: 7, // second of the loop shown to prefers-reduced-motion visitors
    alpha: { lo: 0.3, hi: 0.95 }, // field alpha from the dimmest to the brightest band
    // Brightness ramp, dim → bright. Levels are separated by spaces; the
    // characters of one level are interchangeable variants. Empty = level 0.
    ramp: ":. !/ \\| 1? 7* 25 %0 &# 8@",
    // Plane waves summed into the field. fx/fy = cycles per banner WIDTH (on
    // both axes, so lobes stay round), k = whole cycles per loop (keeps the
    // seam exact). Keep every k distinct; k = 0 is a standing component.
    waves: [
      { fx: 0.75, fy: 0.55, k: 1 },
      { fx: -0.35, fy: 0.95, k: -1 },
      { fx: 0.95, fy: -0.4, k: 0 },
    ],
    gamma: 1.35, // > 1 deepens the dark side of the gradient
    drive: 2.4, // wave-sum divisor; lower = more saturated highlights and deeper troughs
    // Replace the waves with your own brightness function:
    //   (x, y, t) => number in [0, 1]; x, y = cell centre in px, t = seconds into the loop.
    // Make it periodic in t over loopSeconds, or the loop seam will jump. Example:
    //   sample: (x, y, t) => 0.5 + 0.5 * Math.sin(x / 60 + (2 * Math.PI * t) / 20),
    sample: null,
  },

  font: {
    file: null, // null = bundled JetBrains Mono subset; or a path to your own .woff2
    advance: 0.6, // that font's glyph advance in em (JetBrains Mono: 0.6)
  },

  budget: {
    maxBytes: 1048576, // build fails above this many raw bytes; 0 = no limit
  },
};
