# Generation controls implementation and API

31 October 2026. Task 1 controls are implemented in the working tree under the user's subsequent authorization of the [proposal](optional-generation-controls-proposal.md). The staged integration gate is enabled in code and Clean is the built-in caption choice for new requests. This is not a deployed rollout: actual `.env`, secrets, live accounts and provider configuration are unchanged. Internal integration/runtime verification passed; Task 1 independent local acceptance is clear. Task 2 final local acceptance is also clear; see the [validation report](finished-output-validation-report.md). Historical slice results remain in the [decisions log](generation-controls-and-output-validation-decisions.md).

## HTTP contract

All routes use verified account identity and existing ownership/access boundaries. Settings reads remain available after active access ends; writes require active access and do not consume allowances.

| Route | Contract |
| --- | --- |
| `GET /v1/generation-defaults` | `data: {defaults, controls: {version: 1, available, choices, builtins}}`; defaults are `null` before setup. |
| `PUT /v1/generation-defaults` | Body is a partial format map, not a `defaults` envelope. Replaces the map; omitted fields are removed and `{}` clears it. Same response shape as GET. Body limit 12,000 bytes. |
| `GET /v1/projects/:id/generation/availability` | Existing availability plus `controls: {version: 1, available, threadAvailable, choices, focusMaxCharacters: 500, defaults, builtins, defaultsStatus}`. Defaults read failure is visible as `unavailable` with an empty defaults map. Processing configuration also governs availability; thread availability requires shared credits. |
| `POST /v1/projects/:id/generate` | Existing `outputs`, optional `brand`, and optional `controls: {focus?, sourceWindow?, formats?}`; existing idempotency key and finite SSE behavior apply. |
| `GET /v1/projects/:id/generation` | Accepted batch includes its immutable `controls` snapshot when present. Existing output reads and text downloads expose complete thread results. |

Example generation body:

```json
{
  "outputs": {"x_posts": 1},
  "controls": {
    "focus": "Explain the onboarding mistake",
    "sourceWindow": {"startSeconds": 20, "endSeconds": 180},
    "formats": {"x_posts": {"mode": "thread", "maxPosts": 6, "numbering": "include", "length": "auto"}}
  }
}
```

To save those X choices, PUT `{"x_posts":{"mode":"thread","maxPosts":6,"numbering":"include","length":"auto"}}`. Focus and windows are request-only. Unknown keys/types and format settings for unselected formats are rejected, including an empty supplied object for an unselected format. Focus is trimmed and bounded to 500 UTF-16 code units. A source window is one finite ordered nonnegative interval inside the original source; a video window must span at least ten seconds. Source-duration validation precedes reservation.

Resolution is explicit field → saved field → built-in, independently of writing-brand mode, including video-only requests. Explicit Auto selects Auto rather than inheritance. New requests without controls also resolve and save a snapshot. Version 1 snapshots contain `status` (`resolved` or `unavailable`), `formats`, per-field `origins` (`explicit`, `saved`, `builtin`), and any focus/window. Failed default reads use visible built-in fallback. Brand content stays private under its existing snapshot contract.

Normalized explicit request intent determines idempotency separately from resolved defaults. Empty controls normalize to absent intent. Initial lookup and transactional replay return the accepted snapshot before changed or failed settings reads can replace it. Already accepted legacy batches with no snapshot retain their original schema and behavior, including captions Off; they are not retroactively upgraded. Snapshot retention/cleanup follows existing accepted-job content cleanup.

## Supported choices and delivery

| Format | Choices and built-ins |
| --- | --- |
| X | Length `auto/short/standard`, mode `single/thread`; built-ins Auto and single. Threads require maximum `2–10` and numbering `include/exclude`, from explicit or saved choices; neither has an invented built-in. |
| LinkedIn, blog, newsletter | Length `auto/short/medium/long`; built-in Auto. |
| Carousel | Density `auto/standard/light`; theme `auto/dark/light`. Built-ins Auto resolve to Standard and Dark. |
| Short video | Duration `auto/15/30/45/60`, editing `auto/continuous`, captions `clean/off`; built-ins Auto, Auto, Clean. |

Lengths and duration targets are soft preferences. Existing hard character/word and 10–60-second video bounds remain enforced; no padding or correction call is added to reach a target. Word measurement is approximately whitespace-based, not exact multilingual linguistic counting. Auto video may use one to three chronological cuts; continuous enforces exactly one. Final whole-word expansion must remain inside the hard source window. Eligible evidence uses complete in-window words; full transcript context is separately restricted to corrections/conflicts and necessary attribution. Unsupported focus, empty source window and source-window conflict have explicit failures. Timestamp validation alone cannot establish semantic grounding.

Each X thread is one coherent ordered result generated directly. Request maximum N reserves N credits; complete delivery M (1 through N) settles M once and releases N−M across the original funding owners. Technical truncation, malformed output and exact whole-thread duplicates fail the entire slot. Historical standalone posts and prior-thread members may be reused; there is no individual-post history rejection or unique-remainder delivery. Whole-thread deduplication ignores numbering. Numbering uses actual M and counts toward each post's weighted ceiling. Legacy per-format grants cannot generate threads (`generation_threads_unavailable`); no grant migration occurs.

Thread output `data` is `{kind:"thread",status:"ok",posts,numbering}` with ordered unnumbered posts. Top-level `deliveredPosts`, `credits` and `requestedMaxPosts` describe settlement; `text` and download contain the complete rendered thread. Thread slots expose `maxCredits`, with `credits` maximum while pending, actual on success and zero on failure. Ordinary output shapes remain compatible. Select none prevents submitting an empty output selection; it is not a CTA option. No CTA fields/defaults or equivalent renamed controls are included.

Carousel Light has tighter maximum copy limits; Standard retains existing limits. Both themes render five private 1080-square PNGs. Renderer measurement enforces readable font floors and fails instead of truncating or shrinking indefinitely. Theme changes do not bypass exact copy deduplication. Clean burns original timed transcript words into the final cut; Off generates no caption assets. Caption timing follows exact cut durations, with frame-aware joins and final endpoints. No translation, retranscription or additional model call is introduced.

## Engineering limits and remaining evidence

Thread output budget is `min(8192, max(configured short-output budget, 384 + 512*N))`: 5,504 tokens for N=10 with the standard 1,200-token base. This is an engineering bound, not a guarantee of ten posts.

Caption preparation limits are 600 words, 16,000 UTF-16 code units, 240 phrases, 256 KiB per PNG, 32 MiB total PNG bytes, a 64 KiB manifest and 30 seconds preparation; Sharp operations have two-second limits. Fixed 44-pixel two-line text uses local Pango/system-font fallback. Exceeding limits fails without dropping speech. Optional brand accents, packaged/custom fonts, logos and SRT export remain deferred. Local multilingual glyph inspection does not guarantee deployment-image font coverage.

Preserve `artifacts/generation-controls-carousel/` and `artifacts/generation-controls-video/` for Task 2. Recorded synthetic native proofs cover mobile carousel bounds, mixed scripts, caption joins/endpoints, unchanged decoded audio, Off and scratch cleanup. The 60-second caption fixture recorded about 156 MB Node and 441 MB FFmpeg peak RSS on this host; these observations are not a universal platform memory cap or production guarantee. Synthetic color/tone and scripted words establish rendering behavior, not real-speech meaning or final quality. The corrected historical Task 1 verification is recorded below; both tasks are now locally accepted within the [finished-output report](finished-output-validation-report.md) sample limits. Deployment, editing/publishing, stronger semantic deduplication and footage-overlap thresholds remain outside scope.


## Final internal verification

The corrected backend gate passed **617/617 tests**, with zero failures, skips or cancellations (197.632 seconds of tests; 202.239 seconds emulator wall time). Typecheck and build passed. All **171 frozen hashes** remained unchanged; all six owned ports **53956–53961** and associated processes were closed. Evidence is retained at `/tmp/riflo-controls-final-backend-corrected-20261031/`, with manifest SHA-256 `b7065439a93c333090e991be3817d6660f3da3f8cc9e0b38021a75ee1795098e`.

Frontend verification passed **138/138 tests**, typecheck and build. Independent browser functional review and the distinct lean review are clear. These historical internal results are superseded for final local acceptance by the fresh 645-backend/138-frontend gates and independent reviews in the [finished-output report](finished-output-validation-report.md); they do not establish deployment readiness.
