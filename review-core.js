(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaimReviewCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RISK_ORDER = { low: 0, medium: 1, high: 2 };

  function normalizeProposal(proposal) {
    return {
      key: String(proposal.key),
      claimAmount: Number(proposal.claimAmount) || 0,
      beforeApproved: Number(proposal.beforeApproved) || 0,
      proposedApproved: proposal.proposedApproved === null ? null : Number(proposal.proposedApproved),
      beforeRemarks: String(proposal.beforeRemarks || ''),
      proposedRemarks: proposal.proposedRemarks === null ? null : String(proposal.proposedRemarks),
      risk: RISK_ORDER[proposal.risk] === undefined ? 'high' : proposal.risk,
      reason: String(proposal.reason || '')
    };
  }

  function fingerprint(proposals) {
    const input = proposals.map(normalizeProposal).sort((a, b) => a.key.localeCompare(b.key));
    const text = JSON.stringify(input);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function reconcile(proposals, selectedKeys) {
    const selected = selectedKeys ? new Set(selectedKeys) : null;
    const rows = proposals.filter(proposal => !selected || selected.has(proposal.key));
    const totals = rows.reduce((result, proposal) => {
      const before = Number(proposal.beforeApproved) || 0;
      const proposed = proposal.proposedApproved === null ? before : Number(proposal.proposedApproved) || 0;
      result.claimTotal += Number(proposal.claimAmount) || 0;
      result.beforeApprovedTotal += before;
      result.proposedApprovedTotal += proposed;
      result.deductionTotal += Math.max(0, (Number(proposal.claimAmount) || 0) - proposed);
      result.highRiskCount += proposal.risk === 'high' ? 1 : 0;
      result.mediumRiskCount += proposal.risk === 'medium' ? 1 : 0;
      return result;
    }, {
      rowCount: rows.length,
      claimTotal: 0,
      beforeApprovedTotal: 0,
      proposedApprovedTotal: 0,
      deductionTotal: 0,
      highRiskCount: 0,
      mediumRiskCount: 0
    });
    totals.balanced = Math.abs(totals.claimTotal - totals.proposedApprovedTotal - totals.deductionTotal) < 0.005;
    return totals;
  }

  function validateApply({ previewToken, currentToken, createdAt, now = Date.now(), maxAgeMs = 10 * 60 * 1000, selectedProposals, acknowledgedHighRisk }) {
    if (!previewToken || previewToken !== currentToken) return { ok: false, reason: 'stale' };
    if (!createdAt || now - createdAt > maxAgeMs) return { ok: false, reason: 'expired' };
    if (!selectedProposals.length) return { ok: false, reason: 'empty-selection' };
    if (selectedProposals.some(proposal => proposal.risk === 'high') && !acknowledgedHighRisk) {
      return { ok: false, reason: 'high-risk-unacknowledged' };
    }
    const totals = reconcile(selectedProposals);
    if (!totals.balanced) return { ok: false, reason: 'unbalanced', totals };
    return { ok: true, totals };
  }

  function groupProposals(proposals) {
    const groups = new Map();
    for (const proposal of proposals.filter(item => item.risk === 'high')) {
      const id = String(proposal.groupId || (proposal.ruleIds || [])[0] || proposal.key);
      if (!groups.has(id)) groups.set(id, { id, proposals: [] });
      groups.get(id).proposals.push(proposal);
    }
    return [...groups.values()];
  }

  function decisionForGroup(group, mode) {
    const proposals = group?.proposals || [];
    if (mode === 'hold') return { selectedKeys: [], approvedOverrides: {}, acknowledgementRequired: false };
    const approvedOverrides = {};
    let selected = proposals;
    if (mode === 'recommended') {
      selected = proposals.filter(proposal => proposal.recommendedApproved !== null && proposal.recommendedApproved !== undefined);
      for (const proposal of selected) approvedOverrides[proposal.key] = Number(proposal.recommendedApproved);
    } else if (mode === 'approve-all') {
      for (const proposal of proposals) approvedOverrides[proposal.key] = Number(proposal.claimAmount) || 0;
    } else if (mode === 'main-only') {
      for (const proposal of proposals) {
        approvedOverrides[proposal.key] = ['main', 'primary'].includes(proposal.decisionRole)
          ? Number(proposal.claimAmount) || 0
          : 0;
      }
    } else {
      return { selectedKeys: [], approvedOverrides: {}, acknowledgementRequired: false };
    }
    return {
      selectedKeys: selected.map(proposal => proposal.key),
      approvedOverrides,
      acknowledgementRequired: mode === 'approve-all'
    };
  }

  return { RISK_ORDER, fingerprint, reconcile, validateApply, groupProposals, decisionForGroup };
});
