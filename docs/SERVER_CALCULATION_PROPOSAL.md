# Proposal: licensed calculations as a server service

Requested by the owner on November 14, 2026, following the
[licensing security assessment](LICENSING_SECURITY_ASSESSMENT.md).
Status: design proposal. No calculation endpoint or claim-data upload is enabled
by the accompanying hardening PR. MIT remains intentional and unchanged.

## Objective and limits

Require a currently authorized identity to obtain new calculations from the
owner-operated service. The extension becomes a local reader, review interface
and explicit DOM writer; the licensed calculation/rule evaluation stays on the
server. A copied package without entitlement cannot ask that service for results.

This does not stop someone writing an independent calculator, using old bundled
algorithms, replaying previously observed results locally or changing their own
browser's DOM. If the server implementation is distributed under MIT too,
recipients may operate their own copy subject to that licence. The enforceable
boundary remains access to the owner's hosted infrastructure. A signed result
cannot force an untrusted browser to obey it.

## Proposed data flow

```mermaid
sequenceDiagram
  participant Browser as Extension on user device
  participant API as Licensed calculation API
  participant Auth as Firebase Auth
  participant Policy as Entitlement and private rule state
  Browser->>API: ID token, protocol/version, minimal rows, request ID
  API->>Auth: Verify current unrevoked session
  API->>Policy: Read current entitlement, rollout policy and rules
  Policy-->>API: Current authorized rule version
  API-->>Browser: Bounded data-only proposals and policy identity
  Browser->>Browser: Bind live claim/controls; show review and acknowledgement
  Browser->>API: Fresh evaluation before Apply
  API->>Auth: Recheck session
  API->>Policy: Recheck entitlement and active rules
  API-->>Browser: Current data-only proposals or denial
  Browser->>Browser: Apply selected values; retain exact local Undo/recovery
```

The API rechecks access per request rather than trusting a prior display lease.
Versions/protocol fields describe compatibility, not authenticated binary identity.
Rules are loaded by the server; processor clients receive results and stable
reason/policy identifiers rather than an executable rule set or evaluation engine.
Administrator rule authoring/export stays in separately authorized admin APIs.

## Minimal request contract to review

Proposed endpoint: `evaluateLicensedClaim`. Begin with synthetic fixtures and a
fixed protocol schema; reject unknown fields and set a small row/body limit.
The exact limit and fields must follow parity fixtures rather than guesses.

| Field | Proposed purpose / treatment |
| --- | --- |
| `protocolVersion`, `extensionVersion` | Required compatibility contract; never proof of licence or package integrity. |
| Random `requestId` | Idempotency and correlation scoped to the authenticated user; never a TID, portal identifier or patient-derived value. |
| `processingArea` | Strict enum such as IPD/OPD/Pharmacy. |
| Ephemeral row keys | Random per-preview references generated locally, not copied portal control IDs. |
| Package/product codes | Only exact allowlisted codes necessary for the applicable policy. |
| Required numeric inputs | Only needed quantities/rates/claimed/current-approved values. These are financial/claim data even without a patient's name. Validate money/counts server-side and bound all values. |
| Approved policy facts | Only explicitly necessary typed facts after their privacy/policy review; never infer clinical details or procedure order from uncontrolled text. |

Exclude names, TIDs, card numbers, portal URLs, invoice/PDF content, diagnoses,
treatment narratives, authentication secrets beyond the HTTPS bearer header,
free-text remarks and arbitrary DOM/HTML. Keep full claim identity, control IDs,
review decisions and before/after restoration snapshots on-device.

The current privacy policy explicitly keeps claim/amount data local. Removing
direct identifiers is insufficient to claim that the proposed request is
non-sensitive. Before implementation/rollout, review authorization to process
these inputs, provider/region, retention, access controls, disclosures, consent
where required, Store declarations and workplace agreements. Update the public
policy and published package consistently. This proposal does not assume those
data-handling decisions are already approved.

## Trusted server behavior

1. Verify Firebase signature/expiry and live session revocation. Require an active
   account and the current effective paid/organization entitlement. Check policy
   state, minimum protocol/version, maintenance and per-user quotas before work.
2. Load an immutable server-owned rule version. Validate inputs independently;
   never accept client-calculated approvals, licence flags, role claims outside
   verified Auth/DB state, rule definitions or executable expressions as authority.
3. Evaluate deterministically with the existing server engine and a parity-complete
   replacement for bundled behavior. New financial policies still require policy
   owner review and the existing distinct-administrator approval workflow.
   Inputs remain untrusted descriptions of the portal. This API cannot establish
   that a licensed caller supplied the true claim amounts or clinical facts.
   Binding decisions to authoritative portal records or enforcing final
   adjudication would require a separate trusted integration with the portal.
4. Return only bounded numeric proposals, controlled reason codes, warnings and
   immutable policy identity. The packaged client maps those codes to review UI
   and local remark templates. Never return JavaScript, WASM, arbitrary selectors,
   expressions, command trees or a remotely executable program.
5. Expire results quickly (proposed maximum 60 seconds, bounded by licence and
   session expiry). Scope idempotency to UID plus request ID plus input identity;
   reject the same ID with different inputs. Recheck current entitlement before
   returning even a cached/idempotent result. Cache lifetime is not authorization.
6. Keep input handling ephemeral by default. Do not log payloads or persist claim
   values. Persist only an approved minimal usage summary, such as UID, operation,
   time, result category and rule version. Any nonce/digest cache needs an explicit
   short retention and must not become a durable claim correlation database.

Firebase ID tokens remain managed by Firebase. An optional opaque server-side
decision ID must be bound to UID, expiry and intended server operation; the ID
alone never replaces live Auth/entitlement checks. If a later server operation
consumes it, consumption should be atomic and one-use. Such a ticket does not
make purely local DOM writes enforceable. Portal-side verification would require
an independently authorized integration with the portal operator.

## Client safety and availability

Preserve the claim/page/control binding, fresh DOM fingerprint, monetary bounds,
policy conflicts, individual row selection and high-risk acknowledgement already
implemented. Re-evaluate immediately before Apply; a changed rule set or changed
input requires a fresh review. Keep final portal submission entirely with the user.
Undo/recovery continue locally during outages and after access revocation.

No licensed local calculation fallback should ship in the final server-required
package; otherwise a modified client can expose it again. General local viewing,
manual portal operation and restoration remain possible. Server outages block
new licensed proposals/Apply rather than silently using an old decision.

Backend latency, provider failure and sensitive-input handling become operational
dependencies. Measure realistic row counts, latency, request cost and error rates
with synthetic loads before selecting timeouts/quotas. Define a rollback that
disables new service operations while preserving restoration. Reintroducing an
offline evaluator would intentionally restore the bypassable capability.

## Migration and acceptance

1. Finish/deploy the current entitlement/session hardening and establish denial
   metrics. Do not require a future Store version before it exists.
2. Complete the input/privacy review and exact schema, then implement the endpoint
   against synthetic data in its own PR. Add malformed-input, concurrency,
   idempotency, token replay, server-failure and quota tests.
3. Port bundled rule behavior to the server without changing policy. Require
   server/browser fixture parity for normal, Pharmacy, investigation and IPD
   cases, including explicit zero, malformed money/counts, partial approvals,
   mandatory actions and overlapping policy conflicts.
4. Pilot a separately reviewed client behind an account-scoped server feature
   flag. Provide fresh review/acknowledgement and local recovery tests, outage
   tests and a documented operational rollback.
5. Publish a package that omits the valuable local rule data/evaluator paths.
   Verify official Store availability, then enforce the new protocol/minimum and
   remove processor rule downloads in the server-required cohort. Version claims
   can still be forged; the API must remain safe for arbitrary authenticated clients.
6. Prove that unauthenticated, unpaid, expired, deactivated, suspended and revoked
   identities cannot obtain new calculations, even using a modified client or a
   raw HTTP caller. Recheck cache hits, repeated request IDs and requests spanning
   revocation. Demonstrate that old offline binaries remain an explicit limitation.

Chrome permits server-side data operations but restricts remotely supplied
executable logic. Submit a transparent data-only design for Store review; neither
JSON formatting nor a custom interpreter automatically makes remote behavior
compliant. See [Manifest V3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
and [remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

This proposal defines the next implementation scope. It does not claim that
server-only calculations, revised privacy disclosures, device attestation,
concurrent-device limits or anti-redistribution guarantees are already deployed.
