# Signup and licence changes in candidate 1.12.1

The authentication and licence fixes were reviewed and merged in
[PR #46](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/46).
Their behavior and emulator acceptance are documented in
[authentication/signup and licence enforcement](AUTH_SIGNUP_LICENCE.md).
The administrator dashboard and monitoring followed in
[PR #47](https://github.com/vasantsinghraji-byte/CLAIM-EXTENSION/pull/47).

Email verification leaves a resumable pending registration. Individual users
need verified payment, account approval and explicit licence activation;
sponsored access requires an authorized organization/roster path. An inactive
user licence blocks access even when its organization remains active. Legacy
self-registrations without explicit activation require an administrator decision.
Renewal review preserves the existing paid term until expiry.

Fresh claim actions check entitlement. Authorization denials cannot fall back
to bundled rules. Undo and recovery remain available for restoration. Delayed
authentication, licence and policy responses cannot restore a signed-out session.

Root/Functions regressions, isolated unpacked-extension signup, and the
Auth/Functions/Firestore emulator lifecycle cover duplicate signup, verification
recovery, payment/approval/activation separation and deactivation before Apply.
These checks use synthetic identities and send no production verification email.

Candidate packaging and rollout checkpoints are recorded in the
[1.12.1 release review](RELEASE_1.12.1_REVIEW.md). Publishing Hosting or Functions
does not update installed extensions. Verify Store availability before changing
the minimum supported extension version.

The original uncommitted document also recorded historical production operations.
Those claims were not reverified for this candidate and are preserved in the
local recovery snapshot described in [the reconciliation record](WORKTREE_RECONCILIATION.md).
This source PR performs no production account changes, deployment or publication.
