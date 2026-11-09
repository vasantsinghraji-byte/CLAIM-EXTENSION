# RGHS circular implementation plan

## Scope and authority

This document separates the requested extension work from policy source material.
The circulars define compliance requirements; they do not authorize this extension
to submit, reject, or alter a claim without the processor's existing Preview and
Apply workflow.

Sources reviewed:

- *SOPs for IPD, Day Care and OPD under RGHS*: surgical-package payment order,
  daily-package stay-duration rules, documentation and pharmacy requirements.
- *OPD claims above Rs. 2,000 circular*: pending text extraction from the scanned
  source before a financial rule is configured.
- *Correct packaging declaration circular (13 July 2026)*: product code,
  manufacturer pack size, MRP, and dispensed medicine must agree.
- *Medical Oncology circular*: NICE/ICMR-first treatment pathway; generic and
  biosimilar preference; Medical Board review for high-cost therapies.

## Phase 1 — Portal data mapping and safety checks

1. Capture the portal's stable selectors/fields for TID, admission date-time,
   discharge date-time, package code, package type, package rate, and service or
   procedure date. Do not infer these facts from rendered labels alone.
2. Add fixtures from anonymized IPD, Day Care, OPD, Pharmacy, and Oncology claims.
   Include multiple surgical packages, a partial final day, and a 24-hour-complete
   control case.
3. Block automatic financial proposals when a required field is missing, malformed,
   or conflicts with the discharge summary. Surface a high-risk review item instead.

### Validated portal mapping (21 August 2026)

The following selectors and portal structures were confirmed in an authenticated,
read-only browser session. They must be treated as integration points and covered
by portal-layout preflight tests before any financial proposal is enabled.

| Workflow | Confirmed source | Extension use |
| --- | --- | --- |
| IPD claim detail | `#tpaClaimContentDetails .form-group` labels **Date of Admission**, **Time of Admission**, **Date of Discharge**, and **Time of Discharge**, each paired with a read-only input | Read and display the stay duration; calculate completed 24-hour intervals only when all four fields parse successfully. |
| Process sheet | `#processSheetTable`; row cells use `#packageCode_{index}`, `#packageRate_{index}`, `#packageDays_{index}`, `#packageAmount_{index}`, `#packageFinalAmount_{index}`, and `#packageremarks_{index}` | Read expected packages/units/rates. Only approved amount and remarks are writable portal controls. |
| RGHS Card Tracker | `#CardTrackerTable` with transaction, status, pre-auth/final package, admission, discharge, and approved-amount columns | Present a local, on-demand case-history summary; do not persist the result in extension storage. |
| E-card detail | The portal's existing `getRghsCard` calls same-origin `POST /RGHS/tpaECardDetailbytid` with the TID | Add a user-triggered, read-only eligibility/card-summary lookup after endpoint behaviour is fixture-tested. |
| Claim documents | The main claim page exposes an **Investigation-Report** link through `/RGHS/downloadPharmaTPAFile` | Open the existing document on user action and show a processor-entered verification checklist; do not scrape or upload documents automatically. |

### Investigation checklist constraint

`#packageDays_{index}` is a display-only table cell, not a portal input. Therefore
the extension must not claim to change an investigation quantity from (for example)
4 to 3 in the portal. Its safe implementation is to show **Expected 4 / Verified 3**,
propose `rate × 3` in `#packageFinalAmount_{index}`, append a precise verification
remark, and apply only after the processor confirms the proposal. The portal's
displayed unit remains unchanged unless RGHS exposes a supported editable field.

For OPD and pre-auth OPD, compare a currently blocked investigation only with recent
Card Tracker rows that are explicitly **Blocked**, have the same normalized patient
name, and contain the same final-package code. This is an advisory signal only.

## Phase 2 — Requested IPD rules

1. For surgical packages on one TID, identify and order eligible main procedures
   using the portal's explicit procedure/service order. Propose 100% for the first
   procedure, 50% for the second, and 25% for each later procedure. Keep the
   existing reviewer acknowledgement before Apply.
2. For daily IPD packages, calculate completed 24-hour intervals from admission
   and discharge timestamps. If the final billed day is incomplete, propose the
   deduction only for that final daily-package unit; do not apply this rule to
   day-care claims, whose actual stay time is permitted.
3. For LAMA/DAMA discharge after a surgical procedure, read the authoritative
   portal discharge status and propose 75% of the surgical-package claim amount.
   Treat this as high risk and require explicit processor selection before Apply.
   Before a surgical procedure, retain the SOP's daily-package, completed-24-hour
   assessment instead of applying the 75% surgical-package rule.
4. Add clear generated remarks with the SOP rule, calculation basis, and captured
   timestamps/order. Preserve any existing portal remarks.

## Phase 3 — Pharmacy and OPD circular rules

1. Keep the pharmacy patient-name signal local and highlight it only when no
   invoice patient name matches the active patient record.
2. Validate medicine pack size, product code, MRP, and quantity against an
   approved, versioned product-master data source. Flag discrepancies for review;
   never substitute a product mapping automatically.
3. Translate the OPD-above-Rs.2,000 circular after its scanned text is verified.
   Record its threshold, eligibility conditions, documentation requirements,
   exceptions, and effective date as versioned central rules.

## Phase 4 — Oncology rules

1. Require a review flag for high-cost therapy above Rs.30,000 per cycle or month,
   including targeted therapy, immunotherapy, hormonal therapy, and any other drug
   meeting that threshold.
2. Require the applicable documentation: histopathology, staging, biomarkers where
   relevant, prior treatment, response evaluation, ECOG validation, and NICE/ICMR
   justification. Allow NCCN/ESMO support only when NICE/ICMR has no suitable option
   and the physician declaration is present.
3. Prefer generic, biosimilar, and lowest-cost effective options in review output;
   do not auto-replace clinically prescribed medicines.

## Phase 5 — Governance and release

1. Store each circular-derived rule in the existing centralized, versioned processing
   rule set with its source, effective date, owner, and rollback version.
2. Run unit, fixture end-to-end, and browser tests; include false-positive cases and
   a no-change regression suite for non-IPD claims.
3. Pilot with read-only Preview mode, collect processor feedback, then enable Apply
   only after policy-owner sign-off and a documented rollback plan.

## Open inputs required before financial automation

- An anonymized portal sample or selectors that expose admission and discharge
  timestamps, and indicate daily versus day-care packages.
- The portal field that establishes the main surgical procedure order for a TID.
- A validated medicine product master for pack-size, product-code, and MRP checks.
- A legible text copy or policy-owner confirmation of the scanned OPD-above-Rs.2,000
  circular before its rule is encoded.
