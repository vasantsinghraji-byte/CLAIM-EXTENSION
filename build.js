#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');
const hostingSourceDir = path.join(rootDir, 'hosting');
const hostingBuildDir = path.join(rootDir, 'hosting-build');
const zipPath = path.join(rootDir, 'claim-autofill-extension.zip');
const localConfigPath = path.join(rootDir, '.firebase-build-config.json');
const files = [
  'manifest.json',
  'background.js',
  'runtime-config.js',
  'auth-core.js',
  'audit-rules.js',
  'custom-rules.js',
  'processing-rules.js',
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
const emulatorConfig = Object.freeze({
  apiKey: 'claimextension-emulator-key',
  authBaseUrl: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1',
  tokenBaseUrl: 'http://127.0.0.1:9099/securetoken.googleapis.com/v1',
  functionsBaseUrl: 'http://127.0.0.1:5001/demo-claimextension/asia-south1'
});

function validateEnvironmentConfig(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`${name} Firebase configuration is missing`);
  const apiKey = String(value.apiKey || '').trim();
  const functionsBaseUrl = String(value.functionsBaseUrl || '').trim().replace(/\/+$/, '');
  if (apiKey.length < 20 || /obtain-from|placeholder/i.test(apiKey)) {
    throw new Error(`${name} Firebase API key is invalid`);
  }
  if (!/^https:\/\/[a-z0-9-]+\.cloudfunctions\.net$/i.test(functionsBaseUrl)) {
    throw new Error(`${name} Functions URL is invalid`);
  }
  return { apiKey, functionsBaseUrl };
}

function readBuildConfig(configPath = localConfigPath) {
  if (!fs.existsSync(configPath)) {
    if (process.env.CI === 'true') {
      console.warn('CI validation build: using non-deployable placeholder Firebase configuration');
      return {
        development: validateEnvironmentConfig({
          apiKey: 'ci-development-key-not-a-real-credential',
          functionsBaseUrl: 'https://asia-south1-ci-development.cloudfunctions.net'
        }, 'CI development'),
        production: validateEnvironmentConfig({
          apiKey: 'ci-production-key-not-a-real-credential',
          functionsBaseUrl: 'https://asia-south1-ci-production.cloudfunctions.net'
        }, 'CI production')
      };
    }
    throw new Error('Missing .firebase-build-config.json. Copy firebase-build-config.example.json and add rotated keys locally.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    development: validateEnvironmentConfig(config.development, 'Development'),
    production: validateEnvironmentConfig(config.production, 'Production')
  };
}

function runtimeConfigSource(config) {
  return [
    '(function (root) {',
    "  'use strict';",
    `  root.ClaimSparkRuntimeConfig = Object.freeze(${JSON.stringify({
      firebaseApiKey: config.apiKey,
      ...(config.authBaseUrl ? { authBaseUrl: config.authBaseUrl } : {}),
      ...(config.tokenBaseUrl ? { tokenBaseUrl: config.tokenBaseUrl } : {}),
      functionsBaseUrl: config.functionsBaseUrl
    })});`,
    '})(globalThis);',
    ''
  ].join('\n');
}

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

function createStagingManifest(sourceManifest, stagingConfig) {
  const manifest = JSON.parse(JSON.stringify(sourceManifest));
  const stagingUrl = new URL(stagingConfig.functionsBaseUrl);
  if (stagingUrl.hostname.includes('claimextension-prod')) {
    throw new Error('Staging build cannot target the production Functions project');
  }
  for (const script of manifest.content_scripts || []) {
    script.matches = (script.matches || []).filter(origin => !developmentOrigins.has(origin));
  }
  for (const resource of manifest.web_accessible_resources || []) {
    resource.matches = (resource.matches || []).filter(origin => !developmentOrigins.has(origin));
  }
  manifest.host_permissions = (manifest.host_permissions || [])
    .filter(origin => !developmentOrigins.has(origin))
    .filter(origin => origin !== developmentFunctionsOrigin && origin !== productionFunctionsOrigin);
  manifest.host_permissions.push(`${stagingConfig.functionsBaseUrl}/*`);
  assertProductionManifest(manifest);
  if (JSON.stringify(manifest).includes('claimextension-prod')) {
    throw new Error('Production Functions origin leaked into staging manifest');
  }
  return manifest;
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

function createRemoteBuildEntries(config, manifestFactory) {
  return [...files].sort().map(relativePath => {
    const source = path.join(rootDir, relativePath);
    let data;
    if (relativePath === 'manifest.json') {
      data = Buffer.from(`${JSON.stringify(manifestFactory(JSON.parse(fs.readFileSync(source, 'utf8'))), null, 2)}\n`);
    } else if (relativePath === 'runtime-config.js') {
      data = Buffer.from(runtimeConfigSource(config));
    } else {
      data = fs.readFileSync(source);
    }
    return { name: relativePath, data };
  });
}

function createBuildEntries(productionConfig = readBuildConfig().production) {
  return createRemoteBuildEntries(productionConfig, createProductionManifest);
}

function createStagingBuildEntries(stagingConfig = readBuildConfig().development) {
  return createRemoteBuildEntries(stagingConfig, manifest => createStagingManifest(manifest, stagingConfig))
    .map(entry => entry.name === 'popup.js'
      ? {
          ...entry,
          data: Buffer.from(entry.data.toString('utf8').replace(
            'https://claimextension-prod.web.app/admin',
            'https://claimextension.web.app/admin'
          ))
        }
      : entry);
}

function createHostingBuild(config) {
  fs.rmSync(hostingBuildDir, { recursive: true, force: true });
  fs.mkdirSync(hostingBuildDir, { recursive: true });
  for (const name of fs.readdirSync(hostingSourceDir)) {
    const source = path.join(hostingSourceDir, name);
    if (!fs.statSync(source).isFile()) continue;
    let content = fs.readFileSync(source);
    if (name === 'firebase-client.js') {
      content = Buffer.from(content.toString('utf8')
        .replace('__FIREBASE_API_KEY__', config.apiKey)
        .replace('__AUTH_BASE_URL__', config.authBaseUrl || 'https://identitytoolkit.googleapis.com/v1')
        .replace('__TOKEN_BASE_URL__', config.tokenBaseUrl || 'https://securetoken.googleapis.com/v1')
        .replace('__FUNCTIONS_BASE_URL__', config.functionsBaseUrl));
    }
    fs.writeFileSync(path.join(hostingBuildDir, name), content);
  }
}

function main() {
  const emulatorMode = process.argv.includes('--emulator');
  const stagingMode = process.argv.includes('--staging');
  if (emulatorMode && stagingMode) throw new Error('Choose either --emulator or --staging');
  const config = emulatorMode ? null : readBuildConfig();
  for (const relativePath of files.filter(file => file !== 'runtime-config.js')) {
    if (!fs.existsSync(path.join(rootDir, relativePath))) {
      throw new Error(`Required extension file is missing: ${relativePath}`);
    }
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (emulatorMode) {
    fs.writeFileSync(path.join(rootDir, 'runtime-config.js'), runtimeConfigSource(emulatorConfig));
    createHostingBuild(emulatorConfig);
    for (const relativePath of files) {
      const destination = path.join(distDir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, relativePath === 'runtime-config.js'
        ? runtimeConfigSource(emulatorConfig)
        : fs.readFileSync(path.join(rootDir, relativePath)));
    }
    console.log(`Built emulator extension in ${distDir}`);
    console.log(`Built emulator hosting in ${hostingBuildDir}`);
    return;
  }

  if (stagingMode) {
    fs.writeFileSync(path.join(rootDir, 'runtime-config.js'), runtimeConfigSource(config.development));
    createHostingBuild(config.development);
    const stagingEntries = createStagingBuildEntries(config.development);
    for (const entry of stagingEntries) {
      const destination = path.join(distDir, entry.name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.data);
    }
    console.log(`Built staging extension in ${distDir}`);
    console.log(`Built staging hosting in ${hostingBuildDir}`);
    return;
  }

  fs.writeFileSync(path.join(rootDir, 'runtime-config.js'), runtimeConfigSource(config.development));
  createHostingBuild(config.production);
  const entries = createBuildEntries(config.production);
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

module.exports = {
  createBuildEntries,
  createStagingBuildEntries,
  createStagingManifest,
  createHostingBuild,
  createProductionManifest,
  createStoredZip,
  emulatorConfig,
  readBuildConfig,
  runtimeConfigSource,
  validateEnvironmentConfig
};
