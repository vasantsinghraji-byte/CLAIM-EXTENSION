# Apply, Undo, and review recovery

Preview/Apply is bound to the exact claim identifier, page URL, row controls,
captured values, and reviewer-visible labels. Replacing a control, changing
claims on a reused route, or changing a relevant remark requires a new preview.
Supported claim pages require an identifiable claim before Apply.

Central remark-only proposals carry `proposedApproved: null`; the content
writer skips approved-amount writes for those proposals. Reviewed advisory
amounts and remarks are applied exactly as validated, while mandatory actions
remain protected. If recovery cannot be saved, the write batch is rolled back.

Undo batches and persistent snapshots carry their originating claim and exact
URL. Missing claim identifiers on shared routes block restoration. Undo retains
unresolved entries for retry. Partial persistent recovery removes only restored
entries and reports changed values and unavailable controls separately. IPD
action remarks use the same saved recovery and Undo path as amount changes.

The floating widget sends saved review decisions through the service worker;
content scripts do not access `chrome.storage.session` directly. Saved reviews
are scoped to user, claim, and exact page, expire after 24 hours, and are capped
at 30 entries. Sign-in/sign-out clears review memory and invalidates in-flight
review requests. Resuming requires identical preview and rule identities and
requires fresh acknowledgement of high-risk findings.

Applying safe rows refreshes the remaining findings and carries decisions only
for unchanged rows under the same policy. The widget prevents overlapping Apply
actions and keeps Undo/recovery controls available when unresolved fields remain.

## Validation

Run `npm run check`, `npm run lint`, and `npm run test:functions` for the unit
and integration regressions. `npm run test:browser` exercises actual DOM writes,
reviewed overrides, stale controls, exact Undo, and recovery failure rollback.

`npm run test:extension` loads the actual unpacked extension in a temporary
Chrome profile with real extension APIs and a synthetic loopback backend. It
covers claim-bound Undo, service-worker restart, saved review resumption,
multi-tab isolation, safe-row continuation, policy freshness, offline recovery,
and clearing review state on sign-out. It does not use production accounts.
Set `CHROME_PATH` if Chrome is not installed in a standard location.

Authentication/onboarding behavior, licence policy, report-count parsing,
comparison-mode presentation, administrator dashboard changes, and release
versioning are separate work. This PR uses the already-merged calculation fixes
from #44 and includes only their required remark-only writer integration.
