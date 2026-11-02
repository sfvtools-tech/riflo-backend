# Worker limitations: bounded validation, 2026-10-31

This review added tests and evidence only. No production code changed. Hashes matched before and after for 172 existing files: 75 source files, 95 test files, `package.json` and `tsconfig.json`. The snapshot excludes rules, lockfiles, `.env` and documentation. The only added tests were `test/dev/worker-limitations.test.ts` and `test/sources/validation-burst.test.ts`. This is local development-host evidence, not production certification or a 6 GB/one-hour capacity test.

## Results and evidence

All executed checks passed. Counts below are **test executions**, not a count of unique tests: the targeted emulator selection and full observation file overlap. Name filtering deliberately selected relevant tests; these were not a rerun of the earlier 677-test suite.

| Run | Passed | Duration | Evidence under `artifacts/worker-limitations/` |
|---|---:|---:|---|
| Focused local source admission, shutdown, generation worker and restoration HTTP | 28 | 0.545 s | `focused-local.log` |
| Selected Firestore lease, dispatch, restoration, cleanup and observation cases | 46 | 26.174 s | `focused-emulator.log` |
| Complete HTTP operation observation file, including actual local Firestore snapshots | 14 | 0.671 s | `observation.log` |
| Credit reservation release/exhaustion and account claim contention | 3 | 4.859 s | `credits-contention.log` |
| New serial scheduling, empty query counting and pagination experiments | 3 | 2.546 s | `queue-tests.log` |
| Existing import/scratch safety cases | 4 | 0.289 s | `native-existing-tests.log` |

These runs report zero failures, cancellations and skips. Native scratch/crash and renderer scripts are additional experiments, not included in those test counts. `npm run typecheck` passed (`typecheck.log`). A native harness initially expected different FFmpeg error wording; its assertion was corrected to the observed pixel-count diagnostic, with the original harness failure retained in `native-render-harness-assertion.log`. This was not a product fix.

## Newly measured limitations

**Serial worker scheduling.** The actual `runWorkerPass` kept generation uncalled throughout a 251.856 ms blocked intake promise, then started generation after intake completed. This establishes ordering under an injected wait, not real-job throughput. Each long intake delays generation and each long generation delays the next intake. Cleanup eligibility is checked at outer pass entry: one minute is minimum spacing between cleanup starts, not a guaranteed maximum cleanup delay during long jobs.

**Idle queries and cleanup backlog.** Actual stores against a read-only empty query adapter made six queue queries over three idle passes in 2004.272 ms, and eleven queries for one completely empty combined cleanup. These are application query invocations, not billed reads or measured cloud RPCs. Illustrative arithmetic only: with negligible latency, both queues enabled and exactly one cleanup/minute, 172,800 queue queries plus 15,840 cleanup queries gives 188,640 invocations/day/worker. Real latency, active jobs and configuration change this rate; no price is inferred.

The actual legacy source cursor traversed 151 synthetic rows as pages `[50,50,50,1]`, then wrapped to 50. This adapter experiment proves cursor progression under its supplied ordering. The separate emulator regressions also passed for fifty failing deletions ahead of another expired source and new expired rows behind the cursor. Neither establishes an expiry SLA under arbitrary incoming backlog or outages. See `queue-report.md` for query categories and further limits.

**Scratch is process-local.** Two real child processes each admitted a 268,435,458-byte reservation against the same **injected** 314,572,800-byte availability: 536,870,916 total reserved. This reproduces the absence of cross-process disk coordination without filling disk. Same-process refusal and release behavior were checked. SIGKILL left 14 bytes of fixture debris; cleanup retained fresh directories, removed matching directories after their timestamps were aged beyond 24 hours, and preserved an unrelated directory. A real crash may leave much more data; timestamp aging simulates elapsed time and does not prove survival through a real day or actual low-disk behavior. See `native-scratch.mts`, `native-scratch.log` and `native-report.md`.

**One bounded native render.** The actual source preparer and video renderer processed a 10-second 1920×1080 H.264 30 fps `testsrc2` fixture (2,673,112 bytes) into a 720×1280 clip (548,090 bytes), using local reads and mocked upload. Renderer wall time was 471 ms. Its FFmpeg process measured 0.27 s elapsed, 1.58 s user CPU, 0.25 s system CPU and 373,768,192 bytes maximum RSS. RSS is for that FFmpeg process, excluding Node, other processes and host services; it is not total worker peak memory. A native decoder rejected the 2,073,600-pixel source with an injected 1,000,000-pixel ceiling. This is a successful small-fixture envelope on this host, not worst-case decoder RAM, 4K120 acceptance, hour-long encoding or maximum-size throughput. See `native-render.mts`, `native-render.log`, `native-render-time.txt` and `native-report.md` for exact workload and host details.

**Admission overload and release.** The new source test made 2,600 in-process validation calls over 25 rounds: 100 reached a mocked adapter, 1,250 returned account-level 429 and 1,250 returned total-capacity 503. Peak adapter concurrency stayed four. Each round mixed abort, adapter failure and two successes, and the next round reacquired all four slots. This is not an HTTP load test or a memory benchmark. The full observation test file separately passed capacity rejection before database checks, disconnect cancellation, failure/terminal/shutdown listener release, accepted replay behavior and bounded backpressure. Per-handler/process limits do not establish global capacity across replicas.

## Transactional and fault evidence rerun

Fresh local Firestore tests verified competing intake claims admit one owner, account-level import exclusion, stale completion and lease renewal fencing, and expired generation claims failing to save after takeover. Pre-dispatch shutdown and repeated proven pre-dispatch lease crashes retained reservations/retry eligibility while attempt IDs advanced. Missing dispatch evidence retained the bounded retry budget. Explicit transcription retry remained terminal after dispatch. Credit cases verified pending reservation release after revocation, transcription failure, batch expiry and exhausted dispatched attempts, plus idempotent release after terminal failure.

These are local emulator transactions and injected failure/clock sequences. They do not prove that an external provider stopped computing or charging after cancellation, or provide exactly-once provider execution when a dispatched response is lost. Durable dispatch evidence bounds/reconciles application retries; provider-side ambiguity remains. Pending database renewal is awaited at shutdown, so the tests do not establish a universal shutdown wall-clock bound for hung external database calls.

Restoration tests passed with server-owned SHA-256 identity: different restored hashes fail `source_changed`; a retained transcript with incompatible identity fails `source_identity_unverified`; matching identity permits completion. Unverified live caches, active generation, deletion and stale claims are rejected; failed restoration releases the new reservation without refunding the original successful import. This deliberately rejects byte-different downloads even if they look like the same video. The emulator tests inject hashes and metadata; they do not download or rehash a 6 GB source.

## Reproduction and isolation

Run from repository root using Node with `--import tsx`; commands for the new experiments and native prerequisites are retained in the two component reports. Focused commands were:

```sh
node --import tsx --test --test-concurrency=1 test/sources/validation-burst.test.ts test/sources/source.test.ts test/dev/worker-shutdown.test.ts test/generation/worker.test.ts test/http/source-restoration.test.ts
NODE_ENV=test FIRESTORE_EMULATOR_HOST=127.0.0.1:53594 node --import tsx --test --test-concurrency=1 --test-name-pattern='leases|lease crashes|pre-dispatch|shutdown|restor|worker|cleanup|fifty|cursor|provider dispatch|dispatch evidence' test/projects/firestore.test.ts test/generation/firestore.test.ts test/generation/transcription-retry.test.ts test/retention/regressions.test.ts test/http/operation-stream.test.ts
NODE_ENV=test FIRESTORE_EMULATOR_HOST=127.0.0.1:53594 node --import tsx --test --test-concurrency=1 test/http/operation-stream.test.ts
NODE_ENV=test FIRESTORE_EMULATOR_HOST=127.0.0.1:53594 node --import tsx --test --test-concurrency=1 --test-name-pattern='revocation, transcription failure|retryable output failure|one account keeps' test/generation/credits.test.ts test/projects/firestore.test.ts
```

The isolated fresh Firestore emulator used `demo-riflo`, an OS-selected free port 53594 and owned PID 86573; its exact startup command is in `emulator.json`. The observation run briefly overlapped the selected run on this same emulator; tests used unique account fixtures, both runs passed, but they are not independent database instances. No live providers, cloud writes, deployment, `.env` changes or user services were used. The emulator was stopped only after command/PID ownership verification and port 53594 was verified closed (`emulator-cleanup.json`). Reproduction must start a new owned emulator and substitute its free port. `before.json`, `after.json` and `hash-comparison.json` record unchanged existing files and the two test additions.

The native host was arm64 macOS with 12 logical CPUs and 25,769,803,776 bytes RAM, Node v26.11.1 and FFmpeg 9.0.2. The renderer fixture used one segment, silent stereo AAC, no captions and mock storage. Cleanup checks directory name/type/mtime without a liveness marker, so safety for a still-active matching directory older than 24 hours remains unproven.

Remaining deployment-host acceptance: realistic media distributions and worst-case codecs, 6 GB inputs, hour-long duration, whole-worker/whole-host RAM and disk peaks, real low-space behavior, multi-process shared scratch, sustained queue arrivals, cloud query billing/latency, provider response-loss behavior and shutdown under external database stalls. No production fixes or concurrency changes were made as part of this review.
