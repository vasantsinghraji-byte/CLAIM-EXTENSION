const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion } = require('../scripts/release');

test('release workflow calculates semantic versions deterministically', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.2', 'patch'), /Invalid semantic version/);
  assert.throws(() => nextVersion('1.2.3', 'beta'), /major, minor, or patch/);
});
