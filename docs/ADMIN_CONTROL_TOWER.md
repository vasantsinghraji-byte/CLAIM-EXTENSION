# Administrator dashboard and monitoring

The dashboard combines a live overview with the existing account, invitation,
organization, roster, licence, rule and audit controls. The extension exposes
Open Admin Dashboard beside a signed-in platform administrator's account
controls. The website uses a separate tab-scoped session.

Access requires verified email, a platform-administrator Auth claim and an
active platform-administrator profile. Processor and organization-administrator
accounts are denied. Hosted sign-in, token refresh and callable responses cannot
restore a signed-out session. Concurrent refreshes share one request.

## Live overview

`monitorAdminDashboard` is a POST HTTP event stream. Its bearer token is sent only
in the Authorization header. The endpoint verifies token revocation and existing
administrator authorization before creating listeners. Allowed browser origins
are the configured production/staging Hosting domains and loopback development.

It listens to users, organizations, licences, invitations, production configuration,
active policy state, the latest 100 audit records and up to 100 open rule-feedback
records. User/organization/licence/invitation counts use complete snapshots.
Account and licence statuses are separate; explicit deactivation and legacy
activation requirements from #46 remain visible. Tables show the latest 20
accounts, latest 12 attention items, first 20 organizations by ID and latest 25
audit events. Field selection excludes arbitrary audit details and claim/patient
content. Version distribution is a bounded event sample, not install counts or
online presence; feedback displays `100+` at its query limit.

Heartbeat snapshots update expiry counts every 15 seconds. Token revocation and
profile authorization are rechecked every 30 seconds; a profile listener closes
the stream immediately when administrator access is removed. Streams rotate
after at most four minutes and close on token expiry, listener errors, disconnect
or backpressure. Timers and listeners are released on termination.

The browser reconnects with backoff, pauses in hidden tabs and aborts a silent
connection after 45 seconds. Reconnect preserves the latest values with a stale
label. Sign-out clears monitoring values. A missing endpoint shows an explicit
deployment error while existing administration sections remain available.

Each visible dashboard opens server-side listeners and an HTTP connection.
Complete account and organization snapshots incur reads on connection and
changes; monitor read volume as the account base grows. The endpoint caps at ten
instances and configures no minimum instances. No public Firestore reads or new
SDK dependency are introduced.

## Account controls

The directory searches loaded accounts by name, email or organization and filters
account/licence status. Backend truncation is labelled. Account cards keep
management sections open across saves, separate permission/licence controls and
disable already-inactive licence actions. Approval and payment queues expand
when new work arrives. Individual activation still requires verified payment.

Role saving reads the selector in the clicked card. Nonempty invalid custom
durations stop without writing; accepted durations are integer weeks 1–52.
Identical pending mutations are suppressed, and saving/results remain visible
while scrolling. These controls retain server-side authorization and auditing.

## Validation and rollout

- `npm run check`, `npm run lint`, `npm run test:functions` cover auth races,
  stream authorization, bounded/redacted summaries and listener cleanup.
- `npm run test:dashboard` uses actual hosted HTML/scripts and the stream handler
  in isolated Chrome with synthetic loopback data. It checks live updates,
  account controls, search/filtering, navigation, mobile layout and revocation.
- `npm run test:lifecycle` includes real Auth/Functions/Firestore emulator checks
  for unauthorized/processor denial, registration and activation push updates,
  exact count changes and administrator revocation, alongside #46 signup tests.
- CI runs dashboard acceptance before the existing Firestore and lifecycle gates.

This PR contains source and test changes. It makes no production account writes
and performs no deployment or release. A later approved rollout should deploy
the monitor endpoint before the hosted UI using an explicit project, then check
the environment label, live snapshot, authorization boundaries and read volume.
No Firestore rules/index changes or dependency upgrades are needed.
