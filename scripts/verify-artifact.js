#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createBuildEntries, createStoredZip, readBuildConfig } = require('../build');

const root = path.join(__dirname, '..');

function verifyArtifact(baseDir = root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(baseDir, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(baseDir, 'package-lock.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(baseDir, 'release-manifest.json'), 'utf8'));
  const versions = [manifest.version, pkg.version, lock.version, lock.packages?.['']?.version, release.version];
  if (new Set(versions).size !== 1) throw new Error(`Release versions are not aligned: ${versions.join(', ')}`);

  const artifact = fs.readFileSync(path.join(baseDir, release.artifact));
  const sha256 = crypto.createHash('sha256').update(artifact).digest('hex').toUpperCase();
  if (sha256 !== release.sha256) throw new Error(`Artifact checksum mismatch: expected ${release.sha256}, received ${sha256}`);
  // The release builder emits stored ZIPs. Match every packaged byte against
  // current production source/configuration, including the embedded manifest.
  if (path.resolve(baseDir) === path.resolve(root)) {
    const config = readBuildConfig();
    const expected = createStoredZip(createBuildEntries(config.production));
    if (!artifact.equals(expected)) throw new Error('Artifact does not match the current production source and configuration; rebuild it');
  }
  return { version: release.version, sha256 };
}

if (require.main === module) {
  const result = verifyArtifact();
  console.log(`Verified ${result.version} (${result.sha256})`);
}

module.exports = { verifyArtifact };
