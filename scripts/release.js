#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function nextVersion(version, releaseType) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  const [, major, minor, patch] = match.map(Number);
  if (releaseType === 'major') return `${major + 1}.0.0`;
  if (releaseType === 'minor') return `${major}.${minor + 1}.0`;
  if (releaseType === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('Release type must be major, minor, or patch');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function assertCleanWorktree() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error('Unable to verify Git worktree state');
  if (result.stdout.trim()) throw new Error('Release requires a clean Git worktree');
}

function main(args = process.argv.slice(2)) {
  const releaseType = args[0];
  const notesIndex = args.indexOf('--notes');
  const notes = notesIndex >= 0 && args[notesIndex + 1] ? args[notesIndex + 1] : 'Automated verified release.';
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run releases through npm: npm run release -- patch|minor|major');
  assertCleanWorktree();
  const files = ['manifest.json', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'release-manifest.json'];
  const originals = new Map(files.map(file => {
    const target = path.join(root, file);
    return [target, fs.existsSync(target) ? fs.readFileSync(target) : null];
  }));

  const manifestPath = path.join(root, 'manifest.json');
  const packagePath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (manifest.version !== pkg.version || pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) {
    throw new Error('Manifest, package and lockfile versions are not aligned');
  }
  const version = nextVersion(manifest.version, releaseType);

  run(process.execPath, [npmCli, 'run', 'check']);
  run(process.execPath, [npmCli, 'run', 'test:browser']);
  run(process.execPath, [npmCli, 'run', 'test:lifecycle']);
  try {
    manifest.version = version;
    pkg.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const date = new Date().toISOString().slice(0, 10);
    const changelogPath = path.join(root, 'CHANGELOG.md');
    const previous = originals.get(changelogPath)?.toString('utf8') || '# Changelog\n';
    fs.writeFileSync(changelogPath, `${previous.trimEnd()}\n\n## ${version} - ${date}\n\n- ${notes}\n`);

    run(process.execPath, [npmCli, 'run', 'check']);
    run(process.execPath, [npmCli, 'run', 'build']);
    const zip = fs.readFileSync(path.join(root, 'claim-autofill-extension.zip'));
    const rules = require(path.join(root, 'audit-rules.js'));
    const release = {
      version,
      builtAt: new Date().toISOString(),
      artifact: 'claim-autofill-extension.zip',
      sha256: crypto.createHash('sha256').update(zip).digest('hex').toUpperCase(),
      ruleSchemaVersion: rules.schemaVersion,
      ruleSetVersion: rules.version
    };
    fs.writeFileSync(path.join(root, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
    run(process.execPath, [path.join(root, 'scripts', 'verify-artifact.js')]);
    console.log(`Released ${version} (${release.sha256})`);
  } catch (error) {
    for (const [target, original] of originals) {
      if (original === null) {
        if (fs.existsSync(target)) fs.rmSync(target);
      } else {
        fs.writeFileSync(target, original);
      }
    }
    throw error;
  }
}

if (require.main === module) main();

module.exports = { assertCleanWorktree, nextVersion };
