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

function investigationFixtureHtml() {
  const dependencies = ['audit-rules.js', 'custom-rules.js', 'processing-rules.js', 'audit-core.js', 'claim-core.js', 'review-core.js'];
  return `<!doctype html><html><body>
    <input id="transid" value="SYNTHETIC-TEST">
    <table id="processSheetTable"><tr><th>Particular</th><th>Package Code(Package Name)</th><th>Rate</th><th>Unit/Hours/Days</th><th>Claim Amount(Rs.)</th><th>Approved Amount(Rs.)</th><th>Deductions</th><th>Remarks</th><th hidden></th></tr>
      <tr><td hidden>1</td><td id="packageName_0">Investigation</td><td id="packageCode_0">INV-TEST</td><td id="packageRate_0">100</td><td id="packageDays_0">4</td><td id="packageAmount_0">400</td><td><input id="packageFinalAmount_0" name="packageFinalAmounts" type="number" value="400"></td><td>0</td><td><textarea id="packageremarks_0">Existing remark</textarea></td><td hidden>1</td></tr>
    </table><pre id="out">RUNNING</pre>
    <script>
      window.recoveryAllowed = true;
      const chrome = window.chrome = {
        storage: { sync: { get() {} }, local: { get(keys, callback) { callback({}); } }, onChanged: { addListener() {} } },
        runtime: {
          getManifest: () => ({ version: '1.12.0' }),
          onMessage: { addListener() {} }, onConnect: { addListener() {} },
          sendMessage(request, callback) {
            if (request.action === 'ensureRuleOverridesMigration') return;
            if (request.action === 'authRefreshLicence') return callback({ success: true,
              licenceState: { status: 'active', previewAllowed: true, applyAllowed: true } });
            if (request.action === 'refreshProcessingRules') return callback(window.ruleRefreshEnabled
              ? { success: true, ruleSet: window.centralRuleSet || processingRuleSet }
              : { success: false, error: 'NETWORK_ERROR' });
            callback?.({ success: window.recoveryAllowed });
          }
        }
      };
    </script>
    ${dependencies.map(file => `<script>${inlineScript(file)}</script>`).join('')}
    <script>${inlineScript('content.js')}</script>
    <script>
      (async () => {
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const approved = document.getElementById('packageFinalAmount_0');
        const remarks = document.getElementById('packageremarks_0');
        const actions = ClaimAutoFillActions;
        licenceState = { status: 'active', previewAllowed: true, applyAllowed: true };
        const counts = [{ index: 0, found: '3' }];
        let preview = actions.previewInvestigationVerification(counts);
        assert(preview.proposals.length === 1, 'Actual DOM did not map the investigation');
        assert((await actions.applyInvestigationVerification(preview.token)).blockReason === 'high-risk-unacknowledged', 'Missing acknowledgement was accepted');
        approved.value = '350';
        assert((await actions.applyInvestigationVerification(preview.token, { acknowledgedHighRisk: true })).blocked, 'Changed approval was accepted');
        approved.value = '400';
        preview = actions.previewInvestigationVerification(counts);
        const applied = await actions.applyInvestigationVerification(preview.token, { acknowledgedHighRisk: true });
        assert(!applied.blocked && applied.recoverySaved && approved.value === '300', 'Investigation Apply failed');
        assert(remarks.value.includes('3 of 4'), 'Verification remark was not applied');
        assert(actions.undo().count === 2 && approved.value === '400' && remarks.value === 'Existing remark', 'Undo did not restore both real controls');
        assert(!approved.dataset.claimExtensionInvestigationVerified, 'Undo left the verified marker');
        window.recoveryAllowed = false;
        preview = actions.previewInvestigationVerification(counts);
        const failed = await actions.applyInvestigationVerification(preview.token, { acknowledgedHighRisk: true });
        assert(failed.blockReason === 'recovery-save-failed' && approved.value === '400' && remarks.value === 'Existing remark', 'Storage failure did not roll back real controls');
        window.recoveryAllowed = true;
        document.getElementById('packageName_0').textContent = 'Surgical procedure';
        document.getElementById('packageCode_0').textContent = 'SURG-TEST';
        approved.value = '0';
        ipdClaimDetailContext = { tid: 'SYNTHETIC-TEST', dischargeStatus: 'LAMA', finalPackageCodes: [] };
        processingRuleSet = { mode: 'remote-required', versionId: 'synthetic-policy', rules: [], bundledFallbackEnabled: false };
        const governed = actions.preview();
        assert(!governed.blocked && governed.proposals.some(item => item.proposedApproved === 400), 'Central fallback disable was not respected');
        assert(!governed.proposals.some(item => item.ruleIds?.includes('RGHS-IPD-LAMA-DAMA-75')), 'Bundled LAMA adjustment bypassed central policy');
        processingRuleSet = { mode: 'bundled', rules: [] };
        const reviewed = actions.preview();
        const surgical = reviewed.proposals.find(item => item.ruleIds?.includes('RGHS-IPD-LAMA-DAMA-75'));
        assert(surgical && surgical.proposedApproved === 300, 'Surgical review proposal is unavailable');
        const override = await actions.apply({
          token: reviewed.token, selectedRowKeys: [surgical.key], acknowledgedHighRisk: true,
          approvedOverrides: { [surgical.key]: 400 },
          remarkOverrides: { [surgical.key]: 'Processor approved full amount after review.' }
        });
        assert(!override.blocked && approved.value === '400' && remarks.value === 'Processor approved full amount after review.', 'Reviewed amount/remark overrides were ignored');
        actions.undo();
        assert(approved.value === '0' && remarks.value === 'Existing remark', 'Surgical override Undo was incomplete');
        const secondRow = document.getElementById('packageName_0').closest('tr').cloneNode(true);
        for (const element of secondRow.querySelectorAll('[id]')) element.id = element.id.replace(/_0$/, '_1');
        secondRow.querySelector('#packageCode_1').textContent = 'SURG-SECOND';
        secondRow.querySelector('#packageAmount_1').textContent = '200';
        document.getElementById('processSheetTable').appendChild(secondRow);
        processingRuleSet = { mode: 'bundled', rules: [] };
        ipdClaimDetailContext.finalPackageCodes = ['SURG-TEST', 'SURG-SECOND'];
        const conflicting = actions.preview();
        assert(conflicting.blockReason === 'overlapping-ipd-rules', 'Conflicting IPD adjustments: ' + JSON.stringify({ blocked: conflicting.blockReason, rules: conflicting.proposals.map(item => item.ruleIds), values: conflicting.proposals.map(item => item.proposedApproved) }));
        assert(approved.value === '0', 'Conflicting IPD preview changed a control');

        // Exercise central calculation and the real Preview/Apply writer, then
        // verify claim switches and replaced controls without mocking the DOM.
        secondRow.remove();
        ipdClaimDetailContext = {};
        window.ruleRefreshEnabled = true;
        document.getElementById('packageName_0').textContent = 'Synthetic procedure';
        document.getElementById('packageCode_0').textContent = 'PKG-X';
        const claim = document.getElementById('packageAmount_0');
        claim.textContent = '1,000.00';
        approved.value = '';
        const centralRule = {
          ruleId: 'SYN-10', name: 'Synthetic central check', processingArea: 'IPD', priority: 100,
          enabled: true, enforcement: 'mandatory', conditions: { operator: 'packagePresent', packageCodes: ['PKG-X'] },
          actions: [{ type: 'applyDeduction', targetPackageCodes: ['PKG-X'],
            calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 } }]
        };
        window.centralRuleSet = { schemaVersion: 2, mode: 'remote-required', versionId: 'synthetic-central-v1',
          bundledFallbackEnabled: false, rules: [centralRule] };
        processingRuleSet = window.centralRuleSet;
        const applyPrepared = (prepared, extra = {}) => actions.applyFresh({ token: prepared.token,
          selectedRowKeys: prepared.proposals.map(item => item.key), acknowledgedHighRisk: true, ...extra });
        let prepared = await actions.previewFresh();
        let committed = await applyPrepared(prepared);
        assert(!committed.blocked && approved.value === '900' && committed.reconciliation.proposedApprovedTotal === 900,
          'Formatted claim failed central calculation or Apply');
        assert(actions.undo().count === 1 && approved.value === '', 'Central amount Undo failed');
        claim.textContent = '1000oops';
        prepared = await actions.previewFresh();
        assert(prepared.blocked && (await applyPrepared(prepared)).blocked && approved.value === '',
          'Malformed central money was accepted');
        claim.textContent = '1000';
        approved.value = '600';
        centralRule.actions[0].calculation.value = 80;
        prepared = await actions.previewFresh();
        committed = await applyPrepared(prepared);
        assert(!committed.blocked && approved.value === '200', 'Partial approval deduction was capped incorrectly');
        actions.undo();
        approved.value = '400';
        centralRule.actions[0].calculation = { method: 'fullAmount', basis: 'claimedAmount', value: 100 };
        committed = await applyPrepared(await actions.previewFresh());
        assert(!committed.blocked && approved.value === '0', 'Full central deduction did not clear partial approval');
        actions.undo();
        const remarkAction = { type: 'writeRemark', targetPackageCodes: ['PKG-X'],
          target: { sheet: 'IPD', columnKey: 'remarks' }, writeMode: 'append', template: 'Synthetic central remark.' };
        centralRule.actions = [remarkAction];
        approved.value = '0';
        prepared = await actions.previewFresh();
        assert(prepared.proposals[0].proposedApproved === null, 'Remark-only rule proposed an amount write');
        committed = await applyPrepared(prepared);
        assert(!committed.blocked && approved.value === '0' && remarks.value.includes('Synthetic central remark.'),
          'Remark-only Apply changed an explicit zero approval');
        assert(actions.undo().count === 1 && remarks.value === 'Existing remark', 'Remark-only Undo failed');
        approved.value = '';
        centralRule.enforcement = 'advisory';
        centralRule.actions = [{ type: 'applyDeduction', targetPackageCodes: ['PKG-X'],
          calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 } }, remarkAction];
        prepared = await actions.previewFresh();
        const key = prepared.proposals[0].key;
        committed = await applyPrepared(prepared, { approvedOverrides: { [key]: 1000 },
          remarkOverrides: { [key]: 'Processor approved after review.' } });
        assert(!committed.blocked && approved.value === '1000' && committed.reconciliation.proposedApprovedTotal === 1000
          && remarks.value === 'Existing remark; Processor approved after review.', 'Central reviewed overrides were ignored');
        window.structuredClone(committed);
        assert(actions.undo().count === 2 && approved.value === '' && remarks.value === 'Existing remark',
          'Central override Undo did not exactly restore controls');
        prepared = await actions.previewFresh();
        document.getElementById('transid').value = 'SYNTHETIC-OTHER';
        assert((await applyPrepared(prepared)).blockReason === 'stale' && approved.value === '',
          'Old preview was accepted after a claim switch');
        document.getElementById('transid').value = 'SYNTHETIC-TEST';
        prepared = await actions.previewFresh();
        const replacement = approved.cloneNode(true);
        approved.replaceWith(replacement);
        assert((await applyPrepared(prepared)).blockReason === 'stale' && replacement.value === '',
          'Old preview was accepted for a replacement approved control');
        const out = document.getElementById('out');
        out.dataset.passed = 'true';
        out.textContent = 'PASS: actual content-script investigation and central Apply, money validation, partial/full deductions, zero preservation, reviewed overrides, exact Undo, claim/control binding and IPD conflict blocking';
      })().catch(error => {
        const out = document.getElementById('out');
        out.dataset.passed = 'false';
        out.textContent = String(error.stack || error);
      });
    </script></body></html>`;
}

function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to run the browser smoke test.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-browser-smoke-'));
  try {
    for (const [name, html] of [['standard', fixtureHtml()], ['investigation', investigationFixtureHtml()]]) {
      const fixture = path.join(temporary, `${name}.html`);
      fs.writeFileSync(fixture, html);
      const result = spawnSync(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--virtual-time-budget=10000',
        `--user-data-dir=${path.join(temporary, 'profile')}`,
        '--dump-dom',
        pathToFileURL(fixture).href
      ], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Browser exited ${result.status}: ${result.stderr}`);
      if (!/id="out" data-passed="true"/.test(result.stdout)) {
        const diagnostic = result.stdout.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/)?.[1] || result.stderr || 'Missing browser result';
        throw new Error(`${name} browser smoke failed: ${diagnostic.slice(0, 2000)}`);
      }
      console.log(`PASS: ${name} real-browser content and exact undo/recovery restoration.`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = { findChrome, fixtureHtml, investigationFixtureHtml };
