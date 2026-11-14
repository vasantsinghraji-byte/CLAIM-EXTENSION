# Development Guide

The administrator control tower lives at `/admin` on the production Hosting
site. Access, monitoring semantics, tests and the scoped deployment sequence are
documented in [administrator control tower](docs/ADMIN_CONTROL_TOWER.md).

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
- `content.js`: claim portal DOM integration, dynamic-row observation, and undo state
- `popup.html`, `popup.css`, `popup.js`: preview/apply/undo interface
- `floating-widget.js`: Shadow DOM on-page mascot controls, isolated from claim portal styles

Claim Spark supports the verified `/RGHS/processSheetSearch/`,
`/RGHS/tpaOPD*`, and `/RGHS/tpaPharmacy*` workflows. It starts hidden until the stored claim-tools
setting is read, then follows enabled-state events from the content script.

Production process-sheet routes fail closed when the expected claim table headers or stable approved controls cannot be mapped. Audit rule data is schema-validated before claim processing. Portal submission controls are not intercepted or modified by the extension.
Its drag position is clamped to the viewport and stored in `chrome.storage.local` as `claimSparkPosition`. The action panel flips below or right when the mascot is near an edge.

## Manual-commit safety contract

Page load, route updates, DOM mutations, and enabling the extension must never call `fillAllApprovedAmounts()`. Only the explicit `preview` action may calculate proposed changes, and only the explicit `fillNow` / Claim Spark Apply action may write them. Every manual preview scans the current DOM, so dynamically loaded rows remain supported without automatic mutation.

Preview tokens are deterministic fingerprints of row keys, current/proposed values, remarks, risks, and reasons. Apply recomputes the preview against the live DOM and blocks stale, expired, empty, unbalanced, or unacknowledged high-risk selections. Recovery snapshots contain only control IDs, before/after values, TID/URL context, timestamp, and extension version; they expire after 24 hours and are capped at 20 entries.

General previews also bind the exact page URL and current claim identifier.
Apply checks the original control identities and captured values, including
secondary remark columns; switching claims or replacing controls requires a new
preview. Supported claim pages require an identifiable claim before Apply.
Central money parsing, deduction corrections and server/browser parity checks
are described in [claim Apply safety fixes](docs/CLAIM_APPLY_SAFETY_FIXES.md).

Undo batches and saved snapshots require the originating claim ID and exact page
URL. Missing IDs on shared portal routes block recovery. Partial restoration
retains unresolved fields and reports conflicts/unavailable controls. IPD action
remarks use the same recovery and Undo path as amount changes.

Authentication state writes share a serialized queue and an operation generation;
responses from before sign-out, cancellation or an account change cannot restore
credentials, entitlement or rule caches. Simultaneous rule checks are coalesced,
with every subsequent Apply still requesting fresh authority.

Review decisions use a service-worker broker for `chrome.storage.session`; content
scripts never access that storage area directly. Saved reviews are scoped by
user, claim and exact page, limited to 30 reviews/24 hours and cleared on sign-out.
Resuming requires identical proposal and rule identities and resets high-risk
acknowledgement. Safe-row Apply automatically previews remaining work and carries
only unchanged decisions. Compare mode displays amount differences locally and
does not allow central rules to write portal fields.

Run `npm run test:extension` for acceptance with the actual unpacked extension,
real Chrome APIs and an isolated service worker/profile. It uses only a synthetic
loopback backend and fixtures, checks worker restart, multi-tab isolation, review
resumption, safe-row continuation, offline recovery and sign-out races, and never
connects to real claim or Firebase accounts. Chrome must support the DevTools
`Extensions.loadUnpacked` command; set `CHROME_PATH` when needed.

Custom findings are stored under `customRuleConfig` in `chrome.storage.local`.
They may extend only the unbundling and upcoding-review families, are validated
before persistence, and merge as review-only rules. Never add a path that lets
an imported custom rule set `autoDeductEligible`.
Per-built-in-rule remark overrides live in the same object under
`builtInRemarkOverrides`; they alter only presentation and never rule matching,
eligibility, deduction calculations, or the generated `audit-rules.js` source.

`tests/fixtures/rghs-process-sheet.html` mirrors the live claim portal hidden-leading/trailing-cell structure. Its integration test covers mapping, normal and medicine proposals, selective reconciliation, Apply validation, and stale-preview detection without requiring a network session.
- `manifest.json`: permissions and official claim portal origin scope
- `tests/`: dependency-free Node.js regression tests
- `test-page.html`: manual browser fixture

## Workflow

1. Edit the root source files.
2. Run `npm run check`.
3. Run `npm run lint`, `npm run test:functions`, `npm run test:browser`,
   `npm run test:extension`, `npm run test:dashboard`, `npm run test:firebase`,
   and `npm run test:lifecycle` before a release. Match the hosted CI gates.
4. Run `npm run build`.
5. Load or reload `dist/` at `chrome://extensions/`.
6. Refresh the claim page or local `test-page.html` fixture.

The build fails when a required production file is missing. It produces a deterministic `claim-autofill-extension.zip` without another dependency.

For a new version, `npm run release -- patch|minor|major` requires a clean
worktree, prepares the candidate version/changelog, then runs all eight checks
above against that candidate before building and verifying the ZIP. A failed
check stops packaging and restores the original manifest, package, lockfile,
changelog and release metadata. The release-flow tests use isolated temporary
files and simulated commands to verify gate failures and rollback; CI also
executes the actual browser and emulator suites. This command does not deploy
services or publish to the Store.

Release 1.12.1 preparation, artifact verification and rollout checkpoints are
documented in [the release review](docs/RELEASE_1.12.1_REVIEW.md). Existing
uncommitted work is accounted for in [the reconciliation record](docs/WORKTREE_RECONCILIATION.md).
Use a dedicated worktree from current main and retain the original recovery
snapshot until reconciliation and review are complete. Release packaging does
not deploy Firebase services or publish the extension.

## Tests

`npm test` covers normal claims, medicine deduction and whole-rupee rounding, existing approvals, existing remarks, malformed amounts, Indian currency formatting, and debounced dynamic-row processing.

The currently supported process sheets have hidden leading and trailing data cells that do not align one-for-one with their visible headers. Hospital row mapping therefore anchors to `name="packageFinalAmounts"` / `id="packageFinalAmount_*"` and `id="packageremarks_*"`. Pharmacy row mapping anchors to `name="tpaapprovedAmount"` / `id="tpaapprovedAmount_*"` and `id="itemremarks_*"`. Generic header mapping remains available for other supported tables.

Pharmacy approvals use the lower of Claim Total and P25 multiplied by Quantity. When the P25 multiplied by Quantity cap is lower, the item remark records `Approved As per prevailing market price.` A lower Claim Total is approved without that market-price remark. Existing Pharmacy approvals are recalculated because the portal initially pre-populates them from the claim total; hospital approvals retain their existing preserve-nonzero behavior.

Pharmacy validation highlights only the drug-name prefix through `TAB` when a `Tab 1×1` instruction is present; non-tablet dosage forms are excluded. Patient names are compared locally between the active Patient Data row and the same-origin invoice HTML. Case, punctuation, accents, and repeated whitespace are normalized. Mismatches highlight both name locations and the invoice View link; patient names are never persisted or logged.

For a release, also verify in a clean claim portal session that controlled inputs accept the `input` and `change` events, preview counts match visible fields, undo restores them, and dynamically inserted rows are filled once.

## Security scope

The extension runs on `https://rghs.rajasthan.gov.in/*`. Local development is limited to `http://localhost/*` and `http://127.0.0.1/*`; serve `test-page.html` from either host. `all_frames` is intentionally omitted because the repository contains no evidence that the claim form is inside a cross-frame document. Add it only after verifying that requirement on the live portal.
