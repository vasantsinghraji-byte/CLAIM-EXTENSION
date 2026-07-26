# Phase 3 — Single-User Development Pilot

Date: 2026-07-26

Release candidate: `1.8.1`

Firebase project: `claimextension` (development)

Authorized processor: `firemilton@gmail.com`

## Scope decision

The originally proposed five-user beta was deliberately reduced to one
authorized processor to shorten the development feedback cycle. This is a
development-pilot scope change, not evidence of production scale or readiness.
Additional users require a separate approval after Phase 4 hardening.

## Completed evidence

- The platform administrator activated the development organization licence.
- The administrator generated an invitation without using service-worker
  console commands.
- The processor created an account and verified the email address.
- A real onboarding defect was reproduced: the invitation was consumed while
  the corresponding user profile was unavailable, leaving sign-in unable to
  continue.
- Cloud Function logs proved that Firebase password authentication succeeded
  and that the failure was a missing profile, not an invalid password.
- `getCurrentUserProfile` and `acceptInvitation` recovery changes were deployed
  to development.
- Recovery requires an authenticated, verified account and an invitation whose
  accepted UID and normalized email both match the caller.
- Invitation replay for another account remains rejected.
- The missing profile was recovered, the invitation was accepted, the
  administrator activated the account, and Fire Milton onboarding completed.
- Administrator licence, invitation and activation controls are available in
  the extension popup.

## Automated verification

- Extension regression suite: 135 tests passed during recovery development.
- Focused authentication/storage suite: 44 tests passed.
- Functions contract suite: 6 tests passed.
- JavaScript syntax and whitespace validation passed.

The 1.8.1 release gate reruns the complete repository checks, lint, Functions
tests, Firestore Rules emulator tests, and deterministic production build.

## Gate decision

Phase 3 is complete for the approved one-user development scope.

Phase 4 may begin with:

1. immutable 1.8.1 release packaging;
2. production configuration isolation;
3. security and privacy checklist closure;
4. backup and restore testing;
5. unlisted Chrome Web Store preparation;
6. clean-profile installation and authorized RGHS smoke testing.

Production deployment and publication are not implied by this gate decision.
