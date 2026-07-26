# Phase 1 — Firebase Foundation

Status: Development foundation deployed; Authentication and initial
platform-administrator bootstrap complete; production remains release-gated

Historical boundary note: this document records the Phase 1 state. Extension
authentication was connected in Phase 2 and the approved single-user
development pilot completed in Phase 3. Production remains release-gated.

Publisher: `NOCTURNAL_ADMIN`

Support: `nocturnaladmin@gmail.com`

## 1. Project boundary

| Environment | Firebase project | Project number | Intended region |
|---|---|---:|---|
| Development | `claimextension` | `204760753170` | `asia-south1` |
| Production | `claimextension-prod` | `975343888433` | `asia-south1` |

The Firebase CLI is authenticated as `nocturnaladmin@gmail.com`. The two
projects are active, separate Firebase projects. The development Firestore
database is deployed in `asia-south1` with the tested rules. Production
deployment is intentionally excluded from Phase 1: the production project is
a controlled release target, not a development test surface.

Development project `claimextension` is on Blaze. Its monthly budget is
₹1,000 with actual-spend email alerts at ₹100, ₹500 and ₹1,000. The budget is
read-only for project users, and email notifications go to billing
administrators and billing users.

## 2. Frozen pilot decisions

- One organization for the initial pilot.
- Fixed 90-day licence term.
- Maximum 50 named users.
- 72-hour expiry grace: Preview remains available and Apply is disabled.
- AI disabled.
- No patient, TID, claim, clinical, amount, URL, or free-text remark data in
  Firestore, Cloud Functions logs, or usage events.

## 3. Implemented foundation

- Firebase aliases for development and production.
- Node.js 22 Cloud Functions runtime in `asia-south1`.
- Eleven callable Cloud Functions deployed and active in development.
- Email/password Authentication enabled with passwords required.
- Verified, active `NOCTURNAL_ADMIN` platform-administrator identity, custom
  claims, user profile and internal platform organization.
- Authentication, Functions, Firestore and Storage emulators.
- Deny-by-default Firestore rules and a deny-all Storage policy for any future
  Storage provisioning.
- Strict callable request schemas and recursive claim-content rejection.
- Verified-email, active-user, organization-role and platform-admin gates.
- One-time invitation tokens stored only as SHA-256 hashes.
- Organization, invitation, activation, suspension and licence callables.
- Active, grace, expired and suspended licence decisions.
- Fixed-window rate limits stored behind the trusted Functions boundary.
- Metadata-only extension events; claim-related keys are rejected.
- AI hard-disabled in returned configuration and licence records.

## 4. Direct client access

The extension may read only its own user record, its own organization and
non-executable application configuration. It may write only its own strictly
allowlisted settings document.

Licences, invitations, audit events, usage/rate limits and all administrative
mutations are server-only. Firebase Storage has not been provisioned because
the MVP has no approved Storage use case; its checked-in policy denies all
access if provisioning is approved later.

## 5. Verification evidence

The following checks form the Phase 1 trust gate:

```powershell
npm run check
npm run lint
npm run test:functions
npm run test:firebase
```

Coverage includes:

- unauthenticated reads rejected;
- cross-user and cross-organization reads rejected;
- direct licence, audit and rate-limit access rejected;
- settings restricted to the allowlisted schema;
- recursive claim-content keys rejected;
- invitation tokens hashed deterministically;
- active, grace, expired and suspended licence behavior;
- the existing 100-test extension regression suite and matrix coverage.

## 6. Release boundary

Phase 1 does not connect the released extension to Firebase and does not change
its Manifest V3 permissions, RGHS DOM behavior, Preview, Apply or Undo flow.
The current Web Store privacy disclosures therefore remain accurate for
version 1.6.0.

Firestore rules and indexes are deployed to development. All eleven Node.js 22
callable Functions are deployed in `asia-south1` and were read back as
`ACTIVE`. The generated Function images have a seven-day Artifact Registry
cleanup policy to limit development storage costs.

Email/password Authentication is enabled and requires a password. The initial
account `nocturnaladmin@gmail.com` is email-verified, enabled and active with
the `platformAdmin` role and `platform` organization in both custom claims and
Firestore. A one-time password-setup email was sent to that address; no
password, OAuth token or service-account key was written to the repository.

The development IAM review found one human administrator:
`nocturnaladmin@gmail.com` (`NOCTURNAL_ADMIN`) with Owner. The other principals
are the App Engine default and Firebase Admin SDK service accounts required by
Firebase. No additional human administrator has access, and no service account
role was removed.

Production deployment, beta accounts, extension authentication and licence
enforcement belong to later controlled phases and require a fresh gate review.

## 7. Dependency review

The root production audit reports zero vulnerabilities. The Functions
production tree reports eight moderate transitive advisories and no high or
critical advisories. npm's suggested resolution requires `firebase-admin` 14,
while the selected stable `firebase-functions` release declares support only
through `firebase-admin` 13. A forced major or release-candidate upgrade was
not applied. Recheck this boundary before the first beta rollout.
