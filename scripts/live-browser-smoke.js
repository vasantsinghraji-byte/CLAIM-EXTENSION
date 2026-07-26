(function (root, factory) {
  const runner = factory();
  if (typeof module === 'object' && module.exports) module.exports = runner;
  else root.runClaimExtensionLiveSmoke = runner;
})(globalThis, function () {
  'use strict';

  function controls(document) {
    return [...document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
    )];
  }

  function snapshot(document) {
    return controls(document).map((element, index) => ({
      index,
      id: element.id || '',
      name: element.name || '',
      value: 'value' in element ? element.value : element.textContent,
      checked: 'checked' in element ? element.checked : undefined
    }));
  }

  return async function runClaimExtensionLiveSmoke(
    actions = globalThis.ClaimAutoFillActions,
    document = globalThis.document
  ) {
    if (!actions || !document) throw new Error('Run this in the Claim Auto-Fill content-script context on an open process sheet.');
    if (actions.status().enabled !== true) throw new Error('Claim Extension is OFF. Enable it before running the smoke test.');

    const before = snapshot(document);
    if (!before.length) throw new Error('Smoke test found no portal controls to protect. Do not run Apply.');
    const preview = actions.preview();
    const selectedRowKeys = preview.proposals
      .filter(proposal => proposal.risk !== 'high')
      .map(proposal => proposal.key);
    if (!selectedRowKeys.length) throw new Error('Smoke test found no eligible non-high-risk rows.');

    let applyResult;
    try {
      applyResult = actions.apply({ token: preview.token, selectedRowKeys, acknowledgedHighRisk: false });
      if (applyResult.blocked) throw new Error(`Apply was blocked: ${applyResult.blockReason}`);
      if (!applyResult.count) throw new Error('Apply changed no fields.');
    } finally {
      if (actions.status().hasUndo) actions.undo();
    }

    const afterUndo = snapshot(document);
    if (JSON.stringify(afterUndo) !== JSON.stringify(before)) {
      throw new Error('FAILED: Undo did not restore the process sheet exactly. Do not submit this claim.');
    }

    return {
      passed: true,
      previewedRows: preview.proposals.length,
      selectedRows: selectedRowKeys.length,
      appliedFields: applyResult.count,
      restoredControls: afterUndo.length,
      submitted: false
    };
  };
});
