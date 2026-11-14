# Security release 1.12.2 preparation

Prepared November 14, 2026 from main at
`30f67e71aefca35c8f7128c610fb0cda833b5462`, after merged
[security PR #53](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/53)
and [release-validation PR #52](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/52).
Status: local review candidate. Production deployment and Store publication
are separate actions and have not been performed by this preparation.

## Included behavior

- Rule download and rule feedback now require the same current server-owned
  entitlement decision as licence verification, including expiry, organization,
  activation/payment, minimum-version and maintenance policy.
- Every authenticated callable checks current Firebase session revocation.
  Revoked/disabled/deleted identities are rejected; Auth lookup failures deny.
- Active client decisions last at most five minutes, bounded by licence and ID
  token expiry. Critical operations request fresh checks. Verification outages
  clear cached rules/authority and block new processing. Local Undo/recovery stay
  available.
- Controlled rejection metadata supports operational investigation. MIT stays
  unchanged. Claim calculations remain local; the requested
  [server-calculation design](SERVER_CALCULATION_PROPOSAL.md) is a proposal only.
- Release validation now runs all eight acceptance gates against the candidate
  version before packaging, with metadata rollback on failure.

This PR updates extension/package/lock versions, release metadata, changelog and
release/privacy guidance. It adds no further runtime behavior, financial policy,
dependency, permission, production setting or minimum-version change. The
Functions package keeps its independent version.

## Candidate identity and validation

Both base merges passed hosted CI: [#53 post-merge run 43592971036](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/actions/runs/43592971036)
and [combined main run 43593511412](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/actions/runs/43593511412).

The clean isolated worktree ran `npm run release -- patch --notes ...` using
Node 22 and Java 21. All eight candidate gates passed:

- Matrix coverage, syntax/secret checks and 315 root tests.
- ESLint and 69 Functions tests.
- Standard/investigation/companion real-Chrome smoke.
- Actual-extension acceptance, including offline denial and exact local
  Undo/recovery, worker restart, account isolation and review cleanup.
- Hosted-dashboard browser acceptance using synthetic loopback data.
- All 6 Firestore security-rules emulator tests.
- Complete Auth/Functions/Firestore signup, payment/licence, governance and
  monitoring lifecycle, including unsupported versions, expired/revoked licences,
  live token revocation and disabled Auth identities.

The command built and verified the production candidate after those gates.
A second independent build produced identical bytes. Artifact verification
checks all five version values, SHA-256 and every packaged byte against the
current production source/configuration. Regenerated audit rules match source;
all 19 relative links in the reviewed documentation resolve. The lockfile changes
only version metadata. The local command's output does not mean a Store release
or deployment occurred.

Production candidate SHA-256:
`04050810588C8B045A6327C0A4CCEDB2E8D70149A48A3BB8693935E9B19F3BA3`.
The versioned ignored copy is
`artifacts/claim-autofill-extension-1.12.2.zip` in the release worktree.
Its hash and build timestamp are recorded in `release-manifest.json`.

Rebuild this candidate with `npm run build`, then `npm run verify:artifact`.
Running `npm run release -- patch` again would prepare the next version and is
not the rebuild command. Any packaged-source/configuration change requires
regenerated metadata and repeated candidate validation before distribution.

CI builds a non-deployable placeholder package. Distribute only the production
ZIP verified against the final source/configuration and `release-manifest.json`.
The old 1.12.1 ZIP predates the security changes and is not this candidate.

## Deployment and publication order

1. Review and merge this preparation after successful CI. Confirm that merged
   packaged source matches the candidate; rebuild/reverify if it differs. Check
   the currently deployed backend and Store version through the authorized
   consoles. Historical documentation is not proof of the live environment.
2. Use the approved non-production project `claimextension` and the
   [staging checklist](STAGING_DEPLOYMENT_CHECKLIST.md) to validate compatibility
   before production. Keep production users, credentials and records out of
   staging. Stop on failed security or restoration acceptance.
3. In an explicitly authorized production rollout, deploy **all Functions** from
   the reviewed source to `claimextension-prod`. The wrapper affects every
   authenticated callable, not only `verifyLicence` or rule download. From the
   reviewed checkout with authorized Firebase CLI credentials:

   ```powershell
   npx.cmd firebase-tools deploy --only functions --project claimextension-prod --config firebase.json
   ```

   Verify the displayed project before continuing. This candidate introduces no
   Firestore rules/index changes. Any outstanding earlier rollout must still be
   checked against its own reviewed requirements. Update the separately managed
   public privacy page/disclosures through the normal approved publication path.
4. Verify denied/allowed cases with authorized synthetic accounts: active access,
   expired/inactive licence, same-token revocation, disabled identity, maintenance
   and unsupported versions. Never test by suspending real users or globally
   changing production minimum/maintenance settings. Use isolated staging for
   configuration-changing cases. Confirm dashboard sign-in and existing onboarding.
5. Check rejection rates, Auth lookup availability/latency and Function resource
   usage. All authenticated calls now perform an extra live Auth lookup. Outages
   deliberately deny new processing; provide support guidance and verify that
   Undo/recovery remain available.
6. Load the verified production candidate in a clean profile and perform the
   authorized synthetic acceptance in the
   [controlled-distribution runbook](CONTROLLED_DISTRIBUTION.md). Upload only the
   matching production ZIP through the established Store review process; review
   permissions/disclosures and publish explicitly after approval.
7. Confirm Store availability to installed users before considering a new
   minimum version. Do not claim minimum-version enforcement proves the caller
   is running an authentic binary: client version claims are modifiable.

## Failure handling and residual limits

Record source SHA, target project, deployed revisions/time, verified artifact hash,
Store submission/version and smoke evidence in the rollout record. Keep prior
verified packages and source available. Do not clear user restoration data.

If deployment or compatibility verification fails, stop extension distribution
and minimum-version changes, preserve privacy-safe logs and investigate. A
rollback that removes the new authority checks reopens the confirmed service
vulnerability; prefer a reviewed forward fix or controlled access restriction.
Any production rollback/account restriction requires its own authorized action.
Do not assume a lower-version ZIP can replace installed Store extensions.

Already downloaded rules, old bundled calculations and modified offline copies
cannot be remotely recalled. Hosted authorization does not prevent use of an
authorized person's copied credentials until revocation. See the
[security assessment](LICENSING_SECURITY_ASSESSMENT.md) for the exact trust boundary.
No claim-data upload, server calculation API, automatic piracy detection or
production alert is implemented by this candidate.
