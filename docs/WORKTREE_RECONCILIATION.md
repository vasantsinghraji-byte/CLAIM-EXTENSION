# Existing worktree reconciliation

Recorded November 10, 2026 (America/Los_Angeles).

The original checkout is on `fix/claim-apply-safety`, based on
`b03685d18894ed9feec1d24da2ef29e40b643956`. Its application changes are
uncommitted and span several tasks. The workflow safeguards are isolated on
`chore/workflow-safeguards` in `artifacts/worktrees/workflow-safeguards`.
The original files and index were preserved.

A local recovery snapshot is available under
`artifacts/repository-snapshots/2026-11-11T04-15-22-410Z-CFd2Wi` in the
original checkout. Its manifest records the base and untracked-file hashes.
Follow CONTRIBUTING.md to recover into a new worktree. This ignored snapshot
is local and is not part of the repository or a deployment artifact.

## Suggested application PR boundaries

These are review boundaries inferred from the current diffs and tests.
Review shared files by hunk before moving anything; the table does not imply
that a whole file belongs to exactly one task.

| Task / suggested branch | Main paths and evidence | Validation |
| --- | --- | --- |
| Claim Apply correctness: `fix/claim-apply-safety` | `claim-core.js`, `content.js`, `processing-rules.js`, server processing rules, amount parsing and deduction tests, `docs/CLAIM_APPLY_SAFETY_FIXES.md` | Root and Functions tests; browser Apply/Undo acceptance |
| Authentication and recovery: `fix/auth-review-recovery` | `background.js`, `review-core.js`, `popup.js`, authentication race, review resume, recovery and IPD remark tests | Root tests; actual extension acceptance, including sign-out races |
| Signup and licence activation: `fix/signup-licence-activation` | `functions/index.js`, `functions/lib/contracts.js`, deactivation tests, signup acceptance scripts, `docs/SIGNUP_LICENCE_HOTFIX_1.12.1.md` | Functions tests; emulator lifecycle and synthetic signup acceptance |
| Administrator dashboard: `feat/admin-control-tower` | `hosting/admin*`, `hosting/firebase-client.js`, `functions/lib/admin-monitor.js`, monitor/client tests, dashboard scripts and documentation | Root and Functions tests; hosted dashboard acceptance |
| Release preparation: `release/1.12.1` | Version hunks in `manifest.json`, `package.json`, `package-lock.json`, plus `CHANGELOG.md` and `release-manifest.json` | All relevant CI gates, reproducible build, artifact verification |

`README.md`, `DEVELOPMENT.md`, `PRIVACY_POLICY.md`, `eslint.config.js`,
`package.json`, and `.github/workflows/ci.yml` contain supporting changes
that should accompany their corresponding task. Several acceptance scripts
are currently untracked; stage each script with its package-script and CI
integration so the commit can run independently. Keep any prerequisites
together or use explicitly dependent PRs.

For each task, start from fetched `origin/main` (or a documented dependency),
move the selected hunks into its worktree, inspect `git diff --cached`, and
run `npm run check:staged`. Commit one behavior change at a time using
Conventional Commits. Open a PR after inspecting `git diff <base>...HEAD`.
Regenerate release metadata only after the behavior changes are merged.

## Existing safeguards and remaining administration

GitHub Flow, branch/commit policy enforcement, versioned Git hooks, both npm
lockfiles, `npm ci`, dependency download caches, CI concurrency cancellation,
and a ten-minute CI timeout already exist. Retain those checks and the
current application CI additions when merging this workflow branch.

An administrator must verify the server-side `main` protection described in
CONTRIBUTING.md: PRs, at least one approval, stale-review dismissal, resolved
conversations, required `validate` checks, and blocked force pushes/deletion.
This local change does not assert that those GitHub settings are enabled.

The cached branch inventory identifies `chore/version-control-workflow`,
`feat/investigation-companion`, `fix/pr40-release-safety`, and `release/1.12.0`
as merged candidates. Refresh remote references and check for associated work
before deleting any of them. Retain `agent/worktree-safety-20260812` until
its snapshot has been reconciled. No existing branch was deleted.

Node 22 is required by `.nvmrc`, CI, and Functions. This workstation defaults
to Node 24 but already has Node 22 at `.tools/node22`; select that toolchain
for CI-equivalent checks. Docker and `act` are not currently on PATH, so the
documented local Actions run was not performed. Do not add blanket retries
or increase timeouts without evidence from a specific failing step.
