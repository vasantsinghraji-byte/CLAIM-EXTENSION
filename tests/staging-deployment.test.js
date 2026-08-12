const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('staging deployment config permits only the approved non-production Functions origin', () => {
  const config = JSON.parse(read('firebase.staging.json'));
  const policy = config.hosting.headers[0].headers
    .find(header => header.key === 'Content-Security-Policy').value;
  assert.equal(config.functions.runtime, 'nodejs22');
  assert.match(policy, /https:\/\/asia-south1-claimextension\.cloudfunctions\.net/);
  assert.doesNotMatch(policy, /claimextension-prod|127\.0\.0\.1|localhost/);
});

test('staging smoke is production-refusing and covers dashboard, backend and unpacked extension', () => {
  const packageJson = JSON.parse(read('package.json'));
  const source = read('scripts/staging-smoke.js');
  const checklist = read('docs/STAGING_DEPLOYMENT_CHECKLIST.md');
  assert.equal(packageJson.scripts['build:staging'], 'node build.js --staging');
  assert.equal(packageJson.scripts['test:staging'], 'node scripts/staging-smoke.js');
  assert.match(source, /assert\.equal\(projectId, 'claimextension'/);
  assert.match(source, /refuseProduction/);
  assert.match(source, /verifyHostedDashboard/);
  assert.match(source, /verifyUnpackedExtension/);
  assert.match(source, /verifyBackendBoundary/);
  assert.match(source, /verifyAdministrator/);
  assert.match(checklist, /npm\.cmd run build:staging/);
  assert.match(checklist, /npm\.cmd run test:staging/);
  assert.match(checklist, /claimextension-prod.*must not/i);
});
