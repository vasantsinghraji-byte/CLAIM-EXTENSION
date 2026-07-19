# Changelog

## 1.2.0 - 2026-07-19

- Added submission acknowledgement, fail-closed RGHS layout checks, versioned rule validation, privacy-safe activity history, and automated release packaging.

## 1.2.1 - 2026-07-19

- Report exact mutated control counts and use shell-free cross-platform release validation.

## 1.2.2 - 2026-07-19

- Reserve all fixed-unbundling component rows from ordinary autofill; PTCA plus separately billed CAG now marks both rows.

## 1.3.0 - 2026-07-19

- Added executable coverage for all 47 Risk Matrix rows, eight documentation-dependent upcoding review triggers, cross-cutting multiple-major-procedure review, exhaustive rule-family reachability tests, and corrected laminectomy with/without fusion matching.

## 1.3.1 - 2026-07-19

- Highlight every duplicate and parent/component package row, distinguish main packages from included services, and write neutral portal remarks without extension identifiers.

## 1.3.2 - 2026-07-19

- Keep previously remarked duplicate and parent/component rows reserved and highlighted on every preview without duplicating portal remarks.

## 1.3.3 - 2026-07-19

- Allow explicitly selected and acknowledged high-risk review rows to receive their eligible approved amount while keeping unselected rows protected.

## 1.3.4 - 2026-07-19

- Guard the floating widget against stale Chrome API calls after an extension reload and show a refresh-page recovery message instead of throwing Extension context invalidated.

## 1.3.5 - 2026-07-19

- Harden every floating-widget startup and interaction path against extension reload races, including mascot open, recovery checks, and nested storage reads.

## 1.4.0 - 2026-07-19

- Add safe-row automation, grouped audit decisions, calculated outcomes, and acknowledgement only for exceptional overrides.

## 1.4.1 - 2026-07-19

- Exclude HbA1c from CBC haemoglobin bundling and persist green/red portal row highlights for grouped decisions.

## 1.4.2 - 2026-07-19

- Highlight audit-related process-sheet rows automatically on page load and rescan dynamically added claim rows without modifying values.

## 1.4.3 - 2026-07-19

- Correct fixed-deduction decisions to retain component amounts and block recommendations that exceed the configured deduction method.

## 1.4.4 - 2026-07-19

- Enforce distinct calculation invariants for fixed package adjustments, inclusive components, and duplicate-after-first decisions.

## 1.4.5 - 2026-07-19

- Fix submission-interlock control detection to avoid default-button misfires and guard Submit Claim label variants.

## 1.4.6 - 2026-07-19

- Serialize activity, audit, feedback, and recovery storage mutations through the background service worker to prevent cross-tab lost updates.

## 1.4.7 - 2026-07-19

- Preselect CA-01 package deduction while retaining PTCA in full and setting only separately billed CAG to zero after explicit Apply.

## 1.4.8 - 2026-07-19

- Preserve recovery snapshots when persistent restore finds no live controls or restores only part of a sheet, and exclude detached SPA controls from session Undo counts.

## 1.4.9 - 2026-07-19

- Migrate fallback claim and approved input matching into the reviewed proposal pipeline with consistent preview counts, selection, Apply, Undo, and recovery behavior.

## 1.4.10 - 2026-07-19

- Model disabled Apply as an explicit autofill-disabled block with a complete result shape and clear popup and widget messages, preventing false success and malformed submission summaries.

## 1.4.11 - 2026-07-19

- Retry TID detection after early SPA rendering misses and cache only a successfully detected identifier so audit logs and recovery snapshots retain TID matching.

## 1.4.12 - 2026-07-19

- Prevent nested tables from being scanned twice by assigning one table owner and enumerating only direct table rows and direct row cells.

## 1.4.13 - 2026-07-19

- Normalize validated standard and fallback claim amounts before writing approved fields, removing Indian or international grouping separators and redundant decimal zeros.

## 1.4.14 - 2026-07-19

- Strip localhost and 127.0.0.1 content-script and web-accessible-resource matches from production dist and ZIP manifests while retaining them only for unpacked development.

## 1.4.15 - 2026-07-19

- Normalize untrusted sessionStorage submission summaries and render all review values through textContent, preventing markup from spoofing the safety interlock.

## 1.4.16 - 2026-07-19

- Reduce passive-audit CPU and messaging by caching compiled rule entities, gating scan logs behind debug mode, and sending badge updates only when counts change.

## 1.4.17 - 2026-07-19

- Prevent popup status timer races by cancelling the previous hide timer before giving each new message its full three-second display interval.

## 1.4.18 - 2026-07-19

- Serialize and merge auto-deduct override writes through the service worker and refresh every options page from Chrome sync storage changes.

## 1.4.19 - 2026-07-19

- Harden bulk mutation debouncing, keep iframe injection explicitly disabled, clear stale badges on navigation, use an explicit CSV BOM escape, and migrate auto-deduct overrides from sync to profile-local storage.

## 1.4.20 - 2026-07-19

- Complete profile-local override isolation by deleting the legacy Chrome sync key only after its one-time local migration succeeds.
