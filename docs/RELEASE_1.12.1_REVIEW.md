# Release 1.12.1 preparation

Prepared November 11, 2026. Base: main after
[PR #50](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/50),
commit `d03a0c251c4ec844383de5f87f97a2cc70c6f66f`.
Status: review candidate; deployment and Store publication are separate actions.

## Included changes

| PR | Scope |
| --- | --- |
| [#42](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/42) | Staged validation, recovery snapshots and contribution/CI safeguards |
| [#43](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/43) | Saved rule scenario normalization |
| [#44](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/44) | Central money parsing, deduction caps, explicit zero and browser/server parity |
| [#45](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/45) | Claim-bound Apply/Undo, partial recovery, saved reviews and safe-row continuation |
| [#46](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/46) | Signup recovery, auth races, payment/activation separation and licence enforcement |
| [#47](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/47) | Administrator dashboard and authenticated live monitoring |
| [#48](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/48) | Graceful extension-browser teardown |
| [#49](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/49) | Whole-number report counts and companion validation |
| [#50](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/50) | Comparison summaries and safe policy explanations |

This preparation aligns manifest/package/lockfile versions at 1.12.1, updates
the changelog, development and privacy documentation, and regenerates release
metadata from the merged source. It changes no runtime code, rule definitions,
dependencies, permissions, production configuration or minimum supported version.
The Functions package keeps its independent version.

## Validation and package identity

The base passed [post-merge CI run 43019599525](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/actions/runs/43019599525).
Candidate checks under Node 22 and Java 21:

- Matrix coverage, syntax/secret checks, 309 root tests, ESLint and 44 Functions
  tests passed.
- Standard/investigation/companion Chrome smoke, actual unpacked-extension
  acceptance and hosted dashboard acceptance passed.
- All 6 Firestore security-rules tests passed against the local emulator.
- Full Auth/Functions/Firestore lifecycle acceptance passed: sponsored and
  individual access, actual extension signup, payment/activation separation,
  central-rule governance/approval/rollback and authenticated monitoring/revocation.
- Regenerated audit rules match committed source.
- Two independent package constructions produced identical bytes, and
  `npm run verify:artifact` passed against current production source/config.

Production candidate SHA-256:
`16F4A58D7F55604F32110BE71100D128458E3E0F38EF8B6F5F4AAFAA9AA6D150`.

The candidate ZIP is generated locally using the ignored production build
configuration. `npm run verify:artifact` checks all five version values,
the SHA-256, and every packaged byte against current production source/config.
Build the ZIP twice and require identical bytes. `release-manifest.json` records
its hash and build timestamp. The ignored versioned copy is
`artifacts/claim-autofill-extension-1.12.1.zip` in the release worktree.

CI has no production configuration and builds a non-deployable placeholder ZIP.
Its artifact must not replace the locally verified distribution candidate.
The clean-worktree `npm run release -- patch` command advances the version again;
do not use it to rebuild this already prepared candidate. Rebuild with
`npm run build`, then verify against the recorded metadata. If packaged source
changes, regenerate metadata and repeat candidate validation before distribution.

## Rollout checkpoints

1. Merge this PR after independent review and successful CI. Check that the merged
   source matches the reviewed candidate; any packaged changes require rebuilding.
2. Verify current production deployment and Store publication records. Historical
   WIP notes are archived, not evidence of the current environment. The last Store
   publication documented in tracked release evidence is 1.11.1; the current
   listing has not been checked during candidate preparation.
3. Review legacy self-registration activation requirements and dashboard monitoring
   read volume. Do not silently activate legacy users or alter existing accounts.
4. In a separately authorized rollout, deploy compatible backend changes before
   extension distribution: corrected rule evaluator and signup/licence endpoints,
   then monitoring endpoint before hosted dashboard assets. Use explicit Firebase
   project selection and the existing production-readiness checklist. This change
   requires no new Firestore rules or indexes; verify compatibility and backups.
5. Recheck environment labels, authentication/authorization boundaries, monitor
   health and affected central-rule scenarios. Keep bundled fallback enabled
   until parity is established. Any live account tests need separate authorization.
6. Upload only the versioned production ZIP matching `release-manifest.json`, using
   the established Store review/publication process. Update the separately managed
   public privacy page and Store data disclosures from the reviewed policy.
7. Confirm availability to installed users before raising the minimum supported
   extension version. Monitor errors and access denials; preserve the previous
   verified package and backend rollback plan. Store rollback may require a newer
   extension version; do not assume an older ZIP can replace installed versions.

No Firebase deployment, Store upload/publication, release tag or real-account
mutation is performed by this PR. It does not assert live portal acceptance of
this candidate; automated browser acceptance uses synthetic local fixtures.

See [final worktree reconciliation](WORKTREE_RECONCILIATION.md) for every original
changed/untracked file and its disposition. The original checkout is preserved.
