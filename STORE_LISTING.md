# Chrome Web Store listing pack

Prepared from the production Manifest V3 package for version 1.5.1.

## Store listing

### Product name

Claim Amount Auto-Fill

### Summary

Preview, review, and apply approved RGHS claim amounts with local checks for unbundling and duplicate billing.

The summary is 110 characters and is suitable for the manifest `description`
field as well as the store summary.

### Detailed description

Claim Amount Auto-Fill helps authorized RGHS claim reviewers prepare approved
amounts while keeping every change under the reviewer's control.

The extension works only on the official Rajasthan Government Health Scheme
(RGHS) portal. It reads the current process sheet in the browser, proposes
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
- Configure review-only custom findings and remark templates.
- Require a final acknowledgement after extension-applied changes before the
  portal claim can be submitted.

Privacy and security:

- Claim processing happens locally in the user's browser.
- The extension does not send claim, patient, browsing, or usage data to the
  developer or to an external analytics or advertising service.
- Local audit records can contain claim identifiers, RGHS page URLs, package
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

Help authorized RGHS claim reviewers locally preview, audit, and apply approved
amounts and remarks on RGHS process sheets, with explicit review, recovery, and
submission-safety controls.

### Permission justification: activeTab

Used when the reviewer opens the extension popup to identify the currently
active tab and send the reviewer's Preview, Apply, Undo, or status request to
the Claim Amount Auto-Fill content script. It is not used to read unrelated
tabs or browsing history.

### Permission justification: storage

Used to store extension settings and profile-local operational data, including
the enabled state, audit mode, rule settings, remark templates, custom
review-only rules, widget position, audit feedback, audit/activity records, and
short-lived recovery snapshots. Claim data is not sent to the developer or an
external server.

### Host access justification: https://rghs.rajasthan.gov.in/*

Required to run the extension only on the official RGHS portal. The content
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

Do not select:

- Authentication information
- Personal communications
- Location

Explanation for the selected types:

The extension locally reads RGHS process-sheet website content, which may
contain claim identifiers, medical/package information, and monetary claim and
approved amounts. It records the current RGHS URL, rule results, and reviewer
actions locally to support audit history, feedback, recovery, and safety
controls. It does not send this data to the developer or third parties.

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

- Visibility: **Unlisted** for the controlled initial release.
- Regions: **India** only, unless the publisher has a documented need for other
  regions.
- Pricing: **Free**.
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
- [ ] Confirm `dist/manifest.json` version is 1.5.1 or higher than the last
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
- [ ] Verify that listing claims match version 1.5.1 behavior.

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

- [ ] Select **Unlisted**, **India**, and **Free** for the controlled initial
      release.
- [ ] Keep automatic publishing off for the first review.
- [ ] Confirm the publisher contact email is verified and monitored.
- [ ] Confirm all dashboard tabs show no blocking errors.
- [ ] Submit for review.
- [ ] After approval, perform one clean-profile installation and an RGHS
      process-sheet smoke test with synthetic or authorized test data.
- [ ] Verify Preview is read-only, Apply requires explicit review, Undo/recovery
      works, and the extension never submits the portal form.
- [ ] Publish only after the post-approval smoke test passes.
