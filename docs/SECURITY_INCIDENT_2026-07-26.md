# Firebase API Key Exposure Response

Date detected: 26 July 2026

Status: Tracked-source remediation complete; cloud rotation and historical
purge require owner-controlled actions.

## Summary

GitGuardian detected a Firebase-provisioned Google API key committed in
`background.js`. A second production Firebase key was also found during the
repository-wide review.

Firebase web API keys identify a project; they do not authorize Firestore or
Cloud Functions access. Authorization remains enforced by Firebase
Authentication, live server-side role checks, Firestore Security Rules and
callable-function validation. Nevertheless, committed identifiers can consume
restricted quota and create recurring secret-scanning alerts, so both
environment keys are treated as exposed and must be rotated.

## Repository remediation

- Removed every Google API key literal from tracked source and tests.
- Added `.firebase-build-config.json` to `.gitignore`.
- Added a placeholder-only `firebase-build-config.example.json`.
- Extension and Hosting runtime configuration is generated during the build.
- Added `tools/check-no-secrets.js`; the standard `npm run check` fails if a
  tracked file contains a Google API key pattern.
- Generated extension, Hosting and local runtime configuration remains
  untracked.

## Cloud owner actions

For both `claimextension` and `claimextension-prod`:

1. Open Google Cloud Console → APIs & Services → Credentials.
2. Open the Firebase browser key used by the Web App.
3. Confirm API restrictions allow only required Firebase APIs, specifically
   Identity Toolkit and Token Service for the current application.
4. Confirm unrelated APIs, especially Generative Language API, are absent.
5. Choose **Rotate key**, preserve the restrictions and record the new value
   only in local `.firebase-build-config.json`.
6. Rebuild and test both environments.
7. Delete the old key after successful verification.

Google documents console rotation as an owner-controlled action. Do not send
the replacement key through email, chat, issues, commits or pull requests.

## History and alert actions

After rotation:

1. Decide whether to rewrite all branches and tags. Rewriting is disruptive,
   changes commit hashes and requires every existing clone to be discarded or
   carefully cleaned.
2. If approved, use `git-filter-repo --sensitive-data-removal --replace-text`
   from a fresh mirror clone, verify every ref, temporarily coordinate branch
   protection, and force-push the rewritten mirror.
3. Ask collaborators to re-clone.
4. Close GitHub secret-scanning alert 1 as **Revoked** after the old key is
   deleted. If rotation is deliberately not performed after restrictions are
   verified, close it as **False positive** with Firebase public-key
   documentation and restriction evidence.

No history rewrite or alert closure should claim revocation before Google Cloud
confirms the old key is deleted.

