(function (root) {
  'use strict';

  const API_KEY = '__FIREBASE_API_KEY__';
  const AUTH_ORIGIN = '__AUTH_BASE_URL__';
  const TOKEN_ORIGIN = '__TOKEN_BASE_URL__';
  const FUNCTIONS_ORIGIN = '__FUNCTIONS_BASE_URL__';
  const SESSION_KEY = 'claimSparkAdminSession';

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
    const payload = await jsonRequest(
      `${AUTH_ORIGIN}/accounts:signInWithPassword?key=${encodeURIComponent(API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    return save(parseSession(payload));
  }

  async function freshSession() {
    const existing = load();
    if (!existing) throw new Error('UNAUTHENTICATED');
    if (existing.expiresAt > Date.now()) return existing;
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
    return save({ ...parseSession(payload), email: existing.email });
  }

  async function call(name, data = {}) {
    const session = await freshSession();
    const payload = await jsonRequest(`${FUNCTIONS_ORIGIN}/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data })
    });
    return payload.result;
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  root.ClaimSparkAdminApi = Object.freeze({ call, load, signIn, signOut });
})(globalThis);
