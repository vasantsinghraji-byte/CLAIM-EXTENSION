# Account and Invitation Lifecycle Runbook

## Routine administration

Open the production Firebase-hosted Claim Spark administrator dashboard and
sign in as a platform administrator. Use **Refresh** in the relevant section.
The extension popup panel is a constrained break-glass fallback, not the
routine production interface.

### Ordinary processor signup

1. The processor creates an account in Claim Spark.
2. The processor verifies the email once.
3. Claim Spark creates a pending processor profile in the platform organization.
4. Open the administrator dashboard, refresh **Users**, and approve the account.
5. The processor clicks **Check Status** and is signed in after licence and
   capacity checks succeed.

Use **Reject** when the registration is not authorized. Rejection requires a
second confirmation, disables the Firebase identity, revokes its sessions and
records the administrator decision in the audit log.

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

