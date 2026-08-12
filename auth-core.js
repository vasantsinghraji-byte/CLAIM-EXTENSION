(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaimAuthCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Firebase Identity Toolkit/Secure Token errors return the error code as
  // payload.error.message (sometimes "CODE : extra detail"), never a
  // dedicated .code field - normalize both REST error shapes the same way.
  function normalizeRestError(payload) {
    const message = payload && payload.error && payload.error.message;
    const code = String(message || 'UNKNOWN_ERROR').split(/[\s:]/)[0].toUpperCase();
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function networkError(cause) {
    const error = new Error('NETWORK_ERROR');
    error.code = 'NETWORK_ERROR';
    error.cause = cause;
    return error;
  }

  function computeExpiresAt(expiresInSeconds, now = Date.now()) {
    const seconds = Number(expiresInSeconds);
    return now + (Number.isFinite(seconds) ? seconds : 0) * 1000;
  }

  function isTokenFresh(session, now = Date.now(), skewMs = 5 * 60 * 1000) {
    return !!session && Number.isFinite(session.expiresAt) && session.expiresAt - skewMs > now;
  }

  const configuredAuthBaseUrl = globalThis.ClaimSparkRuntimeConfig?.authBaseUrl
    || 'https://identitytoolkit.googleapis.com/v1';
  const configuredTokenBaseUrl = globalThis.ClaimSparkRuntimeConfig?.tokenBaseUrl
    || 'https://securetoken.googleapis.com/v1';

  async function signInWithPassword({ apiKey, authBaseUrl = configuredAuthBaseUrl, email, password, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${authBaseUrl}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true })
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    return {
      idToken: payload.idToken,
      refreshToken: payload.refreshToken,
      expiresAt: computeExpiresAt(payload.expiresIn),
      uid: payload.localId,
      email: payload.email,
      displayName: payload.displayName || ''
    };
  }

  async function signUp({ apiKey, authBaseUrl = configuredAuthBaseUrl, email, password, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${authBaseUrl}/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true })
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    return {
      idToken: payload.idToken,
      refreshToken: payload.refreshToken,
      expiresAt: computeExpiresAt(payload.expiresIn),
      uid: payload.localId,
      email: payload.email,
      displayName: payload.displayName || ''
    };
  }

  async function updateProfile({ apiKey, authBaseUrl = configuredAuthBaseUrl, idToken, displayName, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${authBaseUrl}/accounts:update?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, displayName, returnSecureToken: false })
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    return { displayName: payload.displayName || displayName };
  }

  async function sendEmailVerification({ apiKey, authBaseUrl = configuredAuthBaseUrl, idToken, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${authBaseUrl}/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken })
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    return { email: payload.email };
  }

  // Live lookup of the current server-side account state (email_verified in
  // particular) - more reliable than decoding the idToken's own claims, which
  // only reflect verification status as of when that token was issued.
  async function accountInfo({ apiKey, authBaseUrl = configuredAuthBaseUrl, idToken, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${authBaseUrl}/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken })
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    const user = (payload.users || [])[0] || {};
    return {
      emailVerified: user.emailVerified === true,
      displayName: user.displayName || ''
    };
  }

  async function refreshIdToken({ apiKey, tokenBaseUrl = configuredTokenBaseUrl, refreshToken, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(
        `${tokenBaseUrl}/token?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
        }
      );
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw normalizeRestError(payload);
    return {
      idToken: payload.id_token,
      refreshToken: payload.refresh_token,
      expiresAt: computeExpiresAt(payload.expires_in)
    };
  }

  // Replicates the v1-compatible callable wire protocol that Firebase
  // Functions v2 onCall still honors for non-SDK callers: POST {data},
  // response {result} on success or {error:{message,status}} on failure.
  async function callFunction({ functionsBaseUrl, name, idToken, data, fetchImpl }) {
    let response;
    try {
      response = await fetchImpl(`${functionsBaseUrl}/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({ data: data || {} })
      });
    } catch (cause) {
      throw networkError(cause);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (payload && payload.error)) {
      const status = payload && payload.error && payload.error.status ? String(payload.error.status) : 'UNKNOWN';
      const message = payload && payload.error && payload.error.message ? String(payload.error.message) : 'Function call failed';
      const error = new Error(message);
      error.status = status;
      throw error;
    }
    return payload.result;
  }

  return {
    signInWithPassword,
    signUp,
    updateProfile,
    sendEmailVerification,
    accountInfo,
    refreshIdToken,
    callFunction,
    computeExpiresAt,
    isTokenFresh
  };
});
