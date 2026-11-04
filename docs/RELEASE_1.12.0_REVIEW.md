# Release 1.12.0 review and validation

Date: 2026-11-04 (America/Los_Angeles).
Base: PR #40 (`6260656`) plus repository workflow commit `ad62118`.
Status: local release candidate; production deployment and Store publication are separate actions.

## Review findings resolved

- Self-service signup could reactivate administratively suspended/rejected/deleted
  profiles, replace an existing onboarding/payment path, or accept a missing expiry.
  It now preserves active entitlements, rejects restricted profiles, validates finite
  future expiry and audits eligible legacy registration migrations.
- Investigation Apply bypassed licence/enabled checks, live-value validation,
  policy conflicts and high-risk acknowledgement. It now checks those gates and
  refreshes the rule identity before writing. Counts must be whole numbers within
  expected quantities; approvals cannot exceed the actual claimed amount.
- Investigation remarks were previewed but not written. Amounts and verification
  remarks now share a recovery batch, with rollback on failed/rejected persistence.
  Undo clears the verified marker so subsequent processing is not silently skipped.
- Bundled IPD adjustments ran even when central policy disabled bundled fallback.
  They now respect that setting. Conflicting IPD amounts stop processing for manual
  policy review, including when a separate audit finding covers the same row.
- Companion windows now bind to their own claim identifier and connect only to
  the official RGHS origin. Both UI paths show proposed amounts/remarks and require
  explicit acknowledgement of reductions.
- Reviewed IPD amount and remark overrides were ignored by the final row-writing
  pass. Apply now writes the validated reviewer selection; browser acceptance
  exercises a different approved amount/remark and exact Undo restoration.
- Release validation now includes lint and Functions tests. Artifact verification
  compares the entire production ZIP against current source and local production
  configuration, in addition to version metadata and the recorded SHA-256.

## Automated validation

- Root coverage/syntax/secrets/unit checks: passed (238 tests).
- ESLint: passed.
- Functions contract/engine tests: passed (19 tests).
- Firestore security rules: passed (6 tests, isolated emulator).
- Real Chrome synthetic acceptance: passed for standard and investigation workflows.
  The investigation fixture executes the actual content script against real DOM
  controls and covers acknowledgement, stale values, amount/remark writes, Undo,
  recovery rollback, reviewed IPD overrides, central fallback disable and overlapping IPD rules.
- Auth/Functions/Firestore lifecycle acceptance: passed in `demo-claimextension`.
  Includes sponsored/individual access, renewal, verified self-service onboarding,
  restricted statuses, unpaid/paid path isolation, expiry validation, idempotent
  auditing and two concurrent registrations competing for one remaining seat.

## Authenticated RGHS evidence

Used a dedicated Chrome profile with debugging on 127.0.0.1:9222 and the unpacked
extension. User authenticated RGHS and the extension. No credentials, claim IDs,
patient data, field snapshots or documents are recorded in this report.

- Portal preflight: one supported process-sheet table; eight proposed rows and
  five writable investigation rows.
- Invalid investigation counts and signed-out Apply: blocked; controls unchanged.
- General Apply: six fields changed; recovery saved; Undo exactly restored every
  captured input, textarea, select and editable control.
- Investigation reduction without acknowledgement: blocked.
- Acknowledged investigation Apply: two fields changed (amount and remark);
  recovery saved; Undo exactly restored every captured control.
- Claim submission: never performed.

This is one live process-sheet integration check. It does not establish coverage
of every portal layout or every IPD clinical/policy combination. Overlapping IPD
adjustments deliberately require manual review rather than an inferred precedence.
The new signup behavior was validated against isolated emulators; production
Functions were not modified for that test.

## Release and deployment

Version 1.12.0 advances the extension manifest, root package/lockfile, changelog
and release manifest together. The Functions package has its own version.
The ZIP is built from local production configuration, never CI placeholders.

Before production rollout, review the self-service activation behavior and deploy
compatible Firestore rules, Functions and Hosting in the documented order. Keep
central bundled fallback enabled until rule parity is established. Upload only
the versioned ZIP whose SHA-256 matches `release-manifest.json`; use deferred
Store publication and review the new tabs/windows permissions. No remote branch
merge, production deployment or Chrome Web Store submission is part of preparation.
