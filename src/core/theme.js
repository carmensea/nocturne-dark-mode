/**
 * Nocturne — turns user settings into (a) a concrete palette, (b) a base
 * stylesheet, and (c) a colour transformer used to rewrite the site's own CSS.
 *
 * The transformer never inverts. It maps lightness through a piecewise curve
 * per colour *role* (background / text / border / shadow), keeps hue, and pulls
 * saturation down so brand colours survive but stop shouting.
 */
(() => {
  'use strict';
  const NDM = (globalThis.NDM ||= {});
  if (NDM.theme) return;

  const C = NDM.colors;
  const { clamp } = C;
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Interpolate through a sorted list of [input, output] anchor points. */
  function piecewise(anchors, x) {
    if (x <= anchors[0][0]) return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) {
      const [x1, y1] = anchors[i];
      if (x <= x1) {
        const [x0, y0] = anchors[i - 1];
        return x1 === x0 ? y1 : lerp(y0, y1, (x - x0) / (x1 - x0));
      }
    }
    return anchors[anchors.length - 1][1];
  }

  /* ------------------------------------------------------------------ *
   * Palette derivation
   * ------------------------------------------------------------------ */

  const WARM_HUE = 32 / 360;
  const WARM_SAT = 0.14;
  const NEUTRAL_SAT = 0.1; // below this a colour counts as "grey"

  function derive(settings) {
    const p = settings.palette;

    const [bgH, bgS, bgL0] = C.hexToHsl(p.bg);
    const [, , bg2L0] = C.hexToHsl(p.bg2);
    const [txH, txS, txL0] = C.hexToHsl(p.text);
    const [tx2H, tx2S, tx2L0] = C.hexToHsl(p.text2);
    const [lkH, lkS, lkL0] = C.hexToHsl(p.link);
    const [lvH, lvS, lvL0] = C.hexToHsl(p.linkVisited);
    const [brH, brS, brL0] = C.hexToHsl(p.border);

    // 50 is "palette as authored"; 0 softens, 100 deepens.
    let bgScale = 1 + ((50 - settings.backgroundDarkness) / 50) * 0.6;
    let textScale = 1 + ((settings.textContrast - 50) / 50) * 0.2;
    if (settings.extraDark) {
      bgScale *= 0.5;
      textScale *= 0.93;
    }

    const bgL = clamp(bgL0 * bgScale, 0.015, 0.26);
    const surfaceDelta = Math.max(0.018, bg2L0 - bgL0);
    const bg2L = clamp(bgL + surfaceDelta, bgL + 0.015, 0.3);
    const bg3L = clamp(bg2L + surfaceDelta * 0.8, bg2L + 0.012, 0.34);

    const textL = clamp(txL0 * textScale, 0.42, 0.97);
    const textDelta = Math.max(0.08, txL0 - tx2L0);
    const text2L = clamp(textL - textDelta, bgL + 0.2, textL - 0.04);

    // Borders track the background so they stay perceptible but never glow.
    const bgRatio = bgL0 > 0 ? bgL / bgL0 : 1;
    const borderL = clamp(Math.max(brL0 * bgRatio, bgL + 0.075), 0.09, 0.42);

    const warm = settings.warmText === true;
    const textHue = warm && txS < NEUTRAL_SAT ? WARM_HUE : txH;
    const textSat = warm && txS < NEUTRAL_SAT ? WARM_SAT : txS;
    const text2Hue = warm && tx2S < NEUTRAL_SAT ? WARM_HUE : tx2H;
    const text2Sat = warm && tx2S < NEUTRAL_SAT ? WARM_SAT * 0.8 : tx2S;

    const linkL = clamp(lkL0 * textScale, 0.42, 0.86);
    const visitedL = clamp(lvL0 * textScale, 0.42, 0.86);

    const imageBrightness = settings.dimImages
      ? (settings.extraDark
          ? Math.min(settings.imageBrightness, 80)
          : settings.imageBrightness) / 100
      : 1;

    const satFactor = settings.extraDark ? 0.75 : 1;
    // Keep the gaps between near-white surfaces proportional to how dark the
    // user has asked for, so extra-dark stays extra dark.
    const surfaceSpread = clamp(bgL / 0.09, 0.5, 1.4);

    return {
      // Concrete colours used by the base stylesheet.
      bg: C.hslToHex(bgH, bgS, bgL),
      bg2: C.hslToHex(bgH, bgS, bg2L),
      bg3: C.hslToHex(bgH, bgS, bg3L),
      inputBg: C.hslToHex(bgH, bgS, clamp(bgL + surfaceDelta * 1.3, bgL + 0.02, 0.32)),
      text: C.hslToHex(textHue, textSat, textL),
      text2: C.hslToHex(text2Hue, text2Sat, text2L),
      link: C.hslToHex(lkH, Math.min(lkS, 0.55), linkL),
      linkVisited: C.hslToHex(lvH, Math.min(lvS, 0.5), visitedL),
      border: C.hslToHex(brH, Math.min(brS, 0.3), borderL),
      accent: C.hslToHex(lkH, Math.min(lkS, 0.5), clamp(linkL * 0.85, 0.3, 0.6)),
      selectionBg: C.hslToHex(lkH, Math.min(lkS, 0.45), clamp(bgL + 0.17, 0.14, 0.4)),
      imageBrightness,

      // Parameters for the colour transformer.
      t: {
        warm,
        bgL,
        /**
         * Background lightness curve. The top of the range is deliberately
         * non-linear: sites build hierarchy out of #fff / #fafafa / #f1f3f4,
         * and a straight inversion would collapse all of them onto the page
         * background. Only true white lands on the configured background.
         */
        bgAnchors: [
          [0, Math.max(0.02, bgL * 0.72)],        // black -> a slight lift
          [0.5, Math.min(0.34, bgL + 0.19)],      // mid grey
          [0.85, bgL + 0.105 * surfaceSpread],    // light grey
          [0.96, bgL + 0.055 * surfaceSpread],    // near white
          [1, bgL]                                // white -> the background
        ],
        textHi: textL,                                   // black text -> this
        textLo: Math.max(bgL + 0.26, textL * 0.7),       // mid grey text -> this
        textCeil: Math.min(0.94, textL * 1.12),
        borderHi: borderL,                               // white border -> this
        borderLo: Math.min(0.44, borderL + 0.16),        // black border -> this
        satBg: 0.5 * satFactor, satBgCap: 0.38 * satFactor,
        satText: 0.72 * satFactor, satTextCap: 0.52 * satFactor,
        satBorder: 0.45 * satFactor, satBorderCap: 0.32 * satFactor,
        textHue: textHue, textSat: textSat,
        minTextSeparation: 0.22
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Colour transformer
   * ------------------------------------------------------------------ */

  const BG_PROPS = new Set(['background', 'background-color', 'background-image']);
  const TEXT_PROPS = new Set([
    'color', '-webkit-text-fill-color', '-webkit-text-stroke-color',
    'caret-color', 'text-decoration-color', 'text-emphasis-color',
    'text-decoration', '-webkit-text-decoration'
  ]);
  const SHADOW_PROPS = new Set(['box-shadow', 'text-shadow', '-webkit-box-shadow']);
  const AUTO_PROPS = new Set([
    'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color',
    'accent-color', 'scrollbar-color', 'color-scheme-ignore'
  ]);

  /** Which lightness curve applies to a given CSS property. */
  function roleOf(prop) {
    const name = prop.toLowerCase();
    if (name.startsWith('--')) return 'auto';
    if (BG_PROPS.has(name)) return 'bg';
    if (TEXT_PROPS.has(name)) return 'text';
    if (SHADOW_PROPS.has(name)) return 'shadow';
    if (AUTO_PROPS.has(name)) return 'auto';
    if (name.startsWith('border') || name.startsWith('outline') ||
        name.startsWith('column-rule')) {
      return name.includes('image') ? null : 'border';
    }
    if (name.endsWith('-color')) return 'auto';
    return null;
  }

  function makeTransformer(theme) {
    const t = theme.t;
    const cache = new Map();

    function mapColor(rgba, role) {
      const [r, g, b, a] = rgba;
      if (a === 0) return null; // fully transparent: nothing to see, leave it
      let [h, s, l] = C.rgbToHsl(r, g, b);
      let L = l;
      let S = s;
      let H = h;

      switch (role) {
        case 'bg':
          L = piecewise(t.bgAnchors, l);
          S = Math.min(s * t.satBg, t.satBgCap);
          break;

        case 'text':
          L = l <= 0.5
            ? lerp(t.textHi, t.textLo, l / 0.5)
            : clamp(l, t.textLo, t.textCeil);
          S = Math.min(s * t.satText, t.satTextCap);
          if (L < t.bgL + t.minTextSeparation) L = t.bgL + t.minTextSeparation;
          if (t.warm && s < 0.1) { H = t.textHue; S = Math.max(S, t.textSat * 0.8); }
          break;

        case 'border':
          L = lerp(t.borderLo, t.borderHi, l);
          S = Math.min(s * t.satBorder, t.satBorderCap);
          break;

        case 'shadow':
          // Dark shadows stay dark (harmless on a dark page). Light "glow"
          // shadows used as faux borders get pulled down instead.
          if (l <= 0.5) return null;
          L = lerp(t.borderLo, t.borderHi, l);
          S = Math.min(s * t.satBorder, t.satBorderCap);
          break;

        case 'auto':
        default:
          if (l >= 0.6) {
            L = piecewise(t.bgAnchors, l);
            S = Math.min(s * t.satBg, t.satBgCap);
          } else {
            L = lerp(t.textHi, Math.max(t.bgL + 0.24, t.textLo * 0.95), l / 0.6);
            S = Math.min(s * t.satText, t.satTextCap);
            if (t.warm && s < 0.1) { H = t.textHue; S = Math.max(S, t.textSat * 0.8); }
          }
          break;
      }

      L = clamp(L, 0, 1);
      const [nr, ng, nb] = C.hslToRgb(H, clamp(S, 0, 1), L);
      if (nr === r && ng === g && nb === b) return null;
      return C.toCss([nr, ng, nb, a]);
    }

    /** Transform a single colour string; returns null when unchanged. */
    function color(value, role) {
      const key = role + '|' + value;
      if (cache.has(key)) return cache.get(key);
      const rgba = C.parse(value);
      const out = rgba ? mapColor(rgba, role) : null;
      if (cache.size > 8000) cache.clear();
      cache.set(key, out);
      return out;
    }

    /* ---------------- value tokenizer ---------------- */

    const COLOR_FNS = new Set([
      'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
      'color', 'color-mix', 'light-dark'
    ]);
    const SKIP_FNS = new Set(['url', 'var', 'attr', 'image-set', '-webkit-image-set', 'counter']);
    const IDENT_CHAR = /[-\w]/;

    function matchParen(str, openIndex) {
      let depth = 0;
      for (let i = openIndex; i < str.length; i++) {
        const ch = str[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return i; }
        else if (ch === '"' || ch === "'") {
          const end = str.indexOf(ch, i + 1);
          if (end === -1) return -1;
          i = end;
        }
      }
      return -1;
    }

    /**
     * Rewrite every colour token inside an arbitrary declaration value,
     * leaving url(), var(), lengths, keywords and gradient geometry intact.
     * Returns null when nothing changed.
     */
    function value(prop, input, roleOverride) {
      const role = roleOverride || roleOf(prop);
      if (!role) return null;
      if (!input || input.length > 8000) return null;

      let out = '';
      let changed = false;
      let i = 0;
      const str = input;

      while (i < str.length) {
        const ch = str[i];

        // Quoted strings pass through untouched.
        if (ch === '"' || ch === "'") {
          const end = str.indexOf(ch, i + 1);
          const stop = end === -1 ? str.length : end + 1;
          out += str.slice(i, stop);
          i = stop;
          continue;
        }

        if (ch === '#') {
          let j = i + 1;
          while (j < str.length && /[0-9a-f]/i.test(str[j])) j++;
          const token = str.slice(i, j);
          const replacement = color(token, role);
          if (replacement) { out += replacement; changed = true; }
          else out += token;
          i = j;
          continue;
        }

        if (IDENT_CHAR.test(ch) && !/\d/.test(ch)) {
          let j = i;
          while (j < str.length && IDENT_CHAR.test(str[j])) j++;
          const ident = str.slice(i, j);
          const lower = ident.toLowerCase();

          if (str[j] === '(') {
            const close = matchParen(str, j);
            if (close === -1) { out += str.slice(i); break; }
            const whole = str.slice(i, close + 1);

            if (SKIP_FNS.has(lower)) {
              out += whole;
            } else if (COLOR_FNS.has(lower)) {
              const replacement = color(whole, role);
              if (replacement) {
                out += replacement;
                changed = true;
              } else {
                // Unparseable (e.g. color-mix with var()) — recurse inside.
                const inner = value(prop, str.slice(j + 1, close), role);
                if (inner !== null) { out += ident + '(' + inner + ')'; changed = true; }
                else out += whole;
              }
            } else {
              // gradients, calc(), env(), min()/max() — walk into the args.
              const inner = value(prop, str.slice(j + 1, close), role);
              if (inner !== null) { out += ident + '(' + inner + ')'; changed = true; }
              else out += whole;
            }
            i = close + 1;
            continue;
          }

          // Bare identifier: only a named colour is interesting.
          const replacement = C.PASSTHROUGH.has(lower) ? null : color(ident, role);
          if (replacement) { out += replacement; changed = true; }
          else out += ident;
          i = j;
          continue;
        }

        out += ch;
        i++;
      }

      return changed ? out : null;
    }

    return { color, value, roleOf, mapColor };
  }

  /* ------------------------------------------------------------------ *
   * Base stylesheet
   * ------------------------------------------------------------------ */

  /**
   * The floor every page gets. Broad defaults use :where() so they have zero
   * specificity — any real rule from the site (which we have already
   * transformed) wins over them. Only the root background is forced.
   */
  function baseCss(theme, settings, options = {}) {
    const v = `:root {
  color-scheme: dark !important;
  --ndm-bg: ${theme.bg};
  --ndm-bg2: ${theme.bg2};
  --ndm-bg3: ${theme.bg3};
  --ndm-input-bg: ${theme.inputBg};
  --ndm-text: ${theme.text};
  --ndm-text2: ${theme.text2};
  --ndm-link: ${theme.link};
  --ndm-link-visited: ${theme.linkVisited};
  --ndm-border: ${theme.border};
  --ndm-accent: ${theme.accent};
  --ndm-selection: ${theme.selectionBg};
  --ndm-img-brightness: ${theme.imageBrightness};
}`;

    const core = `
:where(html) { color: var(--ndm-text); }
:where(body) { background-color: var(--ndm-bg); color: var(--ndm-text); }

:where(a, a:link) { color: var(--ndm-link); }
:where(a:visited) { color: var(--ndm-link-visited); }

:where(h1, h2, h3, h4, h5, h6, b, strong, dt, legend, caption, th) { color: var(--ndm-text); }
:where(small, sub, sup, figcaption, blockquote cite, time, .ndm-never) { color: var(--ndm-text2); }
:where(hr) { border-color: var(--ndm-border); background-color: var(--ndm-border); }
:where(code, kbd, pre, samp) { background-color: var(--ndm-bg2); color: var(--ndm-text); }
:where(table, td, th) { border-color: var(--ndm-border); }

:where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="image"]):not([type="file"]),
       textarea, select, optgroup, option) {
  background-color: var(--ndm-input-bg);
  color: var(--ndm-text);
  border-color: var(--ndm-border);
}
:where(input, textarea)::placeholder { color: var(--ndm-text2); opacity: 1; }
:where(button, [type="button"], [type="submit"], [type="reset"], [role="button"]) {
  background-color: var(--ndm-bg3);
  color: var(--ndm-text);
  border-color: var(--ndm-border);
}
:where(input[type="checkbox"], input[type="radio"], progress, meter, input[type="range"]) {
  accent-color: var(--ndm-accent);
}
:where(dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]) {
  background-color: var(--ndm-bg2);
  color: var(--ndm-text);
  border-color: var(--ndm-border);
}
:where(fieldset) { border-color: var(--ndm-border); }
:where(iframe) { color-scheme: dark; background-color: transparent; }

`;

    // Safe on any page, including ones that are already dark.
    const chrome_ = `
::-webkit-scrollbar { background-color: var(--ndm-bg); width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background-color: var(--ndm-bg3); border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background-color: var(--ndm-border); }
::-webkit-scrollbar-corner { background-color: var(--ndm-bg); }
`;

    const selection = `
::selection { background-color: var(--ndm-selection); color: var(--ndm-text); }
`;

    // Media keeps its original appearance unless the user asks for dimming.
    // These elements have no descendants that could be broken by `filter`.
    const media = settings.dimImages
      ? `
img, video, canvas, picture > img, [style*="background-image"] > img {
  filter: brightness(var(--ndm-img-brightness)) !important;
}
`
      : '';

    const motion = settings.suppressTransitions
      ? `
:where(*, *::before, *::after) {
  transition-duration: 0s !important;
  animation-duration: 0.001s !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
}
`
      : '';

    // Passthrough mode: the site is already dark, so only keep the pieces that
    // cannot make it worse — scrollbars, media dimming, motion reduction.
    if (options.minimal) return v + chrome_ + media + motion;
    return v + core + chrome_ + selection + media + motion;
  }

  NDM.theme = { derive, baseCss, makeTransformer, roleOf };
})();
