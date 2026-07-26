'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer', shell: false });
if (result.status !== 0) throw new Error('Unable to list tracked files for secret scanning');

const googleApiKey = /AIza[0-9A-Za-z_-]{30,}/g;
const violations = [];
for (const file of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const matches = content.toString('utf8').match(googleApiKey) || [];
  if (matches.length) violations.push(`${file}: Google API key pattern`);
}

if (violations.length) {
  throw new Error(`Tracked credential material detected:\n${violations.join('\n')}`);
}
console.log('No Google API key patterns found in tracked files');
