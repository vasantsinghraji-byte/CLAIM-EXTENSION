# Claim Amount Auto-Fill Chrome Extension

An invite-only Chrome extension that locally previews RGHS approved-amount
proposals and applies only the rows explicitly selected by an authorized
reviewer.

Current release: **1.8.1**. Phase 3's approved single-user development pilot is
complete; Phase 4 production hardening and controlled distribution are next.

## Features

- **Automatic Detection**: Intelligently identifies claim amount and approved amount field pairs
- **Manual Commit**: Opening a process sheet never changes approved amounts; Preview and Apply are always explicit actions
- **Manual Control**: Enable claim tools, preview changes, apply them, or undo the latest fill
- **Floating Claim Spark**: Drag the process-sheet mascot anywhere in the viewport; it remembers its position and follows the Auto-fill toggle
- **Fresh DOM Review**: Every Preview reads the current process sheet, including dynamically loaded rows
- **Selective Review**: Choose individual rows; high-risk findings start unselected and require acknowledgement
- **Reconciliation**: Review selected claim, proposed approval, and claim-proposed difference totals before Apply
- **Stale Protection**: Apply is blocked when portal values changed or the preview is older than ten minutes
- **Recovery Snapshots**: Pre-Apply values are stored locally for up to 24 hours and can be restored after refresh
- **Invite-only Access**: Firebase email/password authentication, verified
  email, administrator activation, and organization licence checks
- **Administrator Controls**: Development licence renewal, invitation
  generation, and user activation without service-worker console commands
- **Onboarding Recovery**: Idempotent invitation handling safely repairs a
  missing profile only for the matching authenticated UID and email
- **Smart Matching**: Uses multiple strategies to find field pairs:
  - Name/ID attribute matching
  - Table structure analysis
  - Placeholder text recognition

## Installation

### Method 1: Install from Chrome Web Store (Coming Soon)
Once published, you'll be able to install directly from the Chrome Web Store.

### Method 2: Load as Unpacked Extension (For Development/Testing)

1. **Download the Extension**
   - For controlled distribution, extract `claim-autofill-extension.zip`
   - For development, clone the repository and run `npm run build`

2. **Open Chrome Extensions Page**
   - Open Google Chrome
   - Navigate to `chrome://extensions/`
   - Or click the three-dot menu → More Tools → Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the Extension**
   - Click "Load unpacked" button
   - Run `npm run build`, then select the generated `dist` folder
   - Click "Select Folder"

5. **Verify Installation**
   - The extension should now appear in your extensions list
   - Pin the extension to your toolbar for easy access

## Usage

### Basic Usage

1. **Sign in**
   - Use the exact invited and activated email account

2. **Navigate to Your Claim Form**
   - Open an authorized RGHS process sheet

3. **Safe Manual Filling**
   - Opening or updating a process sheet never modifies approved amounts
   - Use Preview, review the proposed counts, and explicitly Apply

4. **Manual Control**
   - Click the extension icon in your toolbar
   - Use the toggle to enable/disable the claim tools and floating widget
   - Click "Preview Fill", review the counts, then apply the changes
   - Use "Undo Last Fill" to restore the latest changed fields while the page remains open

### How It Works

The extension looks for field pairs by analyzing:
- Input field names and IDs containing "claim" or "approved"
- Table structures with claim and approved columns
- Placeholder text and labels

When a claim amount field has a value and its corresponding approved amount field is empty, the extension copies the claim amount to the approved field.

## Supported Field Patterns

The extension recognizes fields with these naming patterns:
- Claim fields: `claim_amount`, `claimAmount`, `claim`, etc.
- Approved fields: `approved_amount`, `approvedAmount`, `sanctioned_amount`, etc.

### Examples:
```html
<!-- Pattern 1: Name attributes -->
<input name="claim_amount" value="1000">
<input name="approved_amount" value="">

<!-- Pattern 2: ID attributes -->
<input id="claimAmt" value="2000">
<input id="approvedAmt" value="">

<!-- Pattern 3: Table structure -->
<table>
  <tr>
    <td>Claim Amount: <input type="text" value="1500"></td>
    <td>Approved Amount: <input type="text" value=""></td>
  </tr>
</table>
```

## Troubleshooting

### Extension Not Working?

1. **Refresh the Page**
   - After installing or updating the extension, refresh the webpage
   - Press `Ctrl+R` (Windows/Linux) or `Cmd+R` (Mac)

2. **Check Extension Status**
   - Click the extension icon
   - Verify that the "Claim tools enabled" toggle is ON

3. **Verify Field Names**
   - The extension works best with standard naming conventions
   - Fields should contain keywords like "claim", "approved", "sanctioned"

4. **Manual Fill**
   - Try previewing and applying a manual fill from the extension popup
   - Check the status message for results

5. **Console Logs**
   - Open Developer Tools (F12)
   - Check Console tab for any error messages
   - Record the exact message and consult the service-worker console only for
     controlled development troubleshooting

### Extension Icon Not Showing?

- Pin the extension: Click the puzzle piece icon in Chrome toolbar → Find "Claim Amount Auto-Fill" → Click the pin icon

## Customization

Portal-field detection and Apply behavior are safety-critical. Change them only
through the tested workflow in `DEVELOPMENT.md`; do not bypass the empty-field,
Preview, selection, stale-data, or acknowledgement gates.

## Calculation Rule

Medicine rows matching the configured RGHS descriptions receive a 12% deduction. The extension calculates 88% of the parsed claim and rounds to the nearest whole rupee using `Math.round`, because approved amounts are entered as whole rupees. Malformed, negative, empty, and zero claims are ignored.

## Privacy & Security

- **Local Processing**: Claim and process-sheet data is handled locally in the user's browser
- **Local Storage**: Settings, audit/activity records, reviewer feedback, and short-lived recovery snapshots are stored in the current Chrome profile as described in `PRIVACY_POLICY.md`
- **Minimum Cloud Data**: Firebase receives authentication, organization,
  licence, configuration, rate-limit, and privacy-safe event metadata. Claim,
  patient, clinical, amount, URL, and free-text remark content remains local.
- **Restricted Production Access**: The distributed extension runs only on the official `rghs.rajasthan.gov.in` portal; localhost access exists only in the source manifest for unpacked development
- **Privacy Policy**: See `PRIVACY_POLICY.md` for handled data, purposes, retention, sharing, and user controls
- **Open Source**: Code is fully visible and auditable

## Browser Compatibility

- **Chrome**: Version 88 or higher (Manifest V3 support)
- **Edge**: Version 88 or higher (Chromium-based)
- **Brave**: Latest version
- **Opera**: Latest version

## Development

### File Structure
```
claim-autofill-extension/
├── claim-core.js      # Tested calculation and decision rules
├── manifest.json      # Extension configuration
├── content.js         # Browser DOM integration
├── popup.html         # Extension popup interface
├── popup.js          # Popup functionality
├── popup.css         # Popup styling
├── icons/            # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── tests/             # Node.js regression tests
├── dist/              # Generated unpacked extension
└── README.md          # This file
```

### Technologies Used
- Manifest V3 (latest Chrome extension format)
- Vanilla JavaScript extension runtime (no remotely executed code)
- Chrome Extension APIs (storage, messaging, tabs)
- Firebase Authentication and callable Cloud Functions

### Build and Test

```bash
npm test
npm run check
npm run build
```

The build copies an explicit production allowlist to `dist/`, generates a production manifest without `localhost` or `127.0.0.1` content-script/web-resource matches, and creates `claim-autofill-extension.zip`. The build fails if a development origin appears in either production artifact. File ordering and ZIP timestamps are fixed, so identical sources produce an identical package.

### Claim Spark review workflow

1. Preview the current process sheet; this is read-only.
2. Click **Apply Safe Rows Now** to fill ordinary eligible rows immediately; audit findings remain untouched.
3. Related audit findings appear as one decision card. Use Jump to inspect each portal row.
4. Choose **Apply package deduction**, **Approve main only**, **Approve both/all**, or **Hold**. The card calculates each resulting approved amount.
   - For CA-01, **Apply package deduction** is preselected as the recommended decision: PTCA remains fully approved and only the separately billed CAG becomes zero. Preview does not write either value; the user must still press Apply.
5. Recommended actions do not require acknowledgement. An acknowledgement is required only for exceptional overrides such as approving every flagged line.
6. Confirm the selected totals reconcile, then Apply Selected. If the sheet changed after Preview, Apply is blocked.
7. Use Undo in the same page session or the two-step saved-snapshot recovery after a refresh.

The widget title shows the active manifest version. When claim tools are disabled, an obvious `Claim Extension OFF` badge remains near the portal header while the mascot stays hidden.
Popup status messages use one resettable hide timer, so a newer result always remains visible for its complete three-second interval.

### Live browser smoke test

On a process sheet with eligible empty rows, open DevTools, select the Claim Auto-Fill content-script execution context, paste `scripts/live-browser-smoke.js`, and run:

```js
await runClaimExtensionLiveSmoke()
```

The smoke test previews, applies only non-high-risk proposals, immediately undoes the fill, and compares every approved/remark control with its original value. It never clicks Submit and throws a blocking error if exact restoration fails.

### Safety and release controls

- Real RGHS process sheets must match the supported header and input mapping before Preview or Apply is allowed.
- If Claim Extension is turned off after Preview, Apply returns an explicit `autofill-disabled` block; it records no applied summary and cannot arm the submission interlock with empty or undefined counts.
- On compatible non-table layouts, claim/approved name and ID matching emits ordinary low-risk review proposals with stable keys; it never bypasses Preview, selection, Apply, Undo, or recovery.
- Table scanning assigns nested markup to one owning table and enumerates only direct rows and cells, preventing duplicate proposals or writes against the same nested DOM controls.
- Approved money fields receive normalized numeric text from the validated amount (`1,23,450.00` becomes `123450`), avoiding grouped-digit ambiguity in portal validation and server parsing.
- The submission interlock guards labelled submit controls and explicit submitters attached to the claim form. Native programmatic `form.submit()` does not emit a submit event and cannot be intercepted by a content-script event listener; this remains a documented portal-integration limitation.
- Activity, audit, feedback, and recovery appends are serialized by the background service worker with a queue per storage key, preventing concurrent RGHS tabs from overwriting one another's entries.
- Saved recovery snapshots are removed only after every saved control is restored. Zero-field and partial restores retain the snapshot so an SPA can finish rendering before another recovery attempt.
- TID detection retries after early SPA misses and caches only a successfully detected identifier, preserving TID-based audit and recovery matching when claim details render late.
- Passive audit passes reuse entity regexes through an object-identity cache, suppress scan logs unless `CLAIM_EXTENSION_DEBUG` is enabled, and send badge updates only when the finding count changes.
- Auto-deduct override edits are serialized through the service worker, merged against current profile-local storage, and reflected in every open options page. A one-time migration copies legacy synced overrides locally and then removes the legacy sync key; adjudication policy no longer propagates to other Chrome profiles.
- Content scripts deliberately use `all_frames: false`: RGHS process sheets are currently supported only in the top-level portal document, avoiding unnecessary iframe access. A future iframe portal layout requires an explicit compatibility review before enabling frame injection.
- Audit rules carry `schemaVersion`, `version`, and `effectiveDate`; invalid or duplicate rule definitions block claim processing.
- Fixed unbundling findings reserve both the main package and every separately billed component from ordinary autofill; only the configured target can receive a deduction after explicit high-risk review.
- `tools/matrix-coverage.json` maps every one of the 47 workbook Risk Matrix rows to executable rules. The build fails if a workbook row, title, or rule mapping drifts.
- Documentation-dependent upcoding risks (fracture extent, radical hysterectomy, fusion/fixation, burns severity, radiotherapy fractions, multi-trauma extent, cataract/SFIOL technique, and pacemaker/CRT configuration) create review-only proposals even when no second billed component is present.
- After extension-applied changes, Submit is intercepted until the reviewer acknowledges a final totals summary. The extension never clicks or submits the portal form.
- Restored submission summaries are type-normalized from page-origin session storage, checked for valid age/path, and rendered into the safety dialog only with `textContent`; stored markup cannot alter the trusted review UI.
- The local claim activity trail retains at most 500 events for 30 days. It records TID, route, counts, totals, rule IDs, and versions—never patient names, diagnoses, treatment, or free-text remarks.
- Use `npm run release -- patch`, `minor`, or `major` to align versions, update the changelog, validate, rebuild, and generate `release-manifest.json` with the distribution SHA-256.

### Shadow-mode promotion workflow (flag-only to auto-deduct)

Every deduct-eligible rule ships **flag-only**. Promotion to auto-deduct is a
data-driven decision backed by auditor feedback:

1. Work claims normally in flag mode. Each flagged row shows ✓ / ✗ buttons:
   **✓ confirms** the finding was correct; **✗ dismisses** it as a false
   positive (this also clears the highlight and the rule's remark segment).
   Verdicts are stored locally per rule in `chrome.storage.local`.
2. Open **Rules & Stats** from the popup (or the extension's Options page). It
   lists every bundle rule with its flagged/deducted counts, confirmed/dismissed
   feedback, and the resulting false-positive rate.
3. When a rule shows a clean record (FP rate green, meaningful sample size),
   switch its **Auto-deduct** toggle on. The override is stored in
   `chrome.storage.local` and applied over the generated rules at runtime — no
   rebuild needed. **Reset all overrides** returns to the generated defaults.
4. Deductions additionally require the popup mode "Flag + auto-deduct",
   code-confirmed matches, an empty approved field, and the per-sheet safety cap.
5. For permanent promotion (survives rule regeneration and applies to other
   machines), also flip `autoDeductEligible` in `tools/rule-curation.json` and
   run `python tools/generate-audit-rules.py`.

The toolbar icon shows a per-tab badge with the number of open audit findings
on the current process sheet. It is cleared when the tab begins a new navigation,
so page transitions cannot leave a stale count visible.

### Custom findings and portal remarks

Open **Rules & Stats** and use **Custom findings** to create profile-local
unbundling or upcoding-review rules without editing the generated
`audit-rules.js`. Custom rules require a unique ID, an exact code or validated
name pattern, a plain-language reason, and an optional reference. They always
start and remain review-only; adding a rule can never silently enable an
automatic deduction.

The same page provides decision-specific remark templates for approved,
deducted, rejected, and held rows. Approved Amount controls remain numeric-only;
templates are written only to portal Remarks. A blank deducted or hold template
keeps the specialized built-in wording. Configuration is stored in
`chrome.storage.local`, applies to open RGHS tabs, and can be exported/imported
as schema-versioned JSON without claim or patient data. Built-in generated rules
remain immutable and the editor can reset all custom configuration safely.

Every generated built-in rule listed on **Rules & Stats** also has an
**Edit remarks** action. Per-rule text takes precedence over the global template
only for that rule; for example, CA-01 can use different CAG wording without
changing BI-01 CBC remarks. **Restore this rule** removes the override and
immediately returns to the specialized generated wording.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the required workflow: GitHub Flow
branching (`feat/*`, `fix/*`, `chore/*`, `hotfix/*` — never commit to `main`),
Conventional Commits enforced by git hooks, pre-commit test/lint gates, PR
review with the claims-safety checklist, and CI that must be green to merge.

Contributions are welcome! Feel free to:
- Report bugs
- Suggest new features
- Submit pull requests
- Improve documentation

## License

MIT License - feel free to use and modify as needed.

## Support

If you encounter any issues or have questions:
1. Check the Troubleshooting section above
2. Review the console logs for error messages
3. Open an issue on the project repository

## Version History

### v1.0.0 (Current)
- Initial release
- Automatic claim to approved amount filling
- Toggle on/off functionality
- Manual fill trigger
- Table structure support
- Real-time DOM observation

## Roadmap

Future enhancements:
- [ ] Custom field mapping configuration
- [ ] Multiple page template presets
- [ ] Keyboard shortcuts
- [ ] Fill history/undo functionality
- [ ] Export/import settings
- [ ] Support for more complex form structures
