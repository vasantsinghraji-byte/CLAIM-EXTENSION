const test = require('node:test');
const assert = require('node:assert/strict');
const sourceManifest = require('../manifest.json');
const { createProductionManifest, createBuildEntries, createStoredZip } = require('../build');

const developmentOrigins = ['http://localhost/*', 'http://127.0.0.1/*'];

test('production manifest strips development origins from every exposed match list', () => {
  const production = createProductionManifest(sourceManifest);
  const sourceText = JSON.stringify(sourceManifest);
  const productionText = JSON.stringify(production);

  for (const origin of developmentOrigins) {
    assert.match(sourceText, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the unpacked development manifest should retain local testing access');
    assert.doesNotMatch(productionText, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.deepEqual(production.content_scripts[0].matches, ['https://rghs.rajasthan.gov.in/*']);
  assert.deepEqual(production.web_accessible_resources[0].matches, ['https://rghs.rajasthan.gov.in/*']);
  assert.equal(production.content_scripts[0].all_frames, false);
});

test('host_permissions pass through production stripping unchanged today, and no prod Firebase host exists yet', () => {
  const production = createProductionManifest(sourceManifest);
  assert.deepEqual(production.host_permissions, sourceManifest.host_permissions);
  assert.equal(JSON.stringify(sourceManifest).includes('claimextension-prod'), false,
    'no production Firebase host should be referenced in manifest.json until production is actually provisioned');
});

test('production dist and ZIP inputs contain only the sanitized manifest', () => {
  const entries = createBuildEntries();
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  assert.ok(manifestEntry);
  const manifestText = manifestEntry.data.toString('utf8');
  const zip = createStoredZip(entries);

  for (const origin of developmentOrigins) {
    assert.equal(manifestText.includes(origin), false);
    assert.equal(zip.includes(Buffer.from(origin)), false);
  }
});
