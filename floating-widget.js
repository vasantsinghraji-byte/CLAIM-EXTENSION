(function () {
  'use strict';

  if (!window.location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  if (document.getElementById('claim-spark-widget-host')) return;

  const actions = globalThis.ClaimAutoFillActions;
  const Review = globalThis.ClaimReviewCore;
  if (!actions || !Review) return;

  let extensionVersion;
  let mascotIconUrl;
  try {
    if (!chrome?.runtime?.id) return;
    extensionVersion = chrome.runtime.getManifest().version;
    mascotIconUrl = chrome.runtime.getURL('icons/claim-spark.png');
  } catch (_) {
    return;
  }
  const statusHost = document.createElement('div');
  statusHost.id = 'claim-extension-status-host';
  statusHost.style.cssText = 'all:initial;display:none;position:fixed;right:18px;top:68px;z-index:2147483647;';
  const statusShadow = statusHost.attachShadow({ mode: 'closed' });
  statusShadow.innerHTML = `
    <style>
      .off { padding:7px 11px;border:1px solid #ef4444;border-radius:999px;background:#fff1f2;color:#991b1b;box-shadow:0 4px 14px rgba(15,23,42,.2);font:700 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em; }
    </style>
    <div class="off" role="status" aria-live="polite">Claim Extension OFF</div>`;

  const host = document.createElement('div');
  host.id = 'claim-spark-widget-host';
  host.style.cssText = 'all:initial;display:none;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .wrap { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172554; }
      .mascot { width:76px;height:76px;padding:0;border:0;border-radius:50%;cursor:pointer;background:linear-gradient(145deg,#fff7b2,#fbbf24);box-shadow:0 8px 24px rgba(15,23,42,.28);display:grid;place-items:center;touch-action:none;user-select:none;transition:transform .18s ease,box-shadow .18s ease; }
      .mascot.dragging { cursor:grabbing;transform:scale(1.04); }
      .mascot:hover { transform:translateY(-3px) scale(1.04);box-shadow:0 12px 28px rgba(15,23,42,.32); }
      .mascot:focus-visible,.btn:focus-visible,.close:focus-visible,.jump:focus-visible,input:focus-visible { outline:3px solid #2563eb;outline-offset:2px; }
      .mascot img { width:70px;height:70px;object-fit:contain;pointer-events:none; }
      .panel { position:absolute;right:0;bottom:88px;width:min(430px,calc(100vw - 24px));max-height:min(720px,calc(100vh - 100px));padding:14px;border:1px solid #bfdbfe;border-radius:16px;background:rgba(255,255,255,.99);box-shadow:0 16px 42px rgba(15,23,42,.25);transform-origin:bottom right;animation:pop .16s ease-out;display:flex;flex-direction:column;gap:10px; }
      .panel[hidden] { display:none; }
      .panel.open-below { bottom:auto;top:88px; }
      .panel.open-right { right:auto;left:0; }
      @keyframes pop { from { opacity:0;transform:scale(.92); } to { opacity:1;transform:scale(1); } }
      .title { display:flex;align-items:center;justify-content:space-between;font-weight:750;font-size:15px; }
      .version { margin-left:6px;color:#64748b;font-size:10px;font-weight:650; }
      .close { border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer;line-height:1; }
      .summary { display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:9px;border-radius:10px;background:#eff6ff;font-size:12px; }
      .summary[hidden],.ack[hidden],.review-list[hidden] { display:none; }
      .metric strong { display:block;color:#1e3a8a;font-size:13px; }
      .review-list { overflow:auto;display:grid;gap:7px;padding-right:3px; }
      .review-row { display:grid;grid-template-columns:24px 1fr auto;gap:7px;align-items:start;padding:9px;border:1px solid #e2e8f0;border-left:5px solid #22c55e;border-radius:10px;background:#fff; }
      .review-row.medium { border-left-color:#f59e0b;background:#fffbeb; }
      .review-row.high { border-left-color:#dc2626;background:#fef2f2; }
      .decision-card { padding:10px;border:1px solid #fecaca;border-left:5px solid #dc2626;border-radius:10px;background:#fef2f2; }
      .decision-title { font-size:12px;font-weight:800;color:#7f1d1d; }
      .decision-lines { margin:5px 0;font-size:11px;line-height:1.4;color:#475569; }
      .decision-buttons { display:flex;flex-wrap:wrap;gap:5px; }
      .decision-buttons button { border:1px solid #cbd5e1;border-radius:7px;padding:5px 7px;background:white;color:#334155;cursor:pointer;font-size:10px;font-weight:700; }
      .decision-buttons button.selected { border-color:#16a34a;background:#dcfce7;color:#166534; }
      .review-row input { width:17px;height:17px;margin-top:2px; }
      .row-title { font-size:12px;font-weight:750;color:#0f172a; }
      .row-values { margin-top:3px;font-size:11px;color:#475569;line-height:1.35; }
      .reason { margin-top:4px;font-size:11px;color:#334155; }
      .badge { display:inline-block;margin-left:5px;padding:2px 5px;border-radius:999px;background:#dcfce7;color:#166534;font-size:9px;text-transform:uppercase; }
      .medium .badge { background:#fef3c7;color:#92400e; }
      .high .badge { background:#fee2e2;color:#991b1b; }
      .jump { border:0;border-radius:7px;padding:5px 7px;background:#e0e7ff;color:#3730a3;cursor:pointer;font-size:11px;font-weight:700; }
      .ack { padding:8px;border:1px solid #fecaca;border-radius:9px;background:#fef2f2;color:#991b1b;font-size:11px;font-weight:650; }
      .ack label { display:flex;gap:7px;align-items:flex-start; }
      .actions { display:grid;grid-template-columns:1fr 1fr;gap:7px; }
      .btn { border:0;border-radius:10px;padding:10px 8px;cursor:pointer;font-weight:700;font-size:12px; }
      .preview { background:#dbeafe;color:#1d4ed8; }
      .safe { grid-column:1/-1;background:#dcfce7;color:#166534; }
      .apply { background:#16a34a;color:white; }
      .undo { background:#fef3c7;color:#92400e; }
      .recover { background:#ede9fe;color:#6d28d9; }
      .btn:disabled { cursor:not-allowed;opacity:.45; }
      .status { min-height:32px;padding:8px 9px;border-radius:9px;background:#f8fafc;color:#475569;font-size:12px;line-height:1.35; }
      .status.success { background:#dcfce7;color:#166534; }
      .status.warning { background:#fef3c7;color:#92400e; }
      .status.error { background:#fee2e2;color:#991b1b; }
    </style>
    <div class="wrap">
      <section class="panel" hidden aria-label="Claim Spark review controls">
        <div class="title"><span>&#9889; Claim Spark Review <span class="version">v${extensionVersion}</span></span><button class="close" type="button" aria-label="Close">&times;</button></div>
        <div class="summary" hidden></div>
        <div class="review-list" hidden aria-label="Proposed row changes"></div>
        <div class="ack" hidden><label><input type="checkbox" class="ack-check" />I reviewed the selected high-risk audit findings and accept applying them.</label></div>
        <div class="actions">
          <button class="btn safe" type="button" disabled>Apply Safe Rows Now</button>
          <button class="btn preview" type="button">Preview Current Sheet</button>
          <button class="btn apply" type="button" disabled>Apply Selected</button>
          <button class="btn undo" type="button" disabled>Undo Last Fill</button>
          <button class="btn recover" type="button" disabled>Restore Saved Snapshot</button>
        </div>
        <div class="status" role="status" aria-live="polite">Preview is read-only. Nothing changes until Apply Selected.</div>
      </section>
      <button class="mascot" type="button" aria-label="Open Claim Spark review" aria-expanded="false"><img src="${mascotIconUrl}" alt="" /></button>
    </div>`;

  const panel = shadow.querySelector('.panel');
  const mascot = shadow.querySelector('.mascot');
  const close = shadow.querySelector('.close');
  const previewButton = shadow.querySelector('.preview');
  const safeButton = shadow.querySelector('.safe');
  const applyButton = shadow.querySelector('.apply');
  const undoButton = shadow.querySelector('.undo');
  const recoverButton = shadow.querySelector('.recover');
  const status = shadow.querySelector('.status');
  const summary = shadow.querySelector('.summary');
  const reviewList = shadow.querySelector('.review-list');
  const ack = shadow.querySelector('.ack');
  const ackCheck = shadow.querySelector('.ack-check');
  let currentPreview = null;
  let selectedKeys = new Set();
  let approvedOverrides = {};
  let exceptionalGroups = new Set();
  let recoveryArmed = false;
  let dragState = null;
  let suppressClick = false;
  const EDGE_GAP = 8;
  const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

  function hasValidExtensionContext() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function invalidateStaleWidget() {
    panel.hidden = false;
    previewButton.disabled = true;
    safeButton.disabled = true;
    applyButton.disabled = true;
    undoButton.disabled = true;
    recoverButton.disabled = true;
    showStatus('The extension was reloaded. Refresh this process-sheet page to reconnect Claim Spark Review.', 'error');
  }

  function withValidExtensionContext(operation) {
    if (!hasValidExtensionContext()) {
      invalidateStaleWidget();
      return false;
    }
    try {
      operation();
      return true;
    } catch (error) {
      if (!hasValidExtensionContext() || /Extension context invalidated/i.test(String(error?.message || error))) {
        invalidateStaleWidget();
        return false;
      }
      throw error;
    }
  }

  function showStatus(message, type = '') {
    status.textContent = message;
    status.className = `status ${type}`.trim();
  }

  function setOpen(open) {
    if (open) {
      const rect = host.getBoundingClientRect();
      panel.classList.toggle('open-below', rect.top < Math.min(730, window.innerHeight - 100));
      panel.classList.toggle('open-right', rect.left < 430);
    }
    panel.hidden = !open;
    mascot.setAttribute('aria-expanded', String(open));
    if (open) previewButton.focus();
  }

  function setEnabled(enabled) {
    host.style.display = enabled ? 'block' : 'none';
    statusHost.style.display = enabled ? 'none' : 'block';
    if (!enabled) setOpen(false);
  }

  function clampPosition(x, y) {
    return {
      x: Math.min(Math.max(EDGE_GAP, x), Math.max(EDGE_GAP, window.innerWidth - 76 - EDGE_GAP)),
      y: Math.min(Math.max(EDGE_GAP, y), Math.max(EDGE_GAP, window.innerHeight - 76 - EDGE_GAP))
    };
  }

  function setPosition(x, y) {
    const position = clampPosition(x, y);
    host.style.left = `${position.x}px`;
    host.style.top = `${position.y}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    return position;
  }

  function selectedProposals() {
    return currentPreview ? currentPreview.proposals
      .filter(proposal => selectedKeys.has(proposal.key))
      .map(proposal => Object.prototype.hasOwnProperty.call(approvedOverrides, proposal.key)
        ? { ...proposal, proposedApproved: Number(approvedOverrides[proposal.key]) }
        : proposal) : [];
  }

  function updateReviewState() {
    if (!currentPreview) return;
    const selected = selectedProposals();
    const totals = Review.reconcile(selected);
    const acknowledgementRequired = exceptionalGroups.size > 0;
    ack.hidden = !acknowledgementRequired;
    if (!acknowledgementRequired) ackCheck.checked = false;
    applyButton.disabled = !selected.length || !totals.balanced || (acknowledgementRequired && !ackCheck.checked);
    applyButton.textContent = selected.length ? `Apply ${selected.length} Selected` : 'Apply Selected';
    summary.hidden = false;
    summary.innerHTML = `
      <div class="metric">Selected rows<strong>${totals.rowCount}</strong></div>
      <div class="metric">Claim total<strong>Rs. ${money.format(totals.claimTotal)}</strong></div>
      <div class="metric">Proposed approved<strong>Rs. ${money.format(totals.proposedApprovedTotal)}</strong></div>
      <div class="metric">Claim-proposed difference<strong>Rs. ${money.format(totals.deductionTotal)}</strong></div>
      <div class="metric">High-risk selected<strong>${totals.highRiskCount}</strong></div>
      <div class="metric">Reconciliation<strong>${totals.balanced ? 'Balanced' : 'BLOCKED'}</strong></div>`;
  }

  function renderPreview(result) {
    currentPreview = result;
    actions.highlightDecisionRows({});
    if (result.blocked) {
      selectedKeys.clear();
      reviewList.textContent = '';
      reviewList.hidden = true;
      summary.hidden = true;
      ack.hidden = true;
      applyButton.disabled = true;
      const messages = {
        'unsupported-layout': 'BLOCKED: The RGHS process-sheet layout is not compatible with this extension version.',
        'invalid-rule-set': 'BLOCKED: The bundled audit rules failed validation. Reload a verified extension build.'
      };
      showStatus(messages[result.blockReason] || 'Preview was blocked by a compatibility check.', 'error');
      return;
    }
    selectedKeys = new Set(result.proposals.filter(proposal => proposal.risk !== 'high').map(proposal => proposal.key));
    approvedOverrides = {};
    exceptionalGroups = new Set();
    reviewList.textContent = '';
    reviewList.hidden = !result.proposals.length;

    const safeProposals = result.proposals.filter(proposal => proposal.risk !== 'high');
    safeButton.disabled = safeProposals.length === 0;
    safeButton.textContent = safeProposals.length
      ? `Apply ${safeProposals.length} Safe Row${safeProposals.length === 1 ? '' : 's'} Now`
      : 'No Safe Rows to Apply';

    for (const proposal of safeProposals) {
      const row = document.createElement('div');
      row.className = `review-row ${proposal.risk}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedKeys.has(proposal.key);
      checkbox.setAttribute('aria-label', `Select ${proposal.label}`);
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selectedKeys.add(proposal.key) : selectedKeys.delete(proposal.key);
        updateReviewState();
      });

      const details = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = proposal.label;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = proposal.risk;
      title.appendChild(badge);
      const values = document.createElement('div');
      values.className = 'row-values';
      const proposed = proposal.proposedApproved === null ? proposal.beforeApproved : proposal.proposedApproved;
      values.textContent = `Claim Rs. ${money.format(proposal.claimAmount)} | Approved ${money.format(proposal.beforeApproved)} -> ${money.format(proposed)}`;
      const reason = document.createElement('div');
      reason.className = 'reason';
      reason.textContent = proposal.reason;
      details.append(title, values, reason);

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'jump';
      jump.textContent = 'Jump';
      jump.addEventListener('click', () => actions.jumpToRow(proposal.key));
      row.append(checkbox, details, jump);
      reviewList.appendChild(row);
    }

    for (const group of Review.groupProposals(result.proposals)) {
      const card = document.createElement('div');
      card.className = 'decision-card';
      const title = document.createElement('div');
      title.className = 'decision-title';
      title.textContent = `${group.id}: one decision for ${group.proposals.length} related row(s)`;
      const lines = document.createElement('div');
      lines.className = 'decision-lines';
      lines.textContent = group.proposals.map(proposal => {
        const recommended = proposal.recommendedApproved;
        return `${proposal.label}: Rs. ${money.format(proposal.claimAmount)}${recommended === null ? ' - hold for review' : ` -> Rs. ${money.format(recommended)}`}`;
      }).join(' | ');
      const buttons = document.createElement('div');
      buttons.className = 'decision-buttons';
      const modes = [];
      if (group.proposals.some(proposal => proposal.recommendedApproved !== null)) {
        const hasPackageDeduction = group.proposals.some(proposal =>
          proposal.decisionRole === 'main' && proposal.recommendedApproved < proposal.claimAmount);
        modes.push([hasPackageDeduction ? 'Apply package deduction' : 'Recommended', 'recommended']);
      }
      modes.push(['Approve both/all', 'approve-all']);
      if (group.proposals.some(proposal => ['main', 'primary'].includes(proposal.decisionRole))) {
        modes.push(['Approve main only', 'main-only']);
      }
      modes.push(['Hold', 'hold']);
      for (const [label, mode] of modes) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          for (const proposal of group.proposals) {
            selectedKeys.delete(proposal.key);
            delete approvedOverrides[proposal.key];
          }
          exceptionalGroups.delete(group.id);
          const decision = Review.decisionForGroup(group, mode);
          for (const key of decision.selectedKeys) selectedKeys.add(key);
          Object.assign(approvedOverrides, decision.approvedOverrides);
          if (decision.acknowledgementRequired) exceptionalGroups.add(group.id);
          actions.highlightDecisionRows(approvedOverrides);
          for (const sibling of buttons.querySelectorAll('button')) sibling.classList.remove('selected');
          button.classList.add('selected');
          updateReviewState();
        });
        buttons.appendChild(button);
      }
      card.append(title, lines, buttons);
      reviewList.appendChild(card);
    }
    ackCheck.checked = false;
    undoButton.disabled = !result.hasUndo;
    updateReviewState();
    showStatus(result.proposals.length
      ? `${safeProposals.length} safe row(s); ${Review.groupProposals(result.proposals).length} decision group(s).`
      : 'No eligible changes found.', result.proposals.length ? 'success' : '');
  }

  mascot.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    dragState = { pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:rect.left,y:rect.top,moved:false };
    mascot.setPointerCapture(event.pointerId);
    mascot.classList.add('dragging');
  });
  mascot.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.hypot(dx, dy) > 4) dragState.moved = true;
    if (dragState.moved) { setOpen(false); setPosition(dragState.x + dx, dragState.y + dy); }
  });
  function finishDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    suppressClick = dragState.moved;
    mascot.classList.remove('dragging');
    if (mascot.hasPointerCapture(event.pointerId)) mascot.releasePointerCapture(event.pointerId);
    if (dragState.moved) {
      const rect = host.getBoundingClientRect();
      withValidExtensionContext(() => chrome.storage.local.set({
        claimSparkPosition:{ x:Math.round(rect.left),y:Math.round(rect.top) }
      }));
    }
    dragState = null;
  }
  mascot.addEventListener('pointerup', finishDrag);
  mascot.addEventListener('pointercancel', finishDrag);
  mascot.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (!hasValidExtensionContext()) {
      invalidateStaleWidget();
      return;
    }
    setOpen(panel.hidden);
  });
  close.addEventListener('click', () => setOpen(false));

  previewButton.addEventListener('click', () => {
    withValidExtensionContext(() => renderPreview(actions.preview()));
  });
  ackCheck.addEventListener('change', updateReviewState);
  function applySelection(keys, overrides, acknowledgedHighRisk) {
    if (!currentPreview || !keys.length) return;
    let result;
    if (!withValidExtensionContext(() => {
      result = actions.apply({
        token: currentPreview.token,
        selectedRowKeys: keys,
        approvedOverrides: overrides,
        acknowledgedHighRisk
      });
    })) return;
    if (result.blocked) {
      const messages = {
        stale: 'BLOCKED: The process sheet changed after Preview. Preview again.',
        expired: 'BLOCKED: Preview expired. Preview again.',
        'empty-selection': 'BLOCKED: Select at least one row.',
        'high-risk-unacknowledged': 'BLOCKED: Acknowledge selected high-risk findings.',
        'invalid-decision': 'BLOCKED: Preview again; the selected decision is no longer valid.',
        unbalanced: 'BLOCKED: Selected totals do not reconcile.'
      };
      showStatus(messages[result.blockReason] || 'Apply was blocked for safety.', 'error');
      applyButton.disabled = true;
      return;
    }
    currentPreview = null;
    selectedKeys.clear();
    approvedOverrides = {};
    exceptionalGroups.clear();
    reviewList.textContent = '';
    reviewList.hidden = true;
    summary.hidden = true;
    ack.hidden = true;
    applyButton.disabled = true;
    applyButton.textContent = 'Apply Selected';
    undoButton.disabled = !result.hasUndo;
    recoverButton.disabled = false;
    showStatus(`Applied ${result.count} field action(s). A recovery snapshot was saved locally.`, 'success');
  }

  safeButton.addEventListener('click', () => {
    if (!currentPreview) return;
    const safeKeys = currentPreview.proposals
      .filter(proposal => proposal.risk !== 'high')
      .map(proposal => proposal.key);
    applySelection(safeKeys, {}, false);
  });
  applyButton.addEventListener('click', () => {
    applySelection(
      [...selectedKeys],
      approvedOverrides,
      exceptionalGroups.size === 0 || ackCheck.checked
    );
  });

  undoButton.addEventListener('click', () => {
    let result;
    if (!withValidExtensionContext(() => { result = actions.undo(); })) return;
    undoButton.disabled = true;
    showStatus(result.count ? `Restored ${result.count} field(s).` : 'Nothing in this page session to undo.', result.count ? 'warning' : '');
  });
  recoverButton.addEventListener('click', async () => {
    if (!recoveryArmed) {
      recoveryArmed = true;
      recoverButton.textContent = 'Confirm Restore Snapshot';
      showStatus('Recovery will replace the matching fields with their saved pre-Apply values. Click again to confirm.', 'warning');
      return;
    }
    recoveryArmed = false;
    recoverButton.textContent = 'Restore Saved Snapshot';
    recoverButton.disabled = true;
    let result;
    if (!hasValidExtensionContext()) {
      invalidateStaleWidget();
      return;
    }
    try {
      result = await actions.restoreRecovery();
    } catch (error) {
      if (!hasValidExtensionContext() || /Extension context invalidated/i.test(String(error?.message || error))) {
        invalidateStaleWidget();
        return;
      }
      throw error;
    }
    showStatus(result.count ? `Restored ${result.count} field(s) from the saved snapshot.` : 'No matching recovery snapshot.', result.count ? 'warning' : '');
  });

  shadow.addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false); });
  undoButton.disabled = !actions.status().hasUndo;
  withValidExtensionContext(() => {
    actions.hasRecovery(hasRecovery => {
      if (!hasValidExtensionContext()) {
        invalidateStaleWidget();
        return;
      }
      recoverButton.disabled = !hasRecovery;
    });
  });
  document.documentElement.append(statusHost, host);
  window.addEventListener('claim-autofill:enabled-change', event => setEnabled(event.detail?.enabled === true));
  withValidExtensionContext(() => chrome.storage.local.get(['claimSparkPosition'], localResult => {
    if (!hasValidExtensionContext()) {
      invalidateStaleWidget();
      return;
    }
    const saved = localResult.claimSparkPosition;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPosition(saved.x, saved.y);
    withValidExtensionContext(() => chrome.storage.sync.get(['autoFillEnabled'], result => {
      if (!hasValidExtensionContext()) {
        invalidateStaleWidget();
        return;
      }
      setEnabled(result.autoFillEnabled !== false);
    }));
  }));
  window.addEventListener('resize', () => {
    if (!host.style.left) return;
    const rect = host.getBoundingClientRect();
    const position = setPosition(rect.left, rect.top);
    withValidExtensionContext(() => chrome.storage.local.set({
      claimSparkPosition:{ x:Math.round(position.x),y:Math.round(position.y) }
    }));
  });
})();
