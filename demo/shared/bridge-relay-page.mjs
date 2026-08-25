import { resolveHref } from './page-path.js';

const CACHE_KEY = 'bitcoin-pages-bridge-cache-v2';

const detailEl = document.getElementById('relayDetail');
const relayParam = new URL(window.location.href).searchParams.get('relay');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeRelayUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return value;
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function createNostrRelay(relayUrl, data = {}) {
  const url = normalizeRelayUrl(relayUrl) || String(relayUrl || '').trim();
  return {
    url,
    fetch_url: data.fetch_url || '',
    fetched_at: data.fetched_at || 0,
    name: data.name || '',
    description: data.description || '',
    pubkey: data.pubkey || '',
    contact: data.contact || '',
    software: data.software || '',
    version: data.version || '',
    icon: data.icon || '',
    limitation: data.limitation && typeof data.limitation === 'object' ? data.limitation : {},
    supported_nips: Array.isArray(data.supported_nips) ? data.supported_nips.filter((nip) => nip !== null && nip !== undefined && nip !== '') : [],
    relay_countries: Array.isArray(data.relay_countries) ? data.relay_countries.filter(Boolean) : [],
    learned_from: data.learned_from || '',
    error: data.error || '',
  };
}

function loadBridgeCache() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { relayCatalog: new Map(), relayInfoCatalog: new Map() };
    const payload = JSON.parse(raw);
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();

    if (Array.isArray(payload.relayCatalog)) {
      for (const entry of payload.relayCatalog) {
        if (!entry?.owner || !Array.isArray(entry.relays)) continue;
        relayCatalog.set(entry.owner, {
          owner: entry.owner,
          kind: entry.kind ?? 0,
          relays: [...new Set(entry.relays.map((relay) => normalizeRelayUrl(relay)).filter(Boolean))],
          updated_at: entry.updated_at || Date.now(),
        });
      }
    }

    if (Array.isArray(payload.relayInfoCatalog)) {
      for (const [url, info] of payload.relayInfoCatalog) {
        const normalized = normalizeRelayUrl(url);
        if (!normalized || !info) continue;
        relayInfoCatalog.set(normalized, createNostrRelay(normalized, info));
      }
    }

    return { relayCatalog, relayInfoCatalog };
  } catch {
    return { relayCatalog: new Map(), relayInfoCatalog: new Map() };
  }
}

function sourceForRelay(relay, relayCatalog) {
  for (const entry of relayCatalog.values()) {
    if ((entry.relays || []).includes(relay)) return entry.owner || 'unknown';
  }
  return '';
}

function nip11FetchUrl(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed.toString().replace(/\/$/, '');
}

function nip11ProxyUrl(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const url = new URL('/nip11', window.location.href);
  url.searchParams.set('relay', normalized);
  return url.toString();
}

async function fetchRelayInfo(relayUrl) {
  const normalized = normalizeRelayUrl(relayUrl);
  if (!normalized) return null;
  const cache = loadBridgeCache();
  const cached = cache.relayInfoCatalog.get(normalized);
  if (cached && !cached.error) return cached;

  const candidates = [nip11ProxyUrl(normalized), nip11FetchUrl(normalized)].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/nostr+json' },
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}\n${raw}`);
      const data = JSON.parse(raw || '{}');
      const record = createNostrRelay(normalized, {
        ...data,
        fetch_url: candidate,
        fetched_at: Date.now(),
      });
      cache.relayInfoCatalog.set(normalized, record);
      try {
        const payload = {
          relayCatalog: [...cache.relayCatalog.values()],
          relayInfoCatalog: [...cache.relayInfoCatalog.entries()],
        };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
      } catch {
        // best effort only
      }
      return record;
    } catch (error) {
      lastError = error;
    }
  }

  return createNostrRelay(normalized, {
    fetch_url: nip11FetchUrl(normalized),
    fetched_at: Date.now(),
    error: lastError?.message || 'unable to fetch NIP-11',
  });
}

function relayHeaderHtml(relay, info, source, loading) {
  const hasInfo = Boolean(info && !info.error);
  const fields = hasInfo ? [
    info.name || '',
    info.description || '',
    info.version ? `v${info.version}` : '',
  ].filter(Boolean) : [];
  return `
    <div class="bridge-card bridge-relay-card bridge-relay-detail-card">
      <div class="bridge-card-summary">
        <div class="bridge-relay-row">
          <div class="bridge-relay-url mono">
            <div>${escapeHtml(relay)}</div>
            ${hasInfo ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(fields.join(' · '))}</div>` : loading ? '<div class="small muted" style="margin-top:4px;">Loading NIP-11…</div>' : ''}
          </div>
          <div class="bridge-relay-meta">
            ${source ? `<span class="bridge-pill bridge-pill-source">${escapeHtml(source)}</span>` : ''}
            ${info?.error ? `<span class="bridge-pill">NIP-11 unavailable</span>` : hasInfo ? '<span class="bridge-pill bridge-pill-ok" aria-label="NIP-11 loaded"><span class="bridge-pill-dot" aria-hidden="true"></span></span>' : loading ? '<span class="bridge-pill">NIP-11 loading</span>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function detailSectionHtml(title, body) {
  if (!body) return '';
  return `
    <section class="bridge-relay-section">
      <h2 class="bridge-relay-section-title">${escapeHtml(title)}</h2>
      ${body}
    </section>
  `;
}

function renderRelayDetail(relay, info, source, loading) {
  const hasInfo = Boolean(info && !info.error);
  const metadataPills = hasInfo ? [
    info.pubkey ? `<span class="bridge-pill bridge-pill-relay">pubkey ${escapeHtml(info.pubkey)}</span>` : '',
    info.contact ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.contact)}</span>` : '',
    info.software ? `<span class="bridge-pill bridge-pill-relay">${escapeHtml(info.software)}</span>` : '',
    info.icon ? `<span class="bridge-pill bridge-pill-relay">icon</span>` : '',
    info.negentropy ? '<span class="bridge-pill bridge-pill-relay">negentropy</span>' : '',
    typeof info.limitation?.auth_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.auth_required ? 'auth required' : 'no auth'}</span>` : '',
    typeof info.limitation?.payment_required === 'boolean' ? `<span class="bridge-pill bridge-pill-relay">${info.limitation.payment_required ? 'payment required' : 'free'}</span>` : '',
  ].filter(Boolean).join('') : '';
  const supportedNips = hasInfo && Array.isArray(info.supported_nips) && info.supported_nips.length
    ? info.supported_nips.map((nip) => `<span class="bridge-pill bridge-pill-relay">NIP-${escapeHtml(nip)}</span>`).join('')
    : '<span class="bridge-pill">supported_nips unknown</span>';
  const countries = hasInfo && Array.isArray(info.relay_countries) && info.relay_countries.length
    ? info.relay_countries.map((country) => `<span class="bridge-pill bridge-pill-relay">${escapeHtml(country)}</span>`).join('')
    : '';
  const rawJson = info ? escapeHtml(JSON.stringify(info, null, 2)) : '';
  detailEl.innerHTML = `
    <div class="row" style="justify-content:space-between; margin-bottom:12px;">
      <div>
        <h1 style="margin:0 0 6px;">Relay detail</h1>
        <div class="small muted">Full relay metadata view.</div>
      </div>
      <a class="button" href="${escapeHtml(resolveHref('./', window.location.href))}">Back to Bridge</a>
    </div>
    ${relayHeaderHtml(relay, info, source, loading)}
    <div class="bridge-relay-details">
      ${source && source !== 'default' ? `<div class="bridge-relay-learned small muted">Learned from ${escapeHtml(source)}</div>` : ''}
      ${info?.error ? `<div class="small muted">NIP-11 fetch failed: ${escapeHtml(info.error)}</div>` : ''}
      ${hasInfo ? `
        ${detailSectionHtml('Description', info.description ? `<div class="small muted">${escapeHtml(info.description)}</div>` : '<div class="small muted">No description provided.</div>')}
        ${detailSectionHtml('Metadata', `<div class="bridge-relay-grid">${metadataPills || '<span class="bridge-pill">No metadata chips</span>'}</div>`)}
        ${detailSectionHtml('Supported NIPs', `<div class="bridge-relay-grid">${supportedNips}</div>`)}
        ${countries ? detailSectionHtml('Relay countries', `<div class="bridge-relay-grid">${countries}</div>`) : ''}
        ${detailSectionHtml('Raw NIP-11', `<pre class="bridge-relay-pre">${rawJson}</pre>`)}
      ` : loading ? `<div class="small muted">Loading NIP-11 metadata…</div>` : `<div class="small muted">NIP-11 metadata not loaded yet.</div>`}
    </div>
  `;
}

async function boot() {
  if (!detailEl) return;
  if (!relayParam) {
    detailEl.innerHTML = `
      <div class="panel">
        <h1 style="margin-top:0;">Relay detail</h1>
        <p class="small muted">Missing relay query parameter.</p>
        <a class="button" href="${escapeHtml(resolveHref('./', window.location.href))}">Back to Bridge</a>
      </div>
    `;
    return;
  }

  const relay = normalizeRelayUrl(relayParam);
  const cache = loadBridgeCache();
  const source = sourceForRelay(relay, cache.relayCatalog) || '';
  const cachedInfo = cache.relayInfoCatalog.get(relay) || null;
  document.title = relay ? `bitcoin-pages Relay Detail · ${relay}` : 'bitcoin-pages Relay Detail';
  renderRelayDetail(relay, cachedInfo, source, !cachedInfo || cachedInfo.error);
  const info = await fetchRelayInfo(relay);
  renderRelayDetail(relay, info, source, false);
}

void boot();
