#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function verifyArtifact() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
  const versions = [manifest.version, pkg.version, lock.version, lock.packages?.['']?.version, release.version];
  if (new Set(versions).size !== 1) throw new Error(`Release versions are not aligned: ${versions.join(', ')}`);

  const artifact = fs.readFileSync(path.join(root, release.artifact));
  const sha256 = crypto.createHash('sha256').update(artifact).digest('hex').toUpperCase();
  if (sha256 !== release.sha256) throw new Error(`Artifact checksum mismatch: expected ${release.sha256}, received ${sha256}`);
  return { version: release.version, sha256 };
}

if (require.main === module) {
  const result = verifyArtifact();
  console.log(`Verified ${result.version} (${result.sha256})`);
}

module.exports = { verifyArtifact };
