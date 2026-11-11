# Comparison presentation

When the existing processing-rule mode is `compare`, Preview evaluates the
central rules alongside the bundled calculation and displays differing approval
amounts in the review widget. For example, a bundled approval of Rs. 200 and a
central proposal of Rs. 180 appear together with a **comparison only** label.

The comparison remains local and informational. It adds no selectable action,
does not change the bundled proposals, reconciliation or Apply fingerprint,
and never makes central rules authoritative. Apply and Undo use the existing
bundled workflow in compare mode. An existing approval remains the baseline
when bundled processing has no new amount proposal.

Only central amount actions differing by at least half a paisa are shown.
Equal amounts, unmatched rules and remark-only actions add no amount line.
If the central evaluation is invalid or blocked, the widget shows that the
comparison needs policy review while bundled processing remains authoritative.
This does not change how `remote-required` mode enforces central blocks.

The same explanation area shows policy warnings and block details. Messages
use text nodes, including rule/package labels, so message text cannot become
HTML. Every preview replaces the prior explanation list and hides it when
empty. A blocked preview disables both Apply Selected and Apply Safe Rows.

## Validation

`npm run check` exercises the actual Preview/Apply functions for differing/equal
amounts, unmatched and remark-only rules, invalid/blocked comparisons, existing
approvals, unchanged fingerprints and authoritative central blocks.

`npm run test:extension` loads the actual unpacked extension against synthetic
loopback fixtures and checks rendered comparison amounts, bundled Apply/Undo,
informational comparison blocks, authoritative blocks, literal HTML-like
messages, warnings and stale-message clearing. An optional
`COMPARISON_SCREENSHOT_PATH` captures the comparison widget for visual review.

Existing lint, browser smoke, backend, Firestore and lifecycle CI gates remain
in place. This PR changes no rule definitions, backend policy, mode selection,
dependencies or versions, and performs no deployment or release.
