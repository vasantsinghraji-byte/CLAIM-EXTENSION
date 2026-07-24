# Privacy Policy for Claim Amount Auto-Fill

**Effective date:** 24 July 2026

**Extension version reviewed:** 1.5.1

Claim Amount Auto-Fill is a Chrome extension for authorized Rajasthan
Government Health Scheme (RGHS) claim reviewers. It helps users preview, audit,
and apply approved claim amounts and remarks on RGHS process sheets.

## Data the extension handles

The extension processes content from the current RGHS process sheet. Depending
on the page, this can include:

- claim or transaction identifiers;
- RGHS page URLs;
- package, procedure, investigation, and treatment descriptions;
- claim, approved, rate, unit, and deduction amounts;
- remarks and field values needed to preview, apply, undo, or recover a change;
- audit rule identifiers, findings, reviewer feedback, and extension actions;
- extension settings, custom review rules, remark templates, and widget
  position.

This information can constitute personally identifiable information, health
information, financial information, website content, browsing activity, and
user activity.

## How the data is used

The extension uses this data only to provide its disclosed purpose:

- detect supported RGHS process-sheet fields;
- calculate and display proposed approved amounts;
- screen configured package combinations for review risks;
- show a review and reconciliation interface;
- apply only the changes explicitly selected by the user;
- provide undo and recovery functions;
- keep local audit, activity, rule-feedback, and configuration records; and
- require acknowledgement of extension-applied changes before portal
  submission.

The extension is a review aid. It does not make final medical or claim
adjudication decisions and does not submit a claim automatically.

## Storage and retention

Data is stored using browser-provided storage:

- Settings such as enabled state and audit mode may be stored with Chrome Sync.
  These settings do not contain claim or patient details.
- Claim-related audit data, feedback, custom rules, remark templates, widget
  position, and recovery information are stored locally in the current Chrome
  profile.
- A local activity trail is limited to 500 events and entries older than 30
  days are removed during subsequent writes.
- Recovery snapshots are limited to 20 and expire after 24 hours during
  subsequent writes. A fully restored snapshot is removed.
- Audit and feedback records are bounded in size but otherwise remain until
  they are cleared by the user or replaced by normal extension operation.
- A short-lived submission summary may be stored in the RGHS tab's session
  storage for up to 24 hours and is scoped to the same portal path.

Users can clear the local audit and activity logs from the extension popup.
Removing the extension also removes its extension storage under Chrome's normal
extension-removal behavior.

## Data sharing and transmission

Claim Amount Auto-Fill does not send claim, patient, browsing, or extension
usage data to the developer, advertising services, analytics services, or other
third parties. It has no developer-operated backend and does not include
external analytics or advertising code.

The extension operates on the RGHS page already opened by the user. Changes
explicitly applied by the user become part of that page and may later be sent
to RGHS when the user independently submits the portal form. The extension
does not click or automatically submit that form.

Chrome may sync the non-claim settings described above according to the user's
Chrome account and browser settings. Google's handling of Chrome Sync data is
governed by Google's own terms and privacy policy.

## Security

The production extension runs only on `https://rghs.rajasthan.gov.in/*`. All
executable code is packaged with the extension; the extension does not download
or execute remote code. It requests only the `activeTab` and `storage`
permissions in addition to its RGHS host access.

No method of local storage can be guaranteed to prevent access by a person or
software that already controls the user's browser profile or device. Users
should protect their Chrome profile and workstation according to their
organization's security requirements.

## User choices and control

Users can:

- disable the claim tools from the extension popup;
- choose audit mode;
- preview changes without applying them;
- select which proposed changes to apply;
- undo or restore eligible changes;
- export or clear local audit/activity records;
- reset local rule overrides and custom configuration; and
- uninstall the extension.

## Limited Use

The extension's use of user data is limited to providing or improving its
single purpose. User data is not sold, used for personalized advertising, used
to determine creditworthiness or for lending, or transferred for unrelated
purposes.

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

This policy will be updated when the extension's data practices materially
change. The effective date at the top identifies the current version.

## Contact

For questions, troubleshooting, or privacy requests, use the public support
page:

`https://claim-amount-auto-fill.vasantsinghraji.chatgpt.site/support`
