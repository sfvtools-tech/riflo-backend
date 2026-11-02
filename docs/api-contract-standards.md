# API contract standards and reuse

These are the rules for reviewing and changing Riflo's public contracts, one API at a time. They are not a claim that every existing endpoint has completed review. The current exceptions below remain separate work.

The [communication policy](communication-policy.md) owns command acceptance, idempotency, finite SSE, recovery and observation. This document adds contract and reuse rules; it does not replace that policy or change the product offering.

## Public contract ownership

- Give each endpoint one stated responsibility. Separate accepted work, its observation, saved results and action eligibility; do not merge them merely to reduce a request count.
- Define response fields explicitly at the service boundary, including nested objects. Do not expose a stored record through a spread or return it directly.
- Give every public field a current consumer or a deliberately documented resource meaning. Internal accounting, cleanup or worker use alone does not justify publishing it.
- Removing a public field must not remove the stored field, worker behavior, accepted-request input or accounting that depends on it.
- Reuse a public projection when GET, command JSON and replay promise the same representation. Review every caller before changing that projection.
- Keep server credentials, refresh tokens, storage paths, worker leases, private profiles and private cost records outside resource responses. Public asset paths must remain owner-checked application routes.
- An intentional browser-credential endpoint, such as Picker access, must document its authorization, scope and lifetime. It is not permission to embed credentials in ordinary project or output responses.

## Values and naming

- Use the same name and type for the same concept. Keep operation identity distinct from output identity, attempt counts, user retries and current resource availability.
- Generate new application UUIDs with `createId` from `src/shared/id.ts` (UUID v7). The browser uses its own thin helper backed by the same library. Keep existing accepted IDs, external identifiers, security tokens and semantic document/asset names unchanged. UUID generation is not a global clock or a delivery-order guarantee.
- List retained outputs by `createdAt` ascending, breaking ties with binary ID comparison. Clients preserve the returned order and treat the ID as identity, not a timestamp.
- [Firestore warns that increasing document IDs can create hotspots](https://firebase.google.com/docs/firestore/best-practices#document_ids) at high write rates. We accept that tradeoff for UUID v7 at the MVP’s low per-account/project write volume; this is not a Firestore index-performance optimization. Reassess ID distribution if write volume grows; output order still comes from `createdAt`.
- Treat IDs as opaque strings. Document their accepted syntax and scope; clients must not parse their generated formatting to recover other fields.
- For every field, document its type, meaning, required/optional status, null behavior and constraints. Missing, null, empty string and zero are not interchangeable.
- Use UTC ISO timestamps for public dates. State what starts the clock and what updates it; do not call a timestamp a heartbeat unless it actually is one.
- State numeric units explicitly: bytes, seconds, milliseconds, counts or currency units. Counts and bytes require appropriate integer bounds; measured seconds may be fractional. Unknown measurement or cost is not zero.
- Publish enum values and their meanings. A new enum value can break a validating client; review compatibility rather than assuming every additive value is safe.
- Keep error codes stable and machine-readable. Clients need a safe generic fallback for unfamiliar codes; raw provider messages are not public error copy.
- Distinguish processing success from retention: completed work may have expired outputs. Availability belongs to the resource's current read/action contract.

## Requests, responses and errors

- Normal JSON success uses `{ "data": ... }`. Errors use `{ "error": { "code": "...", "message": "..." } }`, with only documented safe extensions such as allowance guidance.
- Use HTTP status for the request outcome. Successfully reading a failed job returns 200 with its failed state; a failed read or rejected command uses its documented error status.
- Use 400 for invalid input, 401 for failed authentication, 403 for denied access/allowance, 404 for unavailable owned resources, 409 for state/identity conflicts, and 429 for temporary request/cooldown restrictions. Other failure statuses must describe the actual failure, not disguise it.
- Bearer-authentication 401 responses include `WWW-Authenticate: Bearer`. Do not attach that challenge to OAuth callback validation or unrelated permission errors.
- JSON body endpoints require their documented media type and byte bound. Validate unknown input fields, enum values, numeric bounds and source identities before work admission; return safe 413/415 errors where applicable.
- New paid work must reflect an explicit user choice. Do not silently choose additional billable outputs. Existing accepted requests retain their original normalized input and replay behavior.
- Define whether an error is operation-wide or belongs to one output. Public terminal summaries must not expose an unrelated transient error after recovery; preserve internal history separately.
- Define query support, missing-resource behavior and cache headers per endpoint. Retain `no-store` on authenticated snapshots and the streaming headers required by the communication policy.

## Authentication, admission and reads

- Authenticate and verify ownership for every read, command, download and observation. A client-supplied account ID must never select another user's storage scope.
- Keep access to retained owned state separate from permission to start paid work. Document any current-period-only read explicitly instead of blocking the whole project view on account checks.
- Backend admission checks current access, supported/configured features, resources and allowance. UI availability is advisory and must not recreate quota calculations or override admission.
- State-read GETs must not start/retry/cancel paid work, debit allowance or silently reimport. Document ancillary behavior such as credential refresh separately; it is not permission to admit business work.
- Resolve accepted matching identities before applying new-work gates, as required by the communication policy. Replaying an accepted request must not create new paid work or a fresh allowance reservation.
- Keep source consumption, delivered output allowance and company provider cost distinct. A transport failure does not prove that an upstream provider did no work.

## Client calls and compatibility

- Make a request because the current view or explicit action needs its data. Mounting a closed optional form is not sufficient reason to fetch an account profile.
- Preserve required progress/error discovery, canonical final reads, reload recovery and expiry handling when removing calls. Do not infer operation state solely from the presence of old outputs.
- Project view does not request account usage, saved brand, Drive connection or global capabilities. It uses project-scoped state and availability; other pages retain their own endpoints.
- Temporary preferences contain explicit overrides. Omission inherits saved preferences; an explicit clear and source-default bypass retain their distinct contracts. Never rewrite an uncertain request's saved payload while replaying it.
- Check both wire and meaning compatibility: shared serializers, JSON commands/replays, stored request inputs, old caches, enum changes and optional/null fields. Removing unused response fields still requires a deliberate compatibility decision.
- For separately deployed owned clients, release a tolerant client before pruning a response and account for still-running old clients. Published external contracts may require a longer compatibility window or versioning; do not add a version automatically for every internal refactor.

## Reuse at the correct boundary

- Look for the existing helper/type/rule before adding another. Share identical policy and normalization where they have one meaning, not merely similar syntax.
- Keep one backend owner for admission rules, allowance settlement, source parsing and eligibility classification. Reuse that rule in advisory projections instead of duplicating business decisions in HTTP handlers or the frontend.
- Keep public DTOs separate from database models. Server request validation and browser response validation protect different trust boundaries; neither should import Firestore models into browser code.
- Reuse established HTTP, stream, projection and parser helpers. A recurring rule merits a small local helper; a framework, inheritance hierarchy or shared package needs a demonstrated problem first.
- Do not create a generic serializer or error resolver that hides different domain meanings. Prefer explicit fields and short typed mappings.

Current reuse locations (implementation inventory, not fixed architecture):

| Responsibility | Existing owner |
|---|---|
| JSON envelope, body limits, authentication failures and method handling | [`src/http/app.ts`](../src/http/app.ts) |
| Finite operation streaming and lifecycle cleanup | [`src/http/operations.ts`](../src/http/operations.ts) |
| Grant/configuration projection and accepted-period rules | [`src/access/policy.ts`](../src/access/policy.ts), [`accepted-work.ts`](../src/access/accepted-work.ts) |
| Source input normalization and canonical original URLs | [`src/sources/source.ts`](../src/sources/source.ts) |
| Public project/source projection and import retry guidance | [`src/projects/service.ts`](../src/projects/service.ts) |
| Public batch/slot/output/asset projection and terminal error summary | [`src/generation/service.ts`](../src/generation/service.ts) |
| Configuration advice for generation and transcription retry | [`applyGenerationConfiguration`](../src/generation/service.ts) |
| Transcript/source availability and explicit retry classification | [`transcription.ts`](../src/generation/transcription.ts), [`retention.ts`](../src/generation/retention.ts) |
| Saved-brand inheritance and request snapshots | [`src/brand/generation.ts`](../src/brand/generation.ts) |
| Canonical same-format history and exact-repeat comparison | [`src/generation/history.ts`](../src/generation/history.ts) |
| Browser envelopes, authenticated requests and operation parsing | [`client.ts`](../../riflo-frontend/src/shared/api/client.ts), [`operation-stream.ts`](../../riflo-frontend/src/shared/api/operation-stream.ts) |
| Browser project/batch/output response validation | [`project-response.ts`](../../riflo-frontend/src/features/projects/project-response.ts), [`generation-response.ts`](../../riflo-frontend/src/features/projects/generation-response.ts) |

## Verification and review record

Test changed behavior at its boundary: exact public keys and omitted private fields; types/nulls/enums; owner and access cases; terminal errors; JSON/SSE acceptance; replay and conflicting inputs; old cached responses; unchanged stored accounting where relevant. Cover meaningful failure/concurrency paths, not assertions that only mirror the implementation.

Use provider substitutes and isolated emulators where appropriate. Report passed, failed and skipped counts separately, and identify what was mocked. A mock returning predetermined content proves transport/wiring, not real model quality, semantic novelty or source fidelity. Local streaming tests do not prove the intended hosting path.

For each API review, record:

1. Purpose, method/path, authentication/ownership and access requirements.
2. Request fields: type, units/range, enum, required/optional/null, defaults and rejected inputs.
3. Response fields: meaning, consumer, state conditions and public projection owner.
4. HTTP/domain errors, empty/missing states, side effects and allowance/provider-cost effects.
5. Operation identity, acceptance, observation and recovery behavior when applicable.
6. Compatibility impact, necessary reused rules/helpers, evidence and remaining limitations.

## Known exceptions awaiting their API review

- `POST /generate` currently defaults omitted output selection to two X posts and one LinkedIn post. Explicit-choice behavior is a pending command-contract decision; this document does not change it or accepted-request replay.
- `GET /usage` currently requires an active grant. Its intended historical/current-period access and documentation need review on that API; the project page no longer depends on it.

Keep exceptions specific and remove an entry only after the corresponding implementation, consumer compatibility and checks are complete.
