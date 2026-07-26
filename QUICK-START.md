# Quick Start

## Administrator

1. Sign in using the platform-administrator account.
2. Open **Administrator** in the extension popup.
3. Activate or renew the development licence.
4. Generate an invitation for the exact processor email.
5. Send the generated message through an approved private channel.
6. After the processor accepts it, activate that same email.

Invitation messages are copied manually in 1.8.1; automatic email delivery is
not implemented.

## Processor

1. Install the production package using `INSTALL.md`.
2. Choose **New processor? Create an account**.
3. Use the invited email and one-time invitation token.
4. Verify the Firebase email.
5. Continue until the invitation is accepted.
6. Ask the administrator to activate the account.
7. Select **Check Status**.
8. Use Preview, explicit Apply, and Undo on an authorized RGHS process sheet.

If an account exists but its onboarding profile is missing, sign in normally.
The extension will request the matching invitation token once and recover only
when the authenticated UID and email match the accepted invitation.
