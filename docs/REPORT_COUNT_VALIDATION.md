# Report-count parsing and validation

Report counts are quantities, so they use `ClaimAutoFillCore.parseCount` instead
of the money parser. For example, the previous parser removed the `e` from
`1e1` and treated it as 11 reports. The new parser rejects that string rather
than preparing a different approved amount.

Accepted inputs are safe non-negative integer numbers or digit-only strings,
with surrounding whitespace allowed. Zero is valid. Strings containing decimal
points, exponent notation, commas, currency symbols, signs or other text are
rejected, as are blank values, booleans, objects and unsafe integers. Numeric
values must already be safe integers; textual formatting is checked before
conversion. Money parsing remains unchanged.

Investigation Preview validates submitted row indices and counts with that
parser, rejects duplicate/unknown rows, and caps counts at the row's expected
quantity. A malformed entry blocks the whole submitted preview. A failed new
preview also invalidates the earlier investigation Apply token. The existing
licence/policy checks, reduction acknowledgement, claim binding, approval cap,
recovery and Undo protections still apply.

The companion loads the shared parser before its UI script. Saved malformed or
out-of-range values fall back to the expected count; a saved zero remains zero.
Controls use whole steps and show an input error for invalid counts. Preview
checks the current inputs before sending any request to the process sheet.
Editing counts disables Apply and clears the prior preview. Discard resets
counts and validity together and requires a new preview. A delayed preview
response cannot re-enable Apply after counts were edited, discarded or reloaded.

Validation includes parser boundary and investigation Preview/Apply tests,
real Chrome companion controls with a synthetic transport, and the actual
unpacked extension against a synthetic process sheet. These cover the original
exponent bug, decimal/currency/grouped input, saved-value recovery, zero reports,
valid reductions and exact Undo. Existing CI runs them through `check`,
`test:browser` and `test:extension`.

This PR contains no comparison presentation, dependency or version changes,
backend policy changes, release artifact or deployment.
