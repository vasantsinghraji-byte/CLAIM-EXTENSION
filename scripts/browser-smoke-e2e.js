#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

function findChrome() {
  const configured = process.env.CHROME_PATH;
  const candidates = [
    configured,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function inlineScript(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/<\/script/gi, '<\\/script');
}

function fixtureHtml() {
  return `<!doctype html>
<html><body>
  <label>Claim <input id="claim" value="1000"></label>
  <label>Approved <input id="approved" value="0"></label>
  <pre id="out">RUNNING</pre>
  <script>${inlineScript('claim-core.js')}</script>
  <script>${inlineScript('scripts/live-browser-smoke.js')}</script>
  <script>
    const claim = document.getElementById('claim');
    const approved = document.getElementById('approved');
    let before = null;
    const actions = {
      status: () => ({ enabled: true, hasUndo: before !== null }),
      preview: () => {
        const plan = ClaimAutoFillCore.planRowUpdate({
          claimValue: claim.value,
          approvedValue: approved.value,
          particularText: 'Investigation',
          remarksValue: ''
        });
        return {
          token: 'browser-preview',
          proposals: [{ key: 'browser-row', risk: 'low', proposedApproved: Number(plan.approvedValue) }]
        };
      },
      apply: async () => {
        before = approved.value;
        approved.value = String(ClaimAutoFillCore.planRowUpdate({
          claimValue: claim.value,
          approvedValue: approved.value,
          particularText: 'Investigation',
          remarksValue: ''
        }).approvedValue);
        return { blocked: false, count: 1 };
      },
      undo: () => {
        approved.value = before;
        before = null;
        return { count: 1 };
      }
    };
    runClaimExtensionLiveSmoke(actions, document).then(result => {
      const out = document.getElementById('out');
      out.dataset.passed = String(result.passed && result.appliedFields === 1 && approved.value === '0');
      out.textContent = JSON.stringify(result);
    }).catch(error => {
      const out = document.getElementById('out');
      out.dataset.passed = 'false';
      out.textContent = String(error && error.stack || error);
    });
  </script>
</body></html>`;
}

function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to run the browser smoke test.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-browser-smoke-'));
  try {
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, fixtureHtml());
    const result = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      `--user-data-dir=${path.join(temporary, 'profile')}`,
      '--dump-dom',
      pathToFileURL(fixture).href
    ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Browser exited ${result.status}: ${result.stderr}`);
    if (!/id="out" data-passed="true"/.test(result.stdout)) {
      throw new Error(`Browser smoke failed: ${result.stdout || result.stderr}`);
    }
    console.log('PASS: real-browser preview, async apply, and exact undo restoration.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { findChrome, fixtureHtml };
