# Account and Invitation Lifecycle Runbook

## Routine administration

Open the production Firebase-hosted Claim Spark administrator dashboard and
sign in as a platform administrator. Use **Refresh** in the relevant section.
The extension popup panel is a constrained break-glass fallback, not the
routine production interface.

### Ordinary processor signup

1. The processor creates an account in Claim Spark.
2. The processor verifies the email once.
3. The processor chooses **Continue without organisation sponsorship**.
4. Claim Spark creates a pending processor profile in the platform organization.
5. Open the administrator dashboard, refresh **Users**, and approve the account.
6. The processor clicks **Check Status** and is signed in after licence and
   capacity checks succeed.

Use **Reject** when the registration is not authorized. Rejection requires a
second confirmation, disables the Firebase identity, revokes its sessions and
records the administrator decision in the audit log.

### Organisation-sponsored roster signup

1. Create and activate the organization and its organisation licence.
2. In **Roster**, enter the organization ID and add each authorized employee
   code with its assigned role. Codes are normalized to uppercase and may be
   claimed only once.
3. The processor creates an account and verifies the email.
4. The processor chooses organisation access and enters the organization ID
   and employee code.
5. Claim Spark atomically claims the code and creates a pending sponsored user
   with an inactive organisation license.
6. In **Users**, approve the pending account. Approval activates the user's
   license through the organization licence expiry without a separate license
   action.
7. The processor clicks **Check Status** and is signed in.

Available roster codes may be removed. Claimed codes cannot be removed; suspend
or delete the resulting user according to the applicable account procedure.

For larger organisations, use the dashboard's bulk CSV importer with
`employeeCode,email,role` rows. Imports contain at most 100 rows, reject
duplicate employee codes, and apply atomically: a claimed-code conflict rejects
the whole import rather than leaving a partial roster.

Legacy available roster entries that predate email binding must be resubmitted
with the same organization and employee code plus the employee's verified email.
This updates the available entry in place; claimed entries cannot be reassigned.

### Individual paid signup

The initial manual channel is an administrator-supplied UPI QR code. Do not
request or retain card numbers, bank credentials, UPI PINs, passwords or OTPs.

1. Confirm the official receiver is **YUVAN ENTERPRISES** at `yuvanent@ybl`.
   The fixed plans are ₹99/1 week, ₹198/2 weeks, ₹300/4 weeks and ₹500/12 weeks.
   Send the official UPI QR through an approved channel outside the extension.
2. The user creates an account, verifies the email and chooses
   **I'll Purchase Individually**.
3. After completing payment, the user submits only the UPI transaction ID
   (UTR) in the extension.
4. In **Users → Payment verification**, compare the submitted reference with
   the corresponding settled UPI transaction before verifying it.
5. Click **Verify payment** only after the payment is independently confirmed.
6. Approve the pending account if necessary, then use the existing per-user
   licence controls to activate the purchased number of weeks.
7. The user clicks **Check Status** or **Recheck Licence**.

Payment verification and licence activation are deliberately separate audited
actions. A pending payment cannot be used to activate a new individual licence.

### Individual licence renewal

The signed-in popup offers renewal seven days before an individual licence
expires and after expiry. The user pays the selected fixed plan and submits a
new UPI transaction ID (UTR) themselves. A pending renewal never extends the
licence and does not interrupt access that is still valid; after the current
expiry, Apply remains blocked until the administrator verifies the new payment
and extends the licence for exactly the purchased term.

The administrator dashboard lists active user licences expiring within seven
days and shows renewal submissions in **Payment verification**. Verify the UTR
first, then use **Extend license** with the matching plan duration. A mismatched
duration is rejected server-side.

### Password recovery and rotation

- Signed-out users choose **Forgot password?** and receive Firebase's reset
  email. The extension always shows the same completion message so it does not
  disclose whether an address is registered.
- Signed-in users choose **Change Password**, enter the new password twice, and
  retain a refreshed authenticated session after Firebase accepts the change.
- Suspected account compromise still requires the administrator incident flow:
  suspend the user, revoke refresh tokens, and complete a security review.

If a UTR cannot be independently matched, use **Mark unverified**, record a
non-sensitive reason, and ask the user to check and resubmit it. For a confirmed
refund, reversal or payment dispute, deactivate the related user licence while
the business decision is handled under the published terms. Never record bank
credentials or dispute narratives containing sensitive financial information.

Refund requests go to 7073684173 within 3 calendar days of payment. Eligible
cases are verified duplicate payments, cancellation before activation/use, or a
verified payment that cannot be fulfilled because access cannot be activated.
Initiate approved refunds within 3 calendar days. The published Terms list the
non-refundable cases and applicable-law reservation.

### Explicit invitation

Use an invitation only for a non-default organization or elevated role.

1. Select or enter the organization ID.
2. Enter the user's email and role.
3. Generate the invitation.
4. Send the generated signup instructions through an approved communication
   channel. The user must create the account with that exact email.
5. The user verifies the email once. Claim Spark matches the active invitation
   automatically; the user never handles an invitation token.

### Replace or revoke

- **Revoke** immediately invalidates a pending invitation.
- **Replace** invalidates the pending invitation and creates a new email-based
  invitation.
- Accepted invitations cannot be revoked or replaced. Suspend or delete the
  resulting user instead.

### Activate, suspend or reactivate

- Activate only after the user has verified their email. Ordinary processors
  register without an invitation; explicit invitations remain available for
  special organization or role assignments.
- Suspension disables Firebase Authentication and revokes refresh tokens.
- Reactivation requires an active organization, active licence and available
  seat.
- Role changes revoke refresh tokens; the user must sign in again to receive
  the new authorization claims.

### Delete an account

Account deletion is irreversible for the Firebase Authentication identity:

1. Verify the requester's authority and the exact target email outside the
   extension.
2. Export any legally required privacy-safe audit evidence.
3. Click **Delete account** and read the warning.
4. Click the confirmation button a second time.
5. Refresh Users and Audit events and verify the profile is `deleted` and
   redacted.

The process disables access and revokes tokens before deletion. A redacted
profile and audit events remain for referential integrity.

## Compromised account

1. Suspend the user immediately.
2. Inspect recent audit events.
3. Record the incident time, actor, affected organization and containment.
4. Require a password reset and security review.
5. Reactivate only after authorization and seat checks pass.

## Administrator lockout

Self-suspension, self-deletion and self-role-change are blocked. If all
platform administrators are nevertheless unavailable, use an authorized
break-glass operator in the Firebase project to restore the claims and active
profile. Record every break-glass action and rotate affected credentials.

