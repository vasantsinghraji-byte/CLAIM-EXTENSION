#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const projectId = String(process.env.STAGING_FIREBASE_PROJECT || 'claimextension').trim();
const stagingOrigin = String(process.env.STAGING_ORIGIN || 'https://claimextension.web.app').trim().replace(/\/+$/, '');
const adminEmail = String(process.env.STAGING_ADMIN_EMAIL || '').trim();
const adminPassword = String(process.env.STAGING_ADMIN_PASSWORD || '');

function refuseProduction(value, label) {
  if (/claimextension-prod/i.test(String(value))) {
    throw new Error(`${label} must not target production`);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} returned non-JSON HTTP ${response.status}`);
  }
  return { response, payload };
}

async function callable(functionsBaseUrl, name, idToken, data = {}) {
  return jsonRequest(`${functionsBaseUrl}/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify({ data })
  });
}

async function verifyHostedDashboard(expectedFunctionsBaseUrl, apiKey) {
  for (const route of ['/', '/admin', '/privacy', '/support', '/terms', '/deletion']) {
    const response = await fetch(`${stagingOrigin}${route}`, { redirect: 'error' });
    assert.equal(response.status, 200, `${route} must return HTTP 200`);
    assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy') || '', new RegExp(
      expectedFunctionsBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Claim Spark/);
  }

  const clientResponse = await fetch(`${stagingOrigin}/firebase-client.js`, { redirect: 'error' });
  assert.equal(clientResponse.status, 200, 'deployed firebase-client.js must be available');
  const client = await clientResponse.text();
  assert.match(client, new RegExp(expectedFunctionsBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(client.includes(apiKey), 'deployed dashboard must use the staging Firebase API key');
  assert.doesNotMatch(client, /__FIREBASE_API_KEY__|__FUNCTIONS_BASE_URL__|claimextension-prod/);
}

function verifyUnpackedExtension(expectedFunctionsBaseUrl) {
  const runtime = read(path.join('dist', 'runtime-config.js'));
  const manifest = JSON.parse(read(path.join('dist', 'manifest.json')));
  const popup = read(path.join('dist', 'popup.js'));
  assert.match(runtime, new RegExp(expectedFunctionsBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(runtime, /claimextension-prod|127\.0\.0\.1|localhost/);
  assert.ok(manifest.host_permissions.includes(`${expectedFunctionsBaseUrl}/*`));
  assert.equal(manifest.host_permissions.some(value => /claimextension-prod|127\.0\.0\.1|localhost/.test(value)), false);
  assert.match(popup, /https:\/\/claimextension\.web\.app\/admin/);
  assert.doesNotMatch(popup, /claimextension-prod\.web\.app\/admin/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'icons', 'payment-qr.jpeg')), false);
}

async function verifyBackendBoundary(functionsBaseUrl) {
  const { response, payload } = await callable(functionsBaseUrl, 'getExtensionConfig', null, {});
  assert.equal(response.status, 401, `unauthenticated callable boundary returned ${response.status}`);
  assert.equal(payload.error?.status, 'UNAUTHENTICATED');
}

async function verifyAdministrator(apiKey, functionsBaseUrl) {
  if (!adminEmail || !adminPassword) {
    throw new Error('Set STAGING_ADMIN_EMAIL and STAGING_ADMIN_PASSWORD for the staging administrator smoke test');
  }
  const { response: signInResponse, payload: signIn } = await jsonRequest(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword, returnSecureToken: true })
    }
  );
  assert.equal(signInResponse.ok, true, 'staging administrator sign-in failed');
  assert.ok(signIn.idToken, 'staging administrator sign-in returned no ID token');

  const profile = await callable(functionsBaseUrl, 'getCurrentUserProfile', signIn.idToken, {});
  assert.equal(profile.response.ok, true, 'getCurrentUserProfile failed for the staging administrator');
  assert.equal(profile.payload.result?.email, adminEmail);
  assert.equal(profile.payload.result?.role, 'platformAdmin');
  assert.equal(profile.payload.result?.accountStatus, 'active');

  const users = await callable(functionsBaseUrl, 'listUsers', signIn.idToken, {});
  assert.equal(users.response.ok, true, 'listUsers failed for the staging administrator');
  assert.ok(users.payload.result && Array.isArray(users.payload.result.users));
}

async function main() {
  assert.equal(projectId, 'claimextension', 'staging smoke is locked to the approved non-production project');
  refuseProduction(projectId, 'Firebase project');
  refuseProduction(stagingOrigin, 'Hosting origin');
  const origin = new URL(stagingOrigin);
  assert.equal(origin.protocol, 'https:', 'staging Hosting must use HTTPS');
  assert.ok(
    origin.hostname === `${projectId}.web.app` || origin.hostname === `${projectId}.firebaseapp.com`,
    'STAGING_ORIGIN must be the approved staging Firebase Hosting domain'
  );

  const buildConfig = JSON.parse(read('.firebase-build-config.json'));
  const apiKey = String(buildConfig.development?.apiKey || '').trim();
  const functionsBaseUrl = String(buildConfig.development?.functionsBaseUrl || '').trim().replace(/\/+$/, '');
  assert.ok(apiKey.length >= 20, 'development Firebase API key is missing');
  assert.equal(functionsBaseUrl, `https://asia-south1-${projectId}.cloudfunctions.net`);
  refuseProduction(functionsBaseUrl, 'Functions endpoint');

  verifyUnpackedExtension(functionsBaseUrl);
  await verifyHostedDashboard(functionsBaseUrl, apiKey);
  await verifyBackendBoundary(functionsBaseUrl);
  await verifyAdministrator(apiKey, functionsBaseUrl);
  console.log('PASS: staging dashboard, callable boundary, administrator access, and unpacked extension configuration verified.');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
