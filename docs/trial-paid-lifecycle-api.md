# Trial and paid lifecycle HTTP integration

Content admission requires explicit versioned retention facts. Manual and standalone shared-credit grants retain their accounting but must also supply valid `AccountRetention` metadata and verifiable paid-tenure facts; there is no legacy retention fallback. Retention always uses the lifecycle matrix. Deploy this new-data-only implementation only after the separately authorized clean-state reset, with API readers/writers and all workers on the same single-policy version; mixed retention versions are unsupported. See the [deployment prerequisite](retention-implementation-plan.md#deployment-prerequisite-clean-application-data). No reset or deployment is performed by this change. `TRIAL_ENABLED` defaults to `false`; only the exact strings `true` and `false` are accepted. The example configuration keeps it false. Enabling it is reserved for internal verification until retention verification, abuse-control configuration/deployment and truthful offering/privacy release checks pass. The minimum identity and request safeguards below reduce repeat-account abuse; a Google account does not establish one human.

`subscriptionGrants/{uid}` holds the versioned lifecycle record defined in `src/access/lifecycle.ts` for ordinary trial and paid plans. Trial and paid funding use the existing shared allowance ledgers. No public grant writer, payment mock or payment integration is added. Trusted administrative assignment below uses the same lifecycle transitions as future payment integration. Paid activation/renewal is applied when its supplied period is effective; a trusted caller retries at that boundary. No renewal scheduler is included.

## Administrative plan assignment

Test accounts use ordinary plans. Run this command only with trusted Application Default Credentials authorized for the target Firebase project. The Firebase Auth user must already exist. The command requires an explicit project, does not load `.env`, and has no public HTTP route. Before accessing the account, it prints the target project and UID and whether it is using live services or emulators. To use emulators, set **both** `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST`; setting only one is rejected.

Read the current revision and plan without changing anything:

```sh
npm run access:admin -- --project <project-id> --uid <firebase-uid>
```

Assign an ordinary paid plan without preparing JSON:

```sh
npm run access:admin -- --project <project-id> --uid <firebase-uid> --plan lower --until 2026-12-12
```

Use `lower` or `higher`. A date-only expiry means **00:00 UTC at the start of that date**, not the end of that day. For an exact time use a UTC ISO timestamp such as `2026-12-12T18:30:00Z`. No monthly duration is assumed.

Without active paid access, the command activates the selected plan from now until that expiry. For active paid access, supply its existing expiry: lower→higher upgrades now, higher→lower schedules the downgrade for renewal, and selecting the current plan leaves it unchanged when no downgrade is pending. Requesting higher while a downgrade is pending is refused; requesting lower leaves that scheduled downgrade unchanged. A cancelled active paid period refuses either `--plan` assignment; use a deliberate `--request` with a new event ID and current revision for an intentional change. It does not extend an active period, reset usage, cancel a pending change, or undo withdrawal. The printed current state includes any scheduled downgrade.

`--plan` reads current account state and computes a fresh assignment on each invocation; it does not save requests locally or replay a previous operation. After an uncertain outcome, read the account before deciding whether to assign again. Use `--request` below when you need a stable operation identity for exact retries. Successful commands, including unchanged assignments and explicit replays, print freshly read account state. Errors can occur before that output; run the read command to inspect current state.

Existing manual grants are not converted by this command. They require a separately reviewed migration or explicitly authorized cleanup; ordinary existing lifecycle accounts and Auth users without grants are supported. No account data is reset automatically.

### Advanced lifecycle operations

Save a JSON request file for the intended transition. This example assigns the normal lower plan; replace the dates with the actual current period and choose unique event and period identities:

```json
{
  "eventId": "account_activation_001",
  "command": {
    "type": "activate_paid",
    "expectedRevision": 0,
    "plan": "lower",
    "periodId": "paid_period_001",
    "startsAt": "2026-11-12T00:00:00Z",
    "expiresAt": "2026-12-12T00:00:00Z"
  }
}
```

```sh
npm run access:admin -- --project <project-id> --uid <firebase-uid> --request /path/to/request.json
```

Use the revision from the read command; a new account has revision zero. Requests accept only the documented fields and UTC ISO dates. Retry an uncertain result with the **same event ID and unchanged request**. The transaction replays its original result without adding credits again; the command then reads and prints current account state. Reusing an event ID with a different request or sending a stale revision fails.

Supported commands are the existing lifecycle operations:

| Command | Fields beyond `type` and `expectedRevision` | Effect |
| --- | --- | --- |
| `activate_paid` | `plan`, `periodId`, `startsAt`, `expiresAt` | Assign lower/higher access when no paid period is active. |
| `upgrade` | None | Move lower to higher now, adding only the approved difference to the same allowance period. |
| `downgrade` | None | Schedule higher to lower at renewal. |
| `cancel` | None | Keep access until the period ends and stop renewal. |
| `renew` | `plan`, `periodId`, `startsAt`, `expiresAt` | Start a current, non-overlapping next period consistent with saved cancellation/downgrade settings. |
| `withdraw` | None | Withdraw processing access; the ordinary lifecycle does not undo this operation. |

There is no arbitrary expiry extension, immediate downgrade, trial reset or usage-reset option. Separate test accounts can cover both paid plans and trial behaviour. A trial starts only through the normal first import with the trial feature enabled; this command does not bypass trial identity/abuse controls. Upgrades preserve consumed/reserved balances, while a genuine new billing period gets its normal fresh allowance. Subscription and retention updates commit together, preserving surviving-content rules. The command assigns entitlements only: it does not charge money or invent a payment record.

Existing standalone/manual grants are rejected rather than silently converted or replaced. The planned clean-state rollout removes those old accounts; running this command does not perform that reset.

## Capabilities and preparation

`GET /v1/capabilities` keeps its existing subscription, feature, limits and service configuration fields. Valid lifecycle accounts additionally expose:

- `lifecycle.trial`: `state`, `startsAt`, `expiresAt`; states are `eligible`, `active`, `expired`, `unavailable`.
- `lifecycle.paid`: `state`, `plan`, `startsAt`, `expiresAt`, `cancelAtPeriodEnd`, `nextPlan`; states are `none`, `active`, `scheduled`, `expired`, `withdrawn`.
- `lifecycle.nextChangeAt`: the next known future access boundary, or null.
- `intake`: `available` and `reason`. Active access permits intake. An eligible account permits intake preparation only when trial activation is enabled.

When enabled, a missing grant is trial-eligible. Malformed grants and withdrawn accounts fail closed. Existing manual or paid accounts never gain a trial automatically. Eligibility permits new import submission, YouTube/Drive validation, Picker sessions and Drive authorization; these preparation requests do not start the trial. Brand updates, generation, transcription retry and import retry continue to require active access. Retained owner-checked project, output, brand and usage reads remain available without active access.

For lifecycle accounts, shared accounting does not expose a single aggregate `periodId`: trial and paid periods have separate identities. The effective paid plan supplies access while its valid meters and any remaining valid trial meters fund work independently, trial first. Per-source `capabilities.operationalLimits.maxSourceSeconds` and `maxSourceBytes` now follow eligible access: trial 1,800/3,000,000,000; lower paid 2,700/5,000,000,000; higher paid 3,600/6,000,000,000. Bytes use decimal GB. Paid caps apply independently of trial-first funding. Manual/legacy access retains 1,800 seconds/2 GiB. The frontend renders these backend values without plan checks; project detail does not fetch account capabilities for this purpose. Create and explicit import retry durably snapshot the authorized caps for actual-byte/probe validation and subsequent processing; automatic attempts and exact accepted replay keep that snapshot. Historical records without it use the legacy fallback. Unknown duration reserves the accepted duration cap, then settles measured whole seconds. These admission bounds do not establish measured multi-GB throughput or cost readiness; see the [release requirements](retention-implementation-plan.md#release-requirements).

## First import and retries

New import initiation authenticates, validates the local body/source/idempotency key and resolves accepted replay before new-request authorization. Reliable storage and selected-source configuration checks happen before activation. The backend rejects known-full queues and exhausted source allowance before provider inspection, without promising final capacity. New-trial identity and request-budget checks also precede activation. Only then does an eligible account atomically acquire its identity-use claim, one trial start, seven-day deadline and stable period identity, before upstream metadata validation. Upstream failure or a later atomic admission failure preserves that start. Final transactional queue and funding admission remain authoritative.

Accepted idempotent replay bypasses activation and upstream validation. Preflight, browsing, capabilities and usage never activate access. A subsequent import after a failed validation reuses the original trial. Transactional admission reads current lifecycle state again, so preparation does not reserve capacity or guarantee admission.

## Usage and continuity

`GET /v1/usage` remains read-only for unstarted, inactive and expired accounts. Lifecycle usage includes `access`, `lifecycle` and `periods`. Each period identifies `kind` (`trial` or `paid`), shared `accounting.periodId`, dates, `active`, `limits`, `reserved`, `consumed` and `remaining`. Top-level meters aggregate active periods; inactive periods retain historical counters and report zero spendable remaining allowance.

Paid activation grants a full paid period immediately without changing trial balances or their deadline. Upgrade adds 130 credits and 18,000 seconds to the same paid period; downgrade applies at renewal, and cancellation leaves access through actual paid expiry. Already accepted work retains stored funding owners through ordinary expiry or renewal, subject to work/source/transcript deadlines and explicit withdrawal checks. Public REST and finite SSE acceptance/reconnect behavior are unchanged.

The approved retention matrix applies to all content. trial originals expire at trial start +14 days and transcripts/outputs at +30 days; paid originals expire at successful import +60 days, and transcripts/outputs retain while paid plus 60 days from actual paid end. Promotion and reactivation extend only individually surviving resources and preserve saved promise floors; logically expired/deleted resources never revive. Old retention records and adoption are unsupported; deploy only after the clean-state reset described above.

Public output expiry remains a finite ISO `expiresAt`; optional `retentionMode: "while_paid"` supports the paid-copy projection. Project GET/list and original/retry import replays expose the same effective source expiry before cleanup rewrites. Minimum project/source identity and original URL survive content expiry until user deletion; private content snapshots expire with retained content, while account settings and audit records have separate lifecycles. Immutable owned object paths retain opaque zero-byte deletion barriers against delayed uploads; application expiry is not immediate permanent cloud erasure.

## Explicit source restoration

Explicit source restoration is implemented through `POST /v1/projects/:id/restore-source`; successful restoration consumes source-processing minutes, and live cached-transcript reuse requires verified source-content identity. Legacy live transcripts without verifiable identity are blocked; projects without a live transcript may restore. Deleted projects and expired transcripts are not resurrected. The authenticated, idempotent command uses the saved original Drive/YouTube identity and existing import queue/JSON/SSE operation identity. It requires active access, reserves source allowance and excludes overlapping generation/restoration. Successful attachment settles measured whole source seconds once; failure releases its new reservation without refunding the original import. It restores only Riflo’s copy, leaving the external original and surviving outputs unchanged. Verified digest mismatch fails `source_changed`; unverifiable live-transcript binding fails `source_identity_unverified`, requiring a new-project import. Byte-different re-encodes may therefore be rejected even if visually equivalent. `source_restore_not_available` reports an ineligible or changed source state. Automatic restoration, larger-source readiness, payment collection and production trial release remain outside this integration. Compatible readers/writers/workers, actual bucket retention settings, Firestore backups/PITR, indexes/rules, cleanup health, abuse secret/TTL deployment and truthful offering/privacy disclosure are release gates; no live cloud verification or public enablement is implied. See the [retention implementation record](retention-implementation-plan.md).


## Minimum trial-abuse controls

Riflo account ownership remains the UID from Firebase Admin token verification with revocation checking. **New** trial activation additionally requires `email_verified: true`, current `firebase.sign_in_provider: "google.com"`, and one valid Google subject in the reserved provider identity claim. The current browser implements Google login. Browser-supplied email, account IDs, brands and Drive connections cannot substitute for the verified login. Paid/current-trial accounts are not automatically given new trials. Accepted matching replays resolve before new-work checks.

The server uses a dedicated `TRIAL_ABUSE_HMAC_KEY` of at least 32 bytes encoded as an even-length hexadecimal string. Missing configuration yields `trial_not_configured` for new-trial preparation/activation; malformed supplied configuration is rejected at startup. Nothing generates or rotates this secret automatically. Do not reuse encryption keys from another feature. Stable provisioning and any future rotation with existing claims require an explicit deployment/migration policy.

`trialAbuseClaims/{subjectHmac}` records only `version` and `startedAt` (integer UTC epoch milliseconds). `trialAbuseBindings/{uidHash}` records only `version` and `subjectKey`; its key is a namespaced SHA-256 UID hash. Both sit outside account-owned data, and their creation commits with trial activation. Deleting/recreating the Firebase user or removing its grant must not bypass either record. Minimal pseudonymous trial-use evidence is retained while the lifetime trial restriction applies. It is not content retention and requires truthful privacy disclosure. Neither record stores raw email, Google subject, IP, source URL or device information.

Trial-side provider-facing preparation and new commands share a persisted request budget: initially **10 per minute and 60 per hour**. Preparation includes YouTube/Drive validation, Picker credentials and Drive authorization; new commands include import/retry and generation/transcription retry. Failures count. These are backend engineering defaults, not additional credits or source allowances. Active paid access and accepted replays keep their existing contracts. Existing trial accounts without an identity binding use UID-scoped request evidence without retroactive identity rejection. No shared-network or device block is introduced.

Costly new command preparation additionally has a cumulative **120-attempt ceiling** across the trial: imports (including import retries), generation and transcription retries reserve before upstream work, and failures count. Cheap source validation, Picker and authorization preparation use only the minute/hour limits. This is the source constant `trialWorkLimits.commands`, an engineering default rather than a user-approved offering or a deduction from the trial's 15 creation credits. Existing active trials acquire the counter from zero when absent, without retroactive billing or identity rejection. Active manual or paid access and exact accepted replay bypass both budgets. The approved seven-day/15-credit/45-minute trial and $39/120-credit/300-minute and $69/250-credit/600-minute paid offerings remain unchanged.

`trialAbuseRates/{subjectHmac-or-legacyUidKey}` overwrites minute/hour counters and cumulative `workCount`. Its Firestore timestamp `expiresAt` is the maximum of its previous value, last admitted request +24 hours, and (for costly commands) trial expiry +24 hours; the first command before activation uses now +8 days. Cheap preparation cannot shorten an existing deadline, so TTL cannot reset the ceiling during the active trial. This bounds state per identity rather than creating per-request history. Actual Firestore TTL configuration and eventual deletion must be verified before public release; local code does not establish that cloud policy. Persistent claims/bindings must not receive that TTL. A request budget limits repeated inspections, including concurrent same-key requests before acceptance; it does not guarantee one upstream call for those concurrent requests. Transactional project acceptance and funding remain idempotent.

| HTTP status / code | Meaning and recovery |
| --- | --- |
| 403 `trial_identity_required` | New trial needs verified Google sign-in. Sign out and sign in with the supported verified account. |
| 403 `trial_already_used` | This identity or UID has already received a trial. Use the original account or paid access; no new grant is created. |
| 403 `trial_work_limited` | Cumulative trial processing request ceiling reached; paid access remains available. No `Retry-After` or claim that waiting restores the trial budget. |
| 429 `trial_rate_limited` | Temporary trial request budget reached. `Retry-After` contains positive integer seconds; the JSON error also exposes `retryAfterSeconds` with that value. |
| 503 `trial_not_configured` | Dedicated identity verification configuration is unavailable. No trial starts; try later after server setup. |

All errors retain `{error:{code,message}}` with the documented safe retry extension. Current UI copy is locally mapped and displays the server retry delay. First definite 403/429 admission rejections allow replacing a submission; a prior uncertain request always preserves its original key and payload. GET capabilities, usage, project/output reads and ordinary source browsing never start a trial. Retained authenticated reads and finite REST/SSE command/observation contracts are unchanged.

The ceiling counts command preparations, not provider calls or dollars: internal retries and fanout retain their separate worker bounds. Cheap pretrial preparation can continue at 60/hour while no trial starts. Residual multiple-Google-account abuse remains; the implementation does not claim one-trial-per-human proof. Public enablement remains subject to the [release requirements](retention-implementation-plan.md#release-requirements); local verification is not deployment approval.


### Private-read resource limits

Private source and output reads are byte-bounded and use a 180-second deadline. At most eight read workers run concurrently per process; exceeding capacity fails promptly through the existing safe 503 service-unavailable response. This is an operational resource limit, not a per-account video-count cap or a change to plan source allowances. Audio/video workers treat read capacity and deadline failures as retryable. Download cancellation waits for the SDK worker to terminate, including pending authentication and pre-header I/O; disposal closes remaining readers on shutdown. These mechanisms do not establish measured multi-GB throughput or provider cost readiness.
