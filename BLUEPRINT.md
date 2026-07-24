# Claim Amount Auto-Fill B2B Architecture Blueprint

Status: Phase 0 approved and in progress

Target users: Approximately 50 authorized RGHS claim processors

Baseline: Existing Manifest V3 extension version 1.5.1

Recommended first milestone: Invite-only, non-AI MVP

Phase 0 baseline evidence and decisions are recorded in
[`docs/PHASE_0_BASELINE.md`](docs/PHASE_0_BASELINE.md).

## 1. Purpose

Build an invite-only B2B Chrome extension that preserves the existing
Preview → Review → Apply → Undo workflow while adding authenticated access,
organization licences, privacy-safe usage records, administration, controlled
distribution, and an optional user-initiated AI service.

The architecture uses:

- Chrome Extension for RGHS portal assistance.
- Firebase Authentication for invite-only processor accounts.
- Cloud Firestore for organizations, users, licences, settings, configuration,
  usage counters, and privacy-safe audit events.
- Cloud Functions for trusted authorization, licence enforcement,
  administration, payment verification, and optional AI processing.
- Firebase Hosting for the public website and authenticated admin dashboard.
- Gemini API only for an explicitly requested, separately gated AI feature.
- Razorpay Payment Links or invoices initially; webhook automation later.
- Chrome Web Store for beta and unlisted production distribution.

## 2. Non-negotiable principles

1. Existing claim-processing rules stay local unless a documented feature
   strictly requires backend processing.
2. Page load, login, licence refresh, or backend failure must never change RGHS
   portal fields.
3. Preview remains read-only. Apply remains explicit. Undo and recovery remain
   available independently of the backend.
4. No patient name, TID, diagnosis, treatment narrative, document, claim value,
   approved value, or free-text remark enters routine cloud logs.
5. The extension never receives administrator credentials, service-account
   credentials, Razorpay secrets, or Gemini API keys.
6. The backend returns data and decisions, never remotely hosted executable
   JavaScript.
7. Development and production use separate Firebase projects.
8. AI remains disabled until the non-AI pilot and privacy gate pass.
9. No automatic claim submission or automatic final adjudication.

## 3. Scope

### MVP includes

- Invite-only email/password authentication.
- Verified email requirement.
- Active, expired, and suspended licence enforcement.
- Existing amount preview, reviewed apply, undo, recovery, and audit screening.
- Processor settings synchronization.
- Platform administrator user and licence management.
- Privacy-safe usage counters and client-error metadata.
- Public homepage, privacy policy, support, terms, and data-deletion pages.
- Five-user beta followed by a controlled 15-user pilot.

### MVP defers

- Gemini processing.
- Public registration.
- Automated recurring subscriptions.
- Razorpay checkout embedded in the application.
- Organization-admin role.
- Patient or claim document storage.
- Detailed behavioral analytics.
- Multiple AI providers.
- Automatic claim submission.

## 4. Master implementation flow

```mermaid
flowchart TD
    A[Approve purpose and two MVP workflows] --> B[Inventory exact RGHS fields]
    B --> C[Classify local and cloud data]
    C --> D[Approve minimum-data contracts]
    D --> E[Freeze v1.5.1 baseline]

    E --> F[Create Firebase development project]
    F --> G[Configure Local Emulator Suite]
    G --> H[Implement invite-only Authentication]
    H --> I[Design Firestore collections]
    I --> J[Write and test Security Rules]
    J --> K[Build protected Cloud Functions]

    K --> L[Build minimal admin dashboard]
    L --> M[Connect extension authentication]
    M --> N[Connect licence verification]
    N --> O[Preserve local RGHS workflows]

    O --> P[Local and emulator testing]
    P --> Q[Security and privacy review]
    Q --> R{All non-AI gates pass?}
    R -->|No| S[Fix defects and repeat tests]
    S --> P
    R -->|Yes| T[Private beta with 5 users]

    T --> U[Review defects and feedback]
    U --> V{Five-user exit criteria pass?}
    V -->|No| S
    V -->|Yes| W[Expand pilot to 15 users]
    W --> X[Publish unlisted production version]
    X --> Y[Onboard remaining processors]

    Y --> Z{AI business case approved?}
    Z -->|No| AA[Operate non-AI service]
    Z -->|Yes| AB[Design separate AI privacy gate]
    AB --> AC[Implement user-initiated AI]
    AC --> AD[Independent AI security review]
    AD --> AA

    AA --> AE[Monitor, support, renew, back up]
```

## 5. Production component architecture

```mermaid
flowchart LR
    subgraph Browser["Processor browser"]
        P[Claim Processor]
        EXT[Manifest V3 Extension]
        CS[Content Script]
        SW[Service Worker]
        POP[Popup and Options]
        LOCAL[(Chrome Local Storage)]

        P --> POP
        P --> CS
        POP <--> SW
        CS <--> SW
        SW <--> LOCAL
    end

    subgraph Firebase["Trusted Firebase boundary"]
        AUTH[Firebase Authentication]
        API[Callable Cloud Functions]
        DB[(Cloud Firestore)]
        ADMIN[Admin Dashboard]
        HOST[Firebase Hosting]
        SECRET[Secret Manager]

        HOST --> ADMIN
        ADMIN --> AUTH
        ADMIN --> API
        API --> DB
        API --> SECRET
    end

    subgraph External["Optional external services"]
        GEMINI[Gemini API]
        RAZOR[Razorpay]
        CWS[Chrome Web Store]
    end

    EXT --> AUTH
    SW --> API
    API -. AI disabled in MVP .-> GEMINI
    RAZOR -. verified webhook later .-> API
    CWS --> EXT
```

## 6. Trust boundaries and responsibility split

```mermaid
flowchart TB
    subgraph UntrustedPage["RGHS page boundary"]
        PAGE[RGHS DOM and portal scripts]
    end

    subgraph Extension["Packaged extension boundary"]
        EXTRACT[Field extraction]
        RULES[Local validation rules]
        REVIEW[Preview and review UI]
        WRITE[Explicit Apply and Undo]
        CLIENT[Authenticated API client]
    end

    subgraph Backend["Trusted backend boundary"]
        TOKEN[Verify Firebase ID token]
        ACCESS[Verify account, organization and licence]
        VALIDATE[Validate input and rate limit]
        ADMINOPS[Administrative operations]
        AUDIT[Privacy-safe audit metadata]
    end

    subgraph Secrets["Secret boundary"]
        AIKEY[Gemini key]
        PAYKEY[Razorpay webhook secret]
        ADMINSDK[Firebase Admin credentials]
    end

    PAGE --> EXTRACT
    EXTRACT --> RULES
    RULES --> REVIEW
    REVIEW -->|Explicit user action| WRITE
    CLIENT --> TOKEN
    TOKEN --> ACCESS
    ACCESS --> VALIDATE
    VALIDATE --> AUDIT
    ADMINOPS --> AUDIT
    AIKEY --> VALIDATE
    PAYKEY --> ADMINOPS
    ADMINSDK --> ADMINOPS
```

### Extension owns

- Portal-page detection and compatibility checks.
- Required-field extraction.
- Existing deterministic claim rules.
- Preview, reconciliation, decisions, Apply, Undo, and recovery.
- Authentication UI and token forwarding.
- Short-lived licence cache.
- Clear degraded/offline status.

### Cloud Functions own

- Token verification.
- Account, organization, role, and licence verification.
- Invitation acceptance and administrative mutations.
- Usage limits and rate limiting.
- Privacy-safe server audit events.
- Razorpay signature verification.
- Gemini secrets and optional AI calls.

### Firestore never owns

- Patient names.
- TIDs or claim identifiers.
- Diagnoses or treatment narratives.
- Medical documents.
- Portal remarks.
- Claim, approved, or deduction amounts.
- Raw AI prompts or responses.

## 7. Invite-only customer onboarding

```mermaid
flowchart TD
    A[Customer approves quotation or pilot] --> B[Payment or written approval received]
    B --> C[Platform admin creates organization]
    C --> D[Platform admin creates invitation]
    D --> E[Processor opens one-time setup link]
    E --> F[Processor creates Firebase password]
    F --> G[Processor verifies email]
    G --> H[Cloud Function accepts invitation]
    H --> I[Admin activates account and licence]
    I --> J[Processor signs into extension]
    J --> K[Extension obtains Firebase ID token]
    K --> L[Cloud Function verifies active licence]
    L --> M{Access permitted?}
    M -->|Yes| N[Enable licensed features]
    M -->|No| O[Show controlled access message]
```

## 8. Authentication and licence state machine

```mermaid
stateDiagram-v2
    [*] --> SignedOut
    SignedOut --> Authenticating: Submit credentials
    Authenticating --> EmailUnverified: Valid credentials, email unverified
    Authenticating --> CheckingLicence: Valid and verified
    Authenticating --> SignedOut: Invalid credentials

    EmailUnverified --> CheckingLicence: Email verified
    CheckingLicence --> Active: Account and licence active
    CheckingLicence --> Suspended: Account or organization suspended
    CheckingLicence --> Expired: Licence expired
    CheckingLicence --> Degraded: Backend unavailable

    Active --> CheckingLicence: Cache expires or app resumes
    Active --> SignedOut: User signs out
    Active --> Suspended: Revocation detected
    Active --> Expired: Expiry detected

    Degraded --> CheckingLicence: Retry
    Suspended --> CheckingLicence: Admin reactivates
    Expired --> CheckingLicence: Licence renewed
```

### Licence-cache rule

The cache supports brief outages; it is not an offline perpetual licence.
Duration must be decided before implementation. Expiry, suspension, and minimum
supported-version checks must use server time.

## 9. Runtime claim-processing sequence

```mermaid
sequenceDiagram
    actor P as Processor
    participant E as Chrome Extension
    participant F as Firebase Auth
    participant C as Cloud Function
    participant D as Firestore
    participant G as Gemini

    P->>E: Open extension
    E->>F: Restore authentication session
    F-->>E: Firebase ID token
    E->>C: verifyLicence
    C->>C: Verify token and account
    C->>D: Read organization, user and licence
    D-->>C: Active licence state
    C-->>E: Signed access decision with expiry

    P->>E: Open supported RGHS process sheet
    E->>E: Validate portal layout
    E->>E: Read required fields locally
    P->>E: Click Preview
    E->>E: Execute deterministic local rules
    E-->>P: Show proposals, findings and totals

    alt Non-AI MVP
        P->>E: Select decisions and click Apply
        E->>E: Revalidate freshness and selection
        E->>E: Save local recovery snapshot
        E->>E: Apply selected portal changes
        E-->>P: Show applied summary and Undo
    else AI explicitly enabled and requested later
        P->>E: Click Analyse selected information
        E-->>P: Show disclosure and data categories
        P->>E: Agree and Continue
        E->>C: processWithAI with minimum payload
        C->>C: Verify token, licence, consent and quota
        C->>C: Remove unnecessary identifiers
        C->>G: Submit controlled prompt
        G-->>C: Structured response
        C->>D: Increment metadata-only usage counter
        C-->>E: Validated structured result
        E-->>P: Display result for review only
    end
```

## 10. Authorization path

```mermaid
flowchart LR
    A[Extension or Admin Dashboard] --> B[Firebase ID Token]
    B --> C[Callable Cloud Function]
    C --> D{Token valid?}
    D -->|No| X[Reject unauthenticated]
    D -->|Yes| E{Account active?}
    E -->|No| Y[Reject suspended account]
    E -->|Yes| F{Organization active?}
    F -->|No| Z[Reject suspended organization]
    F -->|Yes| G{Role permits action?}
    G -->|No| R[Reject unauthorized]
    G -->|Yes| H{Licence permits feature?}
    H -->|No| L[Reject unlicensed feature]
    H -->|Yes| I[Validate request schema]
    I --> J[Execute server operation]
    J --> K[(Firestore)]
```

## 11. Firestore logical data model

```mermaid
erDiagram
    ORGANIZATION ||--o{ USER : contains
    ORGANIZATION ||--o{ LICENCE : owns
    USER ||--|| USER_SETTINGS : configures
    USER ||--o{ USAGE_BUCKET : generates
    USER ||--o{ AUDIT_EVENT : performs
    ORGANIZATION ||--o{ AUDIT_EVENT : scopes
    ORGANIZATION ||--o{ INVITATION : issues
    APP_CONFIG ||--o{ FEATURE_FLAG : defines

    ORGANIZATION {
        string id
        string name
        string status
        string plan
        number maximumUsers
        timestamp createdAt
        timestamp updatedAt
    }

    USER {
        string uid
        string email
        string displayName
        string organizationId
        string role
        string accountStatus
        timestamp createdAt
        timestamp lastLoginAt
    }

    LICENCE {
        string id
        string organizationId
        string status
        timestamp startDate
        timestamp expiryDate
        number maximumUsers
        number monthlyAiLimit
    }

    USER_SETTINGS {
        string uid
        map extensionPreferences
        map enabledFeatures
        timestamp lastSyncedAt
    }

    USAGE_BUCKET {
        string id
        string organizationId
        string month
        number extensionActions
        number aiRequests
        number failedRequests
    }

    AUDIT_EVENT {
        string id
        string userId
        string organizationId
        string action
        string result
        timestamp timestamp
        string extensionVersion
    }

    INVITATION {
        string id
        string email
        string organizationId
        string role
        string status
        timestamp expiresAt
    }

    APP_CONFIG {
        string environment
        string minimumSupportedVersion
        boolean maintenanceMode
        boolean aiEnabled
        string supportMessage
    }
```

### Collection contracts

| Collection | Client access | Trusted writes | Claim content allowed |
|---|---|---|---|
| `organizations` | Processor reads limited own-org view | Cloud Functions | No |
| `users` | User reads own profile | Cloud Functions | No |
| `licences` | No direct processor read in MVP | Cloud Functions | No |
| `userSettings` | User reads/writes allowlisted own fields | User or function | No |
| `usage` | Optional own aggregate read | Cloud Functions | No |
| `auditLogs` | Admin-only query | Cloud Functions | No |
| `invitations` | Setup flow through function | Cloud Functions | No |
| `appConfig` | Authenticated read of allowlisted fields | Cloud Functions | No executable code |

## 12. Data classification and allowed destinations

| Data | Local browser | Firebase Auth | Firestore | Functions transient | Gemini |
|---|---:|---:|---:|---:|---:|
| Email and UID | Yes | Yes | Yes | Yes | No |
| Organization and role | Cached | Claims/token | Yes | Yes | No |
| Licence status | Cached briefly | No | Yes | Yes | No |
| Extension settings | Yes | No | Allowlisted | Yes | No |
| Usage counters | Optional cache | No | Yes | Yes | No |
| Patient name | Page only | No | No | No | No |
| TID or claim ID | Local recovery only | No | No | Temporary reference only | No |
| Diagnosis/treatment text | Page only | No | No | AI-only if approved later | Minimum only |
| Claim/approved amounts | Local workflow | No | No | AI-only if essential | Minimum only |
| Portal remarks | Local workflow | No | No | No by default | No by default |
| Raw AI prompt/response | No default persistence | No | No | Request lifetime only | Request processing |

## 13. Data-minimization pipeline

```mermaid
flowchart TD
    A[RGHS page information] --> B[User selects AI-supported action]
    B --> C[Select allowlisted fields]
    C --> D[Remove names and direct identifiers]
    D --> E[Replace claim ID with one-time reference]
    E --> F[Show exact disclosure]
    F --> G{User consents?}
    G -->|No| H[Cancel without transmission]
    G -->|Yes| I[Send minimum payload to Cloud Function]
    I --> J[Validate payload and remove rejected fields]
    J --> K[Process request]
    K --> L[Return validated structured result]
    L --> M[Discard transient payload]
    M --> N[Record metadata-only usage]
```

## 14. Cloud Functions catalogue

### Authentication and licences

- `acceptInvitation`
- `getCurrentUserProfile`
- `verifyLicence`
- `requestPasswordReset`
- `requestAccountDeletion`

### Platform administration

- `createOrganization`
- `updateOrganization`
- `inviteUser`
- `activateUser`
- `suspendUser`
- `activateLicence`
- `suspendLicence`
- `changeUserRole`
- `resetUserAccess`

### System

- `getExtensionConfig`
- `recordExtensionEvent`
- `reportClientError`

### Payments, later

- `recordManualPayment`
- `handleRazorpayWebhook`

### AI, later

- `processWithAI`
- `getAiUsage`
- `setAiLimit`

Every function must verify authentication, account status, organization,
role, licence, input schema, request size, rate limits, and safe logging before
performing its operation.

## 15. Manual payment and licence activation

```mermaid
flowchart LR
    A[Quotation or invoice approved] --> B[Bank, UPI or Razorpay Payment Link]
    B --> C[Platform admin verifies payment]
    C --> D[Record payment reference without payment credentials]
    D --> E[Activate or renew Firestore licence]
    E --> F[Write admin audit event]
    F --> G[Extension sees active licence at next check]
```

## 16. Future Razorpay webhook automation

```mermaid
flowchart LR
    A[Customer selects plan] --> B[Razorpay checkout]
    B --> C[Successful payment]
    C --> D[Razorpay webhook]
    D --> E[Cloud Function reads raw request]
    E --> F{Signature valid?}
    F -->|No| X[Reject and security-log metadata]
    F -->|Yes| G{Event already processed?}
    G -->|Yes| Y[Return idempotent success]
    G -->|No| H[Update Firestore licence]
    H --> I[Record payment and admin audit metadata]
    I --> J[Extension access enabled]
```

## 17. Environment architecture

```mermaid
flowchart TB
    subgraph Local["Local development"]
        EMU[Firebase Emulator Suite]
        DEVEXT[Unpacked development extension]
        FIXTURE[Synthetic RGHS fixtures]
    end

    subgraph Development["Firebase development project"]
        DAUTH[Development Auth]
        DDB[(Development Firestore)]
        DFUNCTIONS[Development Functions]
        DWEB[Development dashboard]
    end

    subgraph Production["Firebase production project"]
        PAUTH[Production Auth]
        PDB[(Production Firestore)]
        PFUNCTIONS[Production Functions]
        PWEB[Production website and dashboard]
    end

    EMU --> DEVEXT
    FIXTURE --> DEVEXT
    DEVEXT --> DAUTH
    DEVEXT --> DFUNCTIONS
    DFUNCTIONS --> DDB

    DFUNCTIONS -. gated promotion .-> PFUNCTIONS
    DWEB -. gated promotion .-> PWEB
    PFUNCTIONS --> PDB
    PWEB --> PAUTH
```

Development credentials, data, project IDs, extension IDs, and allowed origins
must not be interchangeable with production.

## 18. Failure behavior

```mermaid
flowchart TD
    A[Extension operation] --> B{Portal compatible?}
    B -->|No| C[Block Preview and Apply]
    B -->|Yes| D{Authenticated?}
    D -->|No| E[Require sign-in]
    D -->|Yes| F{Fresh licence available?}
    F -->|Yes| G[Enable licensed features]
    F -->|No| H{Valid short-lived cache?}
    H -->|Yes| I[Allow configured degraded mode]
    H -->|No| J[Block paid operation]

    G --> K{Backend fails during local workflow?}
    K -->|Yes| L[Keep local Preview, Undo and recovery safe]
    K -->|No| M[Continue normally]

    L --> N[Never write portal fields automatically]
    J --> N
    C --> N
```

### Required safe failures

- Authentication failure: no portal write.
- Licence failure: no paid-feature write.
- Backend timeout: local recovery remains available.
- Firestore denial: controlled message, no retry storm.
- AI timeout: no partial AI result and no portal write.
- Portal layout drift: block rather than guess.
- Stale preview: require a fresh preview.

## 19. Testing architecture

```mermaid
flowchart LR
    A[Source change] --> B[Unit tests]
    B --> C[Extension regression suite]
    C --> D[Firestore Rules emulator tests]
    D --> E[Functions integration tests]
    E --> F[Admin authorization tests]
    F --> G[Synthetic portal compatibility tests]
    G --> H[Manual authenticated RGHS smoke]
    H --> I[Security and privacy review]
    I --> J{Gate passed?}
    J -->|No| A
    J -->|Yes| K[Beta deployment]
```

### Minimum security tests

- Cross-user profile read denied.
- Cross-organization access denied.
- Processor role cannot change role or licence.
- Expired and suspended accounts rejected.
- Invalid and replayed invitations rejected.
- Invalid Firebase token rejected.
- Oversized and unknown input fields rejected.
- Rate limits enforced.
- Razorpay signatures and idempotency verified.
- Claim content absent from Firestore, logs, analytics, and error reports.
- Admin UI prevents stored and reflected script injection.

## 20. Controlled release workflow

```mermaid
flowchart TD
    A[Create improvement branch] --> B[Implement small change]
    B --> C[Automated tests]
    C --> D[Manual portal testing]
    D --> E[Deploy backend to development]
    E --> F[Test with beta extension]
    F --> G{Passed?}
    G -->|No| B
    G -->|Yes| H[Deploy backward-compatible backend]
    H --> I[Upload extension update]
    I --> J[Chrome Web Store review]
    J --> K{Approved?}
    K -->|No| B
    K -->|Yes| L[Publish update]
    L --> M[Clean-profile smoke test]
    M --> N[Monitor errors and support]
```

Backend changes must remain compatible with the currently published extension
until the new extension version is approved and adopted.

## 21. Pilot and production gates

```mermaid
flowchart TD
    A[Gate 1: Requirements approved] --> B[Gate 2: Backend secure]
    B --> C[Gate 3: Extension ready]
    C --> D[Gate 4: Privacy ready]
    D --> E[Five-user beta]
    E --> F{Exit criteria pass?}
    F -->|No| G[Fix and repeat beta]
    G --> E
    F -->|Yes| H[Fifteen-user pilot]
    H --> I{Pilot stable?}
    I -->|No| G
    I -->|Yes| J[Gate 5: Production ready]
    J --> K[Unlisted production release]
    K --> L[Gradual onboarding to 50 users]
```

### Gate 1 — Requirements approved

- Two MVP workflows documented.
- Supported RGHS routes and fields listed.
- Local and cloud data inventory approved.
- Licence failure behavior decided.
- AI explicitly deferred.

### Gate 2 — Backend secure

- Emulator tests pass.
- Firestore rules deny unauthorized access.
- Admin mutations use Cloud Functions.
- Secrets remain server-side.
- Sensitive claim content is absent from logs and storage.

### Gate 3 — Extension ready

- Existing 100-test regression baseline remains green.
- Login survives browser restart.
- Licence checks are bounded and retry safely.
- Preview is read-only.
- Apply remains explicit and stale-safe.
- Undo and recovery work during backend failure.
- No remote executable code.

### Gate 4 — Privacy ready

- Real publisher identity.
- Monitored support and privacy contact.
- Accurate homepage, privacy, terms, support, and deletion pages.
- Dashboard answers match deployed behavior.
- Firebase subprocessors and retention disclosed.
- In-product transfer disclosure exists before any future AI request.

### Gate 5 — Production ready

- Five-user beta and 15-user pilot completed.
- Critical defects resolved.
- Production backups and restore test completed.
- Billing and cost alerts enabled.
- Support and account-deletion procedures tested.
- Clean-profile Web Store installation smoke passes.

## 22. Support and operating process

```mermaid
flowchart LR
    A[Support request] --> B[Classify]
    B --> C{Type}

    C -->|Bug| D[Reproduce in development]
    C -->|Portal change| E[Update extraction logic]
    C -->|Feature request| F[Review benefit, privacy and risk]
    C -->|Account issue| G[Admin dashboard action]
    C -->|Privacy request| H[Verified deletion or access workflow]

    D --> I[Test beta version]
    E --> I
    F --> J[Schedule approved feature]
    G --> K[Resolve user access]
    H --> L[Record privacy-safe completion]

    I --> M[Release controlled production update]
    J --> D
    M --> N[Monitor]
```

## 23. Twelve-week target schedule

| Week | Deliverable | Exit evidence |
|---|---|---|
| 1 | Requirements and data inventory | Gate 1 approved |
| 2 | Firebase projects and emulators | Isolated dev/prod configuration |
| 3 | Invitations and Authentication | Verified invite-only login tests |
| 4 | Organizations, licences, Rules | Authorization emulator tests |
| 5 | Minimal admin dashboard | Admin role tests |
| 6 | Extension authentication | Restart/session tests |
| 7 | Licence integration | Active/expired/suspended tests |
| 8 | Existing RGHS workflow integration | 100 regressions plus portal smoke |
| 9 | Usage, errors, security hardening | No-sensitive-log evidence |
| 10 | Privacy, terms and deletion | Gate 4 approved |
| 11 | Five-user beta | Recorded exit findings |
| 12 | Fixes and 15-user pilot decision | Production go/no-go |

AI and automated Razorpay subscriptions are not included in this twelve-week
MVP commitment.

## 24. Final build order

1. Approve the two existing high-value workflows as the MVP.
2. Freeze and tag the local v1.5.1 baseline.
3. Create development and production Firebase projects.
4. Configure the Local Emulator Suite.
5. Implement invite-only Authentication.
6. Implement organizations, users, invitations, and licences.
7. Write Firestore Rules and authorization tests.
8. Build trusted Cloud Functions.
9. Build the minimal admin dashboard.
10. Add extension login and session restoration.
11. Add licence verification and safe degraded behavior.
12. Preserve and revalidate local RGHS processing.
13. Add privacy-safe usage and error metadata.
14. Publish accurate privacy, terms, support, and deletion pages.
15. Complete security and privacy gates.
16. Pilot with five users.
17. Expand to fifteen users.
18. Publish an unlisted production extension.
19. Onboard remaining users gradually.
20. Evaluate Gemini and Razorpay automation as separate later phases.

## 25. Decisions required before implementation

| Decision | Required answer |
|---|---|
| Publisher identity | Legal or trading name shown publicly |
| Support | Monitored public support email |
| Firebase projects | Development and production project IDs |
| Initial organizations | One organization or multiple customers |
| Licence term | Monthly, quarterly, annual, or fixed pilot |
| Seat enforcement | Named users and maximum seats |
| Grace period | Duration and allowed degraded features |
| Data residency/legal review | Required organizational or legal constraints |
| First beta users | Five authorized processors |
| AI | Explicitly disabled for MVP unless separately approved |

## 26. Blueprint change control

Changes to authentication, cloud data, permissions, claim-field extraction,
AI processing, retention, payment handling, or administrative access require:

1. An update to this blueprint.
2. A data-inventory review.
3. Updated automated security tests.
4. Privacy-policy and Chrome Dashboard consistency review.
5. A beta release before production.
