/**
 * Nocturne — settings schema, normalisation, and storage access.
 * Classic script; shared by the content script, popup, and service worker.
 */
(() => {
  'use strict';
  const NDM = (globalThis.NDM ||= {});
  if (NDM.settings) return;

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'nocturne';

  const DEFAULT_PALETTE = Object.freeze({
    bg: '#171717',          // page background
    bg2: '#222222',         // cards, headers, secondary surfaces
    text: '#D4D4D4',        // primary text — deliberately not pure white
    text2: '#A3A3A3',       // secondary / muted text
    link: '#79A6D2',        // muted, readable blue
    linkVisited: '#A58BC4', // muted violet
    border: '#333333'
  });

  const DEFAULTS = Object.freeze({
    version: SCHEMA_VERSION,
    /** Master switch. Dark mode is on by default, per the design brief. */
    enabled: true,
    /** 0 = softest (lighter charcoal), 100 = near black. 50 == palette as-is. */
    backgroundDarkness: 50,
    /** 0 = lowest contrast, 100 = highest. 50 == palette as-is. */
    textContrast: 50,
    /** Shift neutral text towards a warm, paper-like tone. */
    warmText: false,
    /** Dim photos and video. */
    dimImages: false,
    /** Brightness percentage applied when dimImages is on. */
    imageBrightness: 85,
    /** Severe light-sensitivity mode: darker still, softer text, dimmer media. */
    extraDark: false,
    /** Reuse the site's own `prefers-color-scheme: dark` theme when it has one. */
    useSiteDarkTheme: true,
    /** Smooth out abrupt colour transitions the site animates. */
    suppressTransitions: false,
    palette: DEFAULT_PALETTE,
    /** hostname -> 'on' | 'off'. Absent means "follow defaultSiteState". */
    siteModes: {},
    defaultSiteState: 'on'
  });

  const PALETTE_KEYS = Object.keys(DEFAULT_PALETTE);
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  const clampNum = (value, lo, hi, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };

  /** Make any stored blob safe to use, whatever shape it is in. */
  function normalize(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const palette = {};
    for (const key of PALETTE_KEYS) {
      const value = input.palette && input.palette[key];
      palette[key] = typeof value === 'string' && HEX_RE.test(value.trim())
        ? value.trim().toLowerCase()
        : DEFAULT_PALETTE[key];
    }

    const siteModes = {};
    if (input.siteModes && typeof input.siteModes === 'object') {
      for (const [host, mode] of Object.entries(input.siteModes)) {
        if (typeof host !== 'string' || !host) continue;
        if (mode === 'on' || mode === 'off') siteModes[host.toLowerCase()] = mode;
      }
    }

    return {
      version: SCHEMA_VERSION,
      enabled: input.enabled !== false,
      backgroundDarkness: clampNum(input.backgroundDarkness, 0, 100, DEFAULTS.backgroundDarkness),
      textContrast: clampNum(input.textContrast, 0, 100, DEFAULTS.textContrast),
      warmText: input.warmText === true,
      dimImages: input.dimImages === true,
      imageBrightness: clampNum(input.imageBrightness, 30, 100, DEFAULTS.imageBrightness),
      extraDark: input.extraDark === true,
      useSiteDarkTheme: input.useSiteDarkTheme !== false,
      suppressTransitions: input.suppressTransitions === true,
      palette,
      siteModes,
      defaultSiteState: input.defaultSiteState === 'off' ? 'off' : 'on'
    };
  }

  /* ------------------------------------------------------------------ *
   * Host matching
   * ------------------------------------------------------------------ */

  /** Normalise a URL or hostname down to a bare, lowercase hostname. */
  function hostOf(input) {
    if (!input) return '';
    let host = String(input).trim().toLowerCase();
    if (host.includes('://') || host.startsWith('//')) {
      try {
        host = new URL(host.startsWith('//') ? 'https:' + host : host).hostname;
      } catch {
        return '';
      }
    } else {
      host = host.split('/')[0].split('?')[0];
    }
    if (host.startsWith('www.')) host = host.slice(4);
    return host.replace(/\.$/, '').split(':')[0];
  }

  /**
   * Resolve the stored mode for a host, honouring parent-domain rules so that
   * turning off "example.com" also covers "shop.example.com".
   */
  function siteMode(settings, urlOrHost) {
    const host = hostOf(urlOrHost);
    if (!host) return settings.defaultSiteState;
    const modes = settings.siteModes || {};
    if (modes[host]) return modes[host];
    const labels = host.split('.');
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join('.');
      if (modes[parent]) return modes[parent];
    }
    return settings.defaultSiteState;
  }

  /** True when Nocturne should be active for this URL. */
  function isActiveFor(settings, url) {
    if (!settings.enabled) return false;
    if (!isSupportedUrl(url)) return false;
    return siteMode(settings, url) === 'on';
  }

  /** Pages Chrome refuses to let any extension touch. */
  function isSupportedUrl(url) {
    if (!url) return false;
    return /^(https?|file|ftp):/i.test(url);
  }

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  async function load() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return normalize(stored && stored[STORAGE_KEY]);
    } catch (error) {
      console.warn('[Nocturne] falling back to default settings:', error);
      return normalize(null);
    }
  }

  async function save(settings) {
    const next = normalize(settings);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  /** Read-modify-write, so concurrent popup/background edits do not clobber. */
  async function update(mutator) {
    const current = await load();
    const draft = mutator({ ...current, palette: { ...current.palette }, siteModes: { ...current.siteModes } });
    return save(draft || current);
  }

  NDM.settings = {
    STORAGE_KEY, SCHEMA_VERSION, DEFAULTS, DEFAULT_PALETTE, PALETTE_KEYS,
    normalize, hostOf, siteMode, isActiveFor, isSupportedUrl,
    load, save, update
  };
})();
