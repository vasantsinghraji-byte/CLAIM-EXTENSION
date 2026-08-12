#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function javaMajor(javaExecutable) {
  const result = spawnSync(javaExecutable, ['-version'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/version "(\d+)/);
  return match ? Number(match[1]) : 0;
}

function windowsJdkCandidates() {
  const roots = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Java'
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (/jdk-?(2[1-9]|[3-9]\d)/i.test(name)) candidates.push(path.join(root, name));
    }
  }
  return candidates.sort().reverse();
}

function resolveJdk() {
  const candidates = [process.env.JAVA_HOME, ...(process.platform === 'win32' ? windowsJdkCandidates() : [])]
    .filter(Boolean);
  for (const candidate of candidates) {
    const executable = path.join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(executable) && javaMajor(executable) >= 21) return candidate;
  }
  if (javaMajor(process.platform === 'win32' ? 'java.exe' : 'java') >= 21) return null;
  throw new Error('Firebase emulators require Java 21 or newer. Install JDK 21+ or set JAVA_HOME to it.');
}

function main() {
  const root = path.join(__dirname, '..');
  const jdk = resolveJdk();
  const env = { ...process.env };
  if (jdk) {
    env.JAVA_HOME = jdk;
    env.PATH = `${path.join(jdk, 'bin')}${path.delimiter}${env.PATH || ''}`;
  }
  const firebaseCli = path.join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  const result = spawnSync(process.execPath, [
    firebaseCli, 'emulators:start', '--only', 'auth,functions,firestore,hosting',
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
