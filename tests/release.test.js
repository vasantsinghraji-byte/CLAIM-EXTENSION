const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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

const requiredGates = ['check', 'lint', 'test:functions', 'test:browser',
  'test:extension', 'test:dashboard', 'test:firebase', 'test:lifecycle'];

function releaseFixture({ failAt, dirty = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-release-flow-'));
  const originals = {
    'manifest.json': '{"version":"1.2.3"}\n',
    'package.json': '{"version":"1.2.3"}\n',
    'package-lock.json': '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}\n',
    'CHANGELOG.md': '# Changelog\n\nExisting release notes.\n',
    'release-manifest.json': '{"version":"1.2.3","sha256":"previous-release"}\n'
  };
  for (const [file, contents] of Object.entries(originals)) fs.writeFileSync(path.join(directory, file), contents);
  fs.writeFileSync(path.join(directory, 'audit-rules.js'), 'module.exports = { schemaVersion: 1, version: "synthetic" };\n');
  const calls = [], versionsAtValidation = [];
  const childProcess = {
    spawnSync(command, args, options) {
      assert.equal(options.cwd, directory);
      if (command === 'git') return { status: 0, stdout: dirty ? ' M source.js\n' : '' };
      const step = args[0] === 'synthetic-npm-cli' ? args[2] : 'verify:artifact';
      calls.push(step);
      if (requiredGates.includes(step)) {
        versionsAtValidation.push(['manifest.json', 'package.json', 'package-lock.json'].map(file =>
          JSON.parse(fs.readFileSync(path.join(directory, file))).version));
      }
      if (step === failAt) return { status: 1 };
      if (step === 'build') fs.writeFileSync(path.join(directory, 'claim-autofill-extension.zip'), 'synthetic candidate package');
      if (step === 'verify:artifact') verifyArtifact(directory);
      return { status: 0 };
    }
  };
  const fixtureModule = { exports: {} };
  const fixtureRequire = name => name === 'node:child_process' ? childProcess : require(name);
  fixtureRequire.main = fixtureModule;
  const execute = () => vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/release.js'), 'utf8'), {
    require: fixtureRequire, module: fixtureModule, __dirname: path.join(directory, 'scripts'),
    process: { argv: ['node', 'release.js', 'patch', '--notes', 'Synthetic release note'],
      execPath: process.execPath, env: { npm_execpath: 'synthetic-npm-cli' } },
    console: { log() {} }
  });
  return {
    directory, calls, versionsAtValidation, execute,
    assertRestored() {
      for (const [file, original] of Object.entries(originals)) {
        assert.equal(fs.readFileSync(path.join(directory, file), 'utf8'), original, file);
      }
    },
    cleanup() {
      assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'claim-release-flow-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('release validates the candidate version with every acceptance gate before building', () => {
  const fixture = releaseFixture();
  try {
    fixture.execute();
    assert.deepEqual(fixture.calls, [...requiredGates, 'build', 'verify:artifact']);
    assert(fixture.versionsAtValidation.every(versions => versions.every(version => version === '1.2.4')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.directory, 'package-lock.json'))).packages[''].version, '1.2.4');
    assert.match(fs.readFileSync(path.join(fixture.directory, 'CHANGELOG.md'), 'utf8'), /Synthetic release note/);
    assert.equal(verifyArtifact(fixture.directory).version, '1.2.4');
  } finally { fixture.cleanup(); }
});

test('a failed release gate stops packaging and restores all original metadata bytes', () => {
  for (const failAt of [...requiredGates, 'build', 'verify:artifact']) {
    const fixture = releaseFixture({ failAt });
    try {
      assert.throws(fixture.execute, /failed/);
      assert.equal(fixture.calls.at(-1), failAt);
      if (requiredGates.includes(failAt)) assert(!fixture.calls.includes('build'));
      fixture.assertRestored();
    } finally { fixture.cleanup(); }
  }
});

test('a dirty worktree cannot start release validation or change metadata', () => {
  const fixture = releaseFixture({ dirty: true });
  try {
    assert.throws(fixture.execute, /clean Git worktree/);
    assert.deepEqual(fixture.calls, []);
    fixture.assertRestored();
  } finally { fixture.cleanup(); }
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
