# Phase 0 — Product and Data Baseline

Status: Implementation baseline

Extension version: 1.6.0

Architecture target: Invite-only, non-AI MVP

This document freezes the behavior and data boundaries that must remain intact
while authentication, licensing, administration, and hosting are introduced.
Phase 1 must not begin by changing claim-processing behavior.

## 1. Approved MVP workflows

### Workflow A — Approved-amount assistance

1. An authorized processor opens an RGHS process sheet.
2. The extension reads the current claim and approved-amount controls.
3. The processor requests a preview.
4. The extension proposes changes without writing to the portal.
5. The processor reviews row selections and reconciliation totals.
6. The processor explicitly applies the selected changes.
7. The extension preserves in-session Undo and a local recovery snapshot.

Safety contract:

- Opening a page never changes an approved amount.
- Preview is read-only.
- Apply is explicit and rejects stale previews or changed portal values.
- No claim is submitted by the extension.
- Undo and recovery remain available independently of future backend services.

### Workflow B — Package audit and reviewer decisions

1. The extension reads package rows on the active RGHS process sheet.
2. Local deterministic rules identify possible unbundling or duplicate billing.
3. Findings are shown for processor review.
4. High-risk findings remain unselected until acknowledged.
5. The processor confirms, dismisses, or selects the finding.
6. Any deduction is applied only through the same explicit Apply workflow.

Safety contract:

- Rules assist a human decision; they do not adjudicate a claim.
- Rule evaluation remains local in the non-AI MVP.
- Custom rules and per-rule overrides remain local to the browser profile.
- Existing reviewer feedback and audit export behavior is preserved.

## 2. Supported portal scope

| Item | Phase 0 baseline |
|---|---|
| Production origin | `https://rghs.rajasthan.gov.in/*` |
| Active workflow routes | `/RGHS/processSheetSearch/*`, `/RGHS/tpaOPD*` |
| Development-only origins | `http://localhost/*`, `http://127.0.0.1/*` |
| Production build rule | Development-only origins are removed by `npm run build` |
| Portal writes | Approved-amount fields only after explicit Apply |
| Claim submission | Not supported |

The extension may inspect DOM labels, table structure, field identifiers,
package descriptions, claim amounts, approved amounts, and the page/TID context
needed for the two workflows. This scope must not be expanded without updating
the blueprint, tests, privacy disclosures, and Web Store declarations.

`/RGHS/tpaOPD*` was added to scope after the Phase 0 freeze (merged via PR #2,
released as 1.5.0). Unlike process sheets, every tpaOPD claim shares one URL,
so the extension identifies the active claim by TID rather than by
`location.href`/`location.pathname` alone; Preview/Apply/Undo and recovery
snapshot matching are all gated on TID agreement to prevent one claim's
reviewed data from being restored onto a different claim on screen. This
scope addition still needs the live-portal verification described in
section 6.

## 3. Data inventory

| Data | Location | Retention | Cloud transfer in v1.6.0 |
|---|---|---|---|
| Claim and approved amounts | Active RGHS page; transient memory during review | Until page/review ends | None |
| Package, treatment, diagnosis, and row text | Active RGHS page; transient rule evaluation | Until page/review ends | None |
| Preview and in-session Undo state | Extension memory in the active tab | Until refresh/tab close | None |
| Recovery snapshot: field IDs, before/after values, TID, URL | `chrome.storage.local` | Up to 24 hours; max 20 snapshots | None |
| Audit log: URL, TID, rule, row, finding, action, amounts | `chrome.storage.local` | Max 2,000 deduplicated entries | None |
| Reviewer feedback: URL, TID, rule, row, verdict | `chrome.storage.local` | Max 2,000 entries | None |
| Privacy-safe activity metadata | `chrome.storage.local` | Up to 30 days; max 500 entries | None |
| Custom rule configuration and per-rule overrides | `chrome.storage.local` | Until changed, reset, or extension data is cleared | None |
| Enable toggle and audit mode | `chrome.storage.sync` | Until changed or Chrome sync data is cleared | Chrome browser sync only |
| Widget position | `chrome.storage.local` | Until changed or extension data is cleared | None |

Phase 0 has no Firebase Authentication, Firestore, Cloud Functions, Gemini, or
Razorpay data flow. Future identity, licence, organization, and usage metadata
must use the minimum-data cloud model in `BLUEPRINT.md`. Raw claim content is
not approved for Firestore, logs, analytics, or AI processing.

## 4. Permission baseline

| Permission or host | Required purpose |
|---|---|
| `activeTab` | Interact with the currently active RGHS process sheet after a user action |
| `storage` | Save settings, local rules, audit/reviewer records, and recovery state |
| `https://rghs.rajasthan.gov.in/*` | Run the claim-assistance interface on the RGHS portal |

No broad browsing-history, tabs, cookies, downloads, clipboard, or remote-code
permission is approved. Any permission increase is a change-controlled event.

## 5. Repository and deployment boundary

- Extension source, tests, listing documents, and Store assets are versioned in
  this repository.
- `privacy-site/` is an independent Git checkout with its own deployment
  history. It is intentionally ignored here to prevent an accidental embedded
  repository or submodule.
- The current root-level extension source layout is authoritative. Phase 0 does
  not introduce a `src/` rewrite.
- Generated `dist/` and `claim-autofill-extension.zip` remain ignored and must
  be reproduced by the build pipeline.

## 6. Phase 0 verification record

The following evidence must be refreshed immediately before the Phase 0
baseline commit:

| Check | Required result |
|---|---|
| `npm run check` | All validation, syntax checks, and 100 regression tests pass |
| `npm run build` | Production `dist/` and ZIP are generated successfully |
| Production manifest | Only the RGHS production origin remains |
| ZIP inventory | No development, test, secret, or nested-site files |
| Reproducibility | Two builds produce the same SHA-256 |
| Git whitespace check | `git diff --check` passes |

Re-verified on 2026-07-24 after reconciling this branch with `main`'s tpaOPD
merge (main was released as 1.5.0; this branch's own rule-editor line was
renumbered to 1.6.0 on top of it - see `CHANGELOG.md`):

- Baseline source commit: `d24d86c` (release commit immediately preceding
  this documentation update), reachable from the merge of `main` at `689a15e`.
- Extension regression result: 100 passed, 0 failed (91 from `main` plus 9
  rule-editor tests from this branch).
- Production package SHA-256, identical across two consecutive builds:
  `149649D121F1FE199E8363DBE4255A794D1E750BAE8D64F89611D0CD22096FBB`.
- Production ZIP contains 19 expected runtime files and no development, test,
  secret, or nested-site files.
- Production manifest contains only `https://rghs.rajasthan.gov.in/*`
  (an origin-wide match; it already covered `/RGHS/tpaOPD*` before this
  merge, since route restriction happens in `claim-core.js`, not the
  manifest match pattern - no permission change was needed for tpaOPD).

Authenticated RGHS runtime verification completed on 2026-07-24, before the
tpaOPD merge:

- Claim Spark loaded on `/RGHS/processSheetSearch/*`.
- Preview and Apply populated the expected eligible approved amounts and
  deduction remarks.
- Undo restored all 10 approved amounts to `0` and all 10 remarks to empty.
- No Submit action occurred.
- The refreshed page reported no browser warnings or errors.

This smoke covered `/RGHS/processSheetSearch/*` only. `/RGHS/tpaOPD*` has unit
and regression coverage (TID-based session isolation, panel-unbundling
detection) but has **not** had an authenticated live-portal smoke test since
being added to scope - carried as an open item below rather than assumed
passing.

## 7. Phase 0 exit criteria

- [x] Two MVP workflows and their human-review contract are documented.
- [x] Supported production origin and workflow route are documented.
- [x] Local, synchronized, transient, and future cloud data are classified.
- [x] Current permissions have purpose statements.
- [x] AI and automated payment processing are deferred.
- [x] Extension and hosted-site repository boundaries are explicit.
- [x] Full regression and build verification is current.
- [x] Deterministic artifact SHA-256 is recorded.
- [x] Baseline source commit ID is recorded.
- [x] Authenticated live RGHS Preview, Apply, Undo, and no-submit smoke passed
      for `/RGHS/processSheetSearch/*`.
- [ ] Authenticated live RGHS Preview, Apply, Undo, and no-submit smoke passed
      for `/RGHS/tpaOPD*`.

## 8. Phase 1 entry rule

Phase 1 may create isolated Firebase development and production projects only
after the Phase 0 verification record is complete. It may not send claim
content to Firebase or change Preview, Apply, Undo, recovery, or audit behavior.
