(function (root) {
  'use strict';

  const API_KEY = '__FIREBASE_API_KEY__';
  const AUTH_ORIGIN = '__AUTH_BASE_URL__';
  const TOKEN_ORIGIN = '__TOKEN_BASE_URL__';
  const FUNCTIONS_ORIGIN = '__FUNCTIONS_BASE_URL__';
  const SESSION_KEY = 'claimSparkAdminSession';
  let sessionGeneration = 0;
  let refreshing = null;

  function normalizedError(payload, fallback) {
    const raw = payload?.error?.message || payload?.error?.status || fallback;
    return String(raw || 'Request failed').split(' : ')[0].replace(/^auth\//, '');
  }

  async function jsonRequest(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error('NETWORK_ERROR');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(normalizedError(payload, response.statusText));
    return payload;
  }

  function parseSession(payload) {
    const expiresIn = Number(payload.expiresIn || payload.expires_in);
    return {
      uid: payload.localId || payload.user_id,
      email: payload.email || null,
      idToken: payload.idToken || payload.id_token,
      refreshToken: payload.refreshToken || payload.refresh_token,
      expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000
    };
  }

  function save(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function load() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      return value?.idToken && value?.refreshToken ? value : null;
    } catch {
      return null;
    }
  }

  async function signIn(email, password) {
    const generation = ++sessionGeneration;
    refreshing = null;
    const payload = await jsonRequest(
      `${AUTH_ORIGIN}/accounts:signInWithPassword?key=${encodeURIComponent(API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    if (generation !== sessionGeneration) throw new Error('UNAUTHENTICATED');
    return save(parseSession(payload));
  }

  async function freshSession() {
    const existing = load();
    if (!existing) throw new Error('UNAUTHENTICATED');
    if (existing.expiresAt > Date.now()) return existing;
    if (refreshing) return refreshing;
    const generation = sessionGeneration;
    refreshing = refreshSession(existing, generation);
    const pending = refreshing;
    try { return await pending; } finally { if (refreshing === pending) refreshing = null; }
  }

  async function refreshSession(existing, generation) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken
    });
    const payload = await jsonRequest(
      `${TOKEN_ORIGIN}/token?key=${encodeURIComponent(API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    );
    if (generation !== sessionGeneration) throw new Error('UNAUTHENTICATED');
    return save({ ...parseSession(payload), email: existing.email });
  }

  async function call(name, data = {}) {
    const generation = sessionGeneration;
    const session = await freshSession();
    if (generation !== sessionGeneration) throw new Error('SESSION_CHANGED');
    const payload = await jsonRequest(`${FUNCTIONS_ORIGIN}/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data })
    });
    if (generation !== sessionGeneration) throw new Error('SESSION_CHANGED');
    return payload.result;
  }

  async function watchMonitor(signal, onEvent) {
    const session = await freshSession();
    if (signal.aborted) return;
    const response = await fetch(`${FUNCTIONS_ORIGIN}/monitorAdminDashboard`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.idToken}`, Accept: 'text/event-stream' }, signal
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'UNAUTHENTICATED'
      : response.status === 403 ? 'PERMISSION_DENIED' : response.status === 404 ? 'MONITOR_NOT_DEPLOYED' : 'UNAVAILABLE');
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('UNAVAILABLE');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        if (buffer.length > 2000000) throw new Error('UNAVAILABLE');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n'), event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && ['snapshot', 'heartbeat', 'monitor-error'].includes(event)) onEvent(event, JSON.parse(data));
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  function signOut() {
    ++sessionGeneration;
    refreshing = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  root.ClaimSparkAdminApi = Object.freeze({ call, load, signIn, signOut, watchMonitor });
})(globalThis);
