/**
 * Nocturne — dark mode transformation engine (content script, document_start).
 *
 * Strategy, in priority order:
 *   1. Paint a dark floor immediately and synchronously, before first paint.
 *   2. If the site ships its own `prefers-color-scheme: dark` theme, re-emit
 *      that theme unconditionally. Native dark beats anything we synthesise.
 *   3. Otherwise mirror the site's stylesheets into an override sheet with
 *      every colour remapped. Stylesheet work only — no per-element rewriting
 *      for the overwhelming majority of a page.
 *   4. Inline `style` attributes and SVG presentation attributes get a small
 *      generated sheet keyed by data-attribute, batched against a frame budget.
 *   5. If the page is already dark, get out of the way.
 */
(() => {
  'use strict';

  const NDM = globalThis.NDM;
  if (!NDM || !NDM.theme || !NDM.settings) return;
  if (globalThis.__nocturneEngineLoaded) return;
  globalThis.__nocturneEngineLoaded = true;

  const DOC = document;
  const IS_TOP = (() => { try { return window === window.top; } catch { return false; } })();

  const COLORISH = /colou?r|background|border|outline|fill|stroke|shadow|gradient/i;
  const PREFERS_DARK = /prefers-color-scheme\s*:\s*dark/i;
  const MAX_GENERATED_CSS = 3_000_000;
  const MAX_REMOTE_SHEETS = 40;
  const MAX_SHADOW_ROOTS = 250;
  const ELEMENT_BUDGET = 400;
  const SITE_THEME_MIN_DECLS = 12;
  /** Near-invisible marker used to tell "our background" from "the site's". */
  const PROBE_COLOR = 'rgba(1, 2, 3, 0.004)';

  const INLINE_ATTR = 'data-ndm-s';
  const PRES_ATTR = 'data-ndm-a';
  const PRES_ATTRS = ['fill', 'stroke', 'bgcolor', 'stop-color'];
  const ELEMENT_QUERY = '[style],[fill],[stroke],[bgcolor],[stop-color]';
  /** Attributes sites flip on <html>/<body> to switch to their own dark theme. */
  const THEME_ATTRS = ['data-theme', 'data-bs-theme', 'data-color-mode', 'data-color-scheme'];

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  let settings = NDM.settings.normalize(null);
  let theme = NDM.theme.derive(settings);
  let transformer = NDM.theme.makeTransformer(theme);

  /** 'generic' | 'site-theme' | 'passthrough' */
  let mode = 'generic';
  let active = true;
  let siteThemeRejected = false;
  let passthroughBg = null;
  /** The page's own settled background, mirrored onto <html> so the area
   *  below short content matches the content instead of banding against it. */
  let rootOverride = null;
  let parseComplete = DOC.readyState !== 'loading';

  const els = { base: null, gen: null, inline: null, probe: null };
  let sheetCache = new WeakMap();     // CSSStyleSheet -> cache entry
  const remoteCache = new Map();      // href -> entry | 'pending' | 'failed'
  const shadowRoots = new Set();
  const shadowStyles = new WeakMap();
  const ownInlineWrites = new WeakMap(); // element -> style attr text we wrote

  const inlineIndex = new Map();
  const attrIndex = new Map();
  let inlineSeq = 0;
  let attrSeq = 0;
  let inlineCssDirty = false;

  const pendingElements = new Set();
  let pendingRoots = [];
  let elementTaskQueued = false;
  let buildTimer = 0;
  let revalidateTimer = 0;
  let sheetSignature = '';
  let warned = 0;

  function warn(...args) {
    if (warned++ > 5) return;
    try { console.warn('[Nocturne]', ...args); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Style element plumbing
   * ------------------------------------------------------------------ */

  function makeStyle(id) {
    const el = DOC.createElement('style');
    if (id) el.id = id;
    el.setAttribute('data-nocturne', '');
    el.media = 'all';
    return el;
  }

  /** Keep our sheets as the final children of <html> so that, at equal
   *  specificity, our `!important` declarations beat the site's. */
  function mountStyles() {
    const root = DOC.documentElement;
    if (!root) return false;
    if (!els.base) {
      els.base = makeStyle('nocturne-base');
      els.gen = makeStyle('nocturne-generated');
      els.inline = makeStyle('nocturne-inline');
      els.probe = makeStyle('nocturne-probe');
    }
    const ordered =
      els.base.parentNode === root &&
      els.base.nextSibling === els.gen &&
      els.gen.nextSibling === els.inline &&
      els.inline.nextSibling === els.probe &&
      els.probe.nextSibling === null;
    if (!ordered) {
      root.appendChild(els.base);
      root.appendChild(els.gen);
      root.appendChild(els.inline);
      root.appendChild(els.probe);
    }
    return true;
  }

  function setCss(el, css) {
    if (el && el.textContent !== css) el.textContent = css;
  }

  /**
   * The root background. `flash-guard.css` paints `var(--ndm-root-bg, #171717)`
   * without `!important` before this script even runs; here we take ownership.
   * Sub-frames stay transparent so that transparent overlay iframes (ads,
   * widgets, captchas) are not turned into opaque dark rectangles — and a
   * transparent frame over an already-dark parent is dark anyway.
   */
  function rootBgCss() {
    if (mode === 'passthrough') {
      return `:root { --ndm-root-bg: ${passthroughBg || theme.bg}; }\n`;
    }
    const value = IS_TOP ? (rootOverride || theme.bg) : 'transparent';
    return `:root { --ndm-root-bg: ${value}; }\n` +
           `:root:root { background-color: var(--ndm-root-bg) !important; }\n`;
  }

  function applyBase() {
    if (!mountStyles()) return;
    const body = NDM.theme.baseCss(theme, settings, { minimal: mode === 'passthrough' });
    setCss(els.base, rootBgCss() + body);
  }

  /* ------------------------------------------------------------------ *
   * Declaration transformation
   * ------------------------------------------------------------------ */

  /**
   * Build the `!important` declaration list for one CSSStyleDeclaration.
   * The CSSOM has already expanded shorthands into longhands, so we never have
   * to reason about values like `background: #fff url(hero.png) no-repeat`.
   */
  function declsFor(style) {
    let out = '';
    const count = style.length;
    for (let i = 0; i < count; i++) {
      const prop = style[i];
      if (!prop) continue;
      const role = NDM.theme.roleOf(prop);
      if (!role) continue;
      let raw;
      try { raw = style.getPropertyValue(prop); } catch { continue; }
      if (!raw) continue;
      const next = transformer.value(prop, raw, role);
      if (next === null) continue;
      out += prop + ':' + next + ' !important;';
    }
    return out;
  }

  /** Re-emit a rule verbatim but forced. Used for the site's own dark theme. */
  function forcedDecls(style) {
    let out = '';
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (!prop) continue;
      let raw;
      try { raw = style.getPropertyValue(prop); } catch { continue; }
      if (!raw) continue;
      out += prop + ':' + raw + ' !important;';
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Stylesheet walking
   * ------------------------------------------------------------------ */

  // Feature-detected rule constructors. Classifying by instanceof avoids
  // touching `rule.cssText`, which would serialise every nested rule of a
  // large @media block on every pass.
  const R = {
    Style: globalThis.CSSStyleRule,
    Import: globalThis.CSSImportRule,
    Media: globalThis.CSSMediaRule,
    Supports: globalThis.CSSSupportsRule,
    Container: globalThis.CSSContainerRule,
    LayerBlock: globalThis.CSSLayerBlockRule,
    Keyframes: globalThis.CSSKeyframesRule,
    FontFace: globalThis.CSSFontFaceRule,
    Page: globalThis.CSSPageRule
  };
  const is = (rule, ctor) => !!ctor && rule instanceof ctor;

  function rulesOf(sheet) {
    try { return sheet.cssRules; } catch { return null; }
  }

  /** Reconstruct a grouping rule's prelude without serialising its body. */
  function preludeOf(rule) {
    if (is(rule, R.Media)) return '@media ' + rule.media.mediaText;
    if (is(rule, R.Supports)) return '@supports ' + rule.conditionText;
    if (is(rule, R.Container)) {
      const name = rule.containerName ? rule.containerName + ' ' : '';
      return '@container ' + name + rule.conditionText;
    }
    if (is(rule, R.LayerBlock)) return ''; // flatten: we want to win the cascade
    return null; // unknown grouping rule — flatten as a best effort
  }

  /** Drop the prefers-color-scheme test, keep any other media conditions. */
  function stripPrefersDark(mediaText) {
    const condition = mediaText
      .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '')
      .replace(/\band\s+and\b/gi, 'and')
      .replace(/^\s*and\s+/i, '')
      .replace(/\s+and\s*$/i, '')
      .replace(/,\s*,/g, ',')
      .replace(/^\s*,|,\s*$/g, '')
      .trim();
    return condition ? '@media ' + condition : '';
  }

  /** Resolve a CSS-nested selector against its parent (`&` substitution). */
  function resolveNested(parentSelector, childSelector) {
    const parent = ':is(' + parentSelector + ')';
    return childSelector.split(',').map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      return trimmed.includes('&') ? trimmed.replace(/&/g, parent) : parent + ' ' + trimmed;
    }).filter(Boolean).join(',');
  }

  /** Rewrite the top-level selectors of a generated CSS fragment. */
  function reparent(css, parentSelector) {
    return css.replace(/(^|\})([^{}@]+)\{/g, (match, close, selector) =>
      close + resolveNested(parentSelector, selector) + '{');
  }

  /**
   * Walk a rule list, producing (a) the transformed override CSS and (b) a
   * verbatim copy of anything the site had behind `prefers-color-scheme: dark`.
   */
  function walkRules(rules, ctx) {
    let css = '';
    let dark = '';
    if (!rules) return { css, dark };

    const count = rules.length;
    for (let i = 0; i < count; i++) {
      const rule = rules[i];
      if (!rule) continue;
      try {
        if (is(rule, R.Keyframes) || is(rule, R.FontFace) || is(rule, R.Page)) continue;

        if (is(rule, R.Import)) {
          if (!rule.styleSheet) continue;
          const inner = walkRules(rulesOf(rule.styleSheet), ctx);
          css += inner.css;
          dark += inner.dark;
          continue;
        }

        if (is(rule, R.Style)) {
          const selector = rule.selectorText;
          if (!selector || selector.includes('data-ndm-')) continue;

          if (ctx.verbatim) {
            const forced = forcedDecls(rule.style);
            if (forced) {
              dark += selector + '{' + forced + '}';
              ctx.darkDecls += rule.style.length;
            }
          } else {
            const decls = declsFor(rule.style);
            if (decls) css += selector + '{' + decls + '}';
          }

          if (rule.cssRules && rule.cssRules.length) {
            const nested = walkRules(rule.cssRules, ctx);
            if (nested.css) css += reparent(nested.css, selector);
            if (nested.dark) dark += reparent(nested.dark, selector);
          }
          continue;
        }

        if (!rule.cssRules) continue;

        // Grouping rule.
        if (is(rule, R.Media) && PREFERS_DARK.test(rule.media.mediaText)) {
          // The site has a real dark theme. Capture it verbatim.
          const darkCtx = { verbatim: true, darkDecls: 0 };
          const inner = walkRules(rule.cssRules, darkCtx);
          ctx.darkDecls += darkCtx.darkDecls;
          if (inner.dark) {
            const wrapper = stripPrefersDark(rule.media.mediaText);
            dark += wrapper ? wrapper + '{' + inner.dark + '}' : inner.dark;
          }
          continue;
        }

        const prelude = preludeOf(rule);
        const inner = walkRules(rule.cssRules, ctx);
        if (prelude) {
          if (inner.css) css += prelude + '{' + inner.css + '}';
          if (inner.dark) dark += prelude + '{' + inner.dark + '}';
        } else {
          css += inner.css;
          dark += inner.dark;
        }
      } catch (error) {
        warn('rule skipped', error);
      }
    }

    return { css, dark };
  }

  function isOwnSheet(sheet) {
    const node = sheet.ownerNode;
    return !!node && node.nodeType === 1 && node.hasAttribute('data-nocturne');
  }

  const EMPTY = { css: '', dark: '', darkDecls: 0 };

  function processSheet(sheet) {
    if (!sheet || sheet.disabled || isOwnSheet(sheet)) return EMPTY;

    const rules = rulesOf(sheet);
    if (!rules) {
      // Cross-origin stylesheet: the service worker fetches it for us.
      const href = sheet.href;
      if (!href || !/^https?:/i.test(href)) return EMPTY;
      const cached = remoteCache.get(href);
      if (cached && typeof cached === 'object') return cached;
      if (cached === undefined && remoteCache.size < MAX_REMOTE_SHEETS) requestRemote(href);
      return EMPTY;
    }

    const cached = sheetCache.get(sheet);
    if (cached && cached.count === rules.length) return cached;

    const ctx = { verbatim: false, darkDecls: 0 };
    const result = walkRules(rules, ctx);
    const entry = {
      count: rules.length,
      css: result.css,
      dark: result.dark,
      darkDecls: ctx.darkDecls
    };
    sheetCache.set(sheet, entry);
    return entry;
  }

  /* ---------------- cross-origin stylesheets ---------------- */

  function absolutizeUrls(cssText, baseUrl) {
    return cssText.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, quote, url) => {
      const value = url.trim();
      if (!value || /^(data:|blob:|https?:|\/\/|#)/i.test(value)) return match;
      try { return 'url("' + new URL(value, baseUrl).href + '")'; } catch { return match; }
    });
  }

  function requestRemote(href) {
    remoteCache.set(href, 'pending');
    let pending;
    try {
      pending = chrome.runtime.sendMessage({ type: 'nocturne:fetch-css', url: href });
    } catch {
      remoteCache.set(href, 'failed');
      return;
    }
    Promise.resolve(pending).then((response) => {
      if (!active) return;
      if (!response || !response.ok || typeof response.css !== 'string') {
        remoteCache.set(href, 'failed');
        return;
      }
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(absolutizeUrls(response.css, href));
        const ctx = { verbatim: false, darkDecls: 0 };
        const result = walkRules(sheet.cssRules, ctx);
        remoteCache.set(href, {
          count: sheet.cssRules.length,
          css: result.css,
          dark: result.dark,
          darkDecls: ctx.darkDecls
        });
        scheduleBuild(0);
      } catch (error) {
        remoteCache.set(href, 'failed');
        warn('remote stylesheet skipped', error);
      }
    }).catch(() => {
      if (active) remoteCache.set(href, 'failed');
    });
  }

  /* ------------------------------------------------------------------ *
   * Already-dark detection
   * ------------------------------------------------------------------ */

  function opaqueBgOf(element) {
    if (!element) return null;
    let value;
    try { value = getComputedStyle(element).backgroundColor; } catch { return null; }
    const rgba = NDM.colors.parse(value);
    if (!rgba || rgba[3] < 0.9) return null;
    return rgba;
  }

  function isProbe(rgba) {
    return rgba && rgba[0] === 1 && rgba[1] === 2 && rgba[2] === 3;
  }

  /**
   * Measure the page as the *site* styles it. Our sheets are switched off and
   * the root background is swapped for a sentinel colour, so we can tell a
   * background the site declared from one we painted. Disable, read, restore
   * all happen inside a single task — the browser never paints in between.
   */
  function measureSite() {
    const sheets = [els.base, els.gen, els.inline];
    const previous = sheets.map((el) => (el && el.sheet ? el.sheet.disabled : false));
    setCss(els.probe, `:root { --ndm-root-bg: ${PROBE_COLOR} !important; }`);
    sheets.forEach((el) => { if (el && el.sheet) el.sheet.disabled = true; });

    const out = { bgLum: null, textLum: null, opaque: false, bg: null };
    try {
      const body = DOC.body;
      let rgba = opaqueBgOf(body);
      if (!rgba) {
        const rootRgba = opaqueBgOf(DOC.documentElement);
        // A sentinel here means the site declares no root background at all.
        if (rootRgba && !isProbe(rootRgba)) rgba = rootRgba;
      }
      if (rgba) {
        out.bgLum = NDM.colors.luminance(rgba[0], rgba[1], rgba[2]);
        out.bg = NDM.colors.toCss(rgba);
        out.opaque = true;
      }
      if (body) {
        const text = NDM.colors.parse(getComputedStyle(body).color);
        if (text) out.textLum = NDM.colors.luminance(text[0], text[1], text[2]);
      }
    } catch (error) {
      warn('measurement failed', error);
    } finally {
      sheets.forEach((el, i) => { if (el && el.sheet) el.sheet.disabled = previous[i]; });
      setCss(els.probe, '');
    }
    return out;
  }

  /** Measure the body as it currently renders, with our styles applied.
   *  Deliberately does not fall back to <html>: that background is ours. */
  function measureCurrent() {
    const rgba = opaqueBgOf(DOC.body);
    if (!rgba) return { opaque: false, bgLum: null, bg: null };
    return {
      opaque: true,
      bgLum: NDM.colors.luminance(rgba[0], rgba[1], rgba[2]),
      bg: NDM.colors.toCss(rgba)
    };
  }

  /** Mirror the settled page background onto <html>. */
  function syncRootBackground() {
    if (!IS_TOP || mode === 'passthrough') return;
    const current = measureCurrent();
    const next = current.opaque && current.bgLum !== null && current.bgLum < 0.2
      ? current.bg
      : null;
    if (next !== rootOverride) {
      rootOverride = next;
      applyBase();
    }
  }

  function looksDark(m) {
    if (!m.opaque || m.bgLum === null) return false;
    if (m.bgLum < 0.06) return true;
    return m.bgLum < 0.2 && m.textLum !== null && m.textLum > 0.35;
  }

  /**
   * Whether the site has switched itself to its own dark theme. Such pages
   * can still measure light — a light backdrop image behind dark panels — but
   * remapping them inverts the site's dark surfaces back to light ones.
   */
  function declaresDark() {
    for (const el of [DOC.documentElement, DOC.body]) {
      if (!el) continue;
      for (const attr of THEME_ATTRS) {
        if ((el.getAttribute(attr) || '').trim().toLowerCase() === 'dark') return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Build
   * ------------------------------------------------------------------ */

  function collectSheets() {
    const out = [];
    const push = (list) => {
      if (!list) return;
      for (let i = 0; i < list.length; i++) out.push(list[i]);
    };
    push(DOC.styleSheets);
    try { push(DOC.adoptedStyleSheets); } catch { /* not supported */ }
    return out;
  }

  function signatureOf(sheets) {
    let signature = sheets.length + ':';
    for (const sheet of sheets) {
      if (isOwnSheet(sheet)) continue;
      const rules = rulesOf(sheet);
      signature += rules ? rules.length + ',' : 'x' + (sheet.href || '') + ',';
    }
    return signature;
  }

  function build() {
    if (!active || !mountStyles()) return;

    try {
      const sheets = collectSheets();
      sheetSignature = signatureOf(sheets);

      if (mode === 'passthrough') {
        setCss(els.gen, '');
        setCss(els.inline, '');
        buildShadowStyles();
        return;
      }

      let generic = '';
      let siteDark = '';
      let darkDecls = 0;
      for (const sheet of sheets) {
        const entry = processSheet(sheet);
        generic += entry.css;
        siteDark += entry.dark;
        darkDecls += entry.darkDecls || 0;
      }

      mode = (settings.useSiteDarkTheme && !siteThemeRejected &&
              darkDecls >= SITE_THEME_MIN_DECLS && siteDark)
        ? 'site-theme'
        : 'generic';

      let css = mode === 'site-theme' ? siteDark : generic;
      if (css.length > MAX_GENERATED_CSS) {
        warn('generated stylesheet truncated at', MAX_GENERATED_CSS, 'bytes');
        css = css.slice(0, MAX_GENERATED_CSS);
      }
      setCss(els.gen, css);
      buildShadowStyles();
    } catch (error) {
      // Leave the base sheet alone: a readable dark page beats a white one.
      warn('build failed, keeping base theme only', error);
    }
  }

  function scheduleBuild(delay = 80) {
    if (!active) return;
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = setTimeout(() => { buildTimer = 0; build(); }, delay);
  }

  /** Cheap poll for CSSOM-only changes (styled-components and friends insert
   *  rules without touching the DOM, so no mutation record is produced). */
  function revalidate() {
    if (!active) return;
    if (!els.base || els.base.parentNode !== DOC.documentElement) applyBase();
    if (signatureOf(collectSheets()) !== sheetSignature) scheduleBuild(0);
  }

  function scheduleRevalidate() {
    if (revalidateTimer) return;
    revalidateTimer = setTimeout(() => { revalidateTimer = 0; revalidate(); }, 250);
  }

  /* ------------------------------------------------------------------ *
   * Inline styles and presentation attributes
   * ------------------------------------------------------------------ */

  function processInlineStyle(el) {
    const raw = el.getAttribute('style');
    if (!raw || !COLORISH.test(raw)) {
      if (el.hasAttribute(INLINE_ATTR)) el.removeAttribute(INLINE_ATTR);
      return;
    }
    // Do not re-transform a value we wrote ourselves: that oscillates.
    if (ownInlineWrites.get(el) === raw) return;

    let entry = inlineIndex.get(raw);
    if (entry === undefined) {
      let decls = '';
      try { decls = declsFor(el.style); } catch { decls = ''; }
      entry = decls ? { id: ++inlineSeq, decls, src: raw } : null;
      if (inlineIndex.size > 6000) inlineIndex.clear();
      inlineIndex.set(raw, entry);
      if (entry) inlineCssDirty = true;
    }

    if (!entry) {
      if (el.hasAttribute(INLINE_ATTR)) el.removeAttribute(INLINE_ATTR);
      return;
    }
    const id = String(entry.id);
    if (el.getAttribute(INLINE_ATTR) !== id) el.setAttribute(INLINE_ATTR, id);

    // An inline `!important` declaration outranks any stylesheet we can emit,
    // so that rare case has to be rewritten in place.
    if (raw.includes('!important')) rewriteImportantInline(el);
  }

  function rewriteImportantInline(el) {
    const style = el.style;
    let touched = false;
    for (let i = style.length - 1; i >= 0; i--) {
      const prop = style[i];
      const role = NDM.theme.roleOf(prop);
      if (!role || style.getPropertyPriority(prop) !== 'important') continue;
      const next = transformer.value(prop, style.getPropertyValue(prop), role);
      if (next === null) continue;
      try { style.setProperty(prop, next, 'important'); touched = true; } catch { /* ignore */ }
    }
    if (touched) ownInlineWrites.set(el, el.getAttribute('style'));
  }

  /**
   * SVG/legacy presentation attributes. Deliberately conservative: only
   * near-black and near-white values are touched, so brand colours and
   * illustrations are left alone.
   */
  function processPresentationAttrs(el) {
    let signature = '';
    let decls = '';
    for (const attr of PRES_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const lower = value.trim().toLowerCase();
      if (lower === 'none' || lower === 'currentcolor' || lower.startsWith('url(')) continue;
      const rgba = NDM.colors.parse(value);
      if (!rgba || rgba[3] === 0) continue;
      const lightness = NDM.colors.rgbToHsl(rgba[0], rgba[1], rgba[2])[2];
      if (lightness > 0.3 && lightness < 0.72) continue;
      const next = transformer.color(value, attr === 'bgcolor' ? 'bg' : 'auto');
      if (!next) continue;
      signature += attr + '=' + value + ';';
      decls += (attr === 'bgcolor' ? 'background-color' : attr) + ':' + next + ' !important;';
    }

    if (!decls) {
      if (el.hasAttribute(PRES_ATTR)) el.removeAttribute(PRES_ATTR);
      return;
    }
    let entry = attrIndex.get(signature);
    if (entry === undefined) {
      entry = { id: ++attrSeq, decls };
      if (attrIndex.size > 3000) attrIndex.clear();
      attrIndex.set(signature, entry);
      inlineCssDirty = true;
    }
    const id = String(entry.id);
    if (el.getAttribute(PRES_ATTR) !== id) el.setAttribute(PRES_ATTR, id);
  }

  /**
   * Re-run the colour transform over the inline/attribute indexes in place.
   * Clearing and rebuilding them instead would briefly expose the site's
   * original light inline colours — a flash, which is the one thing this
   * extension exists to avoid.
   */
  function retransformIndexes() {
    const probe = DOC.createElement('div');
    for (const entry of inlineIndex.values()) {
      if (!entry) continue;
      try {
        probe.setAttribute('style', entry.src);
        entry.decls = declsFor(probe.style);
      } catch { /* keep the previous declarations */ }
    }
    for (const [signature, entry] of attrIndex) {
      if (!entry) continue;
      let decls = '';
      for (const pair of signature.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const attr = pair.slice(0, eq);
        const next = transformer.color(pair.slice(eq + 1), attr === 'bgcolor' ? 'bg' : 'auto');
        if (next) decls += (attr === 'bgcolor' ? 'background-color' : attr) + ':' + next + ' !important;';
      }
      entry.decls = decls;
    }
    inlineCssDirty = true;
  }

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      if (el.hasAttribute('data-nocturne')) return;
      if (el.hasAttribute('style')) processInlineStyle(el);
      for (const attr of PRES_ATTRS) {
        if (el.hasAttribute(attr)) { processPresentationAttrs(el); break; }
      }
      if (el.shadowRoot) registerShadowRoot(el.shadowRoot);
    } catch (error) {
      warn('element skipped', error);
    }
  }

  /** Our generated attribute rules have low specificity; `:not(#x)` lifts them
   *  above almost anything the site declares, short of inline `!important`. */
  function boost(selector) {
    return selector + ':not(#nocturne-x):not(#nocturne-x)';
  }

  function inlineCss() {
    let css = '';
    for (const entry of inlineIndex.values()) {
      if (entry) css += boost(`[${INLINE_ATTR}="${entry.id}"]`) + '{' + entry.decls + '}';
    }
    for (const entry of attrIndex.values()) {
      if (entry) css += boost(`[${PRES_ATTR}="${entry.id}"]`) + '{' + entry.decls + '}';
    }
    return css;
  }

  function flushInlineCss() {
    if (!inlineCssDirty || !els.inline) return;
    inlineCssDirty = false;
    setCss(els.inline, mode === 'passthrough' ? '' : inlineCss());
    buildShadowStyles();
  }

  /* ---------------- element work queue ---------------- */

  function queueElement(el) {
    if (!active) return;
    pendingElements.add(el);
    scheduleElementWork();
  }

  /** Before DOMContentLoaded the parser emits a mutation record for virtually
   *  every element on the page. Matching each node is O(1); walking each node's
   *  subtree would be quadratic, so full subtree scans wait for the full-page
   *  pass at DOMContentLoaded. */
  function queueNode(node) {
    if (!active) return;
    if (parseComplete) {
      pendingRoots.push(node);
      scheduleElementWork();
      return;
    }
    try {
      if (node.matches && node.matches(ELEMENT_QUERY)) queueElement(node);
    } catch { /* ignore */ }
  }

  function queueRoot(node) {
    if (!active || !node) return;
    pendingRoots.push(node);
    scheduleElementWork();
  }

  function scheduleElementWork() {
    if (elementTaskQueued) return;
    elementTaskQueued = true;
    const run = () => { elementTaskQueued = false; runElementWork(); };
    if (typeof requestAnimationFrame === 'function' && !DOC.hidden) requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function runElementWork() {
    if (!active) return;
    let budget = ELEMENT_BUDGET;

    while (pendingRoots.length && budget > 0) {
      const root = pendingRoots.shift();
      try {
        if (root.nodeType === 1 && root.matches && root.matches(ELEMENT_QUERY)) {
          pendingElements.add(root);
        }
        const found = root.querySelectorAll ? root.querySelectorAll(ELEMENT_QUERY) : [];
        for (const el of found) pendingElements.add(el);
        budget -= Math.max(1, found.length / 8);
      } catch (error) {
        warn('subtree skipped', error);
      }
    }

    for (const el of pendingElements) {
      if (budget-- <= 0) break;
      pendingElements.delete(el);
      processElement(el);
    }

    flushInlineCss();
    if (pendingElements.size || pendingRoots.length) scheduleElementWork();
  }

  /* ------------------------------------------------------------------ *
   * Shadow DOM
   * ------------------------------------------------------------------ *
   * Content scripts run in an isolated world, so we cannot patch the page's
   * `attachShadow`. Open roots are discovered by walking the DOM instead;
   * closed roots are not reachable by any extension. */

  function registerShadowRoot(root) {
    if (!root || shadowRoots.has(root) || shadowRoots.size >= MAX_SHADOW_ROOTS) return;
    shadowRoots.add(root);
    try {
      const style = makeStyle('');
      shadowStyles.set(root, style);
      root.appendChild(style);
      buildShadowStyle(root, style);
      observer.observe(root, OBSERVER_OPTIONS);
      queueRoot(root);
    } catch (error) {
      shadowRoots.delete(root);
      warn('shadow root skipped', error);
    }
  }

  /** Document-level selectors cannot reach into a shadow tree, so every root
   *  gets a compact copy: defaults, its own transformed rules, inline rules. */
  function buildShadowStyle(root, style) {
    if (mode === 'passthrough') { setCss(style, ''); return; }
    let css = `:host, :host(*) { color-scheme: dark; }
:where(a, a:link) { color: var(--ndm-link, ${theme.link}); }
:where(a:visited) { color: var(--ndm-link-visited, ${theme.linkVisited}); }
:where(input, textarea, select) {
  background-color: var(--ndm-input-bg, ${theme.inputBg});
  color: var(--ndm-text, ${theme.text});
  border-color: var(--ndm-border, ${theme.border});
}
:where(input, textarea)::placeholder { color: var(--ndm-text2, ${theme.text2}); opacity: 1; }
:where(button) {
  background-color: var(--ndm-bg3, ${theme.bg3});
  color: var(--ndm-text, ${theme.text});
  border-color: var(--ndm-border, ${theme.border});
}
`;
    try {
      const own = [];
      if (root.styleSheets) for (const sheet of root.styleSheets) own.push(sheet);
      if (root.adoptedStyleSheets) for (const sheet of root.adoptedStyleSheets) own.push(sheet);
      for (const sheet of own) {
        const entry = processSheet(sheet);
        css += mode === 'site-theme' ? entry.dark : entry.css;
      }
    } catch (error) {
      warn('shadow stylesheet skipped', error);
    }
    setCss(style, css + inlineCss());
  }

  function buildShadowStyles() {
    for (const root of shadowRoots) {
      const style = shadowStyles.get(root);
      if (!style) continue;
      if (!style.isConnected) {
        try { root.appendChild(style); } catch { continue; }
      }
      buildShadowStyle(root, style);
    }
  }

  function scanForShadowRoots(scope) {
    try {
      for (const el of scope.querySelectorAll('*')) {
        if (el.shadowRoot) registerShadowRoot(el.shadowRoot);
      }
    } catch (error) {
      warn('shadow scan skipped', error);
    }
  }

  /* ------------------------------------------------------------------ *
   * Observation
   * ------------------------------------------------------------------ */

  const OBSERVER_OPTIONS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'fill', 'stroke', 'bgcolor', 'stop-color', ...THEME_ATTRS]
  };

  const observer = new MutationObserver((records) => {
    if (!active) return;
    let sheetsChanged = false;
    let ownStyleRemoved = false;
    let themeChanged = false;

    for (const record of records) {
      if (record.type === 'attributes') {
        if (THEME_ATTRS.includes(record.attributeName)) {
          if (record.target === DOC.documentElement || record.target === DOC.body) themeChanged = true;
        } else if (record.target && record.target.nodeType === 1) {
          queueElement(record.target);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const tag = node.tagName;
        if (tag === 'STYLE' || tag === 'LINK') {
          if (!node.hasAttribute('data-nocturne')) sheetsChanged = true;
        } else {
          queueNode(node);
        }
      }
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-nocturne')) {
          ownStyleRemoved = true;
        }
      }
    }

    if (themeChanged) evaluatePage('theme');
    if (ownStyleRemoved) { applyBase(); scheduleBuild(0); }
    else if (sheetsChanged) scheduleBuild();
    else scheduleRevalidate();
  });

  function observeDocument() {
    try { observer.observe(DOC, OBSERVER_OPTIONS); }
    catch (error) { warn('observer failed', error); }
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle stages
   * ------------------------------------------------------------------ */

  function evaluatePage(stage) {
    if (!active || !DOC.body) return;

    const site = measureSite();
    if (looksDark(site) || declaresDark()) {
      if (mode !== 'passthrough') {
        mode = 'passthrough';
        passthroughBg = site.bg;
        applyBase();
        setCss(els.gen, '');
        setCss(els.inline, '');
        buildShadowStyles();
      }
      return;
    }
    if (mode === 'passthrough') {
      mode = 'generic';
      passthroughBg = null;
      applyBase();
      scheduleBuild(0);
    }

    // A "site theme" that still renders light is not a usable theme.
    if (mode === 'site-theme' && (stage === 'dcl' || stage === 'load')) {
      const current = measureCurrent();
      if (current.opaque && current.bgLum !== null && current.bgLum > 0.25) {
        siteThemeRejected = true;
        mode = 'generic';
        scheduleBuild(0);
        return;
      }
    }

    if (stage === 'dcl' || stage === 'load') syncRootBackground();
  }

  function onBodyAvailable() {
    applyBase();
    evaluatePage('body');
    scheduleBuild(0);
  }

  function waitForBody() {
    if (DOC.body) { onBodyAvailable(); return; }
    const root = DOC.documentElement;
    if (!root) { setTimeout(waitForBody, 5); return; }
    const bodyObserver = new MutationObserver(() => {
      if (DOC.body) { bodyObserver.disconnect(); onBodyAvailable(); }
    });
    try { bodyObserver.observe(root, { childList: true }); }
    catch { setTimeout(waitForBody, 10); }
  }

  /* ------------------------------------------------------------------ *
   * Teardown / reactivation
   * ------------------------------------------------------------------ */

  function teardown() {
    active = false;
    if (buildTimer) { clearTimeout(buildTimer); buildTimer = 0; }
    try { observer.disconnect(); } catch { /* ignore */ }

    for (const key of ['base', 'gen', 'inline', 'probe']) {
      const el = els[key];
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    for (const root of shadowRoots) {
      const style = shadowStyles.get(root);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    }
    shadowRoots.clear();

    try {
      for (const el of DOC.querySelectorAll(`[${INLINE_ATTR}],[${PRES_ATTR}]`)) {
        el.removeAttribute(INLINE_ATTR);
        el.removeAttribute(PRES_ATTR);
      }
    } catch { /* ignore */ }

    inlineIndex.clear();
    attrIndex.clear();
    pendingElements.clear();
    pendingRoots = [];
  }

  function reactivate() {
    active = true;
    mode = 'generic';
    siteThemeRejected = false;
    passthroughBg = null;
    rootOverride = null;
    sheetCache = new WeakMap();
    remoteCache.clear();
    applyBase();
    observeDocument();
    scheduleBuild(0);
    if (DOC.body) {
      evaluatePage('reactivate');
      queueRoot(DOC.documentElement);
      scanForShadowRoots(DOC);
    }
  }

  function applySettings(next, { initial = false } = {}) {
    const wasActive = active;
    settings = next;
    theme = NDM.theme.derive(settings);
    transformer = NDM.theme.makeTransformer(theme);

    if (!NDM.settings.isActiveFor(settings, location.href)) {
      if (wasActive || initial) teardown();
      return;
    }
    if (!wasActive) { reactivate(); return; }

    rootOverride = null;

    // Colours changed, so every cached transformation is stale. Sequence
    // numbers keep climbing so stale data-attributes can never collide.
    sheetCache = new WeakMap();
    remoteCache.clear();
    siteThemeRejected = false;
    retransformIndexes();
    applyBase();
    flushInlineCss();
    // Coalesce: dragging a slider in the popup fires a change per step.
    scheduleBuild(120);
    if (DOC.body) queueRoot(DOC.documentElement);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  // (1) Synchronous dark floor, built from defaults. The service worker only
  //     registers this script where Nocturne is supposed to be on, so painting
  //     dark before storage resolves is safe — and it keeps the storage
  //     round-trip off the critical path to first paint.
  applyBase();
  observeDocument();

  // (2) Real settings land a few milliseconds later.
  NDM.settings.load()
    .then((loaded) => applySettings(loaded, { initial: true }))
    .catch((error) => warn('settings load failed, using defaults', error));

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[NDM.settings.STORAGE_KEY]) return;
      try {
        applySettings(NDM.settings.normalize(changes[NDM.settings.STORAGE_KEY].newValue));
      } catch (error) {
        warn('settings update failed', error);
      }
    });
  } catch (error) {
    warn('storage listener unavailable', error);
  }

  // The popup asks what we are actually doing on this page.
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'nocturne:status' || !IS_TOP) return false;
      sendResponse({ active, mode, host: location.hostname });
      return false;
    });
  } catch (error) {
    warn('status listener unavailable', error);
  }

  waitForBody();

  DOC.addEventListener('DOMContentLoaded', () => {
    parseComplete = true;
    if (!active) return;
    applyBase();
    evaluatePage('dcl');
    scheduleBuild(0);
    queueRoot(DOC.documentElement);
    scanForShadowRoots(DOC);
  }, { once: true });

  window.addEventListener('load', () => {
    parseComplete = true;
    if (!active) return;
    evaluatePage('load');
    scanForShadowRoots(DOC);
    scheduleBuild(0);
    // CSS-in-JS frameworks commonly finish injecting rules after load.
    setTimeout(() => { revalidate(); syncRootBackground(); }, 400);
    setTimeout(() => { revalidate(); syncRootBackground(); }, 1500);
  }, { once: true });
})();
