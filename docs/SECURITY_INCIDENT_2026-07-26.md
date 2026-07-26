# Firebase API Key Exposure Response

Date detected: 26 July 2026

Status: Contained and revoked. Historical purge was not performed because it
requires a separate, disruptive owner decision.

## Summary

GitGuardian detected a Firebase-provisioned Google API key committed in
`background.js`. A second production Firebase key was also found during the
repository-wide review.

Firebase web API keys identify a project; they do not authorize Firestore or
Cloud Functions access. Authorization remains enforced by Firebase
Authentication, live server-side role checks, Firestore Security Rules and
callable-function validation. Nevertheless, committed identifiers can consume
restricted quota and create recurring secret-scanning alerts, so both
environment keys were treated as exposed and rotated.

## Repository remediation

- Removed every Google API key literal from tracked source and tests.
- Added `.firebase-build-config.json` to `.gitignore`.
- Added a placeholder-only `firebase-build-config.example.json`.
- Extension and Hosting runtime configuration is generated during the build.
- Added `tools/check-no-secrets.js`; the standard `npm run check` fails if a
  tracked file contains a Google API key pattern.
- Generated extension, Hosting and local runtime configuration remains
  untracked.

## Cloud remediation completed

For both `claimextension` and `claimextension-prod`:

1. The Firebase browser key was rotated in Google Cloud Console.
2. The replacement was stored only in ignored local configuration.
3. Both replacements were verified to differ from both historically committed
   keys and from each other.
4. The tracked-file scanner, syntax checks, 144 automated tests, lint and
   production build passed.
5. Development Firebase Authentication responded successfully. Production
   returned `CONFIGURATION_NOT_FOUND`, documenting that Authentication has not
   yet been initialized in the production Firebase project.
6. The owner confirmed deletion of both replaced keys on 26 July 2026.

Google documents console rotation as an owner-controlled action. Do not send
replacement keys through email, chat, issues, commits or pull requests.

## History and alert actions

Rotation and revocation are complete. The remaining optional action is:

1. Decide whether to rewrite all branches and tags. Rewriting is disruptive,
   changes commit hashes and requires every existing clone to be discarded or
   carefully cleaned.
2. If approved, use `git-filter-repo --sensitive-data-removal --replace-text`
   from a fresh mirror clone, verify every ref, temporarily coordinate branch
   protection, and force-push the rewritten mirror.
3. Ask collaborators to re-clone.
4. Close GitHub secret-scanning alert 1 as **Revoked**.

The historical values are no longer valid credentials. Their presence in old
commits remains a scanner and repository-hygiene concern, not an active-key
exposure.
