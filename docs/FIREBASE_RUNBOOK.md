# Firebase Foundation Runbook

## Environment selection

```powershell
npx firebase use development
npx firebase use production
```

Prefer explicit project flags in scripts and release work:

```powershell
npx firebase projects:list
npx firebase deploy --only firestore --project claimextension
```

Never use the production alias for emulator tests.

## Local verification

```powershell
npm install
npm --prefix functions install
npm run check
npm run lint
npm run test:functions
npm run test:firebase
```

The Functions package targets Node.js 22. Use Node.js 22 for deployment and
local parity even if another compatible Node version is installed globally.

## Development deployment

1. Confirm the CLI account with `npx firebase login:list`.
2. Confirm `git status --short --branch`.
3. Run all local verification commands.
4. Confirm the target is exactly `claimextension`.
5. Confirm the project is on Blaze and has an appropriate budget alert before
   any Functions deployment.
6. Deploy rules before Functions:

```powershell
npx firebase deploy --only firestore --project claimextension
npx firebase deploy --only functions --project claimextension
```

7. Read back database location and deployed resources.
8. Test with emulator/beta identities; never use live claim content.

Firebase Storage is deliberately not provisioned. Do not create a bucket until
a separate use case, data inventory, retention rule and access-policy review
are approved.

## Production gate

Do not deploy to `claimextension-prod` merely because development is green.
Production requires:

- reviewed commit and clean worktree;
- successful development deployment;
- invitation and authentication tests;
- completed single-user development-pilot approval;
- Phase 4 security, privacy, backup and distribution review;
- privacy and Web Store disclosure consistency;
- explicit production go/no-go.

## Production deployment

The production Web App is separately registered in `claimextension-prod`.
The distributable build replaces the development public API key and Functions
origin with the production values. Never copy development Auth users,
invitations, licences or Firestore data into production.

After all production gates in `PHASE_4_PRODUCTION_READINESS.md` pass:

```powershell
npx firebase deploy --only firestore --project claimextension-prod
npx firebase deploy --only functions --project claimextension-prod
npx firebase deploy --only hosting --project claimextension-prod
```

Enable Email/Password Authentication and bootstrap the platform administrator
through a password-private human procedure. Do not create, transmit or store
the administrator password in this repository.

List backup schedules:

```powershell
npx firebase firestore:backups:schedules:list --database "(default)" --project claimextension-prod
```

The approved production target is one daily backup with 14-day retention.
Record a restore drill into a separate database before publication.

## Incident defaults

- Suspected credential exposure: revoke the credential and reauthenticate.
- Suspected user compromise: suspend the user and revoke refresh tokens.
- Licence uncertainty: deny Apply; Preview may remain available only within
  the documented 72-hour grace period.
- Backend outage: do not alter portal fields and do not bypass authorization.
- Sensitive data in logs: stop the affected path, restrict access, preserve
  minimum incident evidence and follow the approved deletion process.
