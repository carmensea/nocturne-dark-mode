/**
 * Nocturne — color parsing and perceptual lightness mapping.
 *
 * Classic script (not a module) so the exact same file can be loaded by the
 * content script, the popup, and the service worker via importScripts().
 * Everything hangs off the `NDM` namespace on the current global.
 */
(() => {
  'use strict';
  const NDM = (globalThis.NDM ||= {});
  if (NDM.colors) return;

  /* ------------------------------------------------------------------ *
   * Parsing
   * ------------------------------------------------------------------ */

  // Small table of the named colors that actually show up in the wild.
  // Anything else falls through to the canvas-based parser below, which
  // understands every syntax the host Chrome build does (oklch(), lab(),
  // color-mix(), the full 148-name list, ...).
  const NAMED = {
    transparent: [0, 0, 0, 0],
    black: [0, 0, 0, 1], white: [255, 255, 255, 1],
    red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
    gray: [128, 128, 128, 1], grey: [128, 128, 128, 1],
    silver: [192, 192, 192, 1], lightgray: [211, 211, 211, 1],
    lightgrey: [211, 211, 211, 1], darkgray: [169, 169, 169, 1],
    darkgrey: [169, 169, 169, 1], whitesmoke: [245, 245, 245, 1],
    ghostwhite: [248, 248, 255, 1], snow: [255, 250, 250, 1],
    ivory: [255, 255, 240, 1], beige: [245, 245, 220, 1],
    lightyellow: [255, 255, 224, 1], aliceblue: [240, 248, 255, 1],
    gainsboro: [220, 220, 220, 1], navy: [0, 0, 128, 1],
    teal: [0, 128, 128, 1], olive: [128, 128, 0, 1], lime: [0, 255, 0, 1],
    aqua: [0, 255, 255, 1], cyan: [0, 255, 255, 1], fuchsia: [255, 0, 255, 1],
    magenta: [255, 0, 255, 1], maroon: [128, 0, 0, 1], purple: [128, 0, 128, 1],
    yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1], pink: [255, 192, 203, 1],
    brown: [165, 42, 42, 1], gold: [255, 215, 0, 1],
    dodgerblue: [30, 144, 255, 1], steelblue: [70, 130, 180, 1],
    royalblue: [65, 105, 225, 1], crimson: [220, 20, 60, 1],
    tomato: [255, 99, 71, 1], orangered: [255, 69, 0, 1],
    darkblue: [0, 0, 139, 1], darkred: [139, 0, 0, 1],
    darkgreen: [0, 100, 0, 1], darkslategray: [47, 79, 79, 1],
    dimgray: [105, 105, 105, 1], dimgrey: [105, 105, 105, 1]
  };

  // Values that are not colors at all, or that we must never rewrite.
  const PASSTHROUGH = new Set([
    'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentcolor',
    'none', 'auto', 'currentColor'
  ]);

  const HEX_RE = /^#([0-9a-f]{3,8})$/i;
  const NUMERIC_FN_RE = /^(rgba?|hsla?)\(([^()]*)\)$/i;

  let canvasCtx;
  let canvasBroken = false;

  /** Last-resort parser: let the browser normalise the value for us. */
  function parseViaCanvas(value) {
    if (canvasBroken) return null;
    try {
      if (!canvasCtx) {
        if (typeof document === 'undefined') { canvasBroken = true; return null; }
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        canvasCtx = canvas.getContext('2d');
        if (!canvasCtx) { canvasBroken = true; return null; }
      }
      // Sentinel trick: an invalid fillStyle is ignored, leaving the old value.
      canvasCtx.fillStyle = '#000001';
      canvasCtx.fillStyle = value;
      const first = canvasCtx.fillStyle;
      canvasCtx.fillStyle = '#fffffe';
      canvasCtx.fillStyle = value;
      const second = canvasCtx.fillStyle;
      if (first !== second) return null; // value was rejected twice over
      return parseSimple(first);
    } catch {
      return null;
    }
  }

  /** Parse only the cheap, extremely common syntaxes. */
  function parseSimple(value) {
    const hex = HEX_RE.exec(value);
    if (hex) {
      const h = hex[1];
      if (h.length === 3 || h.length === 4) {
        const r = parseInt(h[0] + h[0], 16);
        const g = parseInt(h[1] + h[1], 16);
        const b = parseInt(h[2] + h[2], 16);
        const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
        return [r, g, b, a];
      }
      if (h.length === 6 || h.length === 8) {
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return [r, g, b, a];
      }
      return null;
    }

    const fn = NUMERIC_FN_RE.exec(value);
    if (fn) {
      const kind = fn[1].toLowerCase();
      const parts = fn[2].split(/[,/\s]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const alpha = parts.length > 3 ? parseAlpha(parts[3]) : 1;
      if (kind.startsWith('rgb')) {
        const c = parts.slice(0, 3).map((p) =>
          p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
        if (c.some(Number.isNaN)) return null;
        return [clamp(c[0], 0, 255), clamp(c[1], 0, 255), clamp(c[2], 0, 255), alpha];
      }
      const h = parseFloat(parts[0]);
      const s = parseFloat(parts[1]) / 100;
      const l = parseFloat(parts[2]) / 100;
      if ([h, s, l].some(Number.isNaN)) return null;
      const [r, g, b] = hslToRgb(((h % 360) + 360) % 360 / 360, clamp(s, 0, 1), clamp(l, 0, 1));
      return [r, g, b, alpha];
    }
    return null;
  }

  function parseAlpha(token) {
    const a = token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
    return Number.isNaN(a) ? 1 : clamp(a, 0, 1);
  }

  const parseCache = new Map();
  const PARSE_CACHE_MAX = 4000;

  /**
   * Parse any CSS color into [r, g, b, a] (0-255, 0-255, 0-255, 0-1),
   * or null when the value is not a color we can resolve statically.
   */
  function parse(input) {
    if (typeof input !== 'string') return null;
    const value = input.trim();
    if (!value) return null;

    const cached = parseCache.get(value);
    if (cached !== undefined) return cached;

    let result = null;
    const lower = value.toLowerCase();
    if (!PASSTHROUGH.has(lower)) {
      if (Object.prototype.hasOwnProperty.call(NAMED, lower)) {
        result = NAMED[lower].slice();
      } else {
        result = parseSimple(value) || parseViaCanvas(value);
      }
    }

    if (parseCache.size > PARSE_CACHE_MAX) parseCache.clear();
    parseCache.set(value, result);
    return result ? result.slice() : null;
  }

  /* ------------------------------------------------------------------ *
   * Conversions
   * ------------------------------------------------------------------ */

  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return [h, s, l];
  }

  function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
      Math.round(hueToRgb(p, q, h) * 255),
      Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
    ];
  }

  /** Relative luminance (WCAG), used for "is this page already dark?" checks. */
  function luminance(r, g, b) {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function toCss([r, g, b, a]) {
    const R = clamp(Math.round(r), 0, 255);
    const G = clamp(Math.round(g), 0, 255);
    const B = clamp(Math.round(b), 0, 255);
    if (a >= 1) {
      return '#' + ((1 << 24) | (R << 16) | (G << 8) | B).toString(16).slice(1);
    }
    return `rgba(${R}, ${G}, ${B}, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
  }

  function hexToHsl(hex) {
    const rgb = parse(hex) || [0, 0, 0, 1];
    return rgbToHsl(rgb[0], rgb[1], rgb[2]);
  }

  function hslToHex(h, s, l) {
    return toCss([...hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)), 1]);
  }

  NDM.colors = {
    parse, toCss, rgbToHsl, hslToRgb, hexToHsl, hslToHex,
    luminance, clamp, PASSTHROUGH
  };
})();
