// Bridge page logic extracted from demo/bridge/index.html.
import { SimplePool } from 'https://esm.sh/nostr-tools@2.10.4/pool';
    import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'https://esm.sh/nostr-tools@2.10.4/pure';
    import { createSharedHeader } from './page-header.mjs';
    import { resolveHref } from './page-path.js';
    import { createSharedLibp2pStack } from './libp2p-stack.mjs';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const CACHE_KEY = 'bitcoin-pages-bridge-cache-v2';
    const SIGNER_KEY = 'bitcoin-pages-bridge-signer-v1';
    const BRIDGE_PROTOCOL = 'bitcoin-pages-bridge';
    const BRIDGE_PROTOCOL_VERSION = 1;
    const DEFAULT_RELAYS = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.com',
      'wss://relay.nostr.band',
      'wss://relay.primal.net',
      'wss://nostr.wine',
    ];

    if (!window.__bridgeChromeInitialized) {
      createSharedHeader(document.getElementById('sharedHeader'), {
        title: 'bitcoin-pages',
        logoHref: resolveHref('../', window.location.href),
        iconHref: resolveHref('../shared/favicon.ico', window.location.href),
        subtitleHtml: '',
        navItems: [
          { label: 'Demo', href: resolveHref('../', window.location.href) },
          { label: 'Git viewer', href: resolveHref('../git/', window.location.href) },
          { label: 'Bridge', href: resolveHref('./', window.location.href), current: true },
        ],
      });
      window.__bridgeChromeInitialized = true;
    }

    const pool = new SimplePool();
    const seen = new Set();
    const relayCatalog = new Map();
    const relayInfoCatalog = new Map();
    const relayInfoInFlight = new Map();
    const relayDiscoveryQueue = new Set();
    const relayDiscoverySeen = new Set();
    let relayDiscoveryRunning = false;
    let relayCachePersistTimer = null;
    let bridgePresenceTimer = null;
    let bridgeVerificationRunning = false;
    let defaultRelayRenderScheduled = false;
    let relayRenderScheduled = false;
    let peerRenderScheduled = false;
    let rawEventLogCount = 0;
    let rawEventLogSuppressed = false;
    const metrics = {
      nostrToLibp2p: 0,
      libp2pToNostr: 0,
      relayPublishesAttempted: 0,
      relayPublishesSucceeded: 0,
    };

    const bridgeStatusEl = document.getElementById('bridgeStatus');
    const nostrToLibp2pCountEl = document.getElementById('nostrToLibp2pCount');
    const libp2pToNostrCountEl = document.getElementById('libp2pToNostrCount');
    const seenCountEl = document.getElementById('seenCount');
    const relayPublishCountEl = document.getElementById('relayPublishCount');
    const defaultRelayCountEl = document.getElementById('defaultRelayCount');
    const defaultRelayListEl = document.getElementById('defaultRelayList');
    const relayCountEl = document.getElementById('relayCount');
    const relayListEl = document.getElementById('relayList');
    const peerCountEl = document.getElementById('peerCount');
    const peerListEl = document.getElementById('peerList');

    let node = null;
    let topic = 'nostr/bridge';
    let relays = DEFAULT_RELAYS.slice();
    let started = false;
    let peerPollTimer = null;
    const localPeers = new Map();
    const remotePeers = new Map();
    const bridgeVerificationQueue = [];
    const bridgeVerificationSeen = new Map();
    const bridgeVerificationBackoff = new Map();

    const sharedFooterLogBuffer = window.__sharedFooterLogBuffer || [];
    window.__sharedFooterLogBuffer = sharedFooterLogBuffer;
    window.__flushSharedFooterLogBuffer = () => {
      if (!window.__sharedFooter) return;
      while (sharedFooterLogBuffer.length) {
        const [label, text, levelOrState, maybeState] = sharedFooterLogBuffer.shift();
        window.__sharedFooter.log(label, text, levelOrState, maybeState);
      }
    };
    window.__flushSharedFooterLogBuffer();

    function setStatus(text, state = 'checking') {
      bridgeStatusEl.className = `status status-${state}`;
      bridgeStatusEl.innerHTML = `<span class="status-dot"></span><span></span>`;
      bridgeStatusEl.querySelector('span:last-child').textContent = text;
      window.__sharedFooter?.log('bridge', text, state === 'available' ? 'info' : state, state);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function refreshMetrics() {
      nostrToLibp2pCountEl.textContent = String(metrics.nostrToLibp2p);
      libp2pToNostrCountEl.textContent = String(metrics.libp2pToNostr);
      seenCountEl.textContent = String(seen.size);
      relayPublishCountEl.textContent = `${metrics.relayPublishesSucceeded}/${metrics.relayPublishesAttempted}`;
    }

    function bytesToHex(bytes) {
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function hexToBytes(hex) {
      const clean = String(hex || '').trim();
      if (!clean || clean.length % 2 !== 0) return null;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        const part = clean.slice(i * 2, i * 2 + 2);
        const value = Number.parseInt(part, 16);
        if (!Number.isFinite(value)) return null;
        out[i] = value;
      }
      return out;
    }

    function getBridgeSigner() {
      try {
        const raw = window.localStorage.getItem(SIGNER_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const secretKey = hexToBytes(parsed?.secretKeyHex);
          if (secretKey) {
            return {
              secretKey,
              publicKey: parsed?.publicKey || getPublicKey(secretKey),
              created_at: parsed?.created_at || Date.now(),
            };
          }
        }
      } catch {
        // fall through and create a new signer
      }

      const secretKey = generateSecretKey();
      const signer = {
        secretKey,
        publicKey: getPublicKey(secretKey),
        created_at: Date.now(),
      };
      try {
        window.localStorage.setItem(SIGNER_KEY, JSON.stringify({
          secretKeyHex: bytesToHex(secretKey),
          publicKey: signer.publicKey,
          created_at: signer.created_at,
        }));
      } catch {
        // best effort only
      }
      return signer;
    }

    function isNostrEvent(value) {
      return Boolean(
        value &&
        typeof value === 'object' &&
        typeof value.id === 'string' &&
        typeof value.pubkey === 'string' &&
        typeof value.sig === 'string' &&
        typeof value.content === 'string' &&
        Array.isArray(value.tags) &&
        Number.isFinite(Number(value.kind)) &&
        Number.isFinite(Number(value.created_at))
      );
    }

    function collectBridgeRelayHints(value, found = new Set()) {
      if (!value) return found;
      if (typeof value === 'string') {
        const normalized = normalizeRelayUrl(value);
        if (normalized) found.add(normalized);
        return found;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectBridgeRelayHints(item, found);
        return found;
      }
      if (typeof value === 'object') {
        for (const item of Object.values(value)) collectBridgeRelayHints(item, found);
      }
      return found;
    }

    // libp2p publishes a bridge envelope, not a bare Nostr event.
    // The `event` field is the standard Nostr event; the rest is bridge metadata.
    function buildBridgeEnvelope(event, direction, relayHints = []) {
      return {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        direction,
        event,
        relay_hints: [...new Set(relayHints.filter(Boolean))],
        topic,
        ts: Date.now(),
      };
    }

    function buildBridgePresenceEvent(relayHints = []) {
      const signer = getBridgeSigner();
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      const payload = {
        name: 'bitcoin-pages bridge',
        display_name: 'bitcoin-pages bridge',
        about: `libp2p peer ${node?.peerId?.toString?.() || 'starting'} broadcasting to Nostr relays.`,
        bridge_peer_id: node?.peerId?.toString?.() || '',
        bridge_protocol: BRIDGE_PROTOCOL,
        bridge_topic: topic,
        bridge_relays: publishRelays,
        bridge_version: BRIDGE_PROTOCOL_VERSION,
        updated_at: new Date().toISOString(),
      };
      return finalizeEvent({
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', 'bitcoin-pages'],
          ['t', 'bridge'],
        ],
        content: JSON.stringify(payload),
        pubkey: signer.publicKey,
      }, signer.secretKey);
    }

    // Accept either a bridge envelope or a raw Nostr event for compatibility.
    // When relay hints are present, they are forwarded to the Nostr publish path.
    function unwrapBridgeEnvelope(message) {
      if (!message || typeof message !== 'object') return null;
      if (isNostrEvent(message)) {
        return {
          event: message,
          relayHints: [],
          direction: 'libp2p->nostr',
        };
      }
      const protocol = message.protocol || message.source;
      const event = message.event || message.payload?.event || message.payload || null;
      const relayHints = [
        ...collectBridgeRelayHints(message.relay_hints),
        ...collectBridgeRelayHints(message.relayHints),
        ...collectBridgeRelayHints(message.relays),
        ...collectBridgeRelayHints(message.relayTargets),
      ];
      if (protocol && protocol !== BRIDGE_PROTOCOL && protocol !== 'bitcoin-pages-bridge') {
        return null;
      }
      if (!event || !isNostrEvent(event)) return null;
      return {
        event,
        relayHints,
        direction: message.direction || 'libp2p->nostr',
      };
    }

    function scheduleDefaultRelayRender() {
      if (defaultRelayRenderScheduled) return;
      defaultRelayRenderScheduled = true;
      const run = () => {
        renderDefaultRelays();
        defaultRelayRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function scheduleRelayRender() {
      if (relayRenderScheduled) return;
      relayRenderScheduled = true;
      const run = () => {
        renderRelays();
        relayRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function schedulePeerRender() {
      if (peerRenderScheduled) return;
      peerRenderScheduled = true;
      const run = () => {
        renderPeers();
        peerRenderScheduled = false;
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 0);
      }
    }

    function scheduleBridgeCachePersist() {
      if (relayCachePersistTimer) return;
      relayCachePersistTimer = window.setTimeout(() => {
        relayCachePersistTimer = null;
        void persistBridgeCache();
      }, 750);
    }

    function scheduleBridgePresenceBroadcast(relayHints = currentRelayUrls()) {
      if (bridgePresenceTimer) clearTimeout(bridgePresenceTimer);
      bridgePresenceTimer = window.setTimeout(() => {
        bridgePresenceTimer = null;
        void broadcastBridgePresence(relayHints);
      }, 1000);
    }

    function verificationKey(eventId, relay) {
      return `${eventId}:${relay}`;
    }

    function verificationBlocked(key) {
      const until = bridgeVerificationBackoff.get(key);
      if (!until) return false;
      if (until > Date.now()) return true;
      bridgeVerificationBackoff.delete(key);
      return false;
    }

    function cacheVerification(eventId, relay, verified) {
      const key = verificationKey(eventId, relay);
      bridgeVerificationSeen.set(key, {
        verified,
        at: Date.now(),
      });
    }

    function scheduleBridgeVerification(event, relayHints = [], reason = 'publish') {
      if (!event?.id) return;
      const relaysToCheck = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]).slice(0, 2);
      for (const relay of relaysToCheck) {
        const key = verificationKey(event.id, relay);
        if (bridgeVerificationSeen.has(key) || verificationBlocked(key)) continue;
        bridgeVerificationQueue.push({ event, relay, reason });
        bridgeVerificationBackoff.set(key, Date.now() + 10_000);
      }
      void processBridgeVerificationQueue();
    }

    async function processBridgeVerificationQueue() {
      if (bridgeVerificationRunning) return;
      bridgeVerificationRunning = true;
      try {
        while (bridgeVerificationQueue.length) {
          const { event, relay, reason } = bridgeVerificationQueue.shift();
          const key = verificationKey(event.id, relay);
          if (bridgeVerificationSeen.has(key)) continue;

          window.__sharedFooter?.log('bridge', `verify ${reason} ${event.id} from ${relay}`, 'trace', 'checking');
          try {
            const verifiedEvents = await pool.querySync([relay], { ids: [event.id], limit: 1 }, { maxWait: 2000, label: 'bridge-verify' });
            const found = Array.isArray(verifiedEvents) && verifiedEvents.some((item) => item?.id === event.id);
            cacheVerification(event.id, relay, found);
            if (found) {
              window.__sharedFooter?.log('bridge', `verify ok ${event.id} from ${relay}`, 'info', 'available');
            } else {
              window.__sharedFooter?.log('bridge', `verify miss ${event.id} from ${relay}`, 'warn', 'checking');
            }
          } catch (error) {
            bridgeVerificationBackoff.set(key, Date.now() + 60_000);
            window.__sharedFooter?.log('bridge', `verify failed ${event.id} from ${relay}: ${error?.message || error}`, 'warn', 'unavailable');
          }

          await Promise.resolve();
        }
      } finally {
        bridgeVerificationRunning = false;
      }
    }

    function relayRowHtml(relay, info, source, loading) {
      const hasInfo = Boolean(info && !info.error);
      const fields = hasInfo ? [
        info.name || '',
        info.description || '',
        info.version ? `v${info.version}` : '',
      ].filter(Boolean) : [];
      const learnedFrom = source && source !== 'default'
        ? `<div class="bridge-relay-learned small muted">Learned from ${escapeHtml(source)}</div>`
        : '';
      const detailHref = resolveHref(`./relay.html?relay=${encodeURIComponent(relay)}`, window.location.href);
      return `
        <a class="bridge-card bridge-relay-card bridge-relay-link" href="${escapeHtml(detailHref)}">
          <div class="bridge-card-summary">
            <div class="bridge-relay-row">
              <div class="bridge-relay-url mono">
                <div>${escapeHtml(relay)}</div>
                ${hasInfo ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(fields.join(' · '))}</div>` : loading ? '<div class="small muted" style="margin-top:4px;">Loading NIP-11…</div>' : ''}
              </div>
              <div class="bridge-relay-meta">
                ${info?.error ? `<span class="bridge-pill">NIP-11 unavailable</span>` : hasInfo ? '<span class="bridge-pill bridge-pill-ok" aria-label="NIP-11 loaded"><span class="bridge-pill-dot" aria-hidden="true"></span></span>' : loading ? '<span class="bridge-pill">NIP-11 loading</span>' : ''}
              </div>
            </div>
            ${learnedFrom}
          </div>
        </a>
      `;
    }

    function logRawNostrEvent(prefix, event) {
      if (rawEventLogCount >= 25) {
        if (!rawEventLogSuppressed) {
          rawEventLogSuppressed = true;
          window.__sharedFooter?.log('bridge', 'raw relay event logging suppressed after 25 entries', 'trace', 'available');
        }
        return;
      }
      rawEventLogCount += 1;
      window.__sharedFooter?.log('bridge', `${prefix} ${JSON.stringify(event)}`, 'trace', 'available');
    }

    function relayInfoForUrl(url) {
      return relayInfoCatalog.get(normalizeRelayUrl(url) || url) || null;
    }

    function relayInfoForUrls(urls) {
      return [...new Set(urls.map((url) => normalizeRelayUrl(url) || url))]
        .map((url) => relayInfoForUrl(url))
        .filter(Boolean);
    }

    async function persistBridgeCache() {
      try {
        const payload = {
          relayCatalog: [...relayCatalog.values()],
          relayInfoCatalog: [...relayInfoCatalog.entries()],
          localPeers: [...localPeers.values()],
          remotePeers: [...remotePeers.values()],
        };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        window.__sharedFooter?.log('bridge', 'bridge cache persisted', 'trace', 'available');
      } catch {
        window.__sharedFooter?.log('bridge', 'bridge cache persist failed', 'warn', 'unavailable');
      }
    }

    function restoreBridgeCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) {
          window.__sharedFooter?.log('bridge', 'no cached bridge state found', 'debug', 'idle');
          return false;
        }
        const payload = JSON.parse(raw);
        if (Array.isArray(payload.relayCatalog)) {
          relayCatalog.clear();
          for (let i = 0; i < payload.relayCatalog.length; i += 1) {
            const entry = payload.relayCatalog[i];
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
          relayInfoCatalog.clear();
          for (let i = 0; i < payload.relayInfoCatalog.length; i += 1) {
            const [url, info] = payload.relayInfoCatalog[i] || [];
            const normalized = normalizeRelayUrl(url);
            if (!normalized || !info) continue;
            relayInfoCatalog.set(normalized, createNostrRelay(normalized, info));
          }
        }
        if (Array.isArray(payload.localPeers)) {
          localPeers.clear();
          for (const peer of payload.localPeers) {
            if (!peer?.peer_id) continue;
            localPeers.set(peerKey(peer), peer);
          }
        }
        if (Array.isArray(payload.remotePeers)) {
          remotePeers.clear();
          for (const peer of payload.remotePeers) {
            if (!peer?.peer_id) continue;
            remotePeers.set(peerKey(peer), peer);
          }
        }
        window.__sharedFooter?.log('bridge', `restored cached bridge state (${relayCatalog.size} relay groups, ${localPeers.size + remotePeers.size} peers)`, 'info', 'available');
        return true;
      } catch {
        window.__sharedFooter?.log('bridge', 'failed to restore cached bridge state', 'warn', 'unavailable');
        return false;
      }
    }

    function createNostrRelay(relayUrl, data = {}) {
      const url = normalizeRelayUrl(relayUrl) || String(relayUrl || '').trim();
      const limitation = data.limitation && typeof data.limitation === 'object' ? data.limitation : {};
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
        negentropy: Boolean(data.negentropy),
        supported_nips: Array.isArray(data.supported_nips)
          ? data.supported_nips.filter((nip) => Number.isFinite(Number(nip))).map((nip) => Number(nip))
          : [],
        limitation: {
          max_limit: limitation.max_limit ?? null,
          max_message_length: limitation.max_message_length ?? null,
          max_subscriptions: limitation.max_subscriptions ?? null,
          max_filters: limitation.max_filters ?? null,
          max_event_tags: limitation.max_event_tags ?? null,
          max_content_length: limitation.max_content_length ?? null,
          min_pow_difficulty: limitation.min_pow_difficulty ?? null,
          auth_required: Boolean(limitation.auth_required),
          payment_required: Boolean(limitation.payment_required),
        },
        relay_countries: Array.isArray(data.relay_countries) ? data.relay_countries.filter(Boolean) : [],
        learned_from: data.learned_from || '',
        error: data.error || '',
      };
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
      const fetchUrl = nip11FetchUrl(relayUrl);
      const proxyUrl = nip11ProxyUrl(relayUrl);
      if (!normalized) return null;
      if (relayInfoCatalog.has(normalized)) return relayInfoCatalog.get(normalized);
      if (relayInfoInFlight.has(normalized)) return relayInfoInFlight.get(normalized);
      window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized}`, 'trace', 'checking');

      const request = (async () => {
        try {
          const candidates = [proxyUrl, fetchUrl].filter(Boolean);
          let lastError = null;
          for (const candidate of candidates) {
            try {
              window.__sharedFooter?.log('bridge', `query relay ${normalized} via ${candidate}`, 'trace', 'checking');
              const response = await fetch(candidate, {
                method: 'GET',
                cache: 'no-store',
                headers: { Accept: 'application/nostr+json' },
              });
              const raw = await response.text();
              window.__sharedFooter?.log('bridge', `nip11 raw ${normalized} via ${candidate}\n${raw}`, 'trace', response.ok ? 'available' : 'unavailable');
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}\n${raw}`);
              const data = JSON.parse(raw || '{}');
              const record = createNostrRelay(normalized, {
                ...data,
                fetch_url: candidate,
                fetched_at: Date.now(),
              });
              relayInfoCatalog.set(normalized, record);
              window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized} ok ${record.name || record.version || 'loaded'}`, 'trace', 'available');
              return record;
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError || new Error('unable to fetch NIP-11');
        } catch (error) {
          const record = createNostrRelay(normalized, {
            fetch_url: fetchUrl,
            fetched_at: Date.now(),
            error: error?.message || String(error),
          });
          relayInfoCatalog.set(normalized, record);
          window.__sharedFooter?.log('bridge', `fetch nip11 ${normalized} failed ${record.error}`, 'trace', 'unavailable');
          return record;
        } finally {
          relayInfoInFlight.delete(normalized);
        }
      })();

      relayInfoInFlight.set(normalized, request);
      return request;
    }

    function refreshRelayInfo(relayUrls) {
      const urls = prioritizeRelayUrls(relayUrls || currentRelayUrls());
      if (!urls.length) return;
      window.__sharedFooter?.log('bridge', `refresh nip11 for ${urls.length} relays`, 'trace', 'checking');
      void (async () => {
        for (const url of urls) {
          await fetchRelayInfo(url);
          scheduleDefaultRelayRender();
          scheduleRelayRender();
          await Promise.resolve();
        }
      })();
    }

    function renderDefaultRelays() {
      const entries = [...DEFAULT_RELAYS].sort();
      defaultRelayCountEl.textContent = String(entries.length);
      window.__sharedFooter?.log('bridge', `render default relays (${entries.length})`, 'trace', 'checking');
      defaultRelayListEl.innerHTML = entries.map((relay) => {
        const info = relayInfoForUrl(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        return relayRowHtml(relay, info, 'default', loading);
      }).join('');
    }

    function renderRelays() {
      const defaultRelays = [...new Set(DEFAULT_RELAYS)];
      const learnedRelays = [...new Set([...relayCatalog.values()].flatMap((entry) => entry.relays || []))].sort();
      const visibleRelays = learnedRelays.filter((relay) => {
        const info = relayInfoForUrl(relay);
        return Boolean(info && !info.error && !defaultRelays.includes(relay));
      });
      const combinedRelays = [...defaultRelays, ...visibleRelays];
      relayCountEl.textContent = String(combinedRelays.length);
      window.__sharedFooter?.log('bridge', `render accumulated relays (${combinedRelays.length})`, 'trace', 'checking');
      if (!combinedRelays.length) {
        relayListEl.innerHTML = '<div class="small muted">No relays with loaded NIP-11 yet.</div>';
        return;
      }

      const learned = new Map([...relayCatalog.values()].flatMap((entry) => (entry.relays || []).map((relay) => [relay, entry])));
      relayListEl.innerHTML = combinedRelays.map((relay) => {
        const info = relayInfoForUrl(relay);
        const source = learned.get(relay);
        const loading = relayInfoInFlight.has(normalizeRelayUrl(relay) || relay);
        const sourceLabel = defaultRelays.includes(relay)
          ? 'default'
          : source
            ? (source.owner || 'unknown')
            : 'unknown';
        return relayRowHtml(relay, info, sourceLabel, loading);
      }).join('');
    }

    // Keep one merged peer registry in the browser so the bridge works on Pages and localhost.
    function peerKey(peer) {
      return `${peer.source || 'browser'}:${peer.path || '/'}:${peer.peer_id}:${peer.kind || 'unknown'}`;
    }

    function upsertPeer(source, peer) {
      if (!peer?.peer_id) return;
      const key = peerKey({
        source,
        path: peer.path || '/',
        peer_id: peer.peer_id,
        kind: peer.kind || 'unknown',
      });
      const record = {
        ...peer,
        source: peer.source || source,
        updated_at: peer.updated_at || Date.now(),
      };
      if (source === 'browser') {
        localPeers.set(key, record);
      } else {
        remotePeers.set(key, record);
      }
      scheduleBridgeCachePersist();
    }

    function allPeers() {
      return [...localPeers.values(), ...remotePeers.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }

    function renderPeers() {
      const peers = allPeers();
      peerCountEl.textContent = String(peers.length);
      if (!peers.length) {
        peerListEl.innerHTML = '<div class="small muted">No peers reported yet.</div>';
        return;
      }
      window.__sharedFooter?.log('bridge', `render peers (${peers.length})`, 'trace', 'checking');
      const openPeerKeys = [...peerListEl.querySelectorAll('details[open][data-peer-key]')]
        .map((el) => el.getAttribute('data-peer-key'))
        .filter(Boolean);
      peerListEl.innerHTML = peers.map((peer) => `
        <details class="bridge-card bridge-peer" data-peer-key="${escapeHtml(peerKey(peer))}">
          <summary class="bridge-card-summary">
            <div class="bridge-peer-head">
              <div class="bridge-peer-title mono">${escapeHtml(peer.peer_id)}</div>
              <div class="bridge-peer-meta">
                <span class="bridge-pill">${escapeHtml(peer.kind || 'unknown')}</span>
                <span class="bridge-pill">${escapeHtml(peer.path || '/')}</span>
                <span class="bridge-pill">${escapeHtml(new Date(peer.updated_at || Date.now()).toLocaleTimeString())}</span>
                <span class="bridge-pill bridge-pill-source">${escapeHtml(peer.source || 'browser')}</span>
              </div>
            </div>
          </summary>
          <div class="bridge-peer-detail mono">${peer.detail ? escapeHtml(formatPeerDetail(peer.detail)) : 'no detail'}</div>
        </details>
      `).join('');
      for (const peerKeyValue of openPeerKeys) {
        for (const card of peerListEl.querySelectorAll('details[data-peer-key]')) {
          if (card.getAttribute('data-peer-key') === peerKeyValue) {
            card.open = true;
            break;
          }
        }
      }
    }

    // Poll the local preview server when available. Pages deployments just render browser peers.
    async function pollPeers() {
      try {
        const response = await fetch('/peers', { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const peers = await response.json();
        remotePeers.clear();
        for (const peer of Array.isArray(peers) ? peers : []) {
          upsertPeer('localhost', peer);
        }
        schedulePeerRender();
      } catch (e) {
        schedulePeerRender();
      }
    }

    function currentRelayUrls() {
      return [...new Set([
        ...relays,
        ...[...relayCatalog.values()].flatMap((entry) => entry.relays || []),
      ])];
    }

    function prioritizeRelayUrls(relayUrls) {
      const normalized = [...new Set(relayUrls.map((url) => normalizeRelayUrl(url)).filter(Boolean))];
      normalized.sort((a, b) => {
        if (a === 'wss://nos.lol') return -1;
        if (b === 'wss://nos.lol') return 1;
        return a.localeCompare(b);
      });
      return normalized;
    }

    function scheduleRelayDiscovery(relayUrls = currentRelayUrls()) {
      const urls = prioritizeRelayUrls(relayUrls);
      let added = false;
      for (const url of urls) {
        if (relayDiscoverySeen.has(url) || relayDiscoveryQueue.has(url)) continue;
        relayDiscoveryQueue.add(url);
        added = true;
      }
      if (added) {
        window.__sharedFooter?.log('bridge', `queue relay discovery (${urls.length})`, 'trace', 'checking');
        void processRelayDiscoveryQueue();
      }
    }

    async function processRelayDiscoveryQueue() {
      if (relayDiscoveryRunning) return;
      relayDiscoveryRunning = true;
      try {
        while (relayDiscoveryQueue.size) {
          const batch = [...relayDiscoveryQueue];
          relayDiscoveryQueue.clear();
          const relaysToQuery = batch.filter((url) => !relayDiscoverySeen.has(url));
          if (!relaysToQuery.length) continue;

          for (const relay of relaysToQuery) {
            relayDiscoverySeen.add(relay);
          }

          window.__sharedFooter?.log('bridge', `discover relays from ${relaysToQuery.length} known relays`, 'trace', 'checking');
          window.__sharedFooter?.log('bridge', `subscribe relay discovery batch (generic dump): ${relaysToQuery.join(', ')}`, 'trace', 'checking');
          for (const relay of relaysToQuery) {
            window.__sharedFooter?.log('bridge', `query known relay ${relay}`, 'trace', 'checking');
          }
          pool.subscribeMany(relaysToQuery, [{ limit: 200 }], {
            onevent(event) {
              logRawNostrEvent('discovery event raw', event);
              recordRelayInfo(event);
            },
            oneose() {},
          });

          await Promise.resolve();
        }
      } finally {
        relayDiscoveryRunning = false;
      }
    }

    function kindTopic(event) {
      return `${topic}/${event.kind}`;
    }

    function collectRelayUrls(value, found = new Set()) {
      if (typeof value === 'string') {
        const normalized = normalizeRelayUrl(value);
        if (normalized) found.add(normalized);
        return found;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectRelayUrls(item, found);
        return found;
      }
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectRelayUrls(item, found);
      }
      return found;
    }

    function collectRelayUrlsFromTags(tags, found = new Set()) {
      if (!Array.isArray(tags)) return found;
      for (const tag of tags) {
        if (!Array.isArray(tag) || tag[0] !== 'r' || !tag[1]) continue;
        const normalized = normalizeRelayUrl(tag[1]);
        if (normalized) found.add(normalized);
      }
      return found;
    }

    function normalizeRelayUrl(url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'wss:') return null;
        return parsed.toString().replace(/\/$/, '');
      } catch {
        return null;
      }
    }

    function recordRelayInfo(event) {
      if (!event?.pubkey) return;
      const urls = extractRelayUrlsFromEvent(event);
      if (!urls.size) return;
      window.__sharedFooter?.log('bridge', `accumulate ${urls.size} relays from kind ${event.kind} ${event.pubkey}`, 'trace', 'checking');
      relayCatalog.set(event.pubkey, {
        owner: event.pubkey,
        kind: event.kind,
        relays: [...urls],
        updated_at: Date.now(),
      });
      window.__sharedFooter?.log('bridge', `relay catalog size ${relayCatalog.size}`, 'trace', 'available');
      scheduleRelayRender();
      scheduleBridgeCachePersist();
      scheduleRelayDiscovery([...urls]);
      scheduleBridgePresenceBroadcast([...urls]);
      void refreshRelayInfo([...urls]);
    }

    function extractRelayUrlsFromEvent(event) {
      const urls = new Set();
      if (!event || typeof event !== 'object') return urls;
      collectRelayUrlsFromTags(event.tags || [], urls);
      collectRelayUrls(event.tags || [], urls);
      if (typeof event.content === 'string') {
        try {
          collectRelayUrls(JSON.parse(event.content || '{}'), urls);
        } catch {
          collectRelayUrls(event.content, urls);
        }
      } else {
        collectRelayUrls(event.content, urls);
      }
      for (const value of Object.values(event)) {
        if (value === event.tags || value === event.content) continue;
        collectRelayUrls(value, urls);
      }
      return urls;
    }

    function formatPeerDetail(detail) {
      if (detail == null) return 'no detail';
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) return detail.map((item) => formatPeerDetail(item)).join(', ');
      const scalarText = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (typeof value?.toString === 'function') {
          const text = value.toString();
          if (text && text !== '[object Object]') return text;
        }
        if (value?.bytes instanceof Uint8Array) {
          return [...value.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        if (value?.multihash?.bytes instanceof Uint8Array) {
          return [...value.multihash.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        }
        return '';
      };
      const parseKeyValueString = (text) => {
        const entries = [];
        for (const token of String(text).split(/\s+/)) {
          const [key, ...rest] = token.split('=');
          if (!key || !rest.length) continue;
          entries.push([key, rest.join('=')]);
        }
        return entries;
      };
      const entriesToText = (entries) => entries
        .flatMap(([key, value]) => {
          if (value == null || value === '') return [];
          if (key === 'keys') {
            return [`keys:`, ...String(value).split(',').filter(Boolean).map((item) => `  - ${item}`)];
          }
          return [`${key}: ${value}`];
        })
        .join('\n');
      if (typeof detail === 'object') {
        const fields = [];
        if (scalarText(detail.peerId)) fields.push(['peerId', scalarText(detail.peerId)]);
        if (scalarText(detail.remotePeer)) fields.push(['remotePeer', scalarText(detail.remotePeer)]);
        if (detail.connection?.stat?.direction) fields.push(['direction', detail.connection.stat.direction]);
        if (scalarText(detail.connection?.remoteAddr)) fields.push(['remoteAddr', scalarText(detail.connection.remoteAddr)]);
        if (scalarText(detail.id)) fields.push(['id', scalarText(detail.id)]);
        if (detail.multiaddrs?.length) fields.push(['multiaddrs', detail.multiaddrs.map((addr) => scalarText(addr) || String(addr)).join(' | ')]);
        if (detail.type) fields.push(['type', detail.type]);
        if (scalarText(detail.multihash)) fields.push(['multihash', scalarText(detail.multihash)]);
        if (scalarText(detail.publicKey)) fields.push(['publicKey', scalarText(detail.publicKey)]);
        if (detail.keys && Array.isArray(detail.keys)) fields.push(['keys', detail.keys.join(',')]);
        if (detail.keys && !Array.isArray(detail.keys) && typeof detail.keys === 'string') fields.push(['keys', detail.keys]);
        return fields.length ? entriesToText(fields) : JSON.stringify(detail, null, 2);
      }
      const parsed = parseKeyValueString(detail);
      return parsed.length ? entriesToText(parsed) : String(detail);
    }

    function markSeen(event) {
      if (!event?.id || seen.has(event.id)) return false;
      seen.add(event.id);
      refreshMetrics();
      return true;
    }

    async function publishToLibp2p(event, direction) {
      if (!node) return;
      const payload = buildBridgeEnvelope(event, direction, currentRelayUrls());
      await node.services.pubsub.publish(topic, encoder.encode(JSON.stringify(payload)));
      metrics.nostrToLibp2p += direction === 'nostr->libp2p' ? 1 : 0;
      refreshMetrics();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id}`, 'trace', 'available');
    }

    async function publishToRelays(event, direction, relayHints = []) {
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      if (!publishRelays.length) {
        throw new Error('no relays configured');
      }
      const publishTargets = publishRelays.map((relay) => pool.publish([relay], event));
      const results = await Promise.allSettled(publishTargets);
      const successes = results.filter((result) => result.status === 'fulfilled');
      const failures = results.filter((result) => result.status === 'rejected');
      metrics.relayPublishesAttempted += results.length;
      metrics.relayPublishesSucceeded += successes.length;
      metrics.libp2pToNostr += successes.length;
      refreshMetrics();
      window.__sharedFooter?.log('bridge', `${direction} ${event.kind} ${event.id} via ${publishRelays.join(', ')}`, 'info', 'available');
      window.__sharedFooter?.log('bridge', `publish responses ${event.id}: ${successes.length}/${results.length} ok`, failures.length ? 'warn' : 'info', failures.length ? 'checking' : 'available');
      scheduleBridgeVerification(event, publishRelays, direction);
      return successes[0]?.value || null;
    }

    async function broadcastBridgePresence(relayHints = currentRelayUrls()) {
      if (!node) return;
      const publishRelays = prioritizeRelayUrls([
        ...collectBridgeRelayHints(relayHints),
        ...currentRelayUrls(),
        ...DEFAULT_RELAYS,
      ]);
      if (!publishRelays.length) return;

      const event = buildBridgePresenceEvent(publishRelays);
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', 'bridge presence event failed verification', 'error', 'unavailable');
        return;
      }

      logRawNostrEvent('bridge presence raw', event);
      window.__sharedFooter?.log('bridge', `broadcast bridge presence ${event.id} to ${publishRelays.length} relays`, 'info', 'checking');
      const results = await Promise.allSettled(publishRelays.map(async (relay) => {
        window.__sharedFooter?.log('bridge', `presence publish request ${relay} ${event.id}`, 'trace', 'checking');
        const response = await pool.publish([relay], event);
        window.__sharedFooter?.log('bridge', `presence publish response ${relay} ${event.id}: ${response}`, 'info', 'available');
      }));
      const failed = results.filter((result) => result.status === 'rejected');
      metrics.relayPublishesAttempted += results.length;
      metrics.relayPublishesSucceeded += results.length - failed.length;
      metrics.libp2pToNostr += results.length - failed.length;
      refreshMetrics();
      if (failed.length) {
        for (const result of failed) {
          window.__sharedFooter?.log('bridge', `presence publish failed: ${result.reason?.message || result.reason || 'unknown error'}`, 'warn', 'unavailable');
        }
      }
      window.__sharedFooter?.log('bridge', `bridge presence broadcast complete (${results.length - failed.length}/${results.length})`, failed.length ? 'warn' : 'info', failed.length ? 'checking' : 'available');
      scheduleBridgeVerification(event, publishRelays, 'presence');
    }

    async function handleNostrEvent(event, source = 'relay') {
      if (!event || typeof event !== 'object' || !event.id) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected invalid event ${event.id}`, 'warn', 'unavailable');
        return;
      }
      if (!markSeen(event)) {
        window.__sharedFooter?.log('bridge', `deduped ${event.id}`, 'trace', 'available');
        return;
      }
      if (event.kind === 10002 || event.kind === 3) {
        recordRelayInfo(event);
        scheduleRelayRender();
      }
      window.__sharedFooter?.log('nostr', `${source} kind ${event.kind} ${event.id} by ${event.pubkey}`, 'trace', 'checking');
      try {
        await publishToLibp2p(event, 'nostr->libp2p');
      } catch (e) {
        window.__sharedFooter?.log('bridge', `libp2p publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    async function handleLibp2pMessage(message) {
      const envelope = unwrapBridgeEnvelope(message);
      if (!envelope) {
        window.__sharedFooter?.log('bridge', 'rejected libp2p payload with unsupported protocol', 'warn', 'unavailable');
        return;
      }
      const { event, relayHints, direction } = envelope;
      if (!markSeen(event)) return;
      if (!verifyEvent(event)) {
        window.__sharedFooter?.log('bridge', `rejected libp2p payload ${event.id}`, 'warn', 'unavailable');
        return;
      }
      window.__sharedFooter?.log('bridge', `libp2p→nostr ${direction} ${event.kind} ${event.id}`, 'trace', 'checking');
      try {
        await publishToRelays(event, 'libp2p->nostr', relayHints);
      } catch (e) {
        window.__sharedFooter?.log('bridge', `relay publish failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    // Start with the strongest transport set and fall back until libp2p accepts the browser runtime.
    async function startBridge() {
      if (started) return;
      started = true;
      setStatus('starting libp2p node', 'checking');
      try {
        const configs = [
          // Prefer hole punching-capable transports first.
          { includeWebRTC: true, includeWebRTCDirect: true, includeCircuitRelay: true },
          { includeWebRTC: true, includeWebRTCDirect: false, includeCircuitRelay: true },
          { includeWebRTC: true, includeWebRTCDirect: false, includeCircuitRelay: false },
          // Final fallback: a plain browser node that still can report peers and join pubsub.
          { includeWebRTC: false, includeWebRTCDirect: false, includeCircuitRelay: false },
        ];

        let lastError = null;
        for (const config of configs) {
          try {
            const stack = await createSharedLibp2pStack({
              ...config,
              onLog(level, text, state) {
                window.__sharedFooter?.log('libp2p', text, level, state);
              },
              onPeer(peer) {
                window.__sharedFooter?.log('libp2p', `${peer.kind} ${peer.peer}`, 'trace', 'checking');
                upsertPeer('browser', {
                  peer_id: peer.peer,
                  kind: peer.kind,
                  path: window.location.pathname || '/',
                  detail: peer.detail,
                  source: 'browser',
                  relays: currentRelayUrls(),
                  relay_info: [...relayCatalog.values()],
                  updated_at: Date.now(),
                });
                schedulePeerRender();
              },
              onStatus(state, peerId) {
                setStatus(`${state} ${peerId}`, state === 'started' ? 'available' : 'checking');
              },
            });
            node = stack.node;
            window.__sharedFooter?.log('bridge', `bridge p2p config ok: ${JSON.stringify(config)}`, 'debug', 'available');
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            window.__sharedFooter?.log('bridge', `p2p config failed: ${JSON.stringify(config)} (${e.message})`, 'warn', 'unavailable');
          }
        }

        if (!node) {
          throw lastError || new Error('unable to start libp2p');
        }

        await node.services.pubsub.subscribe(topic);
        window.__sharedFooter?.log('bridge', `subscribed libp2p pubsub ${topic}`, 'trace', 'available');
        node.services.pubsub.addEventListener('message', (evt) => {
          const payload = evt.detail?.data;
          try {
            const message = JSON.parse(decoder.decode(payload));
            void handleLibp2pMessage(message);
          } catch {
            window.__sharedFooter?.log('bridge', 'ignored malformed pubsub payload', 'warn', 'unavailable');
          }
        });

        const relaysSnapshot = prioritizeRelayUrls([...DEFAULT_RELAYS, ...currentRelayUrls()]);
        window.__sharedFooter?.log('bridge', `subscribing Nostr relays: ${relaysSnapshot.join(', ')}`, 'trace', 'checking');
        pool.subscribeMany(relaysSnapshot, [{ limit: 500 }], {
          onevent(event) {
            logRawNostrEvent('relay event raw', event);
            void handleNostrEvent(event, 'relay');
          },
          oneose() {},
        });

        setStatus(`bridging ${relaysSnapshot.length} relays on ${topic}`, 'available');
        window.__sharedFooter?.log('bridge', `bridge ready on topic ${topic}`, 'info', 'available');
        for (const relay of relaysSnapshot) {
          window.__sharedFooter?.log('bridge', `query nostr relay ${relay}`, 'trace', 'checking');
        }
        void refreshRelayInfo(relaysSnapshot);
        scheduleRelayDiscovery(relaysSnapshot);
        scheduleBridgePresenceBroadcast(relaysSnapshot);
        void pollPeers();
        peerPollTimer = window.setInterval(() => {
          void pollPeers();
        }, 2000);
      } catch (e) {
        setStatus(`bridge failed: ${e.message}`, 'unavailable');
        window.__sharedFooter?.log('bridge', `bridge failed: ${e.message}`, 'error', 'unavailable');
      }
    }

    const bootBridge = () => {
      restoreBridgeCache();
      scheduleRelayDiscovery(DEFAULT_RELAYS);
      scheduleRelayDiscovery(relays);
      scheduleDefaultRelayRender();
      scheduleRelayRender();
      schedulePeerRender();
      void refreshRelayInfo(DEFAULT_RELAYS);
      void refreshRelayInfo(currentRelayUrls());
      scheduleRelayDiscovery(currentRelayUrls());
      scheduleBridgePresenceBroadcast(currentRelayUrls());
      window.setTimeout(() => {
        void startBridge();
      }, 0);
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.setTimeout(bootBridge, 0));
    } else {
      window.setTimeout(bootBridge, 0);
    }
