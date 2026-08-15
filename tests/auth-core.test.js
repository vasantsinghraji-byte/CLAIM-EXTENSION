const test = require('node:test');
const assert = require('node:assert/strict');
const AuthCore = require('../auth-core');

function jsonResponse(ok, body) {
  return { ok, json: async () => body };
}

test('successful sign-in parses tokens and computes an expiry from expiresIn', async () => {
  const before = Date.now();
  const result = await AuthCore.signInWithPassword({
    apiKey: 'test-key',
    email: 'user@example.com',
    password: 'secret',
    fetchImpl: async () => jsonResponse(true, {
      idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600', localId: 'uid-1', email: 'user@example.com'
    })
  });
  assert.equal(result.idToken, 'id-token');
  assert.equal(result.refreshToken, 'refresh-token');
  assert.equal(result.uid, 'uid-1');
  assert.equal(result.email, 'user@example.com');
  assert.equal(result.displayName, '');
  assert.ok(result.expiresAt >= before + 3600 * 1000 && result.expiresAt <= Date.now() + 3600 * 1000 + 1000);
});

for (const code of ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'USER_DISABLED', 'TOO_MANY_ATTEMPTS_TRY_LATER']) {
  test(`sign-in maps the Identity Toolkit ${code} error to a normalized code`, async () => {
    await assert.rejects(
      AuthCore.signInWithPassword({
        apiKey: 'test-key',
        email: 'user@example.com',
        password: 'wrong',
        fetchImpl: async () => jsonResponse(false, { error: { message: code } })
      }),
      error => error.code === code
    );
  });
}

test('sign-in normalizes a "CODE : detail" error message to just the code', async () => {
  await assert.rejects(
    AuthCore.signInWithPassword({
      apiKey: 'test-key',
      email: 'user@example.com',
      password: 'wrong',
      fetchImpl: async () => jsonResponse(false, { error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : too many attempts' } })
    }),
    error => error.code === 'TOO_MANY_ATTEMPTS_TRY_LATER'
  );
});

test('a fetch failure is normalized to NETWORK_ERROR rather than leaking the raw cause', async () => {
  await assert.rejects(
    AuthCore.signInWithPassword({
      apiKey: 'test-key',
      email: 'user@example.com',
      password: 'secret',
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
    }),
    error => error.code === 'NETWORK_ERROR'
  );
});

test('signUp parses tokens for a newly created account', async () => {
  const result = await AuthCore.signUp({
    apiKey: 'test-key',
    email: 'new-processor@example.com',
    password: 'secret123',
    fetchImpl: async () => jsonResponse(true, {
      idToken: 'new-id-token', refreshToken: 'new-refresh-token', expiresIn: '3600', localId: 'uid-2', email: 'new-processor@example.com'
    })
  });
  assert.equal(result.uid, 'uid-2');
  assert.equal(result.idToken, 'new-id-token');
});

for (const code of ['EMAIL_EXISTS', 'WEAK_PASSWORD', 'INVALID_EMAIL', 'OPERATION_NOT_ALLOWED']) {
  test(`signUp maps the Identity Toolkit ${code} error to a normalized code`, async () => {
    await assert.rejects(
      AuthCore.signUp({
        apiKey: 'test-key',
        email: 'new-processor@example.com',
        password: 'x',
        fetchImpl: async () => jsonResponse(false, { error: { message: code } })
      }),
      error => error.code === code
    );
  });
}

test('sendEmailVerification returns the target email on success', async () => {
  const result = await AuthCore.sendEmailVerification({
    apiKey: 'test-key',
    idToken: 'id-token',
    fetchImpl: async (url, init) => {
      assert.match(url, /accounts:sendOobCode/);
      assert.deepEqual(JSON.parse(init.body), { requestType: 'VERIFY_EMAIL', idToken: 'id-token' });
      return jsonResponse(true, { email: 'new-processor@example.com' });
    }
  });
  assert.equal(result.email, 'new-processor@example.com');
});

test('sendPasswordReset requests a reset link using only the account email', async () => {
  const result = await AuthCore.sendPasswordReset({
    apiKey: 'test-key',
    email: 'processor@example.com',
    fetchImpl: async (url, init) => {
      assert.match(url, /accounts:sendOobCode/);
      assert.deepEqual(JSON.parse(init.body), {
        requestType: 'PASSWORD_RESET',
        email: 'processor@example.com'
      });
      return jsonResponse(true, { email: 'processor@example.com' });
    }
  });
  assert.equal(result.email, 'processor@example.com');
});

test('updatePassword rotates the authenticated Firebase session', async () => {
  const result = await AuthCore.updatePassword({
    apiKey: 'test-key',
    idToken: 'old-id-token',
    password: 'new-secret',
    fetchImpl: async (url, init) => {
      assert.match(url, /accounts:update/);
      assert.deepEqual(JSON.parse(init.body), {
        idToken: 'old-id-token',
        password: 'new-secret',
        returnSecureToken: true
      });
      return jsonResponse(true, {
        idToken: 'new-id-token', refreshToken: 'new-refresh-token', expiresIn: '3600'
      });
    }
  });
  assert.equal(result.idToken, 'new-id-token');
  assert.equal(result.refreshToken, 'new-refresh-token');
  assert.ok(result.expiresAt > Date.now());
});

test('updateProfile persists the signup display name without rotating tokens', async () => {
  const result = await AuthCore.updateProfile({
    apiKey: 'test-key',
    idToken: 'id-token',
    displayName: 'New Processor',
    fetchImpl: async (url, init) => {
      assert.match(url, /accounts:update/);
      assert.deepEqual(JSON.parse(init.body), {
        idToken: 'id-token',
        displayName: 'New Processor',
        returnSecureToken: false
      });
      return jsonResponse(true, { displayName: 'New Processor' });
    }
  });
  assert.equal(result.displayName, 'New Processor');
});

test('accountInfo reports emailVerified from the live lookup, not the cached token', async () => {
  const verified = await AuthCore.accountInfo({
    apiKey: 'test-key',
    idToken: 'id-token',
    fetchImpl: async () => jsonResponse(true, { users: [{ email: 'a@b.com', emailVerified: true }] })
  });
  assert.equal(verified.emailVerified, true);

  const unverified = await AuthCore.accountInfo({
    apiKey: 'test-key',
    idToken: 'id-token',
    fetchImpl: async () => jsonResponse(true, { users: [{ email: 'a@b.com' }] })
  });
  assert.equal(unverified.emailVerified, false);
});

test('accountInfo returns the server-side display name for lost local onboarding state', async () => {
  const result = await AuthCore.accountInfo({
    apiKey: 'test-key',
    idToken: 'id-token',
    fetchImpl: async () => jsonResponse(true, {
      users: [{ email: 'a@b.com', emailVerified: true, displayName: 'Processor Name' }]
    })
  });
  assert.deepEqual(result, { emailVerified: true, displayName: 'Processor Name' });
});

test('refreshIdToken parses the Secure Token API snake_case response', async () => {
  const result = await AuthCore.refreshIdToken({
    apiKey: 'test-key',
    refreshToken: 'refresh-token',
    fetchImpl: async () => jsonResponse(true, { id_token: 'new-id-token', refresh_token: 'new-refresh-token', expires_in: '3600' })
  });
  assert.equal(result.idToken, 'new-id-token');
  assert.equal(result.refreshToken, 'new-refresh-token');
  assert.ok(result.expiresAt > Date.now());
});

test('refreshIdToken rejects an expired/invalid refresh token with a normalized code', async () => {
  await assert.rejects(
    AuthCore.refreshIdToken({
      apiKey: 'test-key',
      refreshToken: 'stale-token',
      fetchImpl: async () => jsonResponse(false, { error: { message: 'TOKEN_EXPIRED' } })
    }),
    error => error.code === 'TOKEN_EXPIRED'
  );
});

test('callFunction unwraps the callable {result} envelope', async () => {
  const result = await AuthCore.callFunction({
    functionsBaseUrl: 'https://asia-south1-claimextension.cloudfunctions.net',
    name: 'verifyLicence',
    idToken: 'id-token',
    data: { extensionVersion: '1.6.0' },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://asia-south1-claimextension.cloudfunctions.net/verifyLicence');
      assert.equal(init.headers.Authorization, 'Bearer id-token');
      assert.deepEqual(JSON.parse(init.body), { data: { extensionVersion: '1.6.0' } });
      return jsonResponse(true, { result: { status: 'active', previewAllowed: true, applyAllowed: true } });
    }
  });
  assert.deepEqual(result, { status: 'active', previewAllowed: true, applyAllowed: true });
});

for (const status of ['UNAUTHENTICATED', 'FAILED_PRECONDITION', 'RESOURCE_EXHAUSTED']) {
  test(`callFunction throws with the callable ${status} error status`, async () => {
    await assert.rejects(
      AuthCore.callFunction({
        functionsBaseUrl: 'https://asia-south1-claimextension.cloudfunctions.net',
        name: 'verifyLicence',
        idToken: 'id-token',
        data: {},
        fetchImpl: async () => jsonResponse(false, { error: { message: 'denied', status } })
      }),
      error => error.status === status
    );
  });
}

test('computeExpiresAt and isTokenFresh boundary math', () => {
  assert.equal(AuthCore.computeExpiresAt(3600, 1000), 1000 + 3600 * 1000);
  assert.equal(AuthCore.computeExpiresAt('3600', 1000), 1000 + 3600 * 1000);

  const now = 1_000_000;
  assert.equal(AuthCore.isTokenFresh(null, now), false);
  assert.equal(AuthCore.isTokenFresh({ expiresAt: now + 400_000 }, now, 300_000), true);
  assert.equal(AuthCore.isTokenFresh({ expiresAt: now + 100_000 }, now, 300_000), false);
});
