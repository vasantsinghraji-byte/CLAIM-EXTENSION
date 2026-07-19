# Contributing & Version-Control Workflow

This repository processes government health-scheme claims. Discipline here is
not bureaucracy — a bad merge can change how real claims are adjudicated.
Everything below is enforced by tooling where possible (git hooks + CI); the
rest is convention that reviewers hold the line on.

## One-time setup

```bash
npm install        # installs dev tools AND activates the versioned git hooks
                   # (the "prepare" script sets core.hooksPath=.githooks and
                   #  the commit template)
pip install -r tools/requirements.txt
```

## Branching model — GitHub Flow

`main` is always releasable. **Never commit directly to `main`.**

1. Sync first: `git checkout main && git pull`.
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

The `commit-msg` hook rejects messages that don't match:

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

The `pre-commit` hook runs `npm run check` (matrix coverage validation, syntax
checks, all unit tests) and `npm run lint`. A red suite blocks the commit.
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

## Generated & special files

| File | Rule |
|---|---|
| `audit-rules.js` | Generated — edit `tools/rule-curation.json`, then `python tools/generate-audit-rules.py`. CI fails on drift. |
| `package-lock.json` | Committed — CI uses `npm ci` for identical dependency trees. Update only via `npm install <pkg>`. |
| `claim-autofill-extension.zip`, `dist/` | Build artifacts — gitignored / never committed. `npm run build` is reproducible. |
| `release-manifest.json`, `CHANGELOG.md` | Updated by `npm run release -- patch|minor|major` on `main` after merge. |

## Worktree hygiene

- `git status` should be clean before you start and after you finish a session.
- Multiple parallel sessions/editors work in this repo: **re-read files before
  editing, and never overwrite unfamiliar changes — merge them.** If you find
  work you don't recognize, stop and reconcile; don't revert.
- Prune regularly: `git fetch --prune` and delete merged branches
  (`git branch --merged main` shows candidates).
- Stash or commit WIP before switching branches; never carry uncommitted
  changes across branches.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`: locked
installs (`npm ci`, cached), matrix-coverage validation, syntax checks, the
full test suite, ESLint, a staleness check on generated rules, and a
reproducible build uploaded as an artifact. If CI fails on a previously green
branch, bisect from the last green commit rather than pushing guesses.

## Releases

Only from green `main`: `npm run release -- patch|minor|major` aligns
versions, updates the changelog, validates, rebuilds, and writes
`release-manifest.json` with the package SHA-256. Tag the release commit
(`git tag v<version>`) so deployed builds are traceable to exact sources.
