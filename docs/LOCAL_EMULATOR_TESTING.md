# Local Emulator Testing

This workflow isolates Authentication, Cloud Functions, Firestore, and Hosting
from production. It uses only loopback addresses and Firebase's reserved demo
project ID `demo-claimextension`; no production credentials or data are
required, and unavailable emulators cannot fall back to live resources.

Firebase CLI requires Java 21 or newer. The start script uses `JAVA_HOME` when
it points to a compatible JDK and automatically detects common JDK 21+
installations on Windows.

## Run the automated licence acceptance test

From `C:\Users\hi\CLAIM-EXTENSION`, run:

```powershell
npm.cmd run test:lifecycle
```

This command starts isolated Auth, Functions and Firestore emulators, creates
temporary test identities and verifies both paid-access paths end to end:

- a single-use organisation roster code is claimed atomically, administrator
  approval respects the organisation licence and automatically activates the
  sponsored user's licence through the organisation expiry; and
- an individual user selects the four-week ₹300 plan, submits a synthetic UPI
  reference, remains blocked before payment verification, cannot receive the
  wrong licence duration, and receives access only after verification, account
  approval and exact-term activation.

The reserved `demo-claimextension` project ID and loopback emulator addresses
prevent the test from reaching production. Emulator data is discarded when the
command exits. No real payment or UPI request is made.

## Required release gate

The GitHub Actions validation job provisions Node.js 22 and Temurin Java 21,
then runs `npm run test:lifecycle` before building or uploading the extension
artifact. A failed emulator lifecycle therefore blocks the CI job and prevents
the package from being published as a validated artifact.

The local `npm run release -- patch|minor|major` workflow runs the same lifecycle
test before changing version files or building a release. Node.js 22 and Java
21 or newer must be installed for local releases.

## Start the isolated stack

From `C:\Users\hi\CLAIM-EXTENSION`, run:

```powershell
npm.cmd run emulators:local
```

Keep that terminal open. The command builds emulator-specific dashboard and
extension files, then starts Auth, Functions, Firestore, and Hosting.

In a second PowerShell terminal, run:

```powershell
Set-Location C:\Users\hi\CLAIM-EXTENSION
npm.cmd run emulators:seed
```

The seed command is loopback-only and refuses production implicitly by setting
the Admin SDK emulator hosts before initialization. It prints reusable local
credentials for an administrator and a pending individual user.

## Test the hosted dashboard

Open `http://127.0.0.1:5000/admin` and sign in with:

- Email: `admin@claim-spark.local`
- Password: `LocalAdmin!2026`

The seeded individual account is pending approval. In the dashboard:

1. Open **Users** and approve `individual@claim-spark.local`.
2. Select `2 weeks` in that user's license controls.
3. Click **Activate license** and verify the activation and expiry dates.
4. Select `4 weeks`, click **Extend license**, and verify the additive expiry.
5. Click **Deactivate license** and verify the account remains approved while
   paid-feature access is disabled.

## Test the unpacked extension

The `emulators:local` command also creates an emulator-only `dist` directory.
Load `C:\Users\hi\CLAIM-EXTENSION\dist` through `chrome://extensions` using
**Load unpacked**. This build talks only to loopback Auth and Functions.

Sign in as the seeded individual after completing the dashboard steps:

- Email: `individual@claim-spark.local`
- Password: `LocalUser!2026`

## Stop and reset

Press `Ctrl+C` in the emulator terminal. Emulator data is in memory and is
discarded when the stack stops. Start it again and rerun `emulators:seed` for a
clean test environment.

Run `npm.cmd run build` before producing a release. The normal build continues
to use production configuration and strips development origins from the ZIP.
