/**
 * Nocturne — service worker.
 *
 * Owns three things:
 *   1. Dynamic content-script registration. Registering (rather than declaring
 *      the scripts in the manifest) is what lets per-site and global "off"
 *      take effect *before* the page loads, so a disabled site never gets a
 *      dark flash and an enabled one never gets a white one.
 *   2. Fetching cross-origin stylesheets on the engine's behalf. Content
 *      scripts in MV3 cannot read a CDN stylesheet; the worker can, using the
 *      extension's host permissions.
 *   3. The toolbar badge and keyboard shortcuts.
 */
importScripts('/src/core/settings.js');

const NDM = globalThis.NDM;
const SCRIPT_ID = 'nocturne-core';
const FILE_SCRIPT_ID = 'nocturne-core-file';

const ENGINE_JS = [
  'src/core/colors.js',
  'src/core/settings.js',
  'src/core/theme.js',
  'src/content/engine.js'
];
const ENGINE_CSS = ['src/content/flash-guard.css'];

/* -------------------------------------------------------------------- *
 * Content script registration
 * -------------------------------------------------------------------- */

const patternsFor = (host) => [`*://${host}/*`, `*://*.${host}/*`];

/**
 * Decide which URLs the engine should be injected into.
 * Default-on sites use a broad match plus exclusions; default-off flips to an
 * allow-list so we never inject where we are not wanted.
 */
function registrationFor(settings) {
  if (!settings.enabled) return null;

  const off = [];
  const on = [];
  for (const [host, mode] of Object.entries(settings.siteModes)) {
    (mode === 'off' ? off : on).push(host);
  }

  if (settings.defaultSiteState === 'on') {
    const spec = { matches: ['http://*/*', 'https://*/*'] };
    if (off.length) spec.excludeMatches = off.flatMap(patternsFor);
    return spec;
  }
  if (!on.length) return null;
  return { matches: on.flatMap(patternsFor) };
}

function scriptSpec(id, spec) {
  return {
    id,
    js: ENGINE_JS,
    css: ENGINE_CSS,
    matches: spec.matches,
    ...(spec.excludeMatches ? { excludeMatches: spec.excludeMatches } : {}),
    runAt: 'document_start',
    allFrames: true,
    // Covers about:blank/about:srcdoc/data: frames whose initiator matches.
    // (There is no `matchAboutBlank` here — that key exists only on the
    // manifest's static `content_scripts`, not on this dynamic API; passing
    // it throws and silently kills registration.)
    matchOriginAsFallback: true,
    world: 'ISOLATED',
    persistAcrossSessions: true
  };
}

async function unregister(id) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); }
  catch { /* not registered */ }
}

async function applyScript(id, spec, { quiet = false } = {}) {
  if (!spec) { await unregister(id); return; }

  const desired = scriptSpec(id, spec);
  let existing = [];
  try { existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }); }
  catch { existing = []; }

  try {
    // Update in place when possible: unregister/register would leave a window
    // in which a navigation gets no styling at all.
    if (existing.length) await chrome.scripting.updateContentScripts([desired]);
    else await chrome.scripting.registerContentScripts([desired]);
  } catch (error) {
    // `matchOriginAsFallback` needs Chrome 119+. Retry without it.
    const { matchOriginAsFallback, ...fallback } = desired;
    try {
      if (existing.length) await chrome.scripting.updateContentScripts([fallback]);
      else await chrome.scripting.registerContentScripts([fallback]);
    } catch (retryError) {
      await unregister(id);
      try {
        await chrome.scripting.registerContentScripts([fallback]);
      } catch (finalError) {
        // Expected for file:// when the user has not granted file access.
        if (!quiet) console.error('[Nocturne] registration failed', finalError);
      }
    }
  }
}

let registrationSignature = null;

async function ensureRegistration(force = false) {
  const settings = await NDM.settings.load();
  const spec = registrationFor(settings);
  const signature = JSON.stringify(spec);
  if (!force && signature === registrationSignature) return;
  registrationSignature = signature;

  await applyScript(SCRIPT_ID, spec);

  // `file://` injection only works if the user has ticked "Allow access to
  // file URLs" on the extension's details page. Attempt it, ignore failure.
  if (spec && spec.matches.includes('http://*/*')) {
    const fileSpec = { matches: ['file:///*'], excludeMatches: spec.excludeMatches };
    try { await applyScript(FILE_SCRIPT_ID, fileSpec, { quiet: true }); }
    catch { await unregister(FILE_SCRIPT_ID); }
  } else {
    await unregister(FILE_SCRIPT_ID);
  }
}

/* -------------------------------------------------------------------- *
 * Injecting into tabs that are already open
 * -------------------------------------------------------------------- */

/**
 * Registration only affects future navigations. When a site is switched on,
 * push the engine into the tabs showing it right now. The engine guards
 * against double-injection, so this is safe to call speculatively.
 */
async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ENGINE_CSS
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ENGINE_JS,
      world: 'ISOLATED'
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function injectIntoMatchingTabs(settings) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  await Promise.all(tabs.map((tab) => {
    if (!tab.id || !tab.url) return null;
    if (!NDM.settings.isActiveFor(settings, tab.url)) return null;
    return injectIntoTab(tab.id);
  }));
}

/* -------------------------------------------------------------------- *
 * Badge
 * -------------------------------------------------------------------- */

const BADGE_BG = '#2a2a2a';

async function updateBadge(tabId, url, settings) {
  if (!tabId) return;
  try {
    const config = settings || await NDM.settings.load();
    let text = '';
    if (!config.enabled) text = 'off';
    else if (!NDM.settings.isSupportedUrl(url)) text = '—';
    else if (NDM.settings.siteMode(config, url) === 'off') text = 'off';

    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: '#a3a3a3' });
      }
    }
  } catch { /* tab closed mid-update */ }
}

async function refreshAllBadges(settings) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const config = settings || await NDM.settings.load();
  await Promise.all(tabs.map((tab) => updateBadge(tab.id, tab.url, config)));
}

/* -------------------------------------------------------------------- *
 * Cross-origin stylesheet fetching
 * -------------------------------------------------------------------- */

const MAX_CSS_BYTES = 4_000_000;
const CSS_TIMEOUT_MS = 8000;
const cssCache = new Map();
const CSS_CACHE_MAX = 120;

async function fetchCss(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'unsupported-scheme' };
  if (cssCache.has(url)) return { ok: true, css: cssCache.get(url) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CSS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, reason: 'http-' + response.status };

    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('css') && !type.includes('text/plain') && !type.includes('octet-stream')) {
      return { ok: false, reason: 'not-css' };
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_CSS_BYTES) return { ok: false, reason: 'too-large' };

    const css = await response.text();
    if (css.length > MAX_CSS_BYTES) return { ok: false, reason: 'too-large' };

    if (cssCache.size >= CSS_CACHE_MAX) cssCache.delete(cssCache.keys().next().value);
    cssCache.set(url, css);
    return { ok: true, css };
  } catch (error) {
    return { ok: false, reason: error && error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- *
 * Messaging
 * -------------------------------------------------------------------- *
 * Web pages cannot reach this listener: the extension declares no
 * `externally_connectable`, so only our own content scripts and popup can. */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'nocturne:fetch-css':
      fetchCss(String(message.url || '')).then(sendResponse);
      return true;

    case 'nocturne:ensure-injected': {
      const tabId = message.tabId || (sender.tab && sender.tab.id);
      (async () => {
        await ensureRegistration();
        const settings = await NDM.settings.load();
        let injected = false;
        if (tabId) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab && tab.url && NDM.settings.isActiveFor(settings, tab.url)) {
            injected = await injectIntoTab(tabId);
          }
        }
        await refreshAllBadges(settings);
        sendResponse({ ok: true, injected });
      })();
      return true;
    }

    default:
      return false;
  }
});

/* -------------------------------------------------------------------- *
 * Events
 * -------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  try {
    // Materialise defaults so the popup and engine read a stable shape.
    const settings = await NDM.settings.load();
    await NDM.settings.save(settings);
    await ensureRegistration(true);
    await injectIntoMatchingTabs(settings);
    await refreshAllBadges(settings);
  } catch (error) {
    console.error('[Nocturne] install failed', error);
  }
});

chrome.runtime.onStartup.addListener(() => { ensureRegistration(true); });

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[NDM.settings.STORAGE_KEY]) return;
  try {
    const settings = NDM.settings.normalize(changes[NDM.settings.STORAGE_KEY].newValue);
    await ensureRegistration();
    await refreshAllBadges(settings);
  } catch (error) {
    console.error('[Nocturne] settings change failed', error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) updateBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) updateBadge(tabId, tab.url);
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (command === 'toggle-global') {
      const next = await NDM.settings.update((draft) => {
        draft.enabled = !draft.enabled;
        return draft;
      });
      await ensureRegistration();
      if (next.enabled) await injectIntoMatchingTabs(next);
      await refreshAllBadges(next);
      return;
    }

    if (command === 'toggle-site') {
      if (!tab || !tab.url || !NDM.settings.isSupportedUrl(tab.url)) return;
      const host = NDM.settings.hostOf(tab.url);
      if (!host) return;
      const next = await NDM.settings.update((draft) => {
        const current = NDM.settings.siteMode(draft, host);
        draft.siteModes[host] = current === 'on' ? 'off' : 'on';
        return draft;
      });
      await ensureRegistration();
      if (NDM.settings.isActiveFor(next, tab.url) && tab.id) await injectIntoTab(tab.id);
      await refreshAllBadges(next);
    }
  } catch (error) {
    console.error('[Nocturne] command failed', error);
  }
});

// The worker can be spun up for any reason; make sure registration is intact.
ensureRegistration();
