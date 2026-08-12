# Staging Deployment Checklist

This procedure verifies the hosted administrator dashboard and the unpacked
extension against the approved non-production Firebase project
`claimextension`. The production project `claimextension-prod` must not be used
for any command in this checklist.

## 1. Preconditions

- Use a reviewed commit from a feature branch; do not deploy an unreviewed
  working tree.
- Install Node.js 22 and Java 21 or newer.
- Confirm the Firebase CLI account is authorized for `claimextension`.
- Confirm Email/Password Authentication is enabled in the staging project.
- Confirm the staging project is on the required billing plan with a budget
  alert before deploying Functions.
- Keep `.firebase-build-config.json` untracked. Its `development` entry must use
  the staging Web API key and exactly this Functions endpoint:
  `https://asia-south1-claimextension.cloudfunctions.net`.
- Prepare a verified, active staging `platformAdmin` account. Never place its
  password in this repository, documentation, command history, or logs.

## 2. Pre-deployment validation

From `C:\Users\hi\CLAIM-EXTENSION`:

```powershell
git status --short --branch
npx.cmd firebase-tools login:list
npx.cmd firebase-tools projects:list
npm.cmd run check
npm.cmd run lint
npm.cmd run test:functions
npm.cmd run test:firebase
npm.cmd run test:lifecycle
npm.cmd run build:staging
```

Inspect `dist/runtime-config.js`, `dist/manifest.json`, and
`hosting-build/firebase-client.js`. They must reference `claimextension`, never
`claimextension-prod`, localhost, or an emulator. The staging build does not
create or overwrite the production ZIP.

## 3. Deploy in dependency order

Use the explicit project and staging configuration on every command:

```powershell
npx.cmd firebase-tools deploy --only firestore --project claimextension --config firebase.staging.json
npx.cmd firebase-tools deploy --only functions --project claimextension --config firebase.staging.json
npx.cmd firebase-tools deploy --only hosting --project claimextension --config firebase.staging.json
```

Stop immediately if the CLI displays any project other than `claimextension`.
Do not copy production Auth users, licences, roster entries, payment references,
or Firestore documents into staging.

## 4. Automated staging smoke

Set the administrator email normally and enter the password without echoing it:

```powershell
$env:STAGING_ADMIN_EMAIL = 'staging-admin@example.test'
$stagingPassword = Read-Host 'Staging administrator password' -AsSecureString
$env:STAGING_ADMIN_PASSWORD = [Net.NetworkCredential]::new('', $stagingPassword).Password
try {
  npm.cmd run test:staging
} finally {
  Remove-Item Env:STAGING_ADMIN_EMAIL -ErrorAction SilentlyContinue
  Remove-Item Env:STAGING_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
```

The smoke test is locked to `claimextension` and verifies:

- all public dashboard routes and deployed security headers;
- the deployed dashboard contains the staging Firebase configuration;
- unauthenticated callable requests are rejected by the staging backend;
- the staging administrator can sign in, load their profile, and call
  `listUsers`;
- `dist` uses staging Auth/Functions permissions, excludes administrator-supplied
  payment artifacts, and opens the staging administrator dashboard; and
- no production, localhost, or emulator endpoint is present in the unpacked
  staging extension configuration.

## 5. Manual dashboard acceptance

1. Open `https://claimextension.web.app/admin` in a private browser window.
2. Sign in with the staging administrator account.
3. Confirm Users, Invitations, Organizations, Roster, Licences, Payments, and
   Audit panels load without authorization or console errors.
4. Use only synthetic staging users and transaction references.
5. Confirm no password, ID token, UPI credential, or claim data appears in the
   browser console or persisted local storage. Dashboard authentication must
   remain session-only.

## 6. Manual unpacked-extension acceptance

1. Open `chrome://extensions`, enable Developer mode, and choose **Load
   unpacked** for `C:\Users\hi\CLAIM-EXTENSION\dist`.
2. Inspect the extension service worker and confirm requests go only to
   `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, and
   `asia-south1-claimextension.cloudfunctions.net`.
3. Sign in with a verified synthetic staging user that has an active licence.
4. Confirm the popup reports active access and the administrator launcher opens
   `https://claimextension.web.app/admin`.
5. On an approved non-production test page, run Preview and confirm no fields
   change. Run Apply/Undo only with synthetic data and verify exact restoration;
   never click the portal Submit control.

## 7. Record the result

Record the commit SHA, Firebase project, deployment timestamps, smoke-test
result, browser/extension version, staging identities used, and any findings.
A staging failure blocks production deployment. Remove the unpacked staging
extension before installing or testing a production build.
