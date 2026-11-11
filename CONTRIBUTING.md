# Contributing & Version-Control Workflow

This repository processes government health-scheme claims. Discipline here is
not bureaucracy — a bad merge can change how real claims are adjudicated.
Everything below is enforced by tooling where possible (git hooks + CI); the
rest is convention that reviewers hold the line on.

## One-time setup

```bash
npm ci             # installs locked dev tools AND activates the versioned git hooks
                   # (the "prepare" script sets core.hooksPath=.githooks and
                   #  the commit template)
pip install -r tools/requirements.txt
```

The setup script configures the repository-local hooks and marks them
executable on platforms that require it. Verify the setup with
`git config --get core.hooksPath`; it should print `.githooks`.

Also run `npm --prefix functions ci` for Functions development and contract tests.
Use Node 22 from `.nvmrc`, matching CI and the Functions runtime. On Windows,
use `npm.cmd` if PowerShell blocks the `npm.ps1` launcher.

Run `npm run repo:health` at the start and end of a work session. It reports
branch policy, dirty paths, linked worktrees, hook/template configuration,
upstream and cached `origin/main` divergence, package/lockfile version and
dependency-spec drift for both packages, and merged local branches that may
be stale. Run `git fetch --prune` to refresh remote references first. The
report never deletes or rewrites work; `npm ci` remains the full lockfile check.

## Branching model — GitHub Flow

`main` is always releasable. **Never commit directly to `main`.**

1. Start with a clean worktree, then sync: `git fetch --prune`,
   `git switch main`, and `git pull --ff-only`.
2. Branch per unit of work, named by intent:
   - `feat/<slug>` — new behavior (e.g. `feat/adjunct-cluster-check`)
   - `fix/<slug>` — bug fixes (e.g. `fix/cm-ward-split-duplicate`)
   - `refactor/<slug>`, `chore/<slug>`, `docs/<slug>`, `test/<slug>`
   - `hotfix/<slug>` — urgent fix branched from `main`, merged back immediately
   - `experiment/<slug>` — spikes; may be deleted without merging, never merged
     without being cleaned up into a proper `feat/fix` branch first
3. Keep branches **short-lived** (days, not weeks). Rebase or merge `main` into
   your branch early and often; resolve conflicts on the branch, never on `main`.
4. Open a pull request (template auto-fills the claims-safety checklist).
   CI must be green before merge.
5. Merge with a merge commit (`--no-ff`) so features stay traceable as units,
   then **delete the branch** — locally and on origin.

## Commits — Conventional Commits, enforced

The `commit-msg` hook rejects messages that don't match, and CI validates the
entire pull-request commit range so `--no-verify` cannot bypass the policy:

```
<type>(<scope>)?: <subject ≤ 72 chars>
```

Types: `feat` `fix` `refactor` `chore` `docs` `test` `build` `ci` `perf`
`style` `revert`. Suggested scopes: `audit`, `rules`, `autofill`, `popup`,
`options`, `widget`, `review`, `build`, `release`, `docs`.

Rules of thumb:

- **Atomic**: one logical change per commit. If the subject needs "and",
  split it.
- **Never mix** a feature with a refactor or a rule-data change with an
  engine change — they must be separately revertable.
- Body explains **why**; the diff already shows how.
- `git commit` (no `-m`) opens the pre-filled `.gitmessage` template.

The `pre-commit` hook runs `npm run check:staged`: matrix coverage, syntax,
root unit tests, ESLint, and Functions unit tests against a temporary export
of the Git index. Unstaged fixes and untracked dependencies cannot mask an
incomplete commit. Partial staging with `git add -p` remains supported;
validation leaves the index and working files unchanged, including on failure.
Installed root and Functions dependencies are shared with the temporary export.
Missing dependencies block the commit; restore both with `npm ci` and
`npm --prefix functions ci`. CI independently installs from both lockfiles.
Local `fixup!` and `squash!` commits are allowed while working, but the PR gate
rejects them until autosquashed. CI recognizes merge subjects only on actual
merge commits, so a subject beginning with `Merge` cannot bypass validation.
`--no-verify` exists for genuine emergencies only; CI enforces the same gates,
so an unverified commit just fails later and louder.

## Code review discipline

- Every non-trivial change goes through a PR — including your own if you're
  working solo; the PR is the audit trail and the CI gate.
- Reviewers check: correctness, the claims-safety checklist, test coverage for
  new rule logic, and that generated files (`audit-rules.js`) were regenerated
  rather than hand-edited (CI verifies this too).
- Anything touching deduction behavior (`planAuditActions`, allowlists,
  safety caps) needs explicit reviewer sign-off in the PR conversation.

Repository administrators must protect `main` in GitHub: require a pull
request with at least one approval, dismiss stale approvals after new commits,
require conversation resolution and the `validate` CI check, and block force
pushes and branch deletion. Also enable "Automatically delete head branches"
in the repository settings. These server-side rules are authoritative; local
hooks are an early feedback layer and can be bypassed with `--no-verify`.

## Generated & special files

| File | Rule |
|---|---|
| `audit-rules.js` | Generated — edit `tools/rule-curation.json`, then `python tools/generate-audit-rules.py`. CI fails on drift. |
| `package-lock.json` | Committed — CI uses `npm ci` for identical dependency trees. Update only via `npm install <pkg>`. |
| `claim-autofill-extension.zip`, `dist/` | Build artifacts — gitignored / never committed. `npm run build` is reproducible. |
| `release-manifest.json`, `CHANGELOG.md` | Prepared by `npm run release -- patch\|minor\|major` on a release branch, then reviewed in a PR. |

## Worktree hygiene

- `git status` should be clean before you start and after you finish a session.
- Multiple parallel sessions/editors work in this repo: **re-read files before
  editing, and never overwrite unfamiliar changes — merge them.** If you find
  work you don't recognize, stop and reconcile; don't revert.
- Prune regularly: `git fetch --prune` and delete merged branches
  (`git branch --merged main` shows candidates).
- Stash or commit WIP before switching branches; never carry uncommitted
  changes across branches.

For concurrent tasks, use a separate worktree and branch per task. From a
clean checkout, after fetching, create a sibling worktree based on main:

```bash
git worktree add ../claim-workflow-fix -b fix/workflow origin/main
git -C ../claim-workflow-fix status --short --branch
```

If work depends on an unmerged feature, branch from that feature and target
its branch in the first PR. Retarget to main after the dependency merges;
review `git diff <base>...HEAD` before opening a PR to catch unrelated changes.
Use `git add -p` and `git diff --cached` to stage and inspect one logical change.
After merging, remove only a clean worktree with `git worktree remove <path>`,
then use `git branch -d <branch>` for a branch confirmed merged into main.
Keep unmerged safety snapshots until their changes have been reconciled.

### Preserve a mixed worktree before sorting it

Run `npm run repo:snapshot` before reorganizing existing uncommitted work.
It writes an ignored directory under `artifacts/repository-snapshots/` with
the base commit and branch, separate binary-capable staged and unstaged
patches, and copies of nonignored untracked files with SHA-256 checksums.
It does not stage, stash, commit, switch branches, or discard anything.
A snapshot is usable only when its `manifest.json` has `complete: true`;
the command refuses unresolved merges and fails if it detects concurrent edits.
Ignored files, installed dependencies, and local Firebase configuration are
excluded. Keep those local settings separately when needed. These local
snapshots protect against editing mistakes; they are not off-machine backups.

To recover, create a new worktree at the manifest's `base` commit:

```bash
git worktree add ../claim-recovery -b chore/recovery <base-sha>
git -C ../claim-recovery apply --index <absolute-snapshot-path>/staged.patch
git -C ../claim-recovery apply <absolute-snapshot-path>/unstaged.patch
```

Skip a patch command when its file is empty. Copy the contents of the
snapshot's `untracked/` directory into that new worktree, preserving relative
paths. Inspect `git status` and `git diff --cached` there before continuing.
Recovery was tested with partial staging, deletions, binary content, spaces,
and Unicode filenames. Do not apply recovery patches over the original dirty tree.

After taking the snapshot, inventory changes by behavior and dependency.
Create one dedicated branch/worktree per reviewable task; move only that task's
files or hunks and run `npm run check:staged` before committing. Shared files
such as `background.js`, `package.json`, and CI often need hunk-level splitting.
Keep version bumps, release manifests, and changelog preparation together in a
final release PR after the underlying fixes and features merge. Never treat a
mixed recovery snapshot as a release candidate.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`: locked
installs (`npm ci`, cached), matrix-coverage validation, syntax checks, the
full test suite, ESLint, a staleness check on generated rules, and a
reproducible build uploaded as an artifact. If CI fails on a previously green
branch, bisect from the last green commit rather than pushing guesses.

For a faster workflow loop, install [`act`](https://nektosact.com/) and run
`act pull_request -j validate --eventpath <pr-event.json>`. Supply a real PR
event with `pull_request.head.ref`, `pull_request.head.sha`, and
`pull_request.base.sha` referring to commits available in the checkout;
the policy gate rejects missing event data. The browser and Firebase steps need a
Docker image with Node, Python, and Java support; CI remains the authoritative
result when the local container differs from GitHub's hosted runner.

For a failing check, reproduce its exact command first. Use a temporary
worktree for `git bisect` between the last green and first failing commits so
investigation does not disturb current work. Replace network calls with
deterministic fixtures before adding retries; retry only identified transient
infrastructure failures. Inspect the failing step's duration and logs before
changing the existing 10-minute job timeout or runner resources. Node and Python
setup actions already cache package downloads using committed dependency files;
keep `npm ci` so the cache cannot replace lockfile validation.

## Releases

Start a clean `release/<version>` branch from green, freshly fetched
`origin/main`. Run `npm run release -- patch|minor|major` there to align
versions, update the changelog, validate, rebuild, and write
`release-manifest.json` with the package SHA-256. Commit those changes as
`chore(release): prepare <version>` and merge through a reviewed, green PR.
Tag the resulting main commit (`git tag -a v<version> -m "Release <version>"`)
and deploy its verified artifact so each deployment maps to exact sources.
