# Trial and paid lifecycle: proposed next implementation slice

Planning only, 29 October 2026. No application, grant, billing or runtime changes accompany this document.
Offering authority: [frozen findings](../TEMP_PRODUCT_OFFERING_FINDINGS.md) and [development record](../TEMP_DEVELOPMENT_CHANGES.md).
The historical lifecycle decisions below were supplied from earlier user approvals; they are a documentation gap in those files, not questions to reopen.
Implementation choices and continuity recommendations are explicitly proposals pending review.

## Approved behavior and boundaries

- Trial: seven days, 15 creation credits, 2,700 source seconds, no card; starts on first import initiation, including a subsequently failed import.
- Paid lower/higher: $39/$69 monthly, 120/250 credits and 18,000/36,000 source seconds; all six formats, shared quality.
- Creation charges: written output 1, carousel 2, short video 4; reuse the backend catalogue.
- Subscription starts a full paid period immediately. Preserve unused trial balances until their original expiry; spend each valid trial meter before its corresponding paid meter.
- **Earlier approved upgrade:** lower→higher charges the full $30 price difference and adds 130 credits/18,000 source seconds, without proration, date changes, counter reset or a fresh period ID.
- **Earlier approved downgrade:** lower capacity takes effect at renewal. **Earlier approved cancellation:** access continues to actual paid-period end.
- No paid rollover, MVP top-ups, automatic restoration, payment integration or new publishing/brand entitlement work.
- Ownership remains the verified Firebase UID. One brand now; future additional brands do not own allowances or create new trials. Drive connections do not select Riflo identity.
- Approved larger-source limits remain separate readiness work. Current effective ceiling stays 30 minutes/2 GiB; future effective caps are the minimum of supported operational limits and access entitlement.
- **Cap recommendation:** source caps follow effective access (paid when paid), independently of whether trial seconds fund an import. A leftover trial balance should not demote paid access; the current operational minimum still applies.

## Read-only findings from the current implementation

- `src/access/plans.ts` records the offering and builds opt-in shared grants; it activates no trial or subscription.
- `policy.ts` parses one legacy/manual or shared-credit grant. `accepted-work.ts` hashes legacy dates, while shared IDs are explicitly stable across within-period upgrades.
- `accounting.ts` requires each shared slot charge to use `batch.period`; project source reservations also have one owner period.
- `src/projects/firestore.ts` settles source seconds on successful import. `src/generation/firestore.ts` preserves legacy first-delivered-output source settlement.
- Accepted work currently survives ordinary expiry/renewal but cannot survive missing/malformed/withdrawn access. Current same-period feature removal blocks pending work.
- `src/projects/service.ts` checks idempotency, then authorization, then upstream validation, then durable acceptance. Existing HTTP access gates would reject an unstarted trial before intake.
- Project removal reads separate source/batch owners, but still assumes only one ledger per batch. Claims, releases and saves make the same assumption.
- Current retention is the old source 1/7/30-day snapshot and 30-day transcript/output behavior. Approved trial/paid retention is not implemented.

## Proposed minimal state and transitions

Use an explicitly versioned lifecycle shape at `subscriptionGrants/{uid}` alongside unchanged legacy parsing.
Keep persistent trial facts/grant, current paid plan/grant, next-renewal plan/cancellation intent, explicit withdrawal state and a transition revision.
Reuse existing allowance documents at `accounts/{uid}/allowances/shared-{allowancePeriodId}`; do not create another balance system.
Keep expired trial facts to prevent a second UID trial. Derive active/expired state from fixed timestamps rather than scheduled resets or mutations during reads.
Current paid/manual accounts must not automatically receive a trial. Missing, malformed, withdrawn and already-used states require explicit eligibility classification.
Compatibility is opt-in: no automatic grant conversion, historical debit or funding-mode migration; an eventual conversion needs a separate explicit policy.

Trusted internal transitions take an operation/event identity, payload fingerprint and validated predecessor revision/state.
The same identity and same payload replays the recorded result; changed payload, stale predecessor or conflicting period identity returns a conflict without granting again.
Persist replay evidence with the transition transaction. Do not rely on remembering only the latest event, which cannot protect older retries.
Use existing ID generation and explicit UTC period boundaries; do not invent a monthly date-arithmetic policy or infer payment from a browser request.
No public administrator endpoint, payment mock, webhook system or provider abstraction is needed for this slice.
Internal paid transitions are testable lifecycle functions, not end-to-end billing; the trusted operational caller/handoff remains pending. Do not add an unapproved administrator CLI.

| Transition | Proposed data operation implementing approved behavior |
| --- | --- |
| First eligible import initiation | Atomically persist one fixed trial start/end and stable trial period ID. Failures never reset them. |
| Trial→paid | Fresh paid period/full limits; trial facts, balances and deadline remain unchanged. |
| Within-period upgrade | Update paid plan/limits using approved differences; retain period ID, boundaries, counters and reservations. |
| Renewal | New unique period ID/full selected-plan limits; retain old ledgers for settlement/history. |
| Downgrade/cancel intent | Save intent; keep current entitlement until actual paid end. Cancellation clicking does not start archive grace. |
| Ordinary expiry | Exclude expired funding from new admissions; do not delete ledgers or reset counters. |
| Explicit withdrawal | Prevent remaining provider admission/delivery and release pending reservations through existing failure paths. |

## Proposed first-import boundary

Capabilities, source browsing and source-validation preflight may report trial eligibility without activating it; GETs never start the clock.
For a new import command: authenticate → validate local body/source shape/key → resolve accepted replay/conflict → persist eligible trial activation → call upstream validation → reserve/accept intake atomically.
An accepted replay never starts another trial or invokes upstream validation again. Source validation alone never starts a trial.
Upstream failure after activation preserves trial time but creates no consumed source charge. Concurrent initiation/subscription must serialize on lifecycle state.
**Pending engineering boundary:** recommend cheap configuration/rate rejection before activation, with an optional early queue check rejecting an already-full queue without starting trial. This check promises no capacity; final queue/capacity validation remains atomic at acceptance. If the queue fills after activation, reject intake but preserve its trial start. Exact placement remains a recommendation to confirm.
Do not move activation behind successful upstream inspection or import completion to simplify this boundary.
One trial per UID is a baseline, not proof of one human. A proportionate minimum no-card abuse gate remains a rollout prerequisite; no card, invasive tracking or blanket shared-network ban is approved.

## Proposed funding ownership and settlement

- **Split-balance recommendation:** allow one output/import to span trial and paid funds; e.g. a four-credit clip uses three remaining trial credits plus one paid credit. This implements full trial-first use rather than stranding a remainder.
- Store at most two explicit funding allocations per new slot/source reservation: trial and paid. Keep the immutable accepted output cost and original funding identities.
- Normalize old shared single-period charges into one allocation on read; keep legacy per-format work distinct. Do not rewrite historical records merely to read them.
- Keep admission authority separate from funding identity: a paid-admitted batch can consume trial credits. Feature withdrawal must not be inferred from its first funding allocation.
- In one Firestore transaction, read all distinct owning ledgers before writes; reserve the complete selection or nothing. Coalesce repeated owners before modifying counters.
- The two-allocation bound is per slot/source, not per cleanup transaction: deletion can touch three or more historical ledgers across source ownership and later batches.
- Source and creation meters choose trial-first independently. Settlement, retry, failure, claim recovery, deletion and expiry must use stored owners, never whichever grant is current later.
- Successful import consumes measured whole seconds once. If smaller than reserved, consume trial first and release excess paid reservation first. Failed import releases every allocation.
- Duration increases may use only original eligible funding identities and original accepted funding budgets/limit snapshots. Never create debt in a later renewal; reject unsupported adjustment safely.
- Unique persisted output consumes every snapshotted allocation once; terminal failure/duplicate/deletion/work expiry releases all pending allocations. Retry retains the reservation.
- **Expiry continuity recommendation:** already accepted queued/running trial-funded work finishes after ordinary trial expiry, subject to existing source/transcript/work deadlines and withdrawal checks. Only new funding stops. This extends the current accepted-work contract; review explicitly against trial copy before rollout.
- Existing legacy imported sources keep their established first-delivery settlement; cached transcripts do not erase an unsettled source charge. No retroactive read-time debit.
- Explicit transcription retries remain zero customer credits/source seconds. Provider expense stays separate per attempt, including failed/discarded/late attempts.

## Exact implementation consumers and validation

| Files | Required scope |
| --- | --- |
| `src/access/policy.ts`, `plans.ts` | Versioned lifecycle parsing, effective entitlement/capability projection, backend offering configuration. |
| Proposed small `src/access/lifecycle.ts` and persistence helper | Pure transitions/eligibility/funding selection; transactional activation and trusted transition replay. No general lifecycle framework. |
| `src/access/accounting.ts`, `accepted-work.ts` | Normalize snapshots, enumerate funding owners, reserve/consume/release, preserve admission/withdrawal semantics. |
| `src/projects/service.ts`, `firestore.ts` | Activation boundary; source create/retry/usage/claim/renew/complete/fail/remove and legacy reservations. |
| `src/generation/service.ts`, `firestore.ts` | Slot/source snapshots; admission, `reservationsCover`, `claimResources`, claim/recovery/finish/failure/save, availability and legacy settlement. |
| `src/firebase.ts`, `src/http/app.ts` | Lifecycle loading and all existing access consumers: capabilities, brand PUT, source validation/Picker, import/retry, generation/transcription retry and usage. Retained reads stay accessible. |
| `../riflo-frontend/src/features/account/account-response.ts`, `usage-response.ts`, `UsagePage.tsx`, `access-message.ts` | Update access/usage parsers, separate balances/deadlines and guidance. Usage must be readable while inactive or trial-unstarted; reading must not activate trial. |
| `../riflo-frontend/src/features/projects/LiveProjects.tsx`, `ImportVideo.tsx`, `ImportRetry.tsx`, `project-response.ts` | Permit eligible trial intake preparation without activation; preserve command/replay and retry guidance. Preparation, browsing and preflight never start the clock. |
| `../riflo-frontend/src/features/projects/generation-response.ts`, `GenerationPanel.tsx` | Parse project-scoped access/funding guidance and refresh availability when trial expires even while paid access remains active. Do not add account requests to project detail. |
| `src/sources/source.ts`, `drive/files.ts`, `youtube.ts`, `projects/worker.ts` | Verify source-cap consumers agree with effective entitlement/operational minimum; retain present technical ceilings. |
| `README.md`, development record and API contracts | Document versioned compatibility, activation clocks, meter display, upgrade/cancel rules and rollout limitations when implementation is approved. |

Use existing test runners/emulators and targeted regression cases; no new test framework.
Extend `test/generation/credits.test.ts`, `accepted-work.test.ts`, `availability.test.ts`, `firestore.test.ts`, `transcription-retry.test.ts`; `test/projects/firestore.test.ts`, `api.test.ts`, `operation-identities.test.ts`; `test/http/app.test.ts`, `test/sources/api.test.ts`, `test/brand/api.test.ts` and `test/retention/regressions.test.ts` where their consumers change.
Cover first-import validation failure/replay/concurrency; trial expiry; both meters independently exhausted; split slot/source; actual-duration adjustment; renewal during work; upgrade replay/downgrade/cancel; withdrawal; deletion releasing multiple owners; malformed data; legacy compatibility and cross-UID isolation.
Test internal trusted transitions and funding transactions before integrating any frontend flow.
Extend existing frontend unit tests for response parsing, allowance display and access messages; preserve `../riflo-frontend/test/browser/project-reads.mjs` regression coverage for project-only reads, availability refresh and command recovery without extra account requests.

## Sequential delivery and dependencies

1. Review this scope, settle pending activation rejection boundary/minimum abuse gate, and confirm split/queued-expiry recommendations. Preserve historical approvals rather than reopening amounts.
2. Implement/test lifecycle resolution and bounded allocation normalization across old accounting, source/generation settlement and release paths; preserve existing accepted work first.
3. Implement/test first-import eligibility/activation and dual-meter trial/paid admission internally, including concurrent initiation and original-funding settlement. Keep real-user activation unavailable.
4. Implement/test trusted paid activation, upgrade, renewal, downgrade/cancel and replay/predecessor conflicts without payment integration; document the pending operational caller.
5. Wire all HTTP access consumers and define public capabilities/usage/availability fields for separate balances/deadlines. Integrate frontend only after internal transition and emulator checks pass.
6. Satisfy retention compatibility, abuse and truthful privacy/offering release gates before enabling real-user trial activation. Approved trial original day 14/output day 30 and paid promotion cannot be promised while old cleanup deletes earlier. This is a rollout dependency, not retention implementation added to this slice.

At this scope's planning stage, retention promotion/deletion execution, explicit restoration, payment provider integration, larger-source readiness and multiple-brand features were follow-on work. Explicit source restoration is now implemented separately; see [current contracts, source-minute accounting and verified-identity/legacy limits](implementation-assumptions-and-attention.md#explicit-source-restoration--implemented-independent-acceptance-pending-30-october-2026). Automatic restoration remains excluded, and root independent restoration acceptance remains pending.
Preserve trial start, paid start/end and period identity so retention can use approved clocks; funding period is not a retention classification.
Do not claim production readiness from catalogue tests, UID-only trial protection or unchanged cleanup behavior.
