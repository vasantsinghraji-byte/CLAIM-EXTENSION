'use strict';

const assert = require('node:assert/strict');

async function main() {
  const origin = process.env.FIREBASE_HOSTING_EMULATOR_ORIGIN || 'http://127.0.0.1:5000';
  let runtimeHeadersAvailable = false;
  for (const route of ['/', '/admin', '/privacy', '/support', '/terms', '/deletion']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, `${route} must return HTTP 200`);
    const policy = response.headers.get('content-security-policy');
    if (policy) {
      runtimeHeadersAvailable = true;
      assert.match(policy, /script-src 'self'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    }
    const body = await response.text();
    assert.match(body, /Claim Spark/);
  }
  const adminScript = await fetch(`${origin}/admin.js`);
  assert.equal(adminScript.status, 200);
  if (runtimeHeadersAvailable) assert.equal(adminScript.headers.get('cache-control'), 'no-store');
  console.log(runtimeHeadersAvailable
    ? 'Hosted dashboard routes and runtime security headers verified'
    : 'Hosted dashboard routes verified; emulator omitted configured response headers');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
