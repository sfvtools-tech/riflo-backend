# Frontend–backend communication policy

**Status: implemented and locally verified.** This document defines the required communication behavior. The backend, client and local browser acceptance checks implement this policy; deployment-path streaming behavior remains to be verified on the intended host.

## Current implementation

Riflo uses authenticated finite SSE command responses and read-only operation streams for progress, alongside canonical JSON saved-state reads and bounded recovery fallback. Generation consumes complete, validated, structured provider results; it does not stream provider tokens to the browser. The README and communication implementation inventory describe the current interfaces and local verification. This policy remains independent of route names, event names, payload fields, libraries, providers and interval values.

## HTTP and stream roles

Use ordinary HTTP for short metadata checks and validation, OAuth, saved state, usage and downloads. Use one authenticated POST with a finite server-sent event (SSE) response to initiate a user-requested import, generation or manual retry. A preliminary JSON POST is not required.

REST is an architectural style; GET and POST are HTTP methods; SSE is a response format. A POST can return an SSE-formatted response through a streaming HTTP client. The browser's native EventSource interface is a GET-oriented convenience, not a requirement that all SSE use GET. JSON saved-state reads and progress streams serve complementary purposes. See [Fielding's REST constraints](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm), [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [SSE framing](https://html.spec.whatwg.org/multipage/server-sent-events.html) and [Fetch requests and responses](https://fetch.spec.whatwg.org/).

## Admission, identity and recovery

Before submission, the client persists a stable request identity with the intended action and input, scoped to the signed-in account. Before acknowledging acceptance or emitting accepted progress, the server durably records the operation identity and work for an independent worker. Accepted means queued, not started. A missing worker must never look like running work. Disconnecting must not strand accepted work in an HTTP handler.

A matching accepted request replay resolves to the same operation without duplicate paid work. Reusing its identity with different input conflicts. Retain the accepted request-to-operation mapping for at least the documented supported recovery period. An expired recovery identity must be explicitly unresolved or rejected, never silently treated as new work. Automatic worker attempts belong to that operation; a deliberate new manual retry creates a new operation and request identity.

When acceptance is uncertain, preserve the original identity. Resolve that exact request through read-only resolution or explicit recovery resubmission with the same identity and input; never silently generate a new identity. A project's latest batch cannot prove which request was accepted. The server authenticates the owner and validates the identity and input, then resolves accepted identities before applying new-work gates. An absent identity follows ordinary admission checks; an accepted match remains retrievable under those ownership and input checks. This requires exact-request recovery behavior, not a particular lookup endpoint.

New work must pass current access, quota, capability and source checks before acceptance. Subscription expiry or provider configuration changes must not block retrieval or observation of accepted work and saved results. This does not override processing safeguards. Existing results keep their independent retention; partial results survive sibling failures. Source expiry does not prevent eligible generation from a retained transcript, or cause an implicit reimport.

## Observation and saved truth

A read-only authenticated GET stream attaches to the same operation after reload or reconnect. It never starts, retries or cancels work. Closing any stream only ends observation; cancellation requires an explicit user action through its own contract.

Ordinary JSON reads are canonical for status, safe errors and saved outputs. Stream notifications describe meaningful changes, terminal outcomes or observation failures; these are semantic categories, not frozen event names or schemas. They do not duplicate full saved-state snapshots or expose raw provider chunks, internal worker details or secrets. The current target covers progress and availability of saved output. Incremental content could be an explicit future extension; SSE itself does not exclude it, and this policy does not promise it.

Establish the listener, then send an immediate initial notification so the client reads saved state even when work completed before attachment. Keep the observation active while reading. Coalesce notifications and ignore stale responses; if a change occurs during a read, perform a follow-up read so it cannot be lost. Responses from an older account, project or operation must never replace the current view.

Persist an explicit terminal outcome: full success, partial success or failure. Publish terminal notification only after the outcome and available outputs commit. The client performs a final saved-state read and retries failed final reads independently of stream reconnection. It must not display complete results before that committed state is available. End-of-stream, an aborted request and a network error are transport conditions, never proof of job success or failure.

Before response headers, reject requests with normal HTTP status and safe JSON errors. After streaming headers, report safe observation errors in the stream where possible, then close. An observation failure does not become a persisted job failure. Actual job failures are saved and remain readable.

## Browser lifecycle and security

Observe only the active operation in the visible project. Close observation when the tab is hidden, the user navigates away, logs out, or the operation terminates. On return, resynchronize through ordinary reads and observe only an operation still active. Project lists use ordinary refreshes while imports are active; never open one stream per row.

Do not poll in parallel with a healthy stream. Transient failures use bounded reconnection backoff and polling fallback while observation is needed. Never silently stop synchronization after an arbitrary elapsed period. Authentication failures require session recovery, not endless retries. Keep submission state, connection state and persisted job state distinct: a disconnected browser can still have accepted, running work.

Every submission, lookup, read, attachment and reconnection verifies authentication and ownership. Bound each connection by credential validity and a documented, configured maximum lifetime; renew authentication before reconnecting. Logout closes streams, aborts reads, clears timers and prevents late responses or retained request identities from crossing accounts. Session expiry and revocation must remain effective while a stream is open; see [Firebase session management](https://firebase.google.com/docs/auth/admin/manage-sessions).

## Operational boundaries

Bound buffers and notification work, release backend listeners and browser timers on every closure path, and handle slow clients without unbounded accumulation. Heartbeats may maintain transport health but do not indicate business progress or trigger saved-state reads. Verify proxy buffering, idle limits and disconnect cleanup on the intended hosting path. If database listeners are used, follow their [error and detach lifecycle](https://firebase.google.com/docs/firestore/query-data/listen#detach_a_listener).

Choose the smallest mechanism that satisfies these guarantees. This policy does not require a broker, general event framework, durable event log, mandatory revision numbers or separate operation registry. Stable identities and durable outcomes may use existing records. The policy fixes externally observable behavior; implementation details belong with the implementation.

## Acceptance checks for implementation

Before describing streaming as implemented, verify:

- A lost acceptance response and same-identity recovery produce one operation and no duplicate paid work, including after access or configuration changes; mismatched input conflicts.
- Reload, reconnect, completion before attachment, and changes during reads converge to committed state; stale account or operation responses are ignored.
- Full, partial and failed outcomes survive lost terminal notifications; failed final reads retry without rerunning work.
- Stream loss, hidden tabs, navigation and logout clean up observation without cancelling accepted work; return resynchronizes correctly.
- Revoked or expired credentials and unauthorized ownership fail safely; unknown acceptance preserves identity and never creates automatic new work.
- Worker downtime remains honestly queued, slow clients stay bounded, and the hosting path delivers notifications without buffering them until completion.

These are required acceptance cases, not claims that checks have already run.
