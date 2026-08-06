# Controlled Distribution Runbook

## Release artifact

Only distribute `claim-autofill-extension.zip` produced by `npm run release`.
Compare its SHA-256 value with `release-manifest.json` before upload.

## Clean-profile gate

Use a new Chrome profile containing no real RGHS data:

1. Load `dist` as an unpacked extension.
2. Confirm the displayed version.
3. Sign in to the production account.
4. Verify licence and administrator access as applicable.
5. Use a synthetic process sheet to run Preview, Apply and Undo.
6. Confirm Undo exactly restores all captured controls.
7. Confirm no patient, claim, amount, remark or RGHS URL appears in Firebase
   audit events.

## Chrome Web Store

1. Upload the verified ZIP in the Chrome Developer Dashboard.
2. Complete Store Listing, Privacy, Distribution and Test Instructions.
3. Choose **Public** visibility with distribution restricted to **India**.
4. Confirm pricing remains Free and the public listing disclosures are current.
5. Submit for review with deferred publishing.
6. After approval, recheck the package version, permissions, privacy
   declarations, visibility and regions.
7. Publish manually.

Do not email or host the ZIP for normal production installation. Chrome Web
Store distribution provides reviewed, signed updates and a controlled
installation path.

## Rollback

- Suspend the affected licence or organization if unsafe behavior could change
  portal fields.
- Stop onboarding and notify the approved tester.
- Use Chrome Web Store rollback when available, or submit the last known-good
  higher-version package.
- Preserve privacy-safe logs and open an incident record.
- Resume only after regression tests and a clean-profile smoke pass.

