# Retention implementation plan — implementation record

29 October 2026. Implementation is authorized for the approved decisions below. Backend phases 1–4, retention API projections and trusted adoption are implemented; integrated release verification remains a separate gate. This work does not enable retention/public trials, change the actual `.env`, inspect live cloud settings, or run adoption against live data. Offering context comes from `TEMP_PRODUCT_OFFERING_FINDINGS.md`.

## Outcome and boundaries

Implement the approved retention clocks across reads, processing and deletion, preserve promised access and legacy behavior, and prevent subscription changes from reviving logically expired or deleted data. Keep access entitlement, funding ownership and retention classification separate.

Keep `TRIAL_ENABLED=false` for public use until retention compatibility, proportionate no-card abuse controls and truthful offering/privacy disclosures are ready. Abuse implementation, billing/payment integrations, source restoration, larger-source readiness, credit changes, publishing and brand capabilities are separate work. Retention alone grants no generation access or allowance.

## Parameter and decision checklist

| Parameter | Status | Required behavior / next decision |
| --- | --- | --- |
| Trial generation | Settled | Seven days from first import initiation; failed import never resets start. |
| Trial originals | Settled | Expire at trial start +14 days, including later trial imports. |
| Trial transcripts and all generated outputs | Settled | Expire at trial start +30 days; generation ends independently on day 7. |
| Paid originals, both plans | Settled | Each successful import +60 days, including while paid; renewal does not restart this clock. |
| Paid transcripts and all generated outputs | Settled | Retain while paid, then 60 days from actual paid-access end. |
| Trial-to-paid | Settled | Surviving data adopts paid policy; preserve promised deadlines; recover nothing deleted. |
| Trial funding while paid | Settled | Trial-first meters never demote effective paid retention; source and creation funds remain independent. |
| Cancellation / downgrade / upgrade | Settled | Cancel intent keeps access through actual paid end; downgrade at renewal; upgrade retains period/dates. Neither current paid plan changes retention. |
| User deletion | Settled | Earlier deletion allowed; source expiry preserves retained transcript/output access; original Drive/YouTube files unaffected. |
| Exact boundaries | Recommendation | UTC epoch milliseconds; live only when finite effective deadline is strictly greater than now. Treat logically expired data as unavailable even before physical deletion. |
| Paid reactivation during archive grace | Approved | Extend only each resource surviving at activation into the new paid tenure; a longer saved promise can keep an individual resource eligible. Never revive an expired or deleted resource. Original source clocks remain import-based. |
| Refund / administrative withdrawal | Open | Define which trusted event changes actual paid end. Existing processing withdrawal must not silently become an immediate content-deletion policy. Existing refund rules remain unchanged. |
| In-flight work at promotion / paid end | Recommendation to confirm | Retain accepted access origin; reconcile paid promotion transactionally at save. Ordinary expiry preserves accepted funding; fixed work/resource deadlines and withdrawal still apply. |
| Existing lifecycle records | Approved | Explicit trusted dry-run/apply adoption of surviving records with verified origin and saved deadlines. Unknown or ambiguous records preserve their saved expiry behavior; no guessed historic promotion times. |
| Legacy/manual grants and records | Compatibility requirement | Preserve existing finite promises and current grant semantics; no automatic grant conversion, historical debit or read-time migration. |
| Private content snapshots | Approved | Remove private content payloads and snapshots when their retained content expires or the user deletes it; retain necessary financial/idempotency metadata separately. Account writing settings and audit records have separate lifecycles. |
| Minimal project/source metadata after content expiry | Approved | Preserve the minimal project/source identity and original source URL until user deletion. Expiry removes content payloads and private snapshots; account settings and audit records remain separate. |
| Public expiry projection | Engineering recommendation | Preserve mandatory finite ISO `expiresAt`; compute known guaranteed deadline including paid end +60 and old promise floor. Add only the minimum retention mode needed for while-paid copy; no duplicated nested availability state or nullable replacement dates. |
| Advance reminders | Deferred / outside this slice | Optional future product work; not a phase 0 blocker or required implementation. |
| Permanent-erasure disclosure | Required verification | Actual backup/recovery disclosure remains undefined; availability deadline is not immediate permanent erasure. |
| Cleanup timing / operational bounds | Engineering decision | Bounded pages, retries/backoff, leases, real I/O timeouts and monitoring; do not invent new customer limits or promise immediate physical deletion. |
| Cleanup configuration and health | Engineering requirement | Validate backend defaults for cadence, page size, leases, backoff and SDK I/O timeouts against load; measure due age, backlog, attempts/error class and worker heartbeat. These are operational controls, not plan limits. |
| Storage and operation costs | Verification requirement | Track live, pending-delete, soft-deleted/noncurrent and backup bytes separately; measure Firestore reads/writes, object deletion operations and egress. Inspect actual storage classes and applicable early-deletion charges; invent no prices or customer quotas. |

## Original implementation gaps and data inventory

The following inventory describes the starting point; the implementation status below records work completed against it.

- `src/projects/firestore.ts` snapshots 1/7/30 source days at admission/retry and saves `sourceExpiresAt` at successful import. It does not save immutable successful `importedAt`; mutable `updatedAt` cannot supply this anchor.
- `src/generation/firestore.ts` saves creation-time +30-day transcript/output expiry. Raw `expiresAt` also controls history, exact duplicate detection, reads and assets. `src/generation/retention.ts` currently handles source/transcript checks only.
- `src/generation/worker.ts` schedules an initial abort from snapshotted resource deadlines. Promotion/renewal can extend those deadlines; the old timer must not abort otherwise valid work. Fixed stage/batch budgets must remain bounded.
- The asset path's `expiresAt <= now` rejection can admit malformed/NaN deadlines. Replace this with the same finite, fail-closed predicate used by all content consumers.
- Output cleanup unconditionally batch-deletes expired candidates; source cleanup checks attempt/path/deadline but not account retention authority. Both need transactional reconciliation with promotion.
- Inventory includes canonical source copies, transcript text/words, output text/structured content, rendered images/videos, abandoned attempt paths, private batch/history/request snapshots, local scratch and durable deletion manifests.
- Allowance/usage/cost history, idempotency identities, account brand settings and external connection metadata have separate purposes. Determine content-bearing fields explicitly; do not interpret output expiry as permission to delete all account metadata.

## Minimal retention facts and ownership

Use one pure resolver in `src/generation/retention.ts`, consumed everywhere. Do not add a configurable policy engine, another allowance system or a billing event-log reader. All records remain owned by verified Firebase UID; funding allocations are immutable accounting facts, not retention classes.

Add versioned retention metadata only for the new path, with trial anchor or paid-tenure identity, accepted access origin and original finite promise floor. Save new `importedAt` only in the successful import transaction. Preserve legacy timestamps/deadlines unchanged; recover an old import anchor only when its original frozen duration proves it, otherwise require an explicit migration decision.

Persist a compact paid-tenure fact under the UID: stable ID, start, actual paid end, archive deadline and revision. Contiguous renewals extend this document rather than rewriting every output. Persist the first trial promotion timestamp and tenure reference atomically with trusted activation. A trial record is eligible only if its original deadline exceeded promotion time and deletion was not already claimed. Sources still derive their paid deadline from successful import, not tenure end.

A current paid end alone cannot distinguish an expired old archive from new content after reactivation; per-record frozen paid ends require bulk rewrites; billing receipts are excessive for this purpose. The small tenure fact is the minimum durable distinction. Contiguous renewals extend the same tenure; paid gaps create a new tenure. Reactivation resolves survival per resource, including its saved promise floor, against the activation time before applying the newer tenure. This avoids reviving shorter-lived resources merely because another resource survives. Do not retain a monthly renewal event history for retention.

Per request/page, fetch account facts once and each distinct referenced tenure once; no per-output account requests. Existing receipt/revision transactions remain the transition boundary. Readers use `max(original promise, applicable policy deadline)` only for a resource eligible for that policy; this must never turn an expired/deleted resource live again. New explicit restoration, if later implemented, creates a new successful import anchor.

At subscription changes, reads and final saves must observe authoritative facts. A trial-funded output admitted while paid is paid-classified. Paid-admitted work delivered after ordinary paid expiry retains its accepted tenure. Never settle funds from whichever period happens to be current at completion.

## Shared availability and processing rules

Use the resolver for source availability, transcript cache/retry, output list/detail/TXT/assets, project availability, provider history and transactional duplicate checks. A store-read fix alone is insufficient: `generation/history.ts` independently filters raw dates, and duplicate comparison also does so inside output persistence.

Finite numeric stored deadlines remain useful as legacy promises and query candidates; they cannot independently authorize deletion of versioned paid content. Missing/malformed new facts must fail closed for delivery and avoid destructive guesses during cleanup; record an actionable operational failure. Never extend a legacy transcript from current read time.

Refresh resource deadlines when heartbeat/claim/save checks observe promotion or renewal. Re-arm only the resource portion of the abort deadline, preserving original fixed stage and batch deadlines. Reject stale claims, deleted projects and expired required resources before provider admission and final persistence. Keep measured/unknown provider expense even for discarded late responses. Retained transcripts permit eligible text/carousel work after source expiry; clips/transcription need source bytes, with no hidden upstream download.

## Cleanup and storage authority

Reuse the existing durable `assetCleanup` queue. Transactionally reread resource, project and retention authority before committing logical expiry/deletion plus its deletion manifest. Only then perform external deletes. Promotion and deletion must serialize: promotion first recomputes retention; deletion first leaves an irreversible state that promotion and late saves respect. Output batch deletion without this check is unsafe.

Existing queue entries contain paths only: they are safe only after irreversible logical deletion. Delete only Riflo-owned paths verified against UID/project/attempt; never delete original Drive/YouTube files. Preserve path ownership/attempt identity, use object generation preconditions where needed, and recheck uploads that can finish after a deletion pass. Consolidate duplicate immediate source deletion and queued deletion into one authoritative route. Retention expiry never refunds successful imports or delivered outputs; canceling pending work releases its exact original funding owners once. Financial settlement/release and partial-output preservation remain transactional and idempotent.

Due-query scans must progress beyond retained or repeatedly failing candidates. Choose bounded cursor-based passes or materialized next-check dates with appropriate indexes; avoid paid records monopolizing the first 50 old numeric deadlines. Persist retry/backoff/lease state as needed in the existing queue. Implement actual SDK-supported request timeouts/cancellation/native options: trace warnings do not cancel hung operations, and `Promise.race` alone leaves pending requests and worker resources unbounded. Do not add another scheduler, framework or excessive queue parallelism. Retain deletion manifests until all owned paths and late-upload rechecks finish. Keep normal scratch removal in `finally` plus the existing abandoned-directory sweep after 24 hours.

Classify transient failures for bounded backoff; permission/retention holds require an alert and deliberate operational resolution, while malformed metadata/tasks require quarantine and investigation rather than destructive guesses or a hot retry loop. Monitor due age/backlog alongside worker heartbeat so a running process cannot hide stalled deletion; report retained billable categories separately from workspace availability.

## Phases, dependencies and exit gates

| Phase | Files / boundary | Completion gate |
| --- | --- | --- |
| 0. Decision and contract review | This plan; offering/development records; lifecycle API/scope docs | Resolve only open policy branches above; decide historical adoption and public finite-expiry semantics; public trial stays disabled. |
| 1. Pure resolver and compatibility | `src/generation/retention.ts`, `src/projects/service.ts`, `src/generation/service.ts`; existing retention/unit tests | Clock tables, malformed/NaN asset deadlines, legacy promise floors, exact boundaries and no-resurrection checks pass. No new record writes enabled. |
| 2. Durable facts and write anchors | `src/access/lifecycle.ts`, `lifecycle-firestore.ts`, `src/projects/firestore.ts`, accepted batch/resource writes in `src/generation/firestore.ts` | Idempotent tenure extension/promotion, immutable successful import anchor, concurrent activation/save and historical compatibility verified transactionally. No bulk renewal rewrites. |
| 3. All consumers and processing | `src/generation/firestore.ts`, `history.ts`, `transcription.ts`, `worker.ts`; `src/projects/firestore.ts` removal/preservation; projections in services and `src/firebase.ts` | Read/list/download/asset/history/dedup/provider/heartbeat/save all agree; deadlines extend without unbounding work; no remaining raw predicate bypass. |
| 4. Safe deletion and scheduling | Existing project/generation cleanup, `src/storage/cleanup.ts`, `src/generation/assets.ts`, project adapters, `src/worker-pass.ts`, `worker-step.ts`, `firestore.indexes.json` as required | Promotion-versus-expiry, late upload, stale path, retry, starvation, timeout and partial-failure tests pass; manifests durable; no auto-TTL canonical deletion. |
| 5. Compatible API and frontend | Backend projections/contracts; frontend project/output/generation parsers and readers/panels | Mandatory finite expiry remains compatible; honest while-paid labels, inactive retained reads, clock/focus/promotion refresh and expired blob/selection cleanup pass without project-detail account requests. |
| 6. Adoption and release evidence | Explicit migration procedure if approved; `README.md`, lifecycle API and development record | Readers/workers deployed compatibly before new-policy writers; old workers cannot delete new records; actual cloud settings/indexes verified; disclosure and independent abuse gates satisfied before public trial enablement. |

Dependency order: 0 →1 →2 →3; deletion design can progress alongside phase 2 but phase 4 integration depends on phases 2–3. Contract design/frontend mocks and independent storage-setting research can run alongside backend work after phase 0; frontend parser/integration work can parallel cleanup after the contract locks. Preserve existing UI structure. Production writer activation waits for all readers, workers and cleanup compatibility, with a mixed-version deployment guard; no single omnibus deployment or partially enabled retention policy.

Each phase gets its targeted existing-runner checks and review before the next dependent phase. Run backend typecheck/build and the isolated full emulator suite after integrated changes; run frontend typecheck/build/unit and targeted browser checks when frontend consumers change. Planning alone establishes none of these checks as passed.

## Required regression scenarios

- First-import failure/replay/concurrency and later imports retain the same trial anchor; day 7 blocks new trial work without deleting retained results.
- Paid activation before/at/after day14/day30; expired files awaiting cleanup remain expired; user deletion always wins.
- Trial-funded/split-funded work while paid; renewal during accepted work; repeated transition events and stale revisions never duplicate grants or change original funds.
- Activation during import, transcription and media upload; post-expiry late provider result; old timers notice extensions while fixed work budgets remain fixed.
- Paid originals expire after import +60 while paid; transcript-based text continues; clips require source and no automatic restoration occurs.
- Cancel click, actual paid end, upgrade, downgrade, grace reactivation and reactivation after archive expiry follow the approved per-resource survival decision explicitly.
- Old/manual records preserve finite deadlines; missing timestamp never becomes read time or mutable update time; explicit adoption changes no historical debit.
- All retained output history and duplicate checks agree after the old raw deadline passes; expired records do not block fresh delivery.
- Cross-UID fact references, malformed/infinite/NaN deadlines and missing tenure documents cannot disclose or wrongly delete content.
- Promotion versus deletion, stale cleanup versus new import, duplicate cleanup, failed external delete, held I/O, late upload and more-than-one-page candidates preserve correctness and progress.
- Frontend reload/focus/clock transitions refresh both outputs and availability; long timers are capped/rearmed; expired selection and blob URLs are cleared; original source URLs remain usable while retained under the chosen metadata policy; no unsupported Restore CTA.

## Implemented maintenance and verification status

The backend now has shared retention resolution, immutable import anchors, lifecycle tenure/promotion facts, retained-content reads/history/deduplication, worker deadline refresh, transactional cleanup claims and bounded durable deletion processing. The API preserves finite expiry fields and adds the retention mode used by while-paid copy. `RETENTION_ENABLED` defaults to false; public `TRIAL_ENABLED` remains false. Frontend implementation and integrated full-suite results are recorded separately by the implementation lead; none of these statements establish production cloud verification or launch readiness.

`createRetentionAdoption` in `src/access/retention-adoption.ts` is a trusted internal maintenance seam, with no HTTP route, startup hook or live-execution CLI. First use `adoptProject` without `apply`, review reasons and the cutoff, then explicitly apply bounded output pages using its returned output cursor. Each page rereads authority and deletion claims. Existing records require exact accepted-slot/transcription-event facts and a provable frozen source import anchor; malformed, expired, deleted, ambiguous or unknown records keep their saved behavior. History/events above the conservative 50-record proof window are reported as `history_limit`; this is a maintenance proof bound, not a customer quota or permission to truncate history.

For projects whose whole hash inventory cannot be audited in the small adoption transaction, use `backfillOutputFingerprints` separately. Confirm that **all** output writers hash immutable canonical content before starting and retain that deployment fence throughout the proof; pass `writersUpgraded: true` on every call. Review its dry run, then apply bounded pages and resume with the returned `proofId`. The cursor, processed count and completion state live in a private project maintenance document; callers cannot choose or advance a cursor. No maximum project output count is imposed. Each transaction validates every canonical output on that page and patches incorrect/missing hashes; a noncanonical record blocks completion without advancing the page. Only the final transaction sets `dedupVersion: 1`. Hash proof is independent of retention adoption's history/event bounds and changes no expiry, access authority or funding facts.

The upgraded-writer assertion is a trusted deployment precondition, not detection of arbitrary out-of-band admin edits. Concurrent compatible inserts before the server cursor are safe because they already carry canonical hashes. Old writers or manual writes of unhashed/mutable content must be stopped before proof; if that invariant breaks, withdraw the marker and restart the proof from the beginning after fixing writers. Compatibility scanning remains until successful proof, and remains necessary for malformed inventories requiring investigation.

Focused emulator verification on the isolated `demo-riflo` Firestore emulator: adoption plus resumable hash-proof tests passed (11 tests), including 45-output inventory with more than 50 history records, bounded pages, compatible insertion before the cursor, forged proof/writer guard rejection, no dry-run writes, unchanged saved expiry promises and failure of a noncanonical final page. Backend typecheck passed after these changes. Full integrated verification remains pending in this record until the implementation lead records its result. No production cloud or provider operation was performed.

Final integration fixes project effective source expiry through original/retry import replays (including transactional key races) before cleanup, purges the private maintenance proof collection in bounded user-deletion pages, and drains already-running worker resource renewals before teardown so they cannot re-arm timers. Controlled worker tests reproduced all three teardown cases before the fix and pass afterward (18 worker tests total). Real-store public replay plus cleanup regressions passed (8 emulator tests, including 61 rows in each of six child collections); the targeted live-carousel case also passed without late SDK activity. Typecheck passed after these changes. Integrated full-suite evidence remains pending the separate verification run.

## Cloud verification and disclosure evidence

These are platform facts, not observations of the deployed bucket/database:

- Cloud Storage soft delete commonly defaults to seven days, is configurable and remains billable. Check actual bucket settings before disclosing a recovery duration. [Soft delete](https://docs.cloud.google.com/storage/docs/soft-delete)
- Versioning can retain billable noncurrent object generations independently. [Object versioning](https://docs.cloud.google.com/storage/docs/object-versioning)
- Storage lifecycle actions run asynchronously and offer no arbitrary custom `expiresAt` metadata condition. Do not use them as the paid-retention access authority. [Lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle)
- Strong object consistency does not serialize a Firestore decision with an external object deletion/upload; preserve application ownership/generation checks. [Consistency](https://docs.cloud.google.com/storage/docs/consistency)
- Firestore TTL is asynchronous, requires supported date/time fields rather than numeric epoch fields, does not guard reads and does not recursively remove subcollections. It cannot replace application manifests and availability checks. [TTL](https://firebase.google.com/docs/firestore/ttl), [Delete data](https://firebase.google.com/docs/firestore/manage-data/delete-data)
- Firestore backups and point-in-time recovery are separate retained copies. Inspect their actual enablement/windows and the handling of content-bearing logs/snapshots. [Backups](https://firebase.google.com/docs/firestore/backups), [PITR](https://firebase.google.com/docs/firestore/use-pitr)

Before launch, record actual soft delete/versioning/lifecycle/retention-lock settings, Firestore backups/PITR, deployed indexes/rules, cleanup health and honest availability-versus-permanent-erasure copy. Do not change those settings during planning or infer them from prior audit notes.

Worker teardown waits for its already-running Firestore renewal; it uses installed SDK RPC deadlines/retry budgets and transaction retry limits, not a synthetic `Promise.race` cancellation. The installed Firestore API configuration includes finite RPC timeouts and a 600,000ms retry budget for retryable RPCs. This can make database teardown substantially slower than the fixed provider stage budget during outages; the stage budget does not cap Firestore latency. No custom store that returns an indefinitely pending renewal is guaranteed bounded teardown.
