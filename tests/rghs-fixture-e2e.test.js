const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../claim-core');
const Review = require('../review-core');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'rghs-process-sheet.html'), 'utf8');

function text(cell) {
  const inputValue = cell.match(/<(?:input)[^>]*value="([^"]*)"/i)?.[1];
  if (inputValue !== undefined) return inputValue;
  return cell.replace(/<[^>]+>/g, '').trim();
}

function parseFixture(source) {
  const header = [...source.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(match => text(match[1]));
  const rows = [...source.matchAll(/<tr data-case="([^"]+)">([\s\S]*?)<\/tr>/gi)].map(match => ({
    caseName: match[1],
    cells: [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
  }));
  return { header, rows };
}

test('RGHS-shaped hidden-cell fixture previews, reconciles, applies selectively, and detects staleness', () => {
  const fixture = parseFixture(html);
  assert.equal(fixture.header.length, 9);
  assert.equal(fixture.rows[0].cells.length, 10);

  const proposals = fixture.rows.flatMap((row, rowIndex) => {
    const approvedControlIdx = row.cells.findIndex(cell => /name="packageFinalAmounts"/.test(cell));
    const remarksControlIdx = row.cells.findIndex(cell => /id="packageremarks_/.test(cell));
    const indices = Core.resolveRowColumnIndices({
      cellCount: row.cells.length,
      headerCellCount: fixture.header.length,
      particularIdx: 0,
      claimIdx: 4,
      approvedIdx: 5,
      remarksIdx: 7,
      approvedControlIdx,
      remarksControlIdx
    });
    const claimValue = text(row.cells[indices.claimIdx]);
    const approvedValue = text(row.cells[indices.approvedIdx]);
    const particularText = text(row.cells[indices.particularIdx]);
    const remarksValue = text(row.cells[indices.remarksIdx]);
    const plan = Core.planRowUpdate({ claimValue, approvedValue, particularText, remarksValue });
    if (plan.approvedValue === null && plan.remarksValue === null) return [];
    return [{
      key: `row-${rowIndex}`,
      claimAmount: Core.parseAmount(claimValue),
      beforeApproved: Core.parseAmount(approvedValue) || 0,
      proposedApproved: plan.approvedValue === null ? null : Core.parseAmount(plan.approvedValue),
      beforeRemarks: remarksValue,
      proposedRemarks: plan.remarksValue,
      risk: plan.reason === 'medicine' ? 'medium' : 'low',
      reason: plan.reason
    }];
  });

  assert.equal(proposals.length, 2);
  const token = Review.fingerprint(proposals);
  const totals = Review.reconcile(proposals);
  assert.equal(totals.claimTotal, 2000);
  assert.equal(totals.proposedApprovedTotal, 1880);
  assert.equal(totals.deductionTotal, 120);
  assert.equal(totals.balanced, true);
  assert.equal(Review.validateApply({ previewToken: token, currentToken: token, createdAt: 1000, now: 2000, selectedProposals: proposals, acknowledgedHighRisk: false }).ok, true);

  const changed = proposals.map(proposal => proposal.key === 'row-0' ? { ...proposal, beforeApproved: 1 } : proposal);
  assert.equal(Review.validateApply({ previewToken: token, currentToken: Review.fingerprint(changed), createdAt: 1000, now: 2000, selectedProposals: changed, acknowledgedHighRisk: false }).reason, 'stale');
});
