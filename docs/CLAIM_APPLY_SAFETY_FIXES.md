# Claim calculation and Apply safety fixes

These changes correct calculation, publication-validation and reviewed-Apply
defects without changing rule definitions, rule schema version or portal Submit.

## Dependency order

1. Central monetary inputs accept ungrouped, western-grouped and Indian-grouped
   amounts, optionally prefixed by the rupee symbol, Rs. or INR. Invalid monetary
   inputs block evaluation instead of silently becoming zero. Blank approvals
   start from the claim for amount rules; explicit zero approvals remain zero.
2. Non-cumulative deductions are capped against the claimed amount before being
   subtracted from the claim. Cumulative deductions remain capped against the
   current approval. Server publication scenarios use the same calculation and
   rejected-outcome semantics; shared monetary cases compare both evaluators.
3. Remark-only rules do not write approved amounts. Central advisory Apply uses
   the validated reviewer amount and ordinary remark override. Mandatory amounts
   and remarks remain protected, including non-finite/empty numeric overrides.
4. General previews include the claim identifier and exact page URL. Apply also
   checks the original target/source controls and their values, including secondary
   remark columns. Claim switches, replacement controls and relevant value/label
   changes require a fresh preview. Supported claim pages require an identifiable
   current claim before Apply. These checks apply to bundled and central modes.

The established bundled portal behavior that treats initial zero fields as
empty remains unchanged. Central policies distinguish an explicit zero from a
blank approval, matching their server-side synthetic scenarios.

## Validation and rollout

Regression tests exercise the actual Preview/Apply functions with synthetic
tables, the browser and server calculations against shared expected monetary
cases, and the actual content script in Chrome with real DOM controls. They
cover selective writes, mandatory enforcement, exact Undo and recovery failure
rollback as well as the original defects.

Before production rollout, deploy the corrected Functions evaluator, rerun
publication scenarios for affected central rules, and release the corrected
extension through the normal release workflow. A Functions-only deployment does
not correct amount parsing or Apply in already-installed extensions. Review the
minimum supported extension version when expanding centrally governed processing.
No backend deployment, rule publication or Store release is performed by these
source changes.

## Recovery, authentication and review workflow follow-up

- Undo batches carry their originating claim ID/page. Saved recovery requires the
  same identity; shared claim routes never fall back to URL-only matching when
  the current ID is unavailable. Partial Undo is retryable, and partial snapshot
  recovery records exactly which entries were restored.
- Session, entitlement and cached-rule writes share one queue. Sign-out/account
  changes invalidate earlier operations; guarded writes prevent late sign-in,
  token, licence and policy responses from recreating old state.
- Investigation counts use a dedicated safe whole-number parser. Currency text,
  scientific notation, decimals, negative numbers and unsafe integers are rejected.
- Review decisions are brokered through the service worker, scoped to the user,
  claim and page, and restored only against identical proposal/rule identities.
  A resumed high-risk decision requires fresh acknowledgement.
- Safe-row Apply refreshes remaining findings and carries only unchanged
  decisions. Warning/block details and local compare-mode amount differences are
  visible in the widget. IPD action remark edits participate in recovery/Undo.
- `npm run test:extension` loads the actual unpacked extension into a new Chrome
  profile against loopback-only fixtures. It covers real session storage, worker
  restart, multiple tabs, resumed selections, safe-row continuation, authoritative
  policy outages, exact Undo/recovery and delayed verification after sign-out.
