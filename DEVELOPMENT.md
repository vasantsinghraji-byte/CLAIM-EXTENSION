# Development Guide

## Local Firebase configuration

Tracked source contains no Firebase API key values. Copy
`firebase-build-config.example.json` to `.firebase-build-config.json`, then
obtain the development and production Web App values from the corresponding
Firebase project. The local file is ignored by Git.

`npm run build` generates `runtime-config.js` for unpacked development use,
`dist/runtime-config.js` for the production extension package, and
`hosting-build/firebase-client.js` for Firebase Hosting.

Never add the generated configuration files to Git. `npm run check` scans all
tracked files and fails on Google API key patterns.

## Source layout

Editable extension files live at the repository root. Generated files live in `dist/` and `claim-autofill-extension.zip`; do not edit generated copies.

- `claim-core.js`: pure calculation, matching, row-planning, and debounce helpers
- `review-core.js`: deterministic preview fingerprints, reconciliation, expiry, and high-risk Apply gates
- `custom-rules.js`: validation, schema normalization, templates, and safe runtime merging for profile-local rules
- `content.js`: RGHS DOM integration, dynamic-row observation, and undo state
- `popup.html`, `popup.css`, `popup.js`: preview/apply/undo interface
- `floating-widget.js`: Shadow DOM on-page mascot controls, isolated from RGHS styles

Claim Spark supports the verified `/RGHS/processSheetSearch/` and
`/RGHS/tpaOPD*` workflows. It starts hidden until the stored claim-tools
setting is read, then follows enabled-state events from the content script.

Production process-sheet routes fail closed when the expected claim table headers or stable approved controls cannot be mapped. Audit rule data is schema-validated before claim processing. Submission acknowledgement only arms the next user-initiated portal Submit; extension code never submits the form.
Its drag position is clamped to the viewport and stored in `chrome.storage.local` as `claimSparkPosition`. The action panel flips below or right when the mascot is near an edge.

## Manual-commit safety contract

Page load, route updates, DOM mutations, and enabling the extension must never call `fillAllApprovedAmounts()`. Only the explicit `preview` action may calculate proposed changes, and only the explicit `fillNow` / Claim Spark Apply action may write them. Every manual preview scans the current DOM, so dynamically loaded rows remain supported without automatic mutation.

Preview tokens are deterministic fingerprints of row keys, current/proposed values, remarks, risks, and reasons. Apply recomputes the preview against the live DOM and blocks stale, expired, empty, unbalanced, or unacknowledged high-risk selections. Recovery snapshots contain only control IDs, before/after values, TID/URL context, timestamp, and extension version; they expire after 24 hours and are capped at 20 entries.

Custom findings are stored under `customRuleConfig` in `chrome.storage.local`.
They may extend only the unbundling and upcoding-review families, are validated
before persistence, and merge as review-only rules. Never add a path that lets
an imported custom rule set `autoDeductEligible`.
Per-built-in-rule remark overrides live in the same object under
`builtInRemarkOverrides`; they alter only presentation and never rule matching,
eligibility, deduction calculations, or the generated `audit-rules.js` source.

`tests/fixtures/rghs-process-sheet.html` mirrors the live RGHS hidden-leading/trailing-cell structure. Its integration test covers mapping, normal and medicine proposals, selective reconciliation, Apply validation, and stale-preview detection without requiring a network session.
- `manifest.json`: permissions and official RGHS origin scope
- `tests/`: dependency-free Node.js regression tests
- `test-page.html`: manual browser fixture

## Workflow

1. Edit the root source files.
2. Run `npm run check`.
3. Run `npm run lint`, `npm run test:functions`, and `npm run test:firebase`
   before a release.
4. Run `npm run build`.
5. Load or reload `dist/` at `chrome://extensions/`.
6. Refresh the RGHS claim page or local `test-page.html` fixture.

The build fails when a required production file is missing. It produces a deterministic `claim-autofill-extension.zip` without another dependency.

## Tests

`npm test` covers normal claims, medicine deduction and whole-rupee rounding, existing approvals, existing remarks, malformed amounts, Indian currency formatting, and debounced dynamic-row processing.

The RGHS process sheet has hidden leading and trailing data cells that do not align one-for-one with its visible headers. Row mapping therefore anchors to `name="packageFinalAmounts"` / `id="packageFinalAmount_*"` and `id="packageremarks_*"`, with generic header mapping retained for other supported tables.

For a release, also verify in a clean RGHS session that controlled inputs accept the `input` and `change` events, preview counts match visible fields, undo restores them, and dynamically inserted rows are filled once.

## Security scope

The extension runs on `https://rghs.rajasthan.gov.in/*`. Local development is limited to `http://localhost/*` and `http://127.0.0.1/*`; serve `test-page.html` from either host. `all_frames` is intentionally omitted because the repository contains no evidence that the claim form is inside a cross-frame document. Add it only after verifying that requirement on the live portal.
