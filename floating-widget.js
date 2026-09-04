(function () {
  'use strict';

  const Core = globalThis.ClaimAutoFillCore;
  if (!Core || !Core.isSupportedClaimPage(window.location.pathname)) return;
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
      .mascot:focus-visible,.btn:focus-visible,.close:focus-visible,.jump:focus-visible,.panel-width:focus-visible,input:focus-visible { outline:3px solid #2563eb;outline-offset:2px; }
      .mascot img { width:70px;height:70px;object-fit:contain;pointer-events:none; }
      .panel { position:absolute;right:0;bottom:88px;width:min(640px,calc((100vw - 24px) / var(--claim-spark-page-zoom, 1) / var(--panel-scale, 1)));min-width:min(340px,calc((100vw - 24px) / var(--claim-spark-page-zoom, 1) / var(--panel-scale, 1)));max-width:calc((100vw - 24px) / var(--claim-spark-page-zoom, 1) / var(--panel-scale, 1));max-height:calc((100vh - 32px) / var(--claim-spark-page-zoom, 1) / var(--panel-scale, 1));padding:14px;border:1px solid #bfdbfe;border-radius:16px;background:rgba(255,255,255,.99);box-shadow:0 16px 42px rgba(15,23,42,.25);transform:scale(var(--panel-scale, 1));transform-origin:bottom right;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain; }
      .panel[hidden] { display:none; }
      .panel.open-below { bottom:auto;top:88px; }
      .panel.open-right { right:auto;left:0;transform-origin:bottom left; }
      .resize-handle { position:absolute;left:0;bottom:0;width:22px;height:24px;cursor:ew-resize;touch-action:none;user-select:none;z-index:2; }
      .resize-handle::after { content:'↔';position:absolute;bottom:3px;left:4px;color:#64748b;font-size:12px;font-weight:800;line-height:1; }
      .panel.open-right .resize-handle { right:0;left:auto; }
      .title { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-weight:750;font-size:15px; }
      .title-tools { display:flex;align-items:center;gap:3px; }
      .version { margin-left:6px;color:#64748b;font-size:10px;font-weight:650; }
      .text-size,.panel-width,.layout-reset,.close { border:0;background:transparent;color:#475569;cursor:pointer;line-height:1; }
      .text-size,.panel-width,.layout-reset { min-width:25px;height:25px;border-radius:6px;font-size:11px;font-weight:800; }
      .text-size:hover,.panel-width:hover,.layout-reset:hover { background:#e0e7ff;color:#3730a3; }
      .text-size:disabled { cursor:not-allowed;opacity:.4; }
      .panel-width:disabled { cursor:not-allowed;opacity:.4; }
      .close { font-size:20px; }
      .panel::-webkit-scrollbar { width:9px; }
      .panel::-webkit-scrollbar-thumb { border:2px solid transparent;border-radius:999px;background:#94a3b8;background-clip:content-box; }
      .panel-content { display:grid;gap:10px;padding-right:4px; }
      .summary { display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:9px;border-radius:10px;background:#eff6ff;font-size:12px; }
      .summary[hidden],.ipd-context[hidden],.card-history[hidden],.investigation-checklist[hidden],.query-checklist[hidden],.ack[hidden],.review-list[hidden] { display:none; }
      .ipd-context { padding:8px 9px;border:1px solid #bfdbfe;border-radius:10px;background:#f8fbff;color:#1e3a8a;font-size:11px;line-height:1.4;overflow-wrap:anywhere; }
      .ipd-context strong { display:block;font-size:12px; }
      .card-history { padding:8px 9px;border:1px solid #c7d2fe;border-radius:10px;background:#f5f7ff;color:#312e81;font-size:11px;line-height:1.4;overflow-wrap:anywhere; }
      .card-history strong { display:block;font-size:12px; }
      .card-history ul { margin:5px 0 0;padding-left:16px; }
      .ecard { margin-top:6px;border:1px solid #a5b4fc;border-radius:7px;padding:4px 6px;background:#fff;color:#3730a3;cursor:pointer;font-size:10px;font-weight:700; }
      .history-results { margin-top:8px;padding:8px;border:1px solid #c7d2fe;border-radius:8px;background:#fff; }
      .history-results-title { margin-bottom:6px;color:#312e81;font-size:11px;font-weight:800; }
      .history-filters,.history-result-actions { display:flex;flex-wrap:wrap;gap:6px;margin:0 0 7px;align-items:center; }
      .history-filters label { display:flex;gap:4px;align-items:center;color:#475569;font-size:10px; }
      .history-filters select,.history-filters input { accent-color:#4f46e5;font:inherit; }
      .history-filters select { max-width:112px;border:1px solid #c7d2fe;border-radius:5px;padding:3px;background:#fff;color:#312e81; }
      .history-result-actions button,.history-open { border:1px solid #a5b4fc;border-radius:5px;padding:3px 5px;background:#fff;color:#3730a3;cursor:pointer;font-size:9px;font-weight:700; }
      .history-open { margin-top:4px; }
      .history-table-wrap { max-height:260px;overflow:auto;border:1px solid #e2e8f0;border-radius:6px; }
      .history-table { width:100%;border-collapse:collapse;table-layout:fixed;color:#334155;font-size:10px; }
      .history-table th { position:sticky;top:0;padding:6px;background:#eef2ff;color:#312e81;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.03em; }
      .history-table td { padding:6px;border-top:1px solid #e2e8f0;vertical-align:top;overflow-wrap:anywhere; }
      .history-table th:nth-child(1),.history-table td:nth-child(1) { width:43%; }
      .history-table th:nth-child(2),.history-table td:nth-child(2) { width:14%; }
      .history-table th:nth-child(3),.history-table td:nth-child(3) { width:43%; }
      .history-claims { margin:0;padding-left:14px; }
      .history-claims li + li { margin-top:3px; }
      .history-badge { display:inline-block;margin:3px 3px 0 0;padding:2px 4px;border-radius:999px;background:#e0e7ff;color:#3730a3;font-size:8px;font-weight:800; }
      .history-badge.warning { background:#fee2e2;color:#991b1b; }
      .history-detail { display:block;margin-top:2px;color:#475569;font-size:9px; }
      .investigation-checklist { padding:8px 9px;border:1px solid #99f6e4;border-radius:10px;background:#f0fdfa;color:#134e4a;font-size:11px;line-height:1.4;overflow-wrap:anywhere; }
      .investigation-checklist strong { display:block;font-size:12px; }
      .checklist-row { display:grid;grid-template-columns:1fr 62px;gap:7px;align-items:center;margin-top:6px; }
      .checklist-row input { width:100%;border:1px solid #5eead4;border-radius:6px;padding:4px 5px;background:#fff;color:#134e4a;font:inherit; }
      .checklist-actions { display:flex;gap:6px;margin-top:8px; }
      .checklist-actions button { border:1px solid #0f766e;border-radius:7px;padding:5px 7px;background:#fff;color:#115e59;cursor:pointer;font-size:10px;font-weight:700; }
      .query-checklist { padding:8px 9px;border:1px solid #bfdbfe;border-radius:10px;background:#f8fbff;color:#1e3a8a;font-size:11px;line-height:1.4; }
      .query-checklist strong { display:block;font-size:12px; }
      .section-toggle { display:flex;width:100%;align-items:center;justify-content:space-between;border:0;background:transparent;color:inherit;cursor:pointer;font:800 12px/1.2 inherit;text-align:left;padding:0 0 6px; }
      [data-section-collapsed="true"] > :not(.section-toggle) { display:none; }
      .query-option { display:grid;grid-template-columns:16px 1fr auto;gap:7px;align-items:start;margin-top:6px; }
      .query-option input { margin-top:2px;accent-color:#2563eb; }
      .query-option textarea { min-height:38px;resize:vertical;border:1px solid #93c5fd;border-radius:6px;padding:4px;background:#fff;color:#1e3a8a;font:inherit;line-height:1.3; }
      .query-remove { border:0;border-radius:5px;padding:4px 5px;background:#fee2e2;color:#991b1b;cursor:pointer;font-size:10px;font-weight:700; }
      .metric strong { display:block;color:#1e3a8a;font-size:13px; }
      .review-list { overflow:auto;display:grid;gap:7px;padding-right:3px; }
      .review-row { display:grid;grid-template-columns:24px 1fr auto;gap:7px;align-items:start;padding:9px;border:1px solid #e2e8f0;border-left:5px solid #22c55e;border-radius:10px;background:#fff; }
      .review-row.medium { border-left-color:#f59e0b;background:#fffbeb; }
      .review-row.high { border-left-color:#dc2626;background:#fef2f2; }
      .decision-card { padding:10px;border:1px solid #fecaca;border-left:5px solid #dc2626;border-radius:10px;background:#fef2f2; }
      .decision-title { font-size:12px;font-weight:800;color:#7f1d1d; }
      .decision-lines { margin:5px 0;font-size:11px;line-height:1.4;color:#475569; }
      .decision-items { display:grid;gap:5px;margin:7px 0; }
      .decision-item { display:grid;grid-template-columns:auto 1fr;gap:6px;padding:6px;border:1px solid #fecaca;border-radius:7px;background:#fff; }
      .decision-item-index { min-width:42px;color:#991b1b;font-size:10px;font-weight:800; }
      .decision-item-label { color:#334155;font-size:11px;font-weight:800;overflow-wrap:anywhere; }
      .decision-item-values { margin-top:2px;color:#475569;font-size:10px;line-height:1.35; }
      .decision-item-role { margin-top:2px;color:#7f1d1d;font-size:9px;font-weight:750;text-transform:uppercase; }
      .decision-item-controls { display:flex;align-items:center;gap:7px;margin-top:5px; }
      .decision-item-select { display:flex;align-items:center;gap:4px;color:#7f1d1d;font-size:10px;font-weight:750; }
      .decision-item-select input { width:15px;height:15px;margin:0; }
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
      .policy-badge { display:block;width:max-content;max-width:100%;margin-top:5px;padding:3px 6px;border-radius:6px;background:#fee2e2;color:#991b1b;font-size:10px;line-height:1.3; }
      .jump { border:0;border-radius:7px;padding:5px 7px;background:#e0e7ff;color:#3730a3;cursor:pointer;font-size:11px;font-weight:700; }
      .ack { padding:8px;border:1px solid #fecaca;border-radius:9px;background:#fef2f2;color:#991b1b;font-size:11px;font-weight:650; }
      .ack label { display:flex;gap:7px;align-items:flex-start; }
      .actions { display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px; }
      .btn { border:0;border-radius:10px;padding:10px 8px;cursor:pointer;font-weight:700;font-size:12px; }
      .preview { background:#dbeafe;color:#1d4ed8; }
      .safe { grid-column:1/-1;background:#dcfce7;color:#166534; }
      .apply { background:#16a34a;color:white; }
      .undo { background:#fef3c7;color:#92400e; }
      .recover { background:#ede9fe;color:#6d28d9; }
      .btn:disabled { cursor:not-allowed;opacity:.45; }
      .status { min-height:32px;margin-top:10px;padding:8px 9px;border-radius:9px;background:#f8fafc;color:#475569;font-size:12px;line-height:1.35;overflow-wrap:anywhere; }
      .status.success { background:#dcfce7;color:#166534; }
      .status.warning { background:#fef3c7;color:#92400e; }
      .status.error { background:#fee2e2;color:#991b1b; }
      .panel.pending-only .summary,.panel.pending-only .ipd-context,.panel.pending-only .card-history,.panel.pending-only .query-checklist,.panel.pending-only .investigation-checklist[data-verified="true"],.panel.pending-only .review-row.low { display:none; }
    </style>
    <div class="wrap">
      <section class="panel" hidden aria-label="Claim Spark review controls" title="Hold Ctrl and use the mouse wheel to resize the entire widget; use the wheel normally to scroll its contents.">
        <div class="title"><span>&#9889; Claim Spark Review <span class="version">v${extensionVersion}</span></span><div class="title-tools"><button class="panel-width panel-narrower" type="button" aria-label="Make extension narrower" title="Make extension narrower">W&#8722;</button><button class="panel-width panel-wider" type="button" aria-label="Make extension wider" title="Make extension wider">W+</button><button class="text-size text-smaller" type="button" aria-label="Decrease widget size" title="Decrease widget size">A&#8722;</button><button class="text-size text-larger" type="button" aria-label="Increase widget size" title="Increase widget size">A+</button><button class="layout-reset" type="button" aria-label="Reset widget layout" title="Reset widget layout">&#8634;</button><button class="close" type="button" aria-label="Close">&times;</button></div></div>
        <div class="panel-content">
        <div class="summary" hidden></div>
        <div class="ipd-context" hidden aria-live="polite"></div>
        <div class="card-history" hidden aria-live="polite"></div>
        <div class="investigation-checklist" hidden aria-live="polite"></div>
        <div class="query-checklist" hidden aria-live="polite"></div>
        <div class="review-list" hidden aria-label="Proposed row changes"></div>
        <div class="ack" hidden><label><input type="checkbox" class="ack-check" />I reviewed the selected high-risk audit findings and accept applying them.</label></div>
        </div>
        <div class="actions">
          <button class="btn safe" type="button" disabled>Apply Safe Rows Now</button>
          <button class="btn preview" type="button">Preview Current Sheet</button>
          <button class="btn pending" type="button">Only Pending Work</button>
          <button class="btn investigation" type="button">Review Investigations</button>
          <button class="btn documents" type="button">Open Review Documents</button>
          <button class="btn query" type="button">Load IPD Remarks</button>
          <button class="btn compatibility" type="button">Compatibility Details</button>
          <button class="btn apply" type="button" disabled>Apply Selected</button>
          <button class="btn undo" type="button" disabled>Undo Last Fill</button>
          <button class="btn recover" type="button" disabled>Restore Saved Snapshot</button>
        </div>
        <div class="status" role="status" aria-live="polite">Preview is read-only. Nothing changes until Apply Selected.</div>
        <div class="resize-handle" title="Drag horizontally to resize this panel"></div>
      </section>
      <button class="mascot" type="button" aria-label="Open Claim Spark review" aria-expanded="false"><img src="${mascotIconUrl}" alt="" /></button>
    </div>`;

  const panel = shadow.querySelector('.panel');
  const resizeHandle = shadow.querySelector('.resize-handle');
  const mascot = shadow.querySelector('.mascot');
  const close = shadow.querySelector('.close');
  const smallerTextButton = shadow.querySelector('.text-smaller');
  const largerTextButton = shadow.querySelector('.text-larger');
  const layoutResetButton = shadow.querySelector('.layout-reset');
  const narrowerPanelButton = shadow.querySelector('.panel-narrower');
  const widerPanelButton = shadow.querySelector('.panel-wider');
  const previewButton = shadow.querySelector('.preview');
  const pendingButton = shadow.querySelector('.pending');
  const investigationButton = shadow.querySelector('.investigation');
  const documentsButton = shadow.querySelector('.documents');
  const queryButton = shadow.querySelector('.query');
  const compatibilityButton = shadow.querySelector('.compatibility');
  const safeButton = shadow.querySelector('.safe');
  const applyButton = shadow.querySelector('.apply');
  const undoButton = shadow.querySelector('.undo');
  const recoverButton = shadow.querySelector('.recover');
  const status = shadow.querySelector('.status');
  const summary = shadow.querySelector('.summary');
  const ipdContext = shadow.querySelector('.ipd-context');
  const cardHistory = shadow.querySelector('.card-history');
  const investigationChecklist = shadow.querySelector('.investigation-checklist');
  const queryChecklist = shadow.querySelector('.query-checklist');
  const reviewList = shadow.querySelector('.review-list');
  const ack = shadow.querySelector('.ack');
  const ackCheck = shadow.querySelector('.ack-check');
  let currentPreview = null;
  let selectedKeys = new Set();
  let approvedOverrides = {};
  let remarkOverrides = {};
  let exceptionalGroups = new Set();
  let recoveryArmed = false;
  let pendingOnly = false;
  let investigationPreviewToken = null;
  let dragState = null;
  let resizeState = null;
  let suppressClick = false;
  let panelScale = 1;
  const collapsedSections = new Set();
  const EDGE_GAP = 8;
  const PANEL_SCALE_MIN = 0.6;
  const PANEL_SCALE_MAX = 1.5;
  const PANEL_SCALE_STEP = 0.1;
  const PANEL_MIN_WIDTH = 340;
  const PANEL_WIDTH_STEP = 120;
  const DEFAULT_IPD_ACTION_TEMPLATES = {
    approve: ['Approved as per provided documents.'],
    query: ['Please upload complete indoor case papers, treatment chart and nursing notes.', 'Please upload discharge summary mentioning admission and discharge date and time.', 'Please upload all investigation reports supporting the claimed investigations.', 'Please upload operative notes and supporting procedure documents, if applicable.'],
    reject: ['Rejected due to insufficient supporting documents.']
  };
  const IPD_ACTION_LABELS = { approve: 'Approve', query: 'Query', reject: 'Reject' };
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

  function setSectionCollapsed(section, id, collapsed) {
    section.dataset.sectionCollapsed = String(collapsed);
    collapsed ? collapsedSections.add(id) : collapsedSections.delete(id);
    const toggle = section.querySelector('.section-toggle');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.lastChild.textContent = collapsed ? 'Show' : 'Hide';
    }
  }

  function makeSectionCollapsible(section, id, label) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'section-toggle';
    toggle.append(document.createTextNode(label), document.createTextNode('Hide'));
    toggle.addEventListener('click', () => setSectionCollapsed(section, id, !collapsedSections.has(id)));
    section.prepend(toggle);
    setSectionCollapsed(section, id, collapsedSections.has(id));
  }

  function focusSection(section, id) {
    setSectionCollapsed(section, id, false);
    requestAnimationFrame(() => section.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  function resetWidgetLayout() {
    panelScale = 1;
    setPanelScale(1, { persist: false });
    setPanelWidth(640, { persist: false });
    host.style.left = '';
    host.style.top = '';
    host.style.right = '18px';
    host.style.bottom = '18px';
    panel.scrollTop = 0;
    withValidExtensionContext(() => chrome.storage.local.set({
      claimSparkPosition: null,
      claimSparkPanelScale: 1,
      claimSparkPanelWidth: 640
    }));
    showStatus('Widget layout reset.', 'success');
  }

  function decisionMemoryKey() {
    const tid = actions.getCurrentTid?.();
    return tid ? `claimSparkDecisionMemory:${tid}` : '';
  }

  function saveDecisionMemory() {
    const key = decisionMemoryKey();
    if (!key || !currentPreview) return;
    withValidExtensionContext(() => chrome.storage.session.set({ [key]: {
      selectedKeys: [...selectedKeys], approvedOverrides, remarkOverrides, exceptionalGroups: [...exceptionalGroups]
    } }));
  }

  function restoreDecisionMemory() {
    const key = decisionMemoryKey();
    if (!key || !currentPreview) return;
    withValidExtensionContext(() => chrome.storage.session.get(key, result => {
      const saved = result[key];
      if (!saved || !currentPreview) return;
      const available = new Set(currentPreview.proposals.map(proposal => proposal.key));
      selectedKeys = new Set((saved.selectedKeys || []).filter(key => available.has(key)));
      approvedOverrides = Object.fromEntries(Object.entries(saved.approvedOverrides || {}).filter(([key]) => available.has(key)));
      remarkOverrides = Object.fromEntries(Object.entries(saved.remarkOverrides || {}).filter(([key]) => available.has(key)));
      exceptionalGroups = new Set(saved.exceptionalGroups || []);
      updateReviewState();
      showStatus('Restored saved review decisions for this claim.', 'success');
    }));
  }

  function setPanelScale(value, { persist = true } = {}) {
    panelScale = Math.min(PANEL_SCALE_MAX, Math.max(PANEL_SCALE_MIN, Math.round(value * 10) / 10));
    panel.style.setProperty('--panel-scale', String(panelScale));
    smallerTextButton.disabled = panelScale <= PANEL_SCALE_MIN;
    largerTextButton.disabled = panelScale >= PANEL_SCALE_MAX;
    if (persist) {
      withValidExtensionContext(() => chrome.storage.local.set({ claimSparkPanelScale: panelScale }));
    }
  }

  function setPanelWidth(value, { persist = true } = {}) {
    const displayScale = Number(host.dataset.claimSparkZoomCompensation) || 1;
    const maxWidth = Math.max(1, (window.innerWidth - 24) / displayScale / panelScale);
    const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
    const width = Math.round(Math.min(maxWidth, Math.max(minWidth, value)));
    panel.style.width = `${width}px`;
    narrowerPanelButton.disabled = width <= minWidth;
    widerPanelButton.disabled = width >= maxWidth;
    if (persist) {
      withValidExtensionContext(() => chrome.storage.local.set({ claimSparkPanelWidth: width }));
    }
  }

  function getPanelCssWidth() {
    return Number.parseFloat(panel.style.width) || Number.parseFloat(getComputedStyle(panel).width);
  }

  function refreshWidgetZoomCompensation() {
    // Do not auto-compensate browser page zoom. A fixed overlay that counter-scales
    // itself can cover the portal at low page zoom. The processor controls widget
    // size directly with W+/W− and Ctrl + mouse wheel instead.
    host.style.transform = '';
    host.style.transformOrigin = '';
    host.style.removeProperty('--claim-spark-page-zoom');
    host.dataset.claimSparkZoomCompensation = '1';
  }

  function renderHistoricalPackageTable(container, matches, title) {
    container.replaceChildren();
    if (!matches?.length) return;
    const heading = document.createElement('div');
    heading.className = 'history-results-title';
    heading.textContent = title;
    const tableWrap = document.createElement('div');
    tableWrap.className = 'history-table-wrap';
    const table = document.createElement('table');
    table.className = 'history-table';
    const header = table.insertRow();
    for (const text of ['Package', 'Code', 'Previous claim(s)']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = text;
      header.appendChild(cell);
    }
    for (const item of matches) {
      const row = table.insertRow();
      const label = row.insertCell();
      label.textContent = item.label || `Package ${item.code}`;
      const histories = item.history || [];
      const lastDate = histories.map(entry => entry.caseDate).find(Boolean);
      for (const badgeText of [
        `Repeated ${histories.length} time${histories.length === 1 ? '' : 's'}`,
        lastDate ? `Last: ${lastDate}` : '',
        histories.some(entry => /rejected/i.test(entry.claimStatus || '')) ? 'Previously rejected' : ''
      ].filter(Boolean)) {
        const badge = document.createElement('span');
        badge.className = `history-badge${badgeText === 'Previously rejected' ? ' warning' : ''}`;
        badge.textContent = badgeText;
        label.appendChild(document.createElement('br'));
        label.appendChild(badge);
      }
      const code = row.insertCell();
      code.textContent = item.code;
      const history = row.insertCell();
      const list = document.createElement('ul');
      list.className = 'history-claims';
      for (const entry of histories) {
        const line = document.createElement('li');
        const date = entry.caseDate || 'Date unavailable';
        const status = entry.claimStatus || 'Status unavailable';
        line.textContent = `${date} — ${status}${entry.transactionId ? ` (${entry.transactionId})` : ''}`;
        if (Number.isFinite(entry.historicalRequestedUnits) && Number.isFinite(entry.historicalApprovedUnits)) {
          const detail = document.createElement('span');
          detail.className = 'history-detail';
          detail.textContent = `Requested ${entry.historicalRequestedUnits} / Approved ${entry.historicalApprovedUnits}`;
          line.appendChild(detail);
        }
        if (entry.transactionUrl) {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'history-open';
          open.textContent = 'Open portal record';
          open.addEventListener('click', () => {
            const url = new URL(entry.transactionUrl, location.origin);
            if (url.origin !== location.origin) {
              showStatus('The portal record link is not available on this RGHS page.', 'error');
              return;
            }
            url.hash = entry.transactionId || '';
            window.open(url.href, '_blank', 'noopener');
          });
          line.appendChild(open);
        }
        list.appendChild(line);
      }
      history.appendChild(list);
    }
    tableWrap.appendChild(table);
    container.append(heading, tableWrap);
  }

  function parseHistoryDate(value) {
    const match = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return match ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])) : null;
  }

  function isRejectedOrReduced(entry) {
    return /rejected/i.test(entry.claimStatus || '')
      || Number.isFinite(entry.historicalRequestedUnits)
        && Number.isFinite(entry.historicalApprovedUnits)
        && entry.historicalApprovedUnits < entry.historicalRequestedUnits;
  }

  function filterHistoricalMatches(matches, months, onlyRejectedOrReduced) {
    const cutoff = months ? new Date(new Date().getFullYear(), new Date().getMonth() - months, new Date().getDate()) : null;
    return matches.map(item => ({
      ...item,
      history: (item.history || []).filter(entry => {
        const historyDate = parseHistoryDate(entry.caseDate);
        return (!cutoff || historyDate && historyDate >= cutoff)
          && (!onlyRejectedOrReduced || isRejectedOrReduced(entry));
      })
    })).filter(item => item.history.length);
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  async function copyHistoricalReviewSummary(matches, title, filterLabel) {
    const lines = [title, `Claim TID: ${actions.getCurrentTid?.() || 'Unavailable'}`, `Filter: ${filterLabel}`];
    for (const item of matches) {
      lines.push(`${item.label || `Package ${item.code}`} (${item.code}) — repeated ${item.history.length} time(s)`);
      for (const entry of item.history) {
        const detail = Number.isFinite(entry.historicalRequestedUnits) && Number.isFinite(entry.historicalApprovedUnits)
          ? `; requested ${entry.historicalRequestedUnits}, approved ${entry.historicalApprovedUnits}` : '';
        lines.push(`  - ${entry.caseDate || 'Date unavailable'}; ${entry.claimStatus || 'Status unavailable'}; ${entry.transactionId || 'TID unavailable'}${detail}`);
      }
    }
    await copyText(lines.join('\n'));
  }

  function renderHistoricalPackageResults(container, matches, title) {
    let months = 0;
    let onlyRejectedOrReduced = false;
    const render = () => {
      container.replaceChildren();
      const heading = document.createElement('div');
      heading.className = 'history-results-title';
      const filterLabel = `${months ? `Last ${months} months` : 'All history'}${onlyRejectedOrReduced ? '; rejected or reduced only' : ''}`;
      const filtered = filterHistoricalMatches(matches, months, onlyRejectedOrReduced);
      heading.textContent = `${title} — ${filtered.length} package(s) after filters`;
      const filters = document.createElement('div');
      filters.className = 'history-filters';
      const periodLabel = document.createElement('label');
      periodLabel.textContent = 'Period';
      const period = document.createElement('select');
      for (const [value, text] of [['0', 'All history'], ['3', 'Last 3 months'], ['6', 'Last 6 months'], ['12', 'Last 12 months']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = Number(value) === months;
        period.appendChild(option);
      }
      period.addEventListener('change', () => { months = Number(period.value); render(); });
      periodLabel.appendChild(period);
      const restrictedLabel = document.createElement('label');
      const restricted = document.createElement('input');
      restricted.type = 'checkbox';
      restricted.checked = onlyRejectedOrReduced;
      restricted.addEventListener('change', () => { onlyRejectedOrReduced = restricted.checked; render(); });
      restrictedLabel.append(restricted, 'Rejected or reduced only');
      filters.append(periodLabel, restrictedLabel);
      const resultActions = document.createElement('div');
      resultActions.className = 'history-result-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy review summary';
      copy.disabled = !filtered.length;
      copy.addEventListener('click', async () => {
        try {
          await copyHistoricalReviewSummary(filtered, title, filterLabel);
          showStatus('Historical review summary copied to the clipboard.', 'success');
        } catch {
          showStatus('Unable to copy the historical review summary.', 'error');
        }
      });
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear history results';
      clear.addEventListener('click', () => {
        container.replaceChildren();
        container.hidden = true;
        showStatus('Historical review results cleared.', 'success');
      });
      resultActions.append(copy, clear);
      const table = document.createElement('div');
      if (filtered.length) {
        renderHistoricalPackageTable(table, filtered, '');
        table.querySelector('.history-results-title')?.remove();
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No matching packages meet the selected filters.';
        table.appendChild(empty);
      }
      container.append(heading, filters, resultActions, table);
    };
    render();
  }

  function renderIpdContext(context) {
    if (!context?.loaded) return;
    const dates = [context.admissionDate, context.admissionTime, context.dischargeDate, context.dischargeTime];
    if (!dates.some(Boolean)) return;
    ipdContext.hidden = false;
    ipdContext.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'IPD stay context';
    const details = document.createElement('div');
    details.textContent = `Admission: ${context.admissionDate || '—'} ${context.admissionTime || ''} | Discharge: ${context.dischargeDate || '—'} ${context.dischargeTime || ''}`;
    const intervals = document.createElement('div');
    intervals.textContent = Number.isInteger(context.completed24HourIntervals)
      ? `Completed 24-hour intervals: ${context.completed24HourIntervals}`
      : 'Stay duration could not be calculated.';
    ipdContext.append(title, details, intervals);
    makeSectionCollapsible(ipdContext, 'ipd-context', 'IPD stay context');
  }

  function renderCardHistory(history) {
    if (!history?.loaded) return;
    cardHistory.hidden = false;
    cardHistory.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `RGHS case history (${history.cases.length})`;
    cardHistory.appendChild(title);
    if (history.cases.length) {
      const list = document.createElement('ul');
      for (const item of history.cases.slice(0, 5)) {
        const line = document.createElement('li');
        line.textContent = `${item.transactionId} · ${item.claimStatus || 'Status unavailable'} · ${item.admissionDate || '—'} to ${item.dischargeDate || '—'}`;
        list.appendChild(line);
      }
      cardHistory.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.textContent = 'Case history unavailable.';
      cardHistory.appendChild(empty);
    }
    const ecard = document.createElement('button');
    ecard.type = 'button';
    ecard.className = 'ecard';
    ecard.textContent = 'Load e-card summary';
    ecard.addEventListener('click', async () => {
      ecard.disabled = true;
      try {
        const result = await actions.getECardSummary?.();
        if (!result?.ok || !result.entries?.length) return showStatus('E-card information is unavailable for this claim.', 'warning');
        const details = result.entries.map(item => `${item.label}: ${item.value}`).join(' | ');
        showStatus(details, 'success');
      } catch {
        showStatus('E-card information could not be loaded.', 'error');
      } finally {
        ecard.disabled = false;
      }
    });
    cardHistory.appendChild(ecard);
    if (/\/RGHS\/tpa(?:pre.?auth)?OPD/i.test(location.pathname) || /\/RGHS\/tpaOPD(?:pre.?auth)?/i.test(location.pathname)) {
      const blockedInvestigations = document.createElement('button');
      blockedInvestigations.type = 'button';
      blockedInvestigations.className = 'ecard';
      blockedInvestigations.textContent = 'Check recent blocked investigations';
      const historyResults = document.createElement('div');
      historyResults.className = 'history-results';
      historyResults.hidden = true;
      blockedInvestigations.addEventListener('click', async () => {
        blockedInvestigations.disabled = true;
        historyResults.hidden = true;
        historyResults.replaceChildren();
        showStatus('Checking historical pre-auth package approvals…', 'warning');
        let result;
        try {
          result = await actions.getBlockedInvestigationHistory?.();
        } catch {
          showStatus('Historical pre-auth package details could not be checked.', 'error');
          return;
        } finally {
          blockedInvestigations.disabled = false;
        }
        if (!result?.available) {
          const messages = {
            'history-loading': 'Card history is still loading. Try again in a moment.',
            'patient-name-unavailable': 'The current patient name is unavailable, so past claims cannot be matched safely.',
            'current-claim-unavailable': 'Current investigation findings are unavailable. Preview the current sheet and try again.',
            'not-opd': 'This comparison is available only for OPD and pre-auth OPD claims.'
          };
          showStatus(messages[result?.reason] || 'Recent blocked-investigation comparison is unavailable.', 'warning');
          return;
        }
        if (!result.repeatedPackageCount) {
          if (result.similarPackageCount) {
            renderHistoricalPackageResults(historyResults, result.similarPackageHistory,
              `${result.similarPackageCount} matching package(s) in prior OPD/pre-auth claims`);
            historyResults.hidden = false;
            showStatus(result.currentBlockedCount
              ? 'Matching packages are shown below. No earlier reduced approval was verified.'
              : 'Matching packages are shown below. The current claim has no reduced approved quantity yet.', 'warning');
            return;
          }
          showStatus(result.currentCount
            ? 'No matching investigation appears in the available past claims for this patient.'
            : 'No investigation has fewer approved units than requested units in the current claim.', 'success');
          return;
        }
        renderHistoricalPackageResults(historyResults, result.packageMatches,
          `${result.repeatedPackageCount} of ${result.currentCount} blocked package(s) appeared previously`);
        historyResults.hidden = false;
        showStatus('Previously reduced matching packages are shown below.', 'warning');
      });
      cardHistory.append(blockedInvestigations, historyResults);
    }
    makeSectionCollapsible(cardHistory, 'card-history', `RGHS case history (${history.cases.length})`);
  }

  function renderInvestigationChecklist() {
    const items = actions.getInvestigationChecklist?.() || [];
    investigationChecklist.hidden = false;
    investigationChecklist.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'Investigation verification';
    investigationChecklist.appendChild(title);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.textContent = location.pathname.startsWith('/RGHS/tpaClaim')
        ? 'No expected investigation-unit data is available on this main claim. Keep this page open while reviewing the PDF; verify and synchronize quantities on the process sheet.'
        : 'No investigation rows with expected quantities were found on this processing sheet.';
      investigationChecklist.appendChild(empty);
      makeSectionCollapsible(investigationChecklist, 'investigations', 'Investigation verification');
      return;
    }
    const prompt = document.createElement('div');
    const writable = items.every(item => item.writable);
    prompt.textContent = writable
      ? 'Confirm reports found while reviewing the investigation PDF. Values cannot exceed the expected quantity.'
      : 'Expected units are shown from the main claim while the investigation PDF is open. This view does not change pre-auth claim values.';
    investigationChecklist.appendChild(prompt);
    for (const item of items) {
      const row = document.createElement('label');
      row.className = 'checklist-row';
      const label = document.createElement('span');
      label.textContent = `${item.label} — expected ${item.expected}`;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(item.expected);
      input.step = '1';
      input.value = String(item.expected);
      input.dataset.index = String(item.index);
      input.setAttribute('aria-label', `${item.label}: reports found`);
      row.append(label, input);
      investigationChecklist.appendChild(row);
    }
    if (!writable) {
      makeSectionCollapsible(investigationChecklist, 'investigations', 'Investigation verification');
      return;
    }
    const actionsRow = document.createElement('div');
    actionsRow.className = 'checklist-actions';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.textContent = 'Preview verified quantities';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'Apply verified quantities';
    apply.disabled = true;
    preview.addEventListener('click', () => {
      const verifiedCounts = [...investigationChecklist.querySelectorAll('input[data-index]')]
        .map(input => ({ index: Number(input.dataset.index), found: input.value }));
      const result = actions.previewInvestigationVerification?.(verifiedCounts);
      if (!result?.proposals?.length) {
        investigationPreviewToken = null;
        apply.disabled = true;
        showStatus('Enter a valid report count for each investigation to prepare a verification.', 'warning');
        return;
      }
      investigationPreviewToken = result.token;
      apply.disabled = false;
      const reductions = result.proposals.filter(item => item.risk === 'high').length;
      showStatus(`${result.proposals.length} investigation row(s) prepared. ${reductions ? `${reductions} reduction(s) require your confirmed Apply.` : 'No reductions detected.'}`, reductions ? 'warning' : 'success');
    });
    apply.addEventListener('click', async () => {
      if (!investigationPreviewToken) return;
      apply.disabled = true;
      const result = await actions.applyInvestigationVerification?.(investigationPreviewToken);
      if (result?.blocked) {
        showStatus('Investigation verification is stale. Review the quantities again before applying.', 'error');
        return;
      }
      investigationPreviewToken = null;
      undoButton.disabled = !result?.hasUndo;
      recoverButton.disabled = false;
      showStatus(`Applied ${result?.changedFieldCount || 0} verified investigation field change(s). Recovery was saved locally.`, 'success');
    });
    actionsRow.append(preview, apply);
    investigationChecklist.appendChild(actionsRow);
    makeSectionCollapsible(investigationChecklist, 'investigations', 'Investigation verification');
  }

  function revealInvestigationChecklist() {
    focusSection(investigationChecklist, 'investigations');
  }

  function normalizeIpdActionTemplates(saved, legacyQueries) {
    const result = {};
    for (const action of Object.keys(IPD_ACTION_LABELS)) {
      const values = Array.isArray(saved?.[action]) ? saved[action]
        : action === 'query' && Array.isArray(legacyQueries) ? legacyQueries : DEFAULT_IPD_ACTION_TEMPLATES[action];
      result[action] = values.map(value => String(value || '').trim()).filter(Boolean);
    }
    return result;
  }

  function saveIpdActionTemplates(templates) {
    withValidExtensionContext(() => chrome.storage.local.set({ claimSparkIpdActionTemplates: templates }));
  }

  function loadIpdQueryChecklist() {
    withValidExtensionContext(() => chrome.storage.local.get(['claimSparkIpdActionTemplates', 'claimSparkIpdQueryTemplates'], result => {
      renderIpdQueryChecklist(normalizeIpdActionTemplates(result.claimSparkIpdActionTemplates, result.claimSparkIpdQueryTemplates));
      focusSection(queryChecklist, 'ipd-queries');
    }));
  }

  function renderIpdQueryChecklist(templatesByAction, selectedAction = 'query') {
    const templates = templatesByAction[selectedAction] || (templatesByAction[selectedAction] = []);
    queryChecklist.hidden = false;
    queryChecklist.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'IPD action remarks';
    const prompt = document.createElement('div');
    prompt.textContent = `Select, edit, add, or remove ${IPD_ACTION_LABELS[selectedAction]} remarks. Each action has its own saved list.`;
    const actionTabs = document.createElement('div');
    actionTabs.className = 'checklist-actions';
    for (const [action, label] of Object.entries(IPD_ACTION_LABELS)) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.textContent = label;
      tab.classList.toggle('selected', action === selectedAction);
      tab.addEventListener('click', () => renderIpdQueryChecklist(templatesByAction, action));
      actionTabs.appendChild(tab);
    }
    queryChecklist.append(title, prompt, actionTabs);
    for (const [index, text] of templates.entries()) {
      const row = document.createElement('div');
      row.className = 'query-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const description = document.createElement('textarea');
      description.value = text;
      description.setAttribute('aria-label', `${IPD_ACTION_LABELS[selectedAction]} remark ${index + 1}`);
      description.addEventListener('change', () => {
        const value = description.value.trim();
        if (!value) return;
        templates[index] = value;
        saveIpdActionTemplates(templatesByAction);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'query-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        templates.splice(index, 1);
        saveIpdActionTemplates(templatesByAction);
        renderIpdQueryChecklist(templatesByAction, selectedAction);
      });
      row.append(input, description, remove);
      queryChecklist.appendChild(row);
    }
    const actionsRow = document.createElement('div');
    actionsRow.className = 'checklist-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add remark';
    add.addEventListener('click', () => {
      templates.push('');
      renderIpdQueryChecklist(templatesByAction, selectedAction);
    });
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.textContent = `Fill selected ${IPD_ACTION_LABELS[selectedAction]} remarks`;
    fill.addEventListener('click', () => {
      const remarks = [...queryChecklist.querySelectorAll('.query-option')]
        .filter(row => row.querySelector('input')?.checked)
        .map(row => row.querySelector('textarea')?.value.trim())
        .filter(Boolean);
      if (!remarks.length) {
        showStatus(`Select at least one ${IPD_ACTION_LABELS[selectedAction]} remark first.`, 'warning');
        return;
      }
      const result = actions.appendIpdActionRemarks?.(selectedAction, remarks);
      if (!result?.ok) {
        showStatus(`Select Action: ${IPD_ACTION_LABELS[selectedAction]} on the Main IPD page first, then try again.`, 'warning');
        return;
      }
      showStatus(`${result.addedCount} selected ${IPD_ACTION_LABELS[selectedAction]} remark${result.addedCount === 1 ? ' was' : 's were'} added.`, 'success');
    });
    actionsRow.append(add, fill);
    queryChecklist.appendChild(actionsRow);
    makeSectionCollapsible(queryChecklist, 'ipd-queries', 'IPD action remarks');
  }

  function openInvestigationCompanion() {
    try {
      chrome.runtime.sendMessage({
        action: 'openInvestigationCompanion',
        tid: actions.getCurrentTid?.(),
        items: (actions.getInvestigationChecklist?.() || []).map(item => ({
          index: item.index,
          label: item.label,
          expected: item.expected,
          writable: Boolean(item.writable)
        }))
      }, () => { void chrome.runtime.lastError; });
    } catch (_) {
      // The main claim and PDF remain usable if the extension context is reloading.
    }
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
        'autofill-disabled': 'BLOCKED: Claim Extension is OFF. Turn it on, then preview again.',
        'unsupported-layout': 'BLOCKED: The RGHS process-sheet layout is not compatible with this extension version.',
        'invalid-rule-set': 'BLOCKED: The bundled audit rules failed validation. Reload a verified extension build.',
        'invalid-processing-rule-set': 'BLOCKED: The published processing rules failed validation. Contact an administrator.',
        'processing-rules-unavailable': 'BLOCKED: The latest processing rules could not be verified. Try again when connected.',
        'processing-rule-blocked': 'BLOCKED: A centrally governed package rule prevents processing.',
        'processing-validation-required': 'BLOCKED: A centrally required validation must be completed.',
        'processing-rule-target-missing': 'BLOCKED: A configured target column is unavailable on this sheet.',
        'signed-out': 'BLOCKED: Sign in to Claim Spark to continue.',
        'licence-preview-blocked': 'BLOCKED: Your licence does not currently allow Preview. Contact your administrator.',
        'update-required': 'BLOCKED: Update Claim Spark before continuing.',
        maintenance: 'BLOCKED: Claim Spark is temporarily in maintenance mode.',
        'recovery-save-failed': 'BLOCKED: Changes were rolled back because recovery could not be saved.'
      };
      showStatus(messages[result.blockReason] || 'Preview was blocked by a compatibility check.', 'error');
      return;
    }
    selectedKeys = new Set(result.proposals.filter(proposal => proposal.risk !== 'high').map(proposal => proposal.key));
    approvedOverrides = {};
    remarkOverrides = {};
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
      checkbox.disabled = proposal.mandatory === true;
      checkbox.setAttribute('aria-label', `Select ${proposal.label}`);
      checkbox.addEventListener('change', () => {
        checkbox.checked ? selectedKeys.add(proposal.key) : selectedKeys.delete(proposal.key);
        updateReviewState();
        saveDecisionMemory();
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
      title.textContent = `${group.id}: ${group.proposals.length} related process-sheet row${group.proposals.length === 1 ? '' : 's'}`;
      const policyBadge = group.proposals.find(proposal => proposal.policyBadge)?.policyBadge;
      if (policyBadge) {
        const badge = document.createElement('div');
        badge.className = 'policy-badge';
        badge.textContent = policyBadge;
        title.appendChild(badge);
      }
      const lines = document.createElement('div');
      lines.className = 'decision-lines';
      lines.textContent = 'Review each linked row, then choose one decision for this group.';
      const items = document.createElement('div');
      items.className = 'decision-items';
      for (const [index, proposal] of group.proposals.entries()) {
        const item = document.createElement('div');
        item.className = 'decision-item';
        const itemIndex = document.createElement('div');
        itemIndex.className = 'decision-item-index';
        itemIndex.textContent = Number.isInteger(proposal.rowIndex) ? `Row ${proposal.rowIndex + 1}` : `Item ${index + 1}`;
        const detail = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'decision-item-label';
        label.textContent = proposal.packageText || proposal.label;
        const values = document.createElement('div');
        values.className = 'decision-item-values';
        const recommended = proposal.recommendedApproved;
        values.textContent = `Particular: ${proposal.label} · Claim: Rs. ${money.format(proposal.claimAmount)} · ${recommended === null || recommended === undefined ? 'Result: Hold for review' : `Recommended: Rs. ${money.format(recommended)}`}`;
        detail.append(label, values);
        if (proposal.decisionRole) {
          const role = document.createElement('div');
          role.className = 'decision-item-role';
          role.textContent = proposal.decisionRole === 'main' ? 'Main package' : proposal.decisionRole;
          detail.appendChild(role);
        }
        const controls = document.createElement('div');
        controls.className = 'decision-item-controls';
        const rowLabel = Number.isInteger(proposal.rowIndex) ? proposal.rowIndex + 1 : index + 1;
        const selectLabel = document.createElement('label');
        selectLabel.className = 'decision-item-select';
        const select = document.createElement('input');
        select.type = 'checkbox';
        select.checked = selectedKeys.has(proposal.key);
        select.disabled = proposal.mandatory === true;
        select.setAttribute('aria-label', `Select ${proposal.label} on row ${rowLabel}`);
        select.addEventListener('change', () => {
          select.checked ? selectedKeys.add(proposal.key) : selectedKeys.delete(proposal.key);
          if (group.proposals.some(item => selectedKeys.has(item.key))) exceptionalGroups.add(group.id);
          else exceptionalGroups.delete(group.id);
          updateReviewState();
          saveDecisionMemory();
        });
        selectLabel.append(select, document.createTextNode('Select'));
        const itemJump = document.createElement('button');
        itemJump.type = 'button';
        itemJump.className = 'jump';
        itemJump.textContent = 'Jump';
        itemJump.addEventListener('click', () => {
          const jumped = actions.jumpToRow(proposal.key);
          showStatus(jumped ? `Jumped to process-sheet row ${rowLabel}.` : 'The related portal row is unavailable. Preview the current sheet again.', jumped ? 'success' : 'warning');
        });
        controls.append(selectLabel, itemJump);
        detail.appendChild(controls);
        item.append(itemIndex, detail);
        items.appendChild(item);
      }
      const buttons = document.createElement('div');
      buttons.className = 'decision-buttons';
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'jump';
      jump.textContent = group.proposals.length === 1 ? 'Jump to row' : 'Jump to related rows';
      jump.addEventListener('click', () => {
        const count = actions.jumpToRows?.(group.proposals.map(proposal => proposal.key))
          || (actions.jumpToRow(group.proposals[0].key) ? 1 : 0);
        showStatus(count ? `Jumped to ${count} related highlighted row${count === 1 ? '' : 's'}.` : 'The related portal row is unavailable. Preview the current sheet again.', count ? 'success' : 'warning');
      });
      const modes = [];
      if (group.proposals.some(proposal => proposal.recommendedApproved !== null && proposal.recommendedApproved !== undefined)) {
        const hasPackageDeduction = group.proposals.some(proposal =>
          proposal.decisionRole === 'main' && proposal.recommendedApproved < proposal.claimAmount);
        const lamaDamaProposal = group.proposals.find(proposal =>
          proposal.ruleIds?.includes('RGHS-IPD-LAMA-DAMA-75'));
        modes.push([lamaDamaProposal ? `Apply LAMA/DAMA ${Core.LAMA_DAMA_SURGICAL_PERCENT}%` : hasPackageDeduction || group.id === 'CA-01' ? 'Apply package deduction' : 'Recommended', 'recommended']);
      }
      modes.push(['Approve ticked rows', 'approve-selected']);
      modes.push(['Approve both/all', 'approve-all']);
      if (group.proposals.some(proposal => ['main', 'primary'].includes(proposal.decisionRole))) {
        modes.push(['Approve main only', 'main-only']);
      }
      modes.push(['Hold', 'hold']);
      let recommendedButton = null;
      for (const [label, mode] of modes) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
          const individuallySelectedKeys = group.proposals
            .filter(proposal => selectedKeys.has(proposal.key))
            .map(proposal => proposal.key);
          for (const proposal of group.proposals) {
            selectedKeys.delete(proposal.key);
            delete approvedOverrides[proposal.key];
            delete remarkOverrides[proposal.key];
          }
          exceptionalGroups.delete(group.id);
          const decision = Review.decisionForGroup(group, mode, individuallySelectedKeys);
          if (decision.invalidReason) {
            showStatus(decision.invalidReason === 'no-individual-selection'
              ? 'Select at least one individual row before approving ticked rows.'
              : 'BLOCKED: This recommendation conflicts with its configured deduction method or limit.', 'error');
            updateReviewState();
            return;
          }
          for (const key of decision.selectedKeys) selectedKeys.add(key);
          Object.assign(approvedOverrides, decision.approvedOverrides);
          for (const [key, disposition] of Object.entries(decision.remarkDispositions || {})) {
            const proposal = group.proposals.find(item => item.key === key);
            remarkOverrides[key] = proposal?.decisionRemarks?.[disposition] || '';
          }
          if (decision.acknowledgementRequired) exceptionalGroups.add(group.id);
          actions.highlightDecisionRows(approvedOverrides);
          for (const sibling of buttons.querySelectorAll('button')) sibling.classList.remove('selected');
          button.classList.add('selected');
          updateReviewState();
          saveDecisionMemory();
        });
        if (mode === 'recommended') recommendedButton = button;
        buttons.appendChild(button);
      }
      card.append(title, lines, items, jump, buttons);
      reviewList.appendChild(card);
      if (['CA-01', 'RGHS-IPD-INCOMPLETE-FINAL-DAY'].includes(group.id) && recommendedButton) {
        recommendedButton.click();
      }
    }
    ackCheck.checked = false;
    undoButton.disabled = !result.hasUndo;
    updateReviewState();
    const warningCount = result.processingWarnings?.length || 0;
    showStatus(result.proposals.length
      ? `${safeProposals.length} safe row(s); ${Review.groupProposals(result.proposals).length} decision group(s); ${warningCount} central warning(s).`
      : warningCount ? `${warningCount} centrally configured warning(s) require attention.` : 'No eligible changes found.',
    result.proposals.length || warningCount ? 'success' : '');
  }

  function removeVerifiedInvestigationsFromPreview(detail) {
    if (!currentPreview) return;
    const rowIndexes = new Set((detail?.rowIndexes || []).map(Number));
    if (!rowIndexes.size) return;
    const remaining = currentPreview.proposals.filter(proposal => !rowIndexes.has(Number(proposal.rowIndex)));
    if (remaining.length === currentPreview.proposals.length) return;
    const retainedKeys = new Set([...selectedKeys].filter(key => remaining.some(proposal => proposal.key === key)));
    renderPreview({ ...currentPreview, proposals: remaining });
    selectedKeys = retainedKeys;
    updateReviewState();
    restoreDecisionMemory();
    showStatus(`${rowIndexes.size} verified investigation row(s) were removed from this preview.`, 'success');
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
  layoutResetButton.addEventListener('click', resetWidgetLayout);
  smallerTextButton.addEventListener('click', () => setPanelScale(panelScale - PANEL_SCALE_STEP));
  largerTextButton.addEventListener('click', () => setPanelScale(panelScale + PANEL_SCALE_STEP));
  panel.addEventListener('wheel', event => {
    // Keep ordinary wheel scrolling for long investigation lists. Ctrl/Command +
    // wheel is reserved for whole-widget zoom and never changes portal zoom.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const nextScale = panelScale + (event.deltaY < 0 ? PANEL_SCALE_STEP : -PANEL_SCALE_STEP);
    if (nextScale === panelScale) return;
    setPanelScale(nextScale);
    showStatus(`Widget size: ${Math.round(panelScale * 100)}%. Ctrl + mouse wheel changes the entire widget.`, 'success');
  }, { passive: false });
  narrowerPanelButton.addEventListener('click', () => {
    setPanelWidth(getPanelCssWidth() - PANEL_WIDTH_STEP);
  });
  widerPanelButton.addEventListener('click', () => {
    setPanelWidth(getPanelCssWidth() + PANEL_WIDTH_STEP);
  });
  resizeHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: getPanelCssWidth(),
      displayScale: panelScale,
      direction: panel.classList.contains('open-right') ? 1 : -1
    };
    resizeHandle.setPointerCapture(event.pointerId);
  });
  resizeHandle.addEventListener('pointermove', event => {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return;
    setPanelWidth(resizeState.startWidth + (event.clientX - resizeState.startX) * resizeState.direction / resizeState.displayScale, { persist: false });
  });
  function finishResize(event) {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return;
    if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
    const width = getPanelCssWidth();
    resizeState = null;
    setPanelWidth(width);
  }
  resizeHandle.addEventListener('pointerup', finishResize);
  resizeHandle.addEventListener('pointercancel', finishResize);

  previewButton.addEventListener('click', async () => {
    if (!hasValidExtensionContext()) return invalidateStaleWidget();
    try {
      renderPreview(await (actions.previewFresh ? actions.previewFresh() : actions.preview()));
      setSectionCollapsed(ipdContext, 'ipd-context', true);
      setSectionCollapsed(cardHistory, 'card-history', true);
      requestAnimationFrame(() => reviewList.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } catch (_) {
      if (!hasValidExtensionContext()) return invalidateStaleWidget();
      showStatus('Unable to prepare this sheet for preview. Refresh the RGHS page and try again.', 'error');
    }
  });
  pendingButton.addEventListener('click', () => {
    pendingOnly = !pendingOnly;
    panel.classList.toggle('pending-only', pendingOnly);
    pendingButton.textContent = pendingOnly ? 'Show All Work' : 'Only Pending Work';
    showStatus(pendingOnly ? 'Showing unresolved and high-risk work only.' : 'Showing all current work.', 'success');
  });
  investigationButton.addEventListener('click', () => {
    if (!hasValidExtensionContext()) return invalidateStaleWidget();
    if (location.pathname.startsWith('/RGHS/processSheetSearch/')) {
      openInvestigationCompanion();
      showStatus('Opening the process-sheet investigation checklist…');
      return;
    }
    renderInvestigationChecklist();
    revealInvestigationChecklist();
  });
  documentsButton.addEventListener('click', () => {
    if (!hasValidExtensionContext()) return invalidateStaleWidget();
    if (!/^\/RGHS\/tpaClaim(?:Discharge|Settle)/i.test(location.pathname)) {
      showStatus('Review documents can be opened only from the Main IPD claim page.', 'warning');
      return;
    }
    const documents = actions.getReviewDocuments?.() || [];
    if (!documents.length) {
      showStatus('No Mandatory or Non-Mandatory Claim Document links were found. Expand those portal sections and try again.', 'warning');
      return;
    }
    chrome.runtime.sendMessage({ action: 'openReviewDocuments', documents }, response => {
      if (chrome.runtime.lastError || !response?.success) {
        showStatus('Unable to open the selected portal documents.', 'error');
        return;
      }
      showStatus(`Opened ${response.count} Mandatory/Non-Mandatory Claim Document${response.count === 1 ? '' : 's'} in background tabs.`, 'success');
    });
  });
  queryButton.addEventListener('click', () => {
    if (!/^\/RGHS\/tpaClaim(?:Discharge|Settle)/i.test(location.pathname)) {
      showStatus('IPD queries are available only on the Main IPD claim page.', 'warning');
      return;
    }
    loadIpdQueryChecklist();
  });
  compatibilityButton.addEventListener('click', () => {
    const details = actions.getPortalCompatibilityDetails?.();
    if (!details) return showStatus('Compatibility details are unavailable on this page.', 'warning');
    showStatus(`${details.message} Tables found: ${details.tableCount}; mapped tables: ${details.compatibleTables}.`,
      details.compatible ? 'success' : 'warning');
  });
  ackCheck.addEventListener('change', updateReviewState);
  async function applySelection(keys, overrides, remarks, acknowledgedHighRisk) {
    if (!currentPreview) {
      showStatus('Preview the current sheet before applying changes.', 'warning');
      return;
    }
    if (!keys.length) {
      showStatus('Select at least one proposed row before applying changes.', 'warning');
      return;
    }
    let result;
    if (!hasValidExtensionContext()) return invalidateStaleWidget();
    try {
      const applyAction = actions.applyFresh || actions.apply;
      result = await applyAction({
        token: currentPreview.token,
        selectedRowKeys: keys,
        approvedOverrides: overrides,
        remarkOverrides: remarks,
        acknowledgedHighRisk
      });
    } catch {
      if (!hasValidExtensionContext()) return invalidateStaleWidget();
      showStatus('Unable to verify the latest processing rules.', 'error');
      return;
    }
    if (result.blocked) {
      const messages = {
        'autofill-disabled': 'BLOCKED: Claim Extension is OFF. Turn it on, then preview again.',
        stale: 'BLOCKED: The process sheet changed after Preview. Preview again.',
        expired: 'BLOCKED: Preview expired. Preview again.',
        'empty-selection': 'BLOCKED: Select at least one row.',
        'high-risk-unacknowledged': 'BLOCKED: Acknowledge selected high-risk findings.',
        'invalid-decision': 'BLOCKED: Preview again; the selected decision is no longer valid.',
        'mandatory-action-required': 'BLOCKED: All centrally mandatory actions must remain selected.',
        'mandatory-action-override': 'BLOCKED: Centrally mandatory amounts and remarks cannot be overridden.',
        'processing-rules-changed': 'BLOCKED: Processing rules changed after Preview. Preview again.',
        'processing-rules-unavailable': 'BLOCKED: The latest processing rules could not be verified.',
        unbalanced: 'BLOCKED: Selected totals do not reconcile.',
        'signed-out': 'BLOCKED: Sign in to Claim Spark to apply changes.',
        'licence-unverified': 'BLOCKED: Verify your email to continue - check your inbox for a link from Firebase.',
        'licence-apply-blocked': 'BLOCKED: Your licence does not currently allow Apply. Preview remains available if allowed.',
        'update-required': 'BLOCKED: Update Claim Spark before continuing.',
        maintenance: 'BLOCKED: Claim Spark is temporarily in maintenance mode.'
      };
      showStatus(messages[result.blockReason] || 'Apply was blocked for safety.', 'error');
      applyButton.disabled = true;
      return;
    }
    currentPreview = null;
    const memoryKey = decisionMemoryKey();
    if (memoryKey) withValidExtensionContext(() => chrome.storage.session.remove(memoryKey));
    selectedKeys.clear();
    approvedOverrides = {};
    remarkOverrides = {};
    exceptionalGroups.clear();
    reviewList.textContent = '';
    reviewList.hidden = true;
    summary.hidden = true;
    ack.hidden = true;
    applyButton.disabled = true;
    applyButton.textContent = 'Apply Selected';
    undoButton.disabled = !result.hasUndo;
    recoverButton.disabled = false;
    showStatus(`Applied ${result.count} field action(s). Recovery was saved locally.`, 'success');
  }

  safeButton.addEventListener('click', () => {
    if (!currentPreview) {
      showStatus('Preview the current sheet before applying safe rows.', 'warning');
      return;
    }
    const safeKeys = currentPreview.proposals
      .filter(proposal => proposal.risk !== 'high')
      .map(proposal => proposal.key);
    applySelection(safeKeys, {}, {}, false);
  });
  applyButton.addEventListener('click', () => {
    applySelection(
      [...selectedKeys],
      approvedOverrides,
      remarkOverrides,
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
  refreshWidgetZoomCompensation();
  renderIpdContext(actions.getIpdContext?.());
  renderCardHistory(actions.getCardHistory?.());
  window.addEventListener('claim-autofill:ipd-context', event => renderIpdContext(event.detail));
  window.addEventListener('claim-autofill:card-history', event => renderCardHistory(event.detail));
  window.addEventListener('claim-autofill:investigations-verified', event => {
    investigationChecklist.dataset.verified = 'true';
    removeVerifiedInvestigationsFromPreview(event.detail);
  });
  window.addEventListener('claim-autofill:enabled-change', event => setEnabled(event.detail?.enabled === true));
  withValidExtensionContext(() => chrome.storage.local.get(['claimSparkPosition', 'claimSparkPanelScale', 'claimSparkPanelWidth'], localResult => {
    if (!hasValidExtensionContext()) {
      invalidateStaleWidget();
      return;
    }
    const saved = localResult.claimSparkPosition;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPosition(saved.x, saved.y);
    if (Number.isFinite(localResult.claimSparkPanelScale)) {
      setPanelScale(localResult.claimSparkPanelScale, { persist: false });
    } else {
      setPanelScale(1, { persist: false });
    }
    if (Number.isFinite(localResult.claimSparkPanelWidth)) {
      setPanelWidth(localResult.claimSparkPanelWidth, { persist: false });
    }
    withValidExtensionContext(() => chrome.storage.sync.get(['autoFillEnabled'], result => {
      if (!hasValidExtensionContext()) {
        invalidateStaleWidget();
        return;
      }
      setEnabled(result.autoFillEnabled !== false);
    }));
  }));
  window.addEventListener('resize', () => {
    refreshWidgetZoomCompensation();
    const panelWidth = Number.parseFloat(panel.style.width);
    if (Number.isFinite(panelWidth)) setPanelWidth(panelWidth, { persist: false });
    if (!host.style.left) return;
    const rect = host.getBoundingClientRect();
    const position = setPosition(rect.left, rect.top);
    withValidExtensionContext(() => chrome.storage.local.set({
      claimSparkPosition:{ x:Math.round(position.x),y:Math.round(position.y) }
    }));
  });
})();
