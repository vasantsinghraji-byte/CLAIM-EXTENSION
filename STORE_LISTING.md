# Chrome Web Store listing pack

Listing draft for the controlled Manifest V3 release candidate **1.12.0**.
The recorded public Store version remains **1.11.1** until this update is approved
and explicitly published. This file does not change the live Store listing.
The package targets the isolated production Firebase project. The package can
be saved as a Store draft; submission awaits the required source review and
compatible production deployment, with automatic publication disabled.

Production policy and support URLs after Hosting deployment:

- `https://claimextension-prod.web.app/privacy`
- `https://claimextension-prod.web.app/support`
- `https://claimextension-prod.web.app/terms`
- `https://claimextension-prod.web.app/deletion`

## Store listing

### Product name

Claim Amount Auto-Fill

### Summary

Preview, review, and fill approved claim amounts with checks for unbundling and duplicate billing.

The summary is 98 characters and matches the manifest description.

### Detailed description

Claim Amount Auto-Fill helps authorized claim reviewers prepare approved
amounts while keeping every change under the reviewer's control.

The extension works on supported claim portals. Site access is limited to the
portal integration included in this package; other portals require a validated
integration. It reads the current process sheet in the browser, proposes
approved amounts, and checks configured package combinations for possible
unbundling, duplicate billing, and documentation-dependent review risks.

Key features:

- Preview changes before any approved amount or remark is modified.
- Review proposed amounts, deductions, remarks, and totals before applying.
- Keep high-risk findings unselected until the reviewer makes an explicit
  decision.
- Flag bundled services, repeated packages, and configured review risks.
- Undo the latest applied changes or restore a locally saved recovery snapshot.
- Export local audit and activity records for the reviewer.
- Use centrally administered processing rules with validation, version history
  and rollback; processor-side rule configuration is read-only.
- Verify investigation report counts beside the PDF, preview amount and remark
  changes, acknowledge reductions and Apply with recovery and Undo.
- Show claim history, e-card summaries and document-review helpers on supported
  claim pages. Claim submission remains the reviewer's native portal action.
- Require verified, licensed accounts. Default platform registration activates
  only when the platform organisation/licence is active and user capacity remains;
  sponsored and individual-payment paths retain their applicable approvals.

Privacy and security:

- Claim processing happens locally in the user's browser.
- Firebase receives account, organization, licence, rate-limit, extension
  version, and privacy-safe access metadata. Claim, patient, clinical, amount,
  URL, document, and free-text remark content is not sent to Firebase.
- Local audit records can contain claim identifiers, claim-page URLs, package
  and amount details, rule results, and reviewer actions.
- Recovery snapshots can temporarily contain the prior and replacement values
  of fields changed by the extension.
- Recovery snapshots are retained for up to 24 hours; the privacy-safe activity
  log is retained for up to 30 days. Other locally stored audit/configuration
  records remain until the user clears or changes them.
- The user can clear local audit and activity logs from the extension popup.

This extension is a review aid. It does not make a final medical or claim
adjudication decision, does not submit claims automatically, and does not
replace the reviewer's verification of portal data and supporting documents.

### Category

Tools

### Language

English

### Homepage URL

`https://claim-amount-auto-fill.vasantsinghraji.chatgpt.site/`

### Support URL

`https://claim-amount-auto-fill.vasantsinghraji.chatgpt.site/support`

### Privacy policy URL

`https://claim-amount-auto-fill.vasantsinghraji.chatgpt.site/privacy`

### Official URL

Optional. Select a Search Console-verified site only if one is already verified
for the publisher account. Otherwise leave this field blank.

### Promo video

Optional. Leave blank for the initial submission unless an accurate public
YouTube walkthrough is available.

## Privacy practices

### Single purpose

Help authorized claim reviewers locally preview, audit, and apply approved
amounts and remarks on claim process sheets, with explicit review, recovery, and
submission-safety controls.

### Permission justification: activeTab

Used when the reviewer opens the extension popup to identify the currently
active tab and send the reviewer's Preview, Apply, Undo, or status request to
the Claim Amount Auto-Fill content script. It is not used to read unrelated
tabs or browsing history.

### Permission justification: storage

Used to store extension settings and profile-local operational data, including
the enabled state, audit mode, centrally published rule data, widget position,
investigation review state, audit feedback, audit/activity records, and
short-lived recovery snapshots. Claim data is not sent to the developer or an
external server.

### Permission justification: alarms

Used to schedule a bounded licence recheck. The alarm never reads or changes
claim portal fields and never initiates Preview, Apply, Undo, or submission.

### Permission justification: tabs

Used to locate the matching open claim process sheet, connect it to the separate
investigation checklist window, and open same-origin claim documents when the
reviewer requests them. Unrelated tab contents and browsing history are not read
or uploaded. The checklist window remains bound to its own claim identifier.

### Host access justification: Firebase authentication and Functions

`identitytoolkit.googleapis.com` and `securetoken.googleapis.com` provide
email/password authentication and token refresh. The configured
`asia-south1` callable Functions origin verifies the account, organization,
role and licence and performs administrator-authorized mutations. Claim and
patient content is not included in these requests.

### Host access justification: https://rghs.rajasthan.gov.in/*

Required to run the extension on the supported claim portal declared in the package. The content
script reads the visible process-sheet fields needed to propose approved
amounts and audit package combinations, writes only changes explicitly applied
by the reviewer, and adds the on-page Claim Spark review interface. No other
production website is included.

### Remote code

Select: **No, I am not using remote code.**

Justification if a text field is shown:

All executable JavaScript is packaged with the extension. The extension does
not download or execute remote JavaScript or WebAssembly.

### Data handling answer

Select: **Yes, this extension collects or uses user data.**

Google treats local processing and local storage as data handling. Select these
data types conservatively:

- Personally identifiable information
- Health information
- Financial and payment information
- Web history
- User activity
- Website content

Also select:

- Authentication information

Do not select:

- Personal communications
- Location

Explanation for the selected types:

The extension locally reads claim process-sheet website content, which may
contain claim identifiers, medical/package information, and monetary claim and
approved amounts. It records the current claim portal URL, rule results, and reviewer
actions locally to support audit history, feedback, recovery, and safety
controls. It does not send claim content to the developer or third parties.
For individual paid access, the Firebase service stores the UPI transaction ID
(UTR) submitted by the user and its verification metadata. The extension never
requests or stores UPI PINs, OTPs, card numbers or bank-account credentials.

### Data usage certifications

Certify all only after confirming the uploaded package matches this audit:

- Data use is limited to the extension's disclosed single purpose.
- Data is not sold or transferred to third parties except as permitted by the
  Chrome Web Store User Data Policy.
- Data is not used or transferred for purposes unrelated to the single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.
- Data is not used for personalized advertising.
- Humans do not read user data except where the Chrome Web Store Limited Use
  policy expressly permits it.

### Limited Use disclosure

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Distribution

- Visibility: **Public**.
- Regions: **India** only, unless the publisher has a documented need for other
  regions.
- Download pricing: **Free**. The service includes paid individual licences and
  organisation-sponsored access. Mark the listing as containing paid features
  or in-app purchases in the Chrome Web Store dashboard before publishing this
  workflow.
- Individual plan prices: ₹99 for 1 week, ₹198 for 2 weeks, ₹300 for 4 weeks,
  and ₹500 for 12 weeks. The official UPI QR is supplied separately by an
  administrator and is not bundled with the extension.
- Publish automatically after approval: **Off** for the first release, so the
  approved listing can receive a final manual check before publication.

## Graphic assets

- Store icon: `icons/icon128.png` (128x128 PNG).
- Screenshot 1: `store-assets/screenshot-1-popup.png` (1280x800 PNG).
- Screenshot 2: `store-assets/screenshot-2-review.png` (1280x800 PNG).
- Small promo tile: `store-assets/small-promo-tile.png` (440x280 PNG).
- Marquee promo tile: optional, 1400x560.

The screenshots use synthetic claim information and must not contain live
patient or claim data.

## Publishing checklist

### Package

- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Confirm `dist/manifest.json` version is 1.9.1 or higher than the last
      uploaded version.
- [ ] Confirm production matches contain only
      `https://rghs.rajasthan.gov.in/*`.
- [ ] Confirm the ZIP has `manifest.json` at its root.
- [ ] Upload `claim-autofill-extension.zip`.
- [ ] Review dashboard package warnings and resolve every error.

### Store listing

- [ ] Paste the detailed description above.
- [ ] Select category **Tools**.
- [ ] Select language **English**.
- [ ] Upload the 128x128 icon.
- [ ] Upload both 1280x800 screenshots.
- [ ] Upload `store-assets/small-promo-tile.png` as the 440x280 small promo
      tile.
- [x] Public homepage, support, and privacy-policy URLs are deployed.
- [ ] Verify that listing claims match version 1.12.0 behavior.

### Privacy practices

- [ ] Paste the single-purpose statement.
- [ ] Paste each permission and host-access justification.
- [ ] Declare no remote code.
- [ ] Select the six audited data categories above.
- [ ] Publish the privacy policy and paste its public HTTPS URL.
- [ ] Confirm the privacy policy, dashboard disclosures, and package behavior
      are consistent.
- [ ] Complete the Limited Use certifications.

### Distribution and submission

- [ ] Confirm **Public**, **India**, and **Free** for version 1.12.0.
- [ ] Keep automatic publishing off for the first review.
- [ ] Confirm the publisher contact email is verified and monitored.
- [ ] Confirm all dashboard tabs show no blocking errors.
- [ ] Submit version 1.12.0 for review with publication deferred.
- [ ] After approval, perform one clean-profile installation and a supported claim
      process-sheet smoke test with synthetic or authorized test data.
- [ ] Verify Preview is read-only, Apply requires explicit review, Undo/recovery
      works, and the extension never submits the portal form.
- [ ] Publish only after the post-approval smoke test passes.
