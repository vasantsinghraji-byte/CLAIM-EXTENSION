#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function nodeMajor(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  const match = String(result.stdout || '').match(/^v(\d+)/);
  return match ? Number(match[1]) : 0;
}

function node22Candidates() {
  const candidates = [process.env.CLAIM_SPARK_NODE22];
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  if (process.platform === 'win32') {
    const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(winget)) {
      for (const packageName of fs.readdirSync(winget)) {
        if (!packageName.startsWith('OpenJS.NodeJS.22_')) continue;
        const packageRoot = path.join(winget, packageName);
        for (const versionDirectory of fs.readdirSync(packageRoot)) {
          candidates.push(path.join(packageRoot, versionDirectory, 'node.exe'));
        }
      }
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function resolveNode22() {
  for (const candidate of node22Candidates()) {
    try {
      if (fs.existsSync(candidate) && nodeMajor(candidate) === 22) return candidate;
    } catch {
      // Continue through inaccessible or invalid PATH entries.
    }
  }
  throw new Error('Node.js 22 is required for the Functions lifecycle test. Set CLAIM_SPARK_NODE22 to its executable.');
}

function main() {
  const root = path.join(__dirname, '..');
  const node22 = resolveNode22();
  const env = {
    ...process.env,
    PATH: `${path.dirname(node22)}${path.delimiter}${process.env.PATH || ''}`,
    FUNCTIONS_DISCOVERY_TIMEOUT: '60000'
  };
  const firebaseCli = path.join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  const result = spawnSync(node22, [
    firebaseCli, 'emulators:exec', '--only', 'auth,functions,firestore',
    'node scripts/license-lifecycle-acceptance.js',
    '--project', 'demo-claimextension', '--config', 'firebase.emulator.json'
  ], { cwd: root, env, stdio: 'inherit' });
  process.exitCode = result.status === null ? 1 : result.status;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
