# Content retention

Updated 11 November 2026. Riflo uses one subscription-aware retention policy. There is no retention rollout switch or fixed-expiry compatibility path.

## Product rules

| Content | Trial | Paid, either plan |
| --- | --- | --- |
| Original video | Trial start +14 days | Successful import +60 days |
| Transcript and generated outputs | Trial start +30 days | While paid, then 60 days after actual paid access ends |

Trial generation access still lasts seven days from first import initiation. Trial funding used during a paid subscription does not demote retention. Source and creation allowances are independent of storage deadlines.

Surviving trial content adopts paid retention on activation. Renewal extends transcripts and outputs without rewriting them individually. Resubscribing during archive retention extends surviving content; content already expired or deleted never revives. Original video deadlines stay anchored to successful import. An explicit restore creates a new import anchor after verified source acquisition.

Cancellation intent, upgrade and downgrade do not prematurely delete content or shorten a previously promised deadline. Withdrawal of generation access does not itself mean immediate content deletion. User deletion can remove content earlier. Source expiry preserves retained transcripts, outputs, minimal project history and the original source link.

## Stored facts

- Account retention identifies the paid tenure and any trial-to-paid promotion.
- Each retained resource has a trial-start or paid-tenure origin and a finite promised deadline.
- Paid tenures belong to the Firebase UID and hold the actual paid-access end. A new tenure cannot revive an already expired archive.
- Successful imports save immutable `importedAt`.
- `expiresAt`, `sourceExpiresAt` and snapshot deadlines remain useful API guarantees and cleanup hints. A deadline without valid retention authority never authorizes content access.
- Cleanup candidate dates allow bounded queries without scanning old records. Missing or corrupt authority is quarantined rather than guessed or destructively deleted.

The shared resolver is `src/access/retention.ts`. Reads, asset delivery, generation history, duplicate checks, accepted work and cleanup use the same policy. Snapshot reads omit expired private brand/control content while preserving generation status and idempotency identity.

## Access setup

New trials and paid lifecycle transitions always create retention authority. Trusted development setup uses `createDevelopmentAccess` from `src/access/development-access.ts`: it atomically creates a new explicit development grant and its paid-style retention tenure, without changing the grant's accounting or allowances. It refuses to overwrite existing access. Raw grants without retention authority cannot admit imports or generation.

`TRIAL_ENABLED` remains a separate product-access switch. Retention itself has no switch.

## Cleanup and concurrency

The worker selects due candidate dates in bounded pages. Before logical deletion, a transaction rereads the resource and account authority so promotion/renewal and cleanup serialize correctly. Physical file removal uses the durable `assetCleanup` queue, bounded retry/backoff and ownership checks. An expired original cannot cancel otherwise valid text work that has a retained transcript. Failed imports still clean abandoned uploads even though no successful-source policy exists.

Provider work keeps fixed stage and batch deadlines. Retention extensions can refresh only the resource deadline, never extend work indefinitely. Successful import/output accounting is not refunded by storage expiry. Pending reservations release to their original owners exactly once.

## Deployment prerequisite: clean application data

This release intentionally removes old-record support. **Do not deploy it over the existing development database.** Stop API/worker writes, perform the separately authorized reset of Firestore application data, Storage files and Firebase Authentication users, and deploy the single-policy code before allowing new signups/imports. Infrastructure, rules, indexes, secrets and CI/CD are preserved.

Before the first release, update the installed deployment helper to the checked-in version: older helpers require the removed retention configuration value and would reject the new workflow payload. Remove the obsolete GitHub variable/runtime setting during that controlled deployment. This code change does not perform either deployment or data reset.

No retention migration or output-fingerprint backfill machinery remains; new outputs receive fingerprints when saved.

## Verification boundaries

Regression coverage must include exact trial/paid boundaries, promotion/renewal races, restore versus stale cleanup, snapshot reads before physical cleanup, missing/cross-owner authority, accepted work after subscription expiry, failed imports and multi-page cleanup progress. Run typecheck, build and emulator tests before release; record actual results in the change report.

Application expiry is not a guarantee of immediate permanent erasure. Verify Storage soft delete/versioning/lifecycle settings and Firestore backup/PITR configuration separately before publishing permanent-erasure copy. Firestore TTL is not used to delete canonical content: it cannot enforce subscription-aware reads, serialize promotion or recursively remove project files.
