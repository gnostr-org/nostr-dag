function normalizeState(text, fallback = 'idle') {
  const value = String(text || '').toLowerCase();
  if (!value) return fallback;
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'unavailable';
  if (
    value.includes('loading') ||
    value.includes('starting') ||
    value.includes('cloning') ||
    value.includes('fetching') ||
    value.includes('refresh') ||
    value.includes('caching') ||
    value.includes('reading') ||
    value.includes('writing') ||
    value.includes('committing')
  ) return 'checking';
  if (value.includes('ready') || value.includes('done') || value.includes('available') || value.includes('restored')) return 'available';
  return fallback;
}

const LOG_LEVELS = ['none', 'info', 'debug', 'trace', 'warn', 'error'];
const STORAGE_PREFIX = 'bitcoin-pages.logger-footer';
const LOGGER_INGEST_PATH = '/logger';
const FOOTER_SPACER_VAR = '--sticky-footer-space';
const SCROLLBAR_ACTIVE_CLASS = 'scrollbars-active';

function normalizeLevel(value) {
  const level = String(value || 'info').toLowerCase();
  return LOG_LEVELS.includes(level) ? level : 'info';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseLogArgs(levelOrState = 'info', maybeState = null) {
  if (maybeState === null && !LOG_LEVELS.includes(String(levelOrState).toLowerCase())) {
    return {
      level: null,
      state: String(levelOrState || 'idle'),
    };
  }
  return {
    level: normalizeLevel(levelOrState),
    state: maybeState,
  };
}

function deriveLevelFromState(state) {
  const value = String(state || '').toLowerCase();
  if (value.includes('unavailable') || value.includes('failed') || value.includes('error')) return 'error';
  if (value.includes('checking') || value.includes('refresh') || value.includes('loading') || value.includes('cloning') || value.includes('fetching') || value.includes('caching') || value.includes('starting') || value.includes('reading') || value.includes('writing') || value.includes('committing')) return 'debug';
  return 'info';
}

function getStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function resolveStorageKey(title, storageKey) {
  if (storageKey) return storageKey;
  const path = globalThis.location?.pathname || 'unknown';
  return `${STORAGE_PREFIX}:${title}:${path}`;
}

function shouldMirrorLogs() {
  try {
    const host = globalThis.location?.hostname || '';
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function mirrorLogEntry(entry) {
  if (!shouldMirrorLogs()) return;

  const body = JSON.stringify(entry);
  try {
    if (globalThis.navigator?.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      globalThis.navigator.sendBeacon(LOGGER_INGEST_PATH, blob);
      return;
    }
  } catch {
    // best effort only
  }

  void globalThis.fetch?.(LOGGER_INGEST_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    cache: 'no-store',
  }).catch(() => {});
}

function loadPersistedFooterState(storageKey) {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : null,
      level: typeof parsed.level === 'string' ? normalizeLevel(parsed.level) : null,
    };
  } catch {
    return null;
  }
}

function savePersistedFooterState(storageKey, state) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // best effort only
  }
}

function setFooterSpacer(height) {
  try {
    globalThis.document?.documentElement?.style?.setProperty(FOOTER_SPACER_VAR, `${Math.max(0, Math.ceil(height))}px`);
  } catch {
    // best effort only
  }
}

function setScrollbarsActive(active) {
  try {
    globalThis.document?.documentElement?.classList?.toggle(SCROLLBAR_ACTIVE_CLASS, !!active);
  } catch {
    // best effort only
  }
}

function dispatchWindowResize() {
  try {
    globalThis.window?.dispatchEvent(new globalThis.Event('resize'));
  } catch {
    // best effort only
  }
}

export function createLoggerFooter(root, options = {}) {
  if (!root) {
    return {
      log() {},
      setState() {},
      open() {},
      close() {},
      toggle() {},
    };
  }

  const title = options.title || 'Logger';
  const initialState = options.initialState || 'idle';
  const initialTitle = options.initialTitle || 'starting...';
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 1000;
  const storageKey = resolveStorageKey(title, options.storageKey);
  const persisted = loadPersistedFooterState(storageKey);

  const rootStyle = root.style || (root.style = {});
  root.classList.add('sticky-footer');
  rootStyle.resize = 'vertical';
  rootStyle.overflow = 'hidden';
  rootStyle.minHeight = '84px';
  rootStyle.maxHeight = '70vh';
  root.innerHTML = `
    <div class="sticky-footer-inner small muted">
      <div class="footer-header">
        <div class="footer-log-wrap">
          <div class="footer-controls">
            <button data-footer-toggle class="footer-toggle" type="button" aria-expanded="false" aria-controls="footerLogPanel">
              <span class="footer-toggle-label">
                <span>${title}</span>
                <span data-footer-status class="status status-idle" title="" aria-hidden="true">
                  <span class="status-dot" aria-hidden="true"></span>
                </span>
              </span>
            </button>
            <div class="footer-actions">
              <button data-footer-copy class="footer-copy" type="button">Save</button>
              <div class="footer-level-pills" data-footer-level></div>
            </div>
          </div>
        </div>
      </div>
      <div data-footer-log class="footer-log" hidden></div>
    </div>
  `;
  const statusEl = root.querySelector('[data-footer-status]');
  const toggleEl = root.querySelector('[data-footer-toggle]');
  const copyEl = root.querySelector('[data-footer-copy]');
  const levelEl = root.querySelector('[data-footer-level]');
  const logEl = root.querySelector('[data-footer-log]');
  const logs = [];
  let open = persisted?.open ?? false;
  let level = persisted?.level ?? normalizeLevel(options.initialLevel || 'none');
  let autoScroll = true;
  let scrollListenerBound = false;
  let footerObserver = null;
  let scrollbarTimer = null;
  let scrollbarListenersBound = false;
  let renderScheduled = false;

  function persistState() {
    savePersistedFooterState(storageKey, { open, level });
  }

  function isNearBottom() {
    return (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 24;
  }

  function scheduleScrollBottom() {
    if (!open || !autoScroll) return;
    const run = () => {
      logEl.scrollTop = logEl.scrollHeight;
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function bindScrollLock() {
    if (scrollListenerBound) return;
    scrollListenerBound = true;
    logEl.addEventListener('scroll', () => {
      autoScroll = isNearBottom();
      showScrollbars();
    });
    logEl.addEventListener('pointerdown', () => {
      autoScroll = false;
      showScrollbars();
    });
    logEl.addEventListener('wheel', () => {
      autoScroll = false;
      showScrollbars();
    }, { passive: true });
    logEl.addEventListener('touchstart', () => {
      autoScroll = false;
      showScrollbars();
    }, { passive: true });
    logEl.addEventListener('pointerenter', showScrollbars);
    logEl.addEventListener('mousemove', showScrollbars);
    logEl.addEventListener('focusin', showScrollbars);
  }

  function bindScrollbarActivity() {
    if (scrollbarListenersBound) return;
    scrollbarListenersBound = true;
    const activity = () => showScrollbars();
    globalThis.window?.addEventListener('scroll', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('wheel', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('pointerdown', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('pointermove', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('touchstart', activity, { passive: true, capture: true });
    globalThis.window?.addEventListener('keydown', activity, { passive: true, capture: true });
  }

  function syncFooterSpacer() {
    setFooterSpacer(root.getBoundingClientRect?.().height || root.offsetHeight || 0);
  }

  function hideScrollbarsLater() {
    if (scrollbarTimer) clearTimeout(scrollbarTimer);
    scrollbarTimer = setTimeout(() => {
      setScrollbarsActive(false);
    }, 2000);
  }

  function showScrollbars() {
    setScrollbarsActive(true);
    hideScrollbarsLater();
  }

  function renderLevelPills() {
    levelEl.innerHTML = LOG_LEVELS.map((entryLevel) => `
      <button type="button" class="footer-pill${entryLevel === level ? ' active' : ''}" data-level-pill="${entryLevel}">
        ${entryLevel}
      </button>
    `).join('');
    levelEl.querySelectorAll('[data-level-pill]').forEach((button) => {
      button.addEventListener('click', () => {
        level = normalizeLevel(button.getAttribute('data-level-pill'));
        open = level !== 'none';
        persistState();
        render();
      });
    });
  }

  function render() {
    renderScheduled = false;
    toggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    renderLevelPills();
    logEl.hidden = !open;
    const visibleLogs = level === 'none' ? [] : logs.filter((entry) => entry.level === level);
    logEl.innerHTML = visibleLogs.length
      ? visibleLogs.map((entry) => `
        <div class="footer-log-item">
          <span class="footer-log-time mono">${escapeHtml(entry.time)}</span>
          <span>${entry.label ? `${escapeHtml(entry.label)}: ` : ''}${escapeHtml(entry.text)}</span>
        </div>
      `).join('')
      : '<div class="muted">No log entries yet.</div>';
    scheduleScrollBottom();
    syncFooterSpacer();
    if (open) showScrollbars();
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => render();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function saveVisibleLogs() {
    const visibleLogs = level === 'none' ? [] : logs.filter((entry) => entry.level === level);
    const text = visibleLogs.map((entry) => `[${entry.time}] ${entry.label ? `${entry.label}: ` : ''}${entry.text}`).join('\n');
    const filename = `bitcoin-pages-${Math.floor(Date.now() / 1000)}.log`;
    const blob = new Blob([text ? `${text}\n` : ''], { type: 'text/plain;charset=utf-8' });
    const url = globalThis.URL?.createObjectURL?.(blob);

    try {
      if (!url) throw new Error('object-url-unavailable');
      const anchor = globalThis.document?.createElement('a');
      if (!anchor) throw new Error('download-anchor-unavailable');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      globalThis.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => globalThis.URL?.revokeObjectURL?.(url), 0);
      log('logger', `saved ${visibleLogs.length} log lines to ${filename}`, 'debug', 'available');
    } catch {
      if (url) globalThis.URL?.revokeObjectURL?.(url);
      log('logger', 'save logs failed', 'warn', 'unavailable');
    }
  }

  function setState(state, text) {
    const nextState = state || normalizeState(text);
    statusEl.className = `status status-${nextState}`;
    statusEl.title = text || initialTitle;
  }

  function log(label, text, levelOrState = 'info', maybeState = null) {
    const { level: providedLevel, state } = parseLogArgs(levelOrState, maybeState);
    const nextLevel = providedLevel || deriveLevelFromState(state);
    const entry = {
      time: new Date().toLocaleTimeString(),
      label: label || '',
      text: String(text),
      level: nextLevel,
      state: normalizeState(state || text),
      source: 'browser',
    };
    logs.push(entry);
    while (logs.length > maxEntries) logs.shift();
    setState(entry.state, label ? `${label}: ${text}` : String(text));
    mirrorLogEntry(entry);
    scheduleRender();
  }

  toggleEl.addEventListener('click', () => {
    open = !open;
    persistState();
    render();
    dispatchWindowResize();
  });

  copyEl?.addEventListener('click', saveVisibleLogs);

  setState(initialState, initialTitle);
  bindScrollLock();
  bindScrollbarActivity();
  if (typeof globalThis.ResizeObserver === 'function') {
    footerObserver = new globalThis.ResizeObserver(() => syncFooterSpacer());
    footerObserver.observe(root);
  }
  render();

  return {
    log,
    setState,
    setLevel(nextLevel) {
      level = normalizeLevel(nextLevel);
      // Show the log panel as soon as the user picks a real level; hide it again for `none`.
      open = level !== 'none';
      persistState();
      render();
    },
    getLevel() {
      return level;
    },
    open() {
      open = true;
      persistState();
      render();
    },
    close() {
      open = false;
      persistState();
      render();
    },
    toggle() {
      open = !open;
      persistState();
      render();
    },
    destroy() {
      footerObserver?.disconnect?.();
      footerObserver = null;
      if (scrollbarTimer) clearTimeout(scrollbarTimer);
      scrollbarTimer = null;
      setScrollbarsActive(false);
    },
  };
}
