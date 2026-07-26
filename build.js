#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');
const zipPath = path.join(rootDir, 'claim-autofill-extension.zip');
const files = [
  'manifest.json',
  'background.js',
  'auth-core.js',
  'audit-rules.js',
  'custom-rules.js',
  'audit-core.js',
  'claim-core.js',
  'review-core.js',
  'content.js',
  'floating-widget.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'options.html',
  'options.css',
  'options.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/claim-spark.png'
];
const developmentOrigins = new Set(['http://localhost/*', 'http://127.0.0.1/*']);
const developmentFunctionsOrigin = 'https://asia-south1-claimextension.cloudfunctions.net/*';
const productionFunctionsOrigin = 'https://asia-south1-claimextension-prod.cloudfunctions.net/*';
const developmentApiKey = 'AIzaSyD8pZzOBh22-a3dPCMzGThwbMpPKNUIGOs';
const productionApiKey = 'AIzaSyCuDItElzmNWGztOd0_MgjvvZQii74H1C8';

function createProductionManifest(sourceManifest) {
  const manifest = JSON.parse(JSON.stringify(sourceManifest));
  for (const script of manifest.content_scripts || []) {
    script.matches = (script.matches || []).filter(origin => !developmentOrigins.has(origin));
  }
  for (const resource of manifest.web_accessible_resources || []) {
    resource.matches = (resource.matches || []).filter(origin => !developmentOrigins.has(origin));
  }
  manifest.host_permissions = (manifest.host_permissions || []).filter(origin => !developmentOrigins.has(origin));
  manifest.host_permissions = manifest.host_permissions.filter(origin => origin !== developmentFunctionsOrigin);
  if (!manifest.host_permissions.includes(productionFunctionsOrigin)) {
    manifest.host_permissions.push(productionFunctionsOrigin);
  }
  assertProductionManifest(manifest);
  return manifest;
}

function createProductionBackground(source) {
  const output = source
    .replace(developmentApiKey, productionApiKey)
    .replace(
      'https://asia-south1-claimextension.cloudfunctions.net',
      'https://asia-south1-claimextension-prod.cloudfunctions.net'
    )
    .replace('Development project only; production has no counterpart yet.', 'Production project configuration.');
  if (output.includes(developmentApiKey) || output.includes('asia-south1-claimextension.cloudfunctions.net')) {
    throw new Error('Development Firebase configuration leaked into production background');
  }
  if (!output.includes(productionApiKey) || !output.includes('asia-south1-claimextension-prod.cloudfunctions.net')) {
    throw new Error('Production Firebase configuration is incomplete');
  }
  return output;
}

function assertProductionManifest(manifest) {
  const serialized = JSON.stringify(manifest);
  for (const origin of developmentOrigins) {
    if (serialized.includes(origin)) throw new Error(`Development origin leaked into production manifest: ${origin}`);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'));
    const checksum = crc32(entry.data);
    // Fixed DOS timestamp: 2020-01-01 00:00:00, making identical sources reproducible.
    const dosTime = 0;
    const dosDate = (40 << 9) | (1 << 5) | 1;
    const local = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(dosTime), uint16(dosDate),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length), uint16(name.length), uint16(0), name
    ]);
    localParts.push(local, entry.data);

    const central = Buffer.concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(dosTime), uint16(dosDate),
      uint32(checksum), uint32(entry.data.length), uint32(entry.data.length), uint16(name.length), uint16(0),
      uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), name
    ]);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0)
  ]);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createBuildEntries() {
  return [...files].sort().map(relativePath => {
    const source = path.join(rootDir, relativePath);
    let data;
    if (relativePath === 'manifest.json') {
      data = Buffer.from(`${JSON.stringify(createProductionManifest(JSON.parse(fs.readFileSync(source, 'utf8'))), null, 2)}\n`);
    } else if (relativePath === 'background.js') {
      data = Buffer.from(createProductionBackground(fs.readFileSync(source, 'utf8')));
    } else {
      data = fs.readFileSync(source);
    }
    return { name: relativePath, data };
  });
}

function main() {
  for (const relativePath of files) {
    if (!fs.existsSync(path.join(rootDir, relativePath))) {
      throw new Error(`Required extension file is missing: ${relativePath}`);
    }
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const entries = createBuildEntries();
  for (const entry of entries) {
    const destination = path.join(distDir, entry.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.data);
  }

  const zip = createStoredZip(entries);
  fs.writeFileSync(zipPath, zip);
  assertProductionManifest(JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8')));
  for (const origin of developmentOrigins) {
    if (zip.includes(Buffer.from(origin))) throw new Error(`Development origin leaked into production ZIP: ${origin}`);
  }
  console.log(`Built ${entries.length} files in ${distDir}`);
  console.log(`Created reproducible package ${zipPath}`);
}

if (require.main === module) main();

module.exports = { createProductionBackground, createProductionManifest, createBuildEntries, createStoredZip };
