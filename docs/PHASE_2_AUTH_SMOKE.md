# Phase 2 — Authenticated Development Smoke

Date: 2026-07-25

Initial release under test: `1.7.0` (`9a24542`)

Follow-on release: `1.8.1`

Firebase project: `claimextension`

Functions region: `asia-south1`

## Scope

The live development smoke exercised the same REST login and callable protocol
used by the extension without handling the real platform administrator's
password. Two disposable verified identities were created:

- an active `platformAdmin`;
- an active `processor`.

Both identities and every associated Firestore and rate-limit document were
deleted after the assertions completed.

## Results

| Check | Expected | Result |
|---|---|---|
| Platform-admin email/password login | Firebase ID token returned | Passed |
| Processor email/password login | Firebase ID token returned | Passed |
| `getCurrentUserProfile` | Active `platformAdmin` profile returned | Passed |
| Platform-admin protected-call boundary | Authorization passes; invalid empty payload reaches schema validation | Passed (`INVALID_ARGUMENT`) |
| Processor protected-call boundary | Role rejected before mutation | Passed (`PERMISSION_DENIED`) |
| Anonymous profile call | Missing authentication rejected | Passed (`UNAUTHENTICATED`) |
| Cleanup | No disposable Auth or Firestore smoke records retained | Passed |

No organization, licence or claim-processing record was created or changed.
No RGHS claim data was read or sent to Firebase during this smoke.

## Gate decision

The authenticated development boundary passed and advanced to the revised
single-user pilot. The completed pilot and the invitation-recovery defect found
during real onboarding are recorded in `PHASE_3_SINGLE_USER_PILOT.md`.
Production remains release-gated.
