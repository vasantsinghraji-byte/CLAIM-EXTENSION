# Final worktree reconciliation

Reviewed November 11, 2026 against main after PR #50 (`d03a0c2`).
The release branch is `release/1.12.1`; the original checkout remains on
`fix/claim-apply-safety` at `b03685d18894ed9feec1d24da2ef29e40b643956`.
Its index, tracked working files and nonignored untracked files are preserved.

PRs #42–#50 extracted the application and workflow changes into reviewed branches.
This release preparation accounts for all **62 original changed/untracked files**:
21 match merged main after CRLF normalization, 26 retain the reviewed main version,
10 are reconciled into release documentation/metadata, and 5 remain archived
historical QA material. No remaining runtime change requires another feature PR.

## Recovery evidence

The fresh local snapshot is
`artifacts/repository-snapshots/2026-11-11T12-36-59-585Z-cbasXh` in the original
checkout. It contains staged/unstaged binary patches, every nonignored untracked
file and its SHA-256, the original branch/base and a completed manifest.
Snapshot contents are ignored and never enter a package. Follow CONTRIBUTING.md
to recover them in a new worktree; do not apply the old aggregate patch to main.
The original local `artifacts/verify-auth-extraction-source.cjs` can compare the
checkout against this snapshot, using its directory basename as the argument.

The comparison inventory is retained locally at
`artifacts/release-reconciliation-inventory.json`, with individual source/main
diffs in `artifacts/release-reconciliation-diffs/`. These are review evidence,
not shipped assets. The tracked tables below account for every inventory path.

## Original files already merged unchanged (21)

| Paths | Merged scope |
| --- | --- |
| `claim-core.js`, `processing-rules.js`, `functions/lib/processing-rules.js`, `functions/test/processing-rules.test.js`, `functions/test/fixtures/processing-money-cases.json` | #44 calculations/parity and #49 count parser |
| `functions/index.js`, `scripts/run-lifecycle-emulators.js` | #46 signup/licence and #47 monitoring/lifecycle integration |
| `hosting/admin.css`, `hosting/admin.html`, `hosting/admin.js`, `popup.css`, `popup.html` | #46 activation controls and #47 administrator UI |
| `investigation-companion.html`, `tests/extension-context.test.js`, `tests/manual-commit-safety.test.js`, `tests/onboarding-approval-e2e.test.js`, `tests/processing-rules.test.js`, `tests/safety-interlocks.test.js` | Merged calculation, auth, count and safety contracts |
| `tests/ipd-remark-recovery.test.js`, `tests/recovery-safety.test.js`, `tests/review-core.test.js` | #45 recovery and review safeguards |

## Retain reviewed main versions (26)

The original aggregate WIP predates safeguards added during extraction. Copying
these files wholesale would remove reviewed improvements. The unique remaining
differences were inspected; their disposition is recorded here.

| Paths | Reason to retain main |
| --- | --- |
| `.github/workflows/ci.yml`, `eslint.config.js` | Keep dependent-PR CI scope, staged-validation lint coverage and current acceptance registrations. Production-only helper registrations are unnecessary. |
| `background.js`, `review-core.js` | Keep review identity reset/sign-out protection and claim-bound carryover from #45. The original extra argument to `callFunction` has no effect. |
| `content.js`, `floating-widget.js`, `investigation-companion.js` | Keep malformed-count guards, companion validation/revision checks and both blocked Apply buttons from #49/#50. Other content differences are indentation. |
| `functions/lib/contracts.js`, `popup.js` | Remaining differences are formatting only. |
| `functions/lib/admin-monitor.js`, `hosting/admin-monitor.js`, `hosting/firebase-client.js` | Keep newest-first attention, generation-safe stale timers, full sign-out clearing and pre-fetch session guard from #47. |
| `functions/test/admin-monitor.test.js`, `functions/test/user-licence-deactivation.test.js` | Keep deterministic monitor/deactivation coverage; the original extra monitor assertions are covered by the merged monitor test. |
| `tests/admin-client.test.js`, `tests/auth-race.test.js`, `tests/review-resume.test.js` | Keep additional hosted mutation-cancellation, signup-failure/cancellation and cross-claim regressions. |
| `tests/claim-apply-safety.test.js`, `tests/claim-core.test.js`, `tests/investigation-safety.test.js` | Keep expanded comparison, malformed-input and invalidation regressions from #49/#50. |
| `scripts/admin-dashboard-e2e.js`, `scripts/signup-browser-acceptance.js`, `scripts/extension-browser-e2e.js` | Keep graceful browser shutdown, async guarded cleanup, stronger acceptance and persisted recovery waits from #46–#50. |
| `scripts/browser-smoke-e2e.js`, `scripts/license-lifecycle-acceptance.js` | Keep companion browser coverage and corrected auth fixtures; the remaining lifecycle console-message difference has no behavioral effect. |
| `docs/ADMIN_CONTROL_TOWER.md` | Keep reviewed #47 access, monitoring cost, bounded payload and rollout documentation. Original production acceptance claims are archived below. |

Files newly added on main but absent from the old checkout, including broker and
monitor regressions, staged-validation tools, contribution safeguards and scoped
PR documentation, also remain intact. They are not original WIP entries.

## Reconciled release files (10)

| Paths | Disposition |
| --- | --- |
| `README.md`, `DEVELOPMENT.md`, `PRIVACY_POLICY.md` | Document the merged signup, review/recovery, comparison and count behavior. Describe session-storage retention and full release checks. Distinguish candidate preparation from publication; remove unsupported current Store assertions. |
| `CHANGELOG.md` | Record all merged 1.12.1 changes rather than only the earlier signup/dashboard subset. |
| `manifest.json`, `package.json`, `package-lock.json` | Align extension/package/lock versions to 1.12.1 without changing dependencies or dropping the merged snapshot/staged-check npm scripts. |
| `release-manifest.json` | Regenerate from the merged candidate; discard the stale original timestamp/checksum. |
| `docs/CLAIM_APPLY_SAFETY_FIXES.md` | Retain the original cross-cutting safety explanation alongside the scoped merged PR docs. |
| `docs/SIGNUP_LICENCE_HOTFIX_1.12.1.md` | Replace old test counts and unverified deployment claims with reviewed behavior and links to reproducible acceptance/release evidence. |

The new `docs/RELEASE_1.12.1_REVIEW.md` provides candidate identity, validation
and rollout checkpoints. This reconciliation record replaces the initial
suggested boundaries, which are now completed.

## Historical QA material preserved locally (5)

| Paths | Disposition |
| --- | --- |
| `docs/ADMIN_DASHBOARD_ACCEPTANCE_2026-11-10.md` | Historical production acceptance/deployment claims retained in the snapshot and original checkout. They are not reasserted as this candidate's validation. |
| `scripts/admin-dashboard-live-acceptance.js`, `scripts/admin-production-smoke.js`, `scripts/admin-review-browser.js`, `scripts/signup-production-acceptance.js` | One-off production/browser tools depend on a particular operator/session and can inspect or mutate live data. Preserved verbatim in the snapshot/original checkout; excluded from the release PR and package. Synthetic dashboard/signup/lifecycle suites already provide reproducible acceptance. |

These five files are accounted for archival material, not pending release code.
Promoting any of them to supported tooling would require its own scope and review.
No historical script was executed during this reconciliation.

## Completion and later cleanup

The release worktree contains only the focused PR changes. The original checkout
remains a recovery source; it is intentionally still dirty. Reconciliation does
not mean resetting it. Keep the snapshot and original files until the release
PR is merged and the owner elects to retire that checkout. Continue new work in
a clean branch/worktree from current main. Before any later deletion, confirm
the relevant branch is merged and no independent local work or ignored evidence
is needed. Dependency junctions in review worktrees point to the retained
calculation worktree; do not remove that installation while they use it.

Main protection was verified during the extraction sequence: strict `validate`,
one independent approving review, stale-review dismissal, last-push approval,
resolved conversations and no force pushes/deletion, including administrators.
The release PR does not change protection settings or bypass these gates.
