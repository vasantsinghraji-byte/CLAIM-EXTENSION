#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');
const zipPath = path.join(rootDir, 'claim-autofill-extension.zip');
const files = [
  'manifest.json',
  'background.js',
  'audit-rules.js',
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

for (const relativePath of files) {
  if (!fs.existsSync(path.join(rootDir, relativePath))) {
    throw new Error(`Required extension file is missing: ${relativePath}`);
  }
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const entries = files.sort().map(relativePath => {
  const source = path.join(rootDir, relativePath);
  const destination = path.join(distDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return { name: relativePath, data: fs.readFileSync(source) };
});

fs.writeFileSync(zipPath, createStoredZip(entries));
console.log(`Built ${entries.length} files in ${distDir}`);
console.log(`Created reproducible package ${zipPath}`);
