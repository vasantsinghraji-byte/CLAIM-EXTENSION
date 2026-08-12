const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextVersion } = require('../scripts/release');
const { verifyArtifact } = require('../scripts/verify-artifact');

const root = path.join(__dirname, '..');

test('release workflow calculates semantic versions deterministically', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => nextVersion('1.2', 'patch'), /Invalid semantic version/);
  assert.throws(() => nextVersion('1.2.3', 'beta'), /major, minor, or patch/);
});

test('CI and local releases require the emulator licence lifecycle gate', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, 'scripts', 'release.js'), 'utf8');
  const lifecycleStep = workflow.indexOf('run: npm run test:lifecycle');
  const artifactStep = workflow.indexOf('uses: actions/upload-artifact@v4');

  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /distribution:\s*temurin/);
  assert.match(workflow, /java-version:\s*['"]21['"]/);
  assert.ok(lifecycleStep >= 0, 'CI must run the lifecycle acceptance test');
  assert.ok(lifecycleStep < artifactStep, 'lifecycle acceptance must pass before artifact upload');
  assert.match(release, /\[npmCli, 'run', 'test:browser'\]/);
  assert.match(release, /\[npmCli, 'run', 'test:lifecycle'\]/);
  assert.match(release, /assertCleanWorktree\(\)/);
  assert.match(release, /lock\.packages\[''\]\.version = version/);
});

test('artifact verification checks aligned versions and package bytes', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-release-'));
  const artifact = Buffer.from('deterministic extension fixture');
  const sha256 = crypto.createHash('sha256').update(artifact).digest('hex').toUpperCase();
  try {
    fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(fixture, 'package-lock.json'), JSON.stringify({
      version: '1.2.3', packages: { '': { version: '1.2.3' } }
    }));
    fs.writeFileSync(path.join(fixture, 'extension.zip'), artifact);
    fs.writeFileSync(path.join(fixture, 'release-manifest.json'), JSON.stringify({
      version: '1.2.3', artifact: 'extension.zip', sha256
    }));

    assert.deepEqual(verifyArtifact(fixture), { version: '1.2.3', sha256 });
    fs.appendFileSync(path.join(fixture, 'extension.zip'), 'drift');
    assert.throws(() => verifyArtifact(fixture), /Artifact checksum mismatch/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
