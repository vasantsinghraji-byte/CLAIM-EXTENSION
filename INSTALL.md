# Install Claim Amount Auto-Fill

Current release: **1.11.0**

Before building from source, create the ignored
`.firebase-build-config.json` described in `DEVELOPMENT.md`. Never commit that
file or generated `runtime-config.js`.

## Controlled pilot installation

1. Obtain `claim-autofill-extension.zip` from the administrator.
2. Verify its SHA-256 against `release-manifest.json`.
3. Extract the ZIP to a permanent folder.
4. Open `chrome://extensions`.
5. Enable **Developer mode**.
6. Select **Load unpacked**.
7. Choose the extracted folder that contains `manifest.json`.
8. Pin the extension from Chrome's Extensions menu.
9. Sign in with the invited and activated account.

Do not select the ZIP itself, load the repository root, or delete/move the
extracted folder after installation.

## Safe usage

Opening an RGHS page never changes portal fields. On a supported process sheet:

1. Select **Preview Fill**.
2. Review every proposal and audit finding.
3. Select the intended rows.
4. Select **Apply Selected** explicitly.
5. Use **Undo Last Fill** if restoration is required.

The extension never submits the claim.

## Updating an unpacked installation

1. Replace the extracted release folder with the newly supplied release.
2. Open `chrome://extensions`.
3. Select **Reload** for Claim Amount Auto-Fill.
4. Refresh any open RGHS page.

For development builds, run `npm run build` and load the generated `dist`
folder. See `DEVELOPMENT.md`.
