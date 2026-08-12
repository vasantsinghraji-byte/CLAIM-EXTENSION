# Centralized Processing Rule Governance

## Status

Implemented in the repository. Deployment remains an explicit operator-controlled action.

## Authority

- Only a verified, active `platformAdmin` can create or modify drafts, validate, publish, activate, or roll back processing rules.
- Processors cannot mutate rules through Firestore, the extension background worker, or the Options page.
- Processors can submit structured, claim-free exception feedback.
- Callable Cloud Functions enforce authorization; Admin Panel visibility is not a security boundary.

## Publish lifecycle

1. Save drafts in `processingRuleDrafts`.
2. Validate the complete draft set and review its impact.
3. Run Admin-authored synthetic scenarios. Every high-impact rule must have passing coverage that triggers that rule.
4. For deduction, exclusion, or fallback-disable changes, create a 24-hour approval request. A different active platform administrator must approve it.
5. Publish an immutable document in `processingRuleSets`.
6. Atomically update `processingRuleState/active`.
7. Retain the old version for history and rollback.

Published documents are never edited. Rollback activates an earlier immutable version.

## Processor lifecycle

1. Preview requests a fresh active-version check through the extension service worker.
2. The client validates schema version 2 before evaluation.
3. Rules execute by ascending priority, then ascending rule ID.
4. Mandatory actions cannot be deselected or overridden through Claim Spark.
5. Preview records the version ID and checksum.
6. Apply rechecks the active version. A changed or unavailable authoritative version blocks Apply.
7. Undo and recovery remain local and available during backend outages.

When no published version exists, the backend reports `bundled` migration mode. Once the first version is published, the default becomes `remote-required` unless `appConfig/production.processingRulesMode` explicitly selects another rollout mode.

Supported modes:

- `bundled`: existing packaged behavior remains active.
- `compare`: downloads the central version without allowing it to control writes.
- `remote-required`: centrally published processing rules are authoritative and freshness is required.

Each published version also records whether the packaged safety fallback remains enabled. Keep it enabled while converting and parity-testing existing rules. After the complete baseline is represented centrally, publish with the fallback disabled; from that version onward, packaged deduction, combination, Pharmacy-cap, medicine, and remark behavior no longer controls processing. This cutover requires passing scenarios for every active rule and approval by a second administrator.

## Rule model

Schema version 2 supports:

- OPD, Pharmacy, IPD, or all processing areas.
- Nested `all`, `any`, and `not` conditions.
- Package presence, absence, and combinations.
- Processing-outcome and amount conditions.
- Warnings, blocking, exclusions, fixed/percentage/minimum/full deductions, controlled remarks, and required validations.
- Advisory, mandatory, blocking, and manual-review enforcement.
- Controlled semantic remark columns; arbitrary selectors and executable code are rejected.
- Guided Admin builders for conditions, actions, target columns, and synthetic scenarios; raw executable or JSON rule editing is not exposed.

Synthetic scenarios contain package codes, processing area, input amounts, and expected matches/block/approved amounts only. They are evaluated on the server against the complete ordered draft set immediately before an approval request and again immediately before approval.

## Feedback privacy

Central feedback contains only the rule ID, published version, category, processing area, normalized package codes, organization, actor, status, and server timestamps. It does not accept claim IDs, TIDs, patient data, narratives, monetary values, documents, URLs, or free-text portal remarks.

## Deployment order

1. Deploy Firestore rules.
2. Deploy Cloud Functions.
3. Deploy Firebase Hosting.
4. Release the extension containing schema-version-2 support.
5. Create and validate draft rules.
6. Publish the initial rule set with bundled fallback retained after the compatible extension reaches the controlled processor group.
7. Validate central-versus-bundled parity, Preview, Apply, version-change blocking, Undo, and feedback in the pilot group.
8. Publish the parity-complete version with bundled fallback disabled.
9. Expand to the remaining processors.

Publishing before compatible extensions are deployed is safe: incompatible extensions receive a failed-precondition response and cannot use the unsupported rule set.

## Operational rollback

Use the Admin Panel's Published Versions list to activate the last known-good version. Activations that introduce deductions, exclusions, or a disabled fallback also require a second administrator. Processors with an older Preview will be forced to preview again. Do not edit or delete the faulty published version; retain it for audit history.
