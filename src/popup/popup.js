/**
 * Nocturne popup — settings UI only. All transformation logic lives in the
 * content-script engine; this file reads and writes `chrome.storage.local`
 * and lets the engine react to the change event.
 */
(() => {
  'use strict';

  const NDM = globalThis.NDM;
  const $ = (id) => document.getElementById(id);

  const TOGGLES = ['warmText', 'dimImages', 'extraDark', 'useSiteDarkTheme', 'suppressTransitions'];
  const SLIDERS = ['backgroundDarkness', 'textContrast', 'imageBrightness'];
  const SWATCHES = [
    ['bg', 'Background'],
    ['bg2', 'Surfaces'],
    ['text', 'Text'],
    ['text2', 'Secondary text'],
    ['link', 'Links'],
    ['linkVisited', 'Visited links'],
    ['border', 'Borders']
  ];

  let settings = NDM.settings.normalize(null);
  let tab = null;
  let host = '';
  let supported = false;
  let saveTimer = 0;

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  /** Debounced so dragging a slider does not hammer storage. */
  function persist({ immediate = false } = {}) {
    if (saveTimer) clearTimeout(saveTimer);
    const write = () => {
      saveTimer = 0;
      NDM.settings.save(settings).catch((error) => {
        console.error('[Nocturne] could not save settings', error);
        setStatus('Could not save settings', true);
      });
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 140);
  }

  /** Registration only covers future navigations, so ask the worker to push
   *  the engine into this tab when we have just switched something on. */
  function ensureInjected() {
    if (!tab || !tab.id) return;
    try {
      chrome.runtime.sendMessage({ type: 'nocturne:ensure-injected', tabId: tab.id })
        .then(() => refreshStatus())
        .catch(() => { /* worker asleep or tab gone */ });
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function setStatus(text, warn = false) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }

  function renderPreview() {
    const theme = NDM.theme.derive(settings);
    const preview = $('preview');
    preview.style.backgroundColor = theme.bg;
    preview.style.borderColor = theme.border;
    preview.style.color = theme.text;
    preview.querySelector('.preview-head').style.color = theme.text;
    preview.querySelector('.preview-muted').style.color = theme.text2;
    $('preview-link').style.color = theme.link;

    const button = preview.querySelector('.preview-button');
    button.style.backgroundColor = theme.bg3;
    button.style.borderColor = theme.border;
    button.style.color = theme.text;

    const input = preview.querySelector('.preview-input');
    input.style.backgroundColor = theme.inputBg;
    input.style.borderColor = theme.border;
    input.style.color = theme.text2;
  }

  function renderSwatches() {
    const container = $('swatches');
    if (container.childElementCount) {
      for (const [key] of SWATCHES) {
        const input = container.querySelector(`input[data-key="${key}"]`);
        const hex = container.querySelector(`[data-hex="${key}"]`);
        if (input) input.value = settings.palette[key];
        if (hex) hex.textContent = settings.palette[key];
      }
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const [key, label] of SWATCHES) {
      const wrap = document.createElement('label');
      wrap.className = 'swatch';

      const input = document.createElement('input');
      input.type = 'color';
      input.value = settings.palette[key];
      input.dataset.key = key;
      input.addEventListener('input', () => {
        settings.palette[key] = input.value;
        hex.textContent = input.value;
        renderPreview();
        persist();
      });

      const text = document.createElement('span');
      text.className = 'swatch-text';
      const name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = label;
      const hex = document.createElement('span');
      hex.className = 'swatch-hex';
      hex.dataset.hex = key;
      hex.textContent = settings.palette[key];

      text.append(name, hex);
      wrap.append(input, text);
      fragment.append(wrap);
    }
    container.append(fragment);
  }

  function render() {
    $('enabled').checked = settings.enabled;

    for (const key of TOGGLES) $(key).checked = settings[key];
    for (const key of SLIDERS) {
      const input = $(key);
      input.value = settings[key];
      updateSliderOutput(key);
    }
    $('imageBrightness-wrap').hidden = !settings.dimImages;

    const sitePanel = $('site-panel');
    const siteToggle = $('site-enabled');
    $('site-host').textContent = host || 'this page';

    if (!supported) {
      sitePanel.classList.add('unsupported');
      siteToggle.checked = false;
      siteToggle.disabled = true;
      $('site-hint').textContent = 'Chrome does not allow styling this page';
    } else {
      sitePanel.classList.remove('unsupported');
      siteToggle.disabled = !settings.enabled;
      siteToggle.checked = NDM.settings.siteMode(settings, host) === 'on';
      $('site-hint').textContent = siteToggle.checked
        ? 'Dark mode is on for this site'
        : 'Dark mode is off for this site';
    }

    renderSwatches();
    renderPreview();
    refreshStatus();
  }

  function updateSliderOutput(key) {
    const value = Number($(key).value);
    const out = $(key + '-out');
    if (!out) return;
    out.textContent = key === 'imageBrightness' ? value + '%' : String(value);
  }

  /* ------------------------------------------------------------------ *
   * Status line
   * ------------------------------------------------------------------ */

  const MODE_TEXT = {
    'site-theme': "Using this site's own dark theme",
    passthrough: 'This page is already dark — standing by',
    generic: 'Converting this page to dark'
  };

  function refreshStatus() {
    if (!settings.enabled) { setStatus('Off everywhere'); return; }
    if (!supported) { setStatus('This page cannot be styled'); return; }
    if (NDM.settings.siteMode(settings, host) === 'off') {
      setStatus('Off for ' + (host || 'this site'));
      return;
    }

    setStatus('On');
    if (!tab || !tab.id) return;
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'nocturne:status' })
        .then((response) => {
          if (!response) return;
          if (!response.active) setStatus('On — reload this tab to apply');
          else setStatus(MODE_TEXT[response.mode] || 'On');
        })
        .catch(() => setStatus('On — reload this tab to apply'));
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function wire() {
    $('enabled').addEventListener('change', (event) => {
      settings.enabled = event.target.checked;
      persist({ immediate: true });
      render();
      if (settings.enabled) ensureInjected();
    });

    $('site-enabled').addEventListener('change', (event) => {
      if (!host) return;
      settings.siteModes[host] = event.target.checked ? 'on' : 'off';
      persist({ immediate: true });
      render();
      if (event.target.checked) ensureInjected();
    });

    for (const key of TOGGLES) {
      $(key).addEventListener('change', (event) => {
        settings[key] = event.target.checked;
        if (key === 'dimImages') $('imageBrightness-wrap').hidden = !event.target.checked;
        persist({ immediate: true });
        renderPreview();
      });
    }

    for (const key of SLIDERS) {
      $(key).addEventListener('input', (event) => {
        settings[key] = Number(event.target.value);
        updateSliderOutput(key);
        renderPreview();
        persist();
      });
    }

    $('reset-colors').addEventListener('click', () => {
      settings.palette = { ...NDM.settings.DEFAULT_PALETTE };
      persist({ immediate: true });
      render();
    });

    $('reset-all').addEventListener('click', () => {
      const { siteModes, enabled } = settings;
      settings = NDM.settings.normalize({ siteModes, enabled });
      persist({ immediate: true });
      render();
      setStatus('Appearance reset to defaults');
    });

    $('open-shortcuts').addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // Keep in step with changes made by the keyboard shortcut or another popup.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[NDM.settings.STORAGE_KEY]) return;
      if (saveTimer) return; // our own pending write
      settings = NDM.settings.normalize(changes[NDM.settings.STORAGE_KEY].newValue);
      render();
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function init() {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = active || null;
    } catch { tab = null; }

    const url = tab && tab.url ? tab.url : '';
    supported = NDM.settings.isSupportedUrl(url);
    host = supported ? NDM.settings.hostOf(url) : '';

    try {
      settings = await NDM.settings.load();
    } catch (error) {
      console.error('[Nocturne] could not load settings', error);
      setStatus('Could not read settings — showing defaults', true);
    }

    wire();
    render();
  }

  init();
})();
