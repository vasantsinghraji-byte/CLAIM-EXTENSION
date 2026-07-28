# Phase 4 Production Readiness

Status: All pre-distribution production gates complete; private Chrome Web
Store upload, review and explicit publication remain open.

Date: 26 July 2026

## Delivered controls

The primary production administrator interface is the static dashboard under
`hosting/`, deployed through Firebase Hosting. The popup administrator panel is
retained only as a pilot/break-glass substitute.

- List up to 100 users with status, role and organization.
- Activate, suspend and reactivate users. Suspension disables Firebase
  Authentication and revokes refresh tokens.
- Change another user's role. A platform administrator cannot change their own
  role, suspend themselves or delete themselves.
- Permanently delete a Firebase Authentication account after a two-step UI
  confirmation and exact server-side email match. The Firestore profile is
  retained in redacted form so audit relationships are not destroyed.
- List invitations and derived pending, expired, accepted, revoked or replaced
  status.
- Revoke or replace pending invitations. Replacement invalidates the old token
  and returns the new plaintext token once; Firestore stores only SHA-256
  hashes.
- Create and update organizations, including status and maximum-user limits.
- View the latest 100 privacy-safe administration and extension audit events.
- Record administrator mutations in immutable, server-written audit events.
- Enforce active organization, active licence and seat limit during activation.
- Build the production ZIP with production Firebase identifiers and remove
  development origins and development Functions configuration.
- Serve public home, privacy, support, terms and account-deletion pages plus
  the authenticated administrator dashboard through Firebase Hosting.
- Apply a strict Content Security Policy, framing denial, no-sniff,
  no-referrer, capability restrictions and no-store headers to hosted
  administrator assets.
- Keep dashboard authentication tokens in session storage only. Passwords are
  sent directly to Firebase Authentication and are never stored by the site.

## Security boundaries

- Every administration callable requires an authenticated, email-verified
  Firebase identity with the `platformAdmin` custom claim.
- Firestore rules deny direct client access to invitations, licences,
  rate-limit records and audit events. Administration flows only through Cloud
  Functions.
- Request schemas reject unknown fields. Identifiers, email addresses, enums
  and numeric limits are validated server-side.
- Claim, patient, clinical, amount, remark and portal URL keys are rejected
  from cloud audit metadata.
- Destructive account deletion requires the target UID and exact target email,
  cannot target the caller, disables the account first, revokes refresh tokens,
  redacts the profile and then removes the Firebase Authentication identity.
- User-supplied values are rendered with `textContent`; the administrator UI
  does not use `innerHTML`.

## Production isolation

Firebase projects:

- Development: `claimextension`
- Production: `claimextension-prod`

The production Firebase Web App is registered separately. `npm run build`
creates the distributable ZIP with only the production callable Functions
origin and production public Firebase Web API key. The unpacked source remains
configured for development testing.

## Operational objectives

| Objective | Target |
|---|---|
| Administration API availability | 99.5% monthly during the controlled release |
| Apply safety during authorization uncertainty | Fail closed after the one-hour cached decision tolerance |
| Audit-event retention | 365 days unless legal review specifies otherwise |
| Authentication/invitation metadata retention | Account lifetime plus 90 days after deletion, subject to legal approval |
| Recovery point objective | 24 hours after daily backups are enabled |
| Recovery time objective | 8 business hours for the controlled release |
| Incident acknowledgement | 4 business hours |

These are operating targets, not contractual service-level guarantees.

## Human-controlled production gates

The following actions intentionally cannot be completed safely by source-code
automation alone:

1. Confirm production billing, budget alerts and authorized administrators.
2. Enable Email/Password Authentication and bootstrap the production
   `platformAdmin` identity without sharing its password.
3. Deploy reviewed Firestore rules, Functions and Hosting to
   `claimextension-prod`.
4. Enable a daily Firestore backup schedule with 14-day retention, then perform
   and record a restore drill into a separate recovery database.
5. Complete the privacy/legal review for retention, support response and RGHS
   authorization.
6. Load the production ZIP in a clean Chrome profile and run sign-in, licence,
   preview, reviewed apply and exact undo smoke tests using synthetic data.
7. Upload the verified ZIP to the Chrome Web Store, choose **Private** for the
   first controlled release, add only the approved tester, and choose deferred
   publishing.
8. Review Chrome Web Store warnings and permissions before explicitly
   publishing.

No production user should receive the package before all eight gates are
recorded as passed.

## Production gate record

| Gate | Status | Evidence |
|---|---|---|
| Billing, budget and authorized administrator | Passed | Blaze enabled for `claimextension-prod`; INR 1,000 monthly budget with 10%, 50% and 100% alerts; operator confirmed 26 July 2026 |
| Authentication and administrator bootstrap | Passed | Email/Password enabled; `nocturnaladmin@gmail.com` verified as active `platformAdmin`; hosted dashboard sign-in and organization/licence/audit visibility confirmed 26 July 2026 |
| Firestore, Functions and Hosting deployment | Passed | Production rules/indexes, 20 active Gen2 Functions and Hosting deployed; `/admin` verified with no-store and security headers |
| Daily backup and restore drill | Passed | Daily schedule with 14-day retention produced a READY backup; restored successfully into isolated database `phase4-restore-20260728` and verified 28 July 2026 |
| Privacy/legal review | Passed (owner attestation) | Responsible business owner Vasant S Raji approved the six documented privacy/operational statements on 26 July 2026, including RGHS authorization, browser-only claim/patient content, privacy-safe Firebase metadata, stated retention, support/deletion handling and disabled AI. This is an internal operational approval, not independent legal advice or an RGHS-issued authorization |
| Clean-profile extension smoke | Passed | Responsible owner confirmed version 1.10.0 Preview, Apply and exact Undo on an authorized RGHS test claim without submission on 28 July 2026; installation, production sign-in, active licence, off-domain Apply blocking and extension-error checks also passed |
| Private Chrome Web Store upload | Ready | Sole approved Private tester: `firemilton@gmail.com`; upload must use the verified ZIP and deferred/manual publishing |
| Store review and explicit publication | Not started | Blocked by all preceding gates |

The candidate production artifact is version 1.10.0. Its SHA-256 is recorded in
`release-manifest.json`; operators must calculate the ZIP hash again immediately
before upload and require an exact match.

### Controlled distribution approval record

The initial Chrome Web Store release is restricted to **Private** visibility
with only `firemilton@gmail.com` in the tester list. Automatic publishing is
not approved. The operator must use deferred/manual publishing, review all
permissions, privacy declarations, warnings and the final tester list, and
obtain explicit publication approval before making the release available.

### Privacy and operational approval record

On 26 July 2026, Vasant S Raji, acting as the responsible business owner for
Claim Spark, explicitly confirmed and approved:

1. authorization to use the extension with RGHS;
2. keeping claim and patient content inside the browser;
3. sending only privacy-safe operational metadata to Firebase;
4. retaining audit events for 365 days;
5. retaining deleted-account metadata for up to 90 days;
6. handling support and deletion requests through the published contact while
   AI processing remains disabled.

This attestation closes the project's internal privacy/operations gate. It is
not independent legal advice and does not substitute for any separate approval
that RGHS, an employer, a data controller or applicable law may require.

### Backup restore drill record

On 28 July 2026, the READY backup
`d5668c53-ede5-4d3a-94d8-69f651de2da1`, captured at
`2026-07-27T13:43:29.462712Z`, was restored into the isolated database
`phase4-restore-20260728` in `asia-south1`.

- Restore started: `2026-07-28T07:57:06.415205Z`
- Restore completed: `2026-07-28T08:18:46.183149Z`
- Recovery duration: 21 minutes 40 seconds
- Snapshot age at restore start: approximately 18 hours 14 minutes
- Operation state: `SUCCESSFUL`; no error
- RPO result: passed against the 24-hour target
- RTO result: passed against the eight-business-hour target
- Restored evidence: active `platform` organization; active one-seat licence;
  AI limit zero; production configuration with maintenance disabled; one active
  platform administrator; privacy-safe `production.bootstrap` audit event
- Production `(default)` database: not overwritten
- Recovery database cleanup: deletion protection explicitly disabled and
  database deleted at `2026-07-28T09:21:59.186068Z`; subsequent inventory
  confirmed that only the delete-protected Production `(default)` database
  remained

