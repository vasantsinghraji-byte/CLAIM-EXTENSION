## What

<!-- One or two sentences: what does this PR change and why. -->

## Type

<!-- Check one - keep PRs single-purpose. Split mixed changes into separate PRs. -->

- [ ] feat - new behavior
- [ ] fix - bug fix
- [ ] refactor - no behavior change
- [ ] chore / build / ci / docs / test

## Claims-safety checklist

- [ ] `npm run check` and `npm run lint` pass locally
- [ ] No rule gains `autoDeductEligible: true` without shadow-mode evidence (FP stats from the options page)
- [ ] `audit-rules.js` was regenerated (not hand-edited) if `tools/rule-curation.json` or the workbook changed
- [ ] Changes that touch amount-writing paths were exercised on `test-page.html` (and the live smoke test where applicable)
- [ ] No patient-identifying data in code, fixtures, logs, or commit messages

## Notes for the reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, areas needing careful review. -->
