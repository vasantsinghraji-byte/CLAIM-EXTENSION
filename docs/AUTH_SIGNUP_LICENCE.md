# Authentication, signup, and licence enforcement

The [November licensing security assessment](LICENSING_SECURITY_ASSESSMENT.md)
documents the current server session/entitlement guard, five-minute client
decision deadline, fail-closed outage policy and legacy/local-code limitations.
The [server-calculation proposal](SERVER_CALCULATION_PROPOSAL.md) describes the
separately reviewed migration for protecting hosted calculations.

Signup saves the newly created identity as pending before profile updates or
verification-email requests. Those optional requests cannot strand the account.
Duplicate or concurrent signup requests retain the first pending identity.
Signing in with an unverified account resumes verification, including after
reopening the popup. Verification refreshes the ID token before calling a
verified-email backend endpoint.

Registration creates a pending profile with an inactive individual licence.
The user chooses email-bound organization sponsorship or an individual plan.
Payment submission, payment verification, account approval, and licence
activation remain separate. Retry cannot overwrite paid, sponsored, rejected,
suspended, or administratively activated access. Only an unassigned unpaid
registration can move to the roster-based sponsorship path.

The server blocks inactive user licences, unpaid initial individual terms,
and legacy self-registrations that inherited organization access without an
explicit activation timestamp. Organization expiry remains authoritative for
approved sponsored members. A pending or declined renewal retains evidence
of an already verified and activated term until that term expires. Individual
activation/extension requires verified payment; the administrator controls show
that prerequisite and select the requested duration.

Auth, licence, pending identity, and cached-rule writes share a serialized
queue and an operation generation. Sign-out, account changes, and cancellation
invalidate older network responses. Concurrent rule refreshes share one request
while later Apply actions can still request fresh authority. Review-memory
clearing retains the #45 safeguards, including sign-out when session storage
fails.

Preview/Apply refreshes licence authority. Authorization failures cannot fall
back to bundled rules; signed-out claim tools stay locked. Undo and recovery
remain available to restore previous edits.

## Validation

`npm run check`, `npm run lint`, and `npm run test:functions` cover the auth
races, pending onboarding, policy gates, and unpaid/legacy/renewal cases.
`npm run test:extension` exercises actual extension APIs and delayed licence
verification after sign-out.

`npm run test:lifecycle` uses the Auth, Functions, and Firestore emulators for
sponsored and individual onboarding, payment/activation ordering, renewal,
capacity, idempotency, and rule governance. It also runs the actual unpacked
extension signup flow against those emulators, applies a local verification
code, checks popup recovery and inline feedback, and verifies deactivation
immediately before Apply. The fixture is restricted to `demo-claimextension`
and loopback emulator endpoints. It sends no production verification emails.

This source PR prepares no release artifact or deployment. Report-count parsing,
comparison presentation, and the dashboard monitor/redesign are separate work.
Existing legacy self-registrations denied by the new policy need an explicit
administrator licence decision; they are not activated automatically.
