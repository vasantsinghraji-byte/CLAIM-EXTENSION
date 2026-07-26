const test = require('node:test');
const assert = require('node:assert/strict');
const sourceManifest = require('../manifest.json');
const {
  createProductionBackground,
  createProductionManifest,
  createBuildEntries,
  createStoredZip
} = require('../build');

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

test('production host permissions isolate callable Functions from development', () => {
  const production = createProductionManifest(sourceManifest);
  assert.equal(production.host_permissions.includes('https://asia-south1-claimextension.cloudfunctions.net/*'), false);
  assert.equal(production.host_permissions.includes('https://asia-south1-claimextension-prod.cloudfunctions.net/*'), true);
  assert.equal(sourceManifest.host_permissions.includes('https://asia-south1-claimextension.cloudfunctions.net/*'), true);
});

test('production background replaces all development Firebase identifiers', () => {
  const development = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
  const production = createProductionBackground(development);
  assert.equal(production.includes('AIzaSyD8pZzOBh22-a3dPCMzGThwbMpPKNUIGOs'), false);
  assert.equal(production.includes('asia-south1-claimextension.cloudfunctions.net'), false);
  assert.match(production, /AIzaSyCuDItElzmNWGztOd0_MgjvvZQii74H1C8/);
  assert.match(production, /asia-south1-claimextension-prod\.cloudfunctions\.net/);
});

test('production dist and ZIP inputs contain only the sanitized manifest', () => {
  const entries = createBuildEntries();
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  const backgroundEntry = entries.find(entry => entry.name === 'background.js');
  assert.ok(manifestEntry);
  assert.ok(backgroundEntry);
  const manifestText = manifestEntry.data.toString('utf8');
  const zip = createStoredZip(entries);

  for (const origin of developmentOrigins) {
    assert.equal(manifestText.includes(origin), false);
    assert.equal(zip.includes(Buffer.from(origin)), false);
  }
  assert.equal(zip.includes(Buffer.from('asia-south1-claimextension.cloudfunctions.net')), false);
});
