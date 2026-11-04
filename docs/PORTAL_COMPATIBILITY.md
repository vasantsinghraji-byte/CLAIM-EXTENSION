# Claim portal compatibility

Claim Amount Auto-Fill uses generic product wording for claim review and filling.
The current package still includes one validated portal integration, with hospital,
pharmacy, investigation and supported inpatient workflows. Its exact site and route
permissions remain in `manifest.json` and the existing integration code.

Branding does not establish compatibility with another portal. To add a portal:

1. Identify its exact HTTPS origin and supported claim-page routes.
2. Map claim, approved amount, rate, quantity and remark fields using synthetic
   fixtures, including hidden cells and dynamically loaded controls.
3. Configure that portal's applicable package codes, rates and deduction rules.
   The existing 12% medicine and inpatient policies are integration-specific;
   they must not become assumed defaults for another scheme.
4. Validate read-only Preview, reviewer-selected Apply, acknowledgement, stale
   values, licensed access, recovery and exact Undo on the new portal.
5. Add only the required site permissions and matching Store/privacy disclosures.

Historical rule IDs, saved-data keys, source workbook names and legacy remark
recognition retain their identifiers for compatibility and audit traceability.
Existing portal URLs and API paths remain exact so navigation and requests work.
New interface text, exported filenames and proposed remarks use generic wording.
