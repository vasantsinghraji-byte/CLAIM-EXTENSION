'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function createSnapshot(root) {
  const git = (...args) => execFileSync('git', args, {
    cwd: root, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  const text = (...args) => git(...args).toString('utf8').trim();
  const output = 'artifacts/repository-snapshots';
  // Refuse to create recursive, accidentally stageable backups.
  git('check-ignore', '--quiet', '--no-index', '--', `${output}/probe`);
  const diffArgs = ['--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const patches = () => ({
    staged: git('diff', ...diffArgs, '--cached', 'HEAD', '--'),
    unstaged: git('diff', ...diffArgs, '--')
  });
  if (text('ls-files', '--unmerged')) throw new Error('Resolve merge conflicts before creating a recovery snapshot');
  const base = text('rev-parse', 'HEAD');
  const branch = text('branch', '--show-current');
  const before = patches();
  const untracked = () => git('ls-files', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean).sort();
  const files = untracked();
  const parent = path.join(root, output);
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  const manifest = { complete: false, createdAt: new Date().toISOString(), base, branch, untracked: [] };
  const saveManifest = () => fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  saveManifest();
  fs.writeFileSync(path.join(directory, 'staged.patch'), before.staged);
  fs.writeFileSync(path.join(directory, 'unstaged.patch'), before.unstaged);
  for (const file of files) {
    const source = path.join(root, file);
    const destination = path.join(directory, 'untracked', file);
    const stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new Error(`Snapshot requires a regular untracked file: ${file}`);
    const content = fs.readFileSync(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { mode: stat.mode });
    manifest.untracked.push({ path: file, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const after = patches();
  const stable = base === text('rev-parse', 'HEAD') && branch === text('branch', '--show-current') &&
    before.staged.equals(after.staged) && before.unstaged.equals(after.unstaged) &&
    JSON.stringify(files) === JSON.stringify(untracked()) && manifest.untracked.every((file) =>
      createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex') === file.sha256);
  if (!stable) throw new Error(`Work changed during the snapshot; retry. Incomplete backup: ${directory}`);
  manifest.complete = true;
  saveManifest();
  return directory;
}

if (require.main === module) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    console.log(`Recovery snapshot: ${createSnapshot(root)}`);
    console.log('Includes staged/unstaged binary patches and nonignored untracked files. See CONTRIBUTING.md for recovery.');
  } catch (error) {
    console.error(`repository-snapshot: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createSnapshot };
