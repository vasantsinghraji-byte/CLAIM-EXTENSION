const test = require('node:test');
const assert = require('node:assert/strict');
const sourceManifest = require('../manifest.json');
const {
  createProductionManifest,
  createBuildEntries,
  createStagingBuildEntries,
  createStagingManifest,
  createStoredZip,
  emulatorConfig,
  runtimeConfigSource,
  validateEnvironmentConfig
} = require('../build');

const developmentOrigins = ['http://localhost/*', 'http://127.0.0.1/*'];
const testProductionConfig = {
  apiKey: 'test-firebase-key-not-a-real-credential',
  functionsBaseUrl: 'https://asia-south1-claimextension-prod.cloudfunctions.net'
};
const testStagingConfig = {
  apiKey: 'test-staging-key-not-a-real-credential',
  functionsBaseUrl: 'https://asia-south1-claimextension.cloudfunctions.net'
};

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

test('runtime Firebase configuration is generated from validated untracked values', () => {
  const config = validateEnvironmentConfig(testProductionConfig, 'Test');
  const source = runtimeConfigSource(config);
  assert.match(source, /test-firebase-key-not-a-real-credential/);
  assert.match(source, /asia-south1-claimextension-prod\.cloudfunctions\.net/);
  assert.match(source, /https:\/\/claimextension-prod\.web\.app\/admin/);
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8'),
    /AIza[0-9A-Za-z_-]{30,}/);
});

test('staging manifest and unpacked build isolate callable Functions from production', () => {
  const staging = createStagingManifest(sourceManifest, testStagingConfig);
  assert.equal(staging.host_permissions.includes('https://asia-south1-claimextension.cloudfunctions.net/*'), true);
  assert.equal(staging.host_permissions.includes('https://asia-south1-claimextension-prod.cloudfunctions.net/*'), false);
  assert.equal(JSON.stringify(staging).includes('http://127.0.0.1'), false);

  const entries = createStagingBuildEntries(testStagingConfig);
  const runtime = entries.find(entry => entry.name === 'runtime-config.js').data.toString('utf8');
  assert.match(runtime, /asia-south1-claimextension\.cloudfunctions\.net/);
  assert.match(runtime, /https:\/\/claimextension\.web\.app\/admin/);
  assert.doesNotMatch(runtime, /claimextension-prod/);
  assert.throws(() => createStagingManifest(sourceManifest, {
    ...testStagingConfig,
    functionsBaseUrl: 'https://asia-south1-claimextension-prod.cloudfunctions.net'
  }), /cannot target the production Functions project/);
});

test('emulator runtime configuration is loopback-only', () => {
  const source = runtimeConfigSource(emulatorConfig);
  assert.match(source, /127\.0\.0\.1:9099\/identitytoolkit\.googleapis\.com\/v1/);
  assert.match(source, /127\.0\.0\.1:9099\/securetoken\.googleapis\.com\/v1/);
  assert.match(source, /127\.0\.0\.1:5001\/demo-claimextension\/asia-south1/);
  assert.doesNotMatch(source, /cloudfunctions\.net/);
});

test('a real local Firebase configuration is mandatory outside CI', () => {
  const { readBuildConfig } = require('../build');
  const previous = process.env.CI;
  process.env.CI = 'false';
  try {
    assert.throws(() => readBuildConfig(require('node:path').join(__dirname, 'missing-config.json')),
      /Missing \.firebase-build-config\.json/);
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
});

test('production dist and ZIP inputs contain only the sanitized manifest', () => {
  const entries = createBuildEntries(testProductionConfig);
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  const backgroundEntry = entries.find(entry => entry.name === 'background.js');
  assert.ok(manifestEntry);
  assert.ok(backgroundEntry);
  assert.ok(entries.find(entry => entry.name === 'runtime-config.js'));
  const manifestText = manifestEntry.data.toString('utf8');
  const zip = createStoredZip(entries);

  for (const origin of developmentOrigins) {
    assert.equal(manifestText.includes(origin), false);
    assert.equal(zip.includes(Buffer.from(origin)), false);
  }
  assert.equal(zip.includes(Buffer.from('asia-south1-claimextension.cloudfunctions.net')), false);
});

test('production package excludes administrator-supplied payment artifacts', () => {
  const entries = createBuildEntries(testProductionConfig);
  const qrEntry = entries.find(entry => /payment-qr/i.test(entry.name));
  assert.equal(qrEntry, undefined);
});
