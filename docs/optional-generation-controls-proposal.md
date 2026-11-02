# Optional generation controls — consolidated proposal

**Implementation authorized on 31 October 2026 after acceptance of this proposal. Controls are implemented in the working tree; internal integration/runtime checks passed; Task 1 independent local acceptance is clear. No deployment is claimed.**

The user confirmed “Let’s not do CTA, other things makes sense,” followed by implementation authorization. The accepted direction includes saved defaults, soft length bands, source windows, Clean/Off captions, carousel themes, and directly generated X threads with up to ten posts. Reserve N credits, settle delivered M and release N−M; number using actual M. The [implementation/API record](generation-controls-implementation.md) describes current behavior and the [decisions log](generation-controls-and-output-validation-decisions.md) preserves slice evidence. The remaining proposal language records requirements and the original baseline, not current implementation status. Task 2 finished-output evidence and clear final local acceptance are recorded in the [validation report](finished-output-validation-report.md).

The review is organized around seven product-and-engineering pairs: shared controls, X, LinkedIn, blog, newsletter, carousel, and short video, followed by cross-area critique. The planning process uses fourteen area reviewers and two cross-area reviewers. This is a structured planning review, not a claim that the full LLM Council methodology or real customer validation was executed.

## 1. Scope and original baseline

Give each output a small optional customization area. A user can generate immediately, inherit useful preferences, or direct this particular result. Preserve the existing one-output-at-a-time interface; backend support for several selected formats is not a reason to force a batch-selection experience.

Existing writing preferences already cover business/person context, audience and reader knowledge, voice, language, spelling, writing sample, and avoided phrases. They apply to writing and carousel copy through [brand generation](../src/brand/generation.ts). They do not change original video audio. Do not introduce overlapping tone, purpose, expertise, or depth selectors. Audience supplies reader knowledge; the focus field supplies this request’s topic, angle, or purpose. Business context and writing examples remain context, never evidence for source claims or the author’s identity.

Baseline output bounds live in [generation configuration](../src/generation/config.ts) and [validation](../src/generation/validation.ts). X originally supported one post with a 280 weighted-character maximum; that ceiling now applies to each thread member including numbering. LinkedIn has a 3,000 JavaScript string-length maximum. Blogs have a 1,200-body-word and 16,000-character ceiling; newsletters have 1,500 body words and 21,000 characters. Carousel output is five square PNGs, 1080 × 1080, each no larger than 5,000,000 bytes. Video uses one to three chronological segments totaling 10–60 seconds, rendered with original audio into a padded 720 × 1280, 30 fps MP4.

Saved format defaults, request focus/window controls, named length presets, two carousel themes and Clean/Off captions are now implemented in the working tree. Internal integration verification passed; Task 1 independent local acceptance is clear. Saved visual colours or font names alone do not establish a working visual-brand pipeline; optional brand accents, packaged/custom fonts and logos remain deferred.

## 2. Shared controls and precedence

| Control | Options and proposed built-in default | Save behavior | Applies to | User value |
| --- | --- | --- | --- | --- |
| Focus | Optional single field, maximum 500 characters; empty means automatic selection | Request only | All formats | Direct topic, angle, or purpose without a mandatory outline |
| Source window | Optional one start/end interval in seconds; absent means full eligible source | Request only | All formats | Restrict the material eligible for this result |
| Writing preferences | Existing saved profile and request overrides | Existing brand behavior | Writing and carousel copy | Reuse audience, voice, language and terminology |

A focus such as “Explain the onboarding mistake for first-time founders” guides selection and presentation. It cannot authorize new evidence. A request for an unsupported topic must produce an explicit unsupported-source result, rather than unrelated content or an invented explanation. There is no separate first-release passage editor: the focus field and a single time window provide the bounded selection surface.

A source window is a **hard evidence boundary**, not a hint. Validate finite ordered timestamps against source duration. Reject a window shorter than ten seconds upfront when video is selected, since it cannot support the existing minimum clip duration. A short window can still be useful for a written output; do not invent a universal minimum for writing.

Keep the full transcript available read-only to detect later corrections, withdrawals, contradictions, and necessary attribution. It cannot supply additional substantive material from outside the selected interval. If a correction outside the window makes its selected claims unsafe or unsupported, explain the conflict and return no generated output for that slot. Do not silently widen the window. Video word-boundary expansion must remain inside the window; a requested boundary does not permit cutting a spoken word or extending into excluded evidence.

### Defaults independent of brand

Generation defaults belong to the account and format, independently of the writing-brand mode. Turning writing preferences off does not turn off saved video duration, carousel density, or text-length choices. Resolve relevant generation defaults even for video-only generation and paths that bypass writing-brand reads.

Resolution is: **explicit request override → saved format default → built-in default**. An explicit Auto selects Auto even when a saved preference says Short. An absent field inherits. Resetting a request control restores inheritance; it does not save a preference or overwrite account settings. A separate “Save as default” action writes only supported durable choices.

Expose saved format defaults in settings in the first release of these controls. Do not defer all default support to a future phase. Save length, X thread count and numbering, carousel density/theme, and supported video choices per format. Focus and timestamps remain request-only. Do not add saved CTA settings or campaign destinations.

If reading saved defaults fails, make the fallback visible and identify the resolved settings. A built-in fallback may keep generation available, but cannot masquerade as successful inheritance. The accepted job records the resolved values and fallback status. A subsequent settings change cannot alter already accepted work. Show a concise resolved summary before/with generation, including inherited versus explicit choices and any failed preference read.

For multi-output requests, focus and window are shared; format-specific parameters apply to all variants requested for that format. Reject explicitly supplied parameters for unselected formats instead of ignoring likely mistakes. Unused saved defaults are simply irrelevant. Do not create a per-variant settings matrix in this proposal.

## 3. CTA controls excluded by user decision

No CTA mode, custom reader-action field, CTA default, or destination-URL control is included. Preserve existing source-grounding and link restrictions; do not broaden validators or prompts to support promotional instructions through this work. This decision does not ban a natural conclusion, takeaway, or an action already supported by the source. Do not replace removed CTA controls with equivalent fields under another name.

## 4. Written-format choices

All named length ranges below are **soft targets**, not minimum requirements. Built-in selection is Auto for every format. A shorter accurate result remains valid; there is no padding, quota of paragraphs, or automatic paid regeneration merely to hit a band. Saving a length preference affects that format only.

| Format | Proposed choices | Built-in Auto behavior | Existing hard limits | Save and value |
| --- | --- | --- | --- | --- |
| X | Auto; Short 80–140; Standard 180–260 weighted characters | Choose a useful standalone post within the hard limit | 280 weighted characters per post | Save choice; choose compact versus developed copy |
| LinkedIn | Auto; Short 400–800; Medium 900–1,500; Long 1,600–2,400 characters | Fit supported substance to the post | 3,000 UTF-16 code units | Save choice; control reading commitment |
| Blog | Auto; Short 400–600; Medium 700–900; Long 1,000–1,200 body words | Develop the available source without padding | 1,200 body words; 16,000 UTF-16 code units; title 120 | Save choice; choose useful depth within current capacity |
| Newsletter | Auto; Short 300–500; Medium 600–800; Long 1,000–1,200 body words | Preserve the existing 1,000–1,200-word target when supported | 1,500 body words; 21,000 UTF-16 code units; subject 100; preview 160 | Save choice; choose a shorter letter or developed edition |

X supports standalone posts and threads. The accepted format choice is **Single post / Thread**. A single post contains one post; a thread accepts an explicit integer maximum from **2 to 10**. Users choose “up to N posts” and may save that maximum as a default for later threads. The source-supported delivered count may be lower. Do not treat the selected maximum as an exact count or pad the thread to reach it. If no saved count exists, request a valid count rather than inventing an approved built-in count.

**Confirmed charging: one credit per delivered X post.** A delivered three-post thread costs three credits. Before submission show the requested maximum cost (“up to N credits”). Validate and reserve N credits atomically at acceptance using the existing allowance and idempotency principles. On successful delivery of M source-supported posts, consume M credits and release the unused N−M reservation. A request for up to ten posts that produces six coherent posts consumes six credits and releases four. Replaying the accepted request must not charge again.

**Numbering: Include / Exclude**, using `1/M`, `2/M`, and so on when included, where M is the actual delivered count, not the requested maximum. Users may save this preference and change it before each generation. Interpret “ask before generation” as an editable, prefilled choice in Customize with the selected value in the generation summary—not an extra confirmation popup. If no numbering default exists, make the choice explicit rather than silently declaring a user-approved built-in preference. Numbering counts within each post’s 280 weighted-character ceiling.

The existing single-post length bands and hard weighted-character ceiling apply to each post, not to the thread total. A thread must develop one coherent source-supported sequence without padding or repeated points. Validate its ordered structure, actual delivered count and requested maximum; preserve source qualifications across the whole sequence. Whole-thread exact duplicate handling must not treat changed numbering as new content. The thread-specific history-reuse rule below overrides per-post cross-history avoidance, not whole-output exact protection. Length bands must use the same weighted measurement as validation, including URL treatment. [X’s character-counting documentation](https://docs.x.com/fundamentals/counting-characters) explains why plain string length is insufficient. Do not present the other formats’ JavaScript string lengths as equivalent to X weighting or visible glyph counts.

**Confirmed thread originality policy:** generate the thread directly as one coherent ordered result, not by stitching independently generated posts. Its prompt should require each post to contribute a new point and avoid redundant statements within that thread. This is semantic guidance, not a guarantee of perfect nonrepetition or authorization for another AI verification/correction call.

A thread may reuse material or posts already generated from the same project, including prior standalone posts or posts in earlier threads. Do not reject individual thread posts because they match historical posts, filter out those posts, or deliver only a “unique remainder.” Scope this exception to thread generation; standalone-post duplicate checks and history guidance remain unchanged. History supplied for a thread must not retain an incompatible instruction banning that permitted reuse.

This decision does not authorize delivering an entirely identical prior thread. Preserve the existing principle of exact whole-output duplicate protection when adding the thread output type; do not silently disable it or infer that cosmetic numbering creates a new thread. No mandatory duplicate-correction attempt, extra AI call, or new charge has been approved.

**Confirmed source-limited behavior:** deliver a complete, coherent thread with fewer posts when the source cannot support the requested maximum. Never add filler or repetitive points to reach N. The delivered thread is the complete result, not a broken partial result. A technical failure, truncated model response or invalid/incomplete thread must not be exposed as a partially successful thread merely to charge for surviving posts; preserve the existing failure policy. Actual provider expenses remain recorded independently of delivered-post credits.


LinkedIn does not need separate “professional,” “thought leadership,” or “educational” controls. Existing voice and audience plus a request focus cover those intentions without creating competing instructions. Preserve source uncertainty and speaker attribution even when the selected length is Short.

Blog length is not an authorization to add research, examples from memory, or unsupported SEO claims. Reader knowledge comes from the audience setting. The 1,200-word maximum remains in force even if a source could support a larger article; a larger limit is a separate capacity decision.

Newsletter Auto preserves the [current prompt’s](../src/generation/prompts/long-form.ts) supported 1,000–1,200 body-word ambition. A short or repetitive recording can yield less. Multiple connected themes are allowed when they serve a coherent promise; do not force a fixed section count, greeting, sign-off, or reply request. The proposed Long band is a target below the existing 1,500-word ceiling, not a reduction of that ceiling.

Body-word bands exclude blog title and newsletter subject/preview. Current validation splits words on whitespace, which is imprecise for languages without whitespace-separated words. Before presenting multilingual bands as measured promises, choose and test a language-aware measurement policy, including compatibility with existing ceilings. Until then, label word targets approximate, retain character bounds, and do not claim exact linguistic counts. Avoid silently changing accounting or existing validation semantics as an incidental UI improvement.

## 5. Carousel: density and two tested themes

| Control | Proposed options and default | Save | Applicability and value |
| --- | --- | --- | --- |
| Density | Auto resolves to Standard; Standard or Light | Per-format default | Control how much copy appears per slide |
| Theme | Auto is proposed to retain the existing Dark treatment; Dark or Light | Per-format default | Two predictable, tested visual treatments |
| Focus and window | Shared behavior above | Request only | Direct the source-supported sequence |
| Visual brand accent / packaged font | Optional later supported choices; not currently a working capability | Only after renderer support exists | Carry visual identity consistently |

Standard retains the current per-slide ceilings: title 80 characters and 12 words; body 240 characters and 45 words. Proposed Light ceilings are title 60 characters and 9 words; body 160 characters and 28 words. Both character and word ceilings apply. Neither density has a minimum; a readable short slide is acceptable. These bounded densities differ from the written formats’ soft length bands.

The accepted planning direction includes two deterministic, tested Dark/Light themes as new first-render scope. Keep exactly five 1080 × 1080 square PNGs, each within the existing 5 MB bound. No arbitrary layouts, slide count, aspect ratios, font sizes, uploaded images, or charts. A theme changes presentation, not source evidence or slide structure.

Readability is a rendering requirement, not a promise that a character cap fits every script. Measure rendered text against width and height, wrap and fit within bounded typography rules, and test actual mobile previews. [Sharp’s constructor/text options](https://sharp.pixelplumbing.com/api-constructor/) provide relevant layout primitives; they do not prove that today’s renderer already performs the needed fitting. Test long words, mixed scripts, punctuation, emoji, and right-to-left text where supported; existing URL restrictions remain in force.

Stage optional brand accents and packaged fonts after core controls. Use a tested font allowlist with verified script coverage; define fallbacks and contrast constraints. Do not promise that every stored font name or colour already works. Defer logo upload until asset ownership, upload validation, retention, replacement, and deletion are designed. Keep final-copy grounding tests alongside visual tests: attractive slides must still preserve qualifications and avoid invented examples.

## 6. Short video: selection and optional captions

| Control | Proposed options and default | Save | Applicability and value |
| --- | --- | --- | --- |
| Duration | Auto; About 15 / 30 / 45 / 60 seconds | Per-format default | Express preferred viewing time without damaging speech |
| Editing | Auto; One continuous clip | Per-format default | Let selection use up to three segments or require exactly one |
| Captions | Clean / Off, proposed new capability | Per-format default once supported | Improve comprehension with readable original-language captions |
| Source focus/window | Shared optional controls | Request only | Choose the subject or eligible moment |
| Frame | Summary only: full source preserved in padded 720 × 1280 at 30 fps | No redundant selector | Make the actual output treatment clear |

Duration targets are soft within the unchanged hard 10–60-second total. A complete 24-second explanation can satisfy About 30; a misleading 30-second cut cannot. Auto may select one to three chronological segments under current validation. One continuous clip must be enforced as exactly one segment, not merely requested in a prompt. Do not expose a separate forced multi-cut mode: it can manufacture cuts without improving the result.

Preserve chronology, speech meaning, original audio, and current boundary preparation. Source-window enforcement must cover both the initial plan and final boundary expansion. A 60-second target must never become a reason to exceed the existing ceiling. The ceiling is a Riflo product limit, not a universal platform maximum: [YouTube documents Shorts up to three minutes](https://support.google.com/youtube/answer/15424877?hl=en).

The accepted planning direction includes Clean/Off captions as new first-render quality scope. Clean can become the default only once implemented and accepted; current output must not be labeled captioned. Use original spoken language, phrase-level captions, at most two lines, tested size and contrast, and safe placement. Rebase word timings over selected segments, remove captions for discarded speech, and test joins and final word visibility. This does not need another LLM call.

Safe placement is a fixed tested treatment, not a promise of face or graphic awareness. Crop-to-fill, speaker tracking, face detection, translated captions, dubbing, music, speech rewriting, and generated footage are excluded. A separate SRT export is useful possible scope but deferred unless requested; it is not essential to this proposal. Future visual fonts/accents depend on actual renderer and asset support.

Speech transcription alone is not a complete accessibility guarantee: meaningful non-speech audio and speaker identification may require additional treatment. [W3C caption guidance](https://www.w3.org/WAI/media/av/captions/) explains the broader requirements. Describe the proposed result accurately as generated speech captions with tested readability, rather than certifying universal accessibility.

## 7. Failure behavior, distinctness, and charging

| Situation | Required outcome |
| --- | --- |
| Invalid enum, oversized field, bad interval, unselected-format parameter, obviously impossible combination | Clear validation error before provider work and credit reservation |
| Valid request but source cannot support focus, five useful slides, or a safe clip inside the window | Explicit unsupported-source outcome for that slot; no fabricated content |
| Saved-default read fails | Visible fallback status and resolved settings; immutable accepted snapshot |
| Result misses only a soft length/duration target | Accept if grounded and within hard limits; no automatic paid repair |
| Result violates a hard content/rendering bound | Existing failure handling; no silent factual truncation |
| Result duplicates retained content | Existing whole-output exact protection remains; threads may reuse historical individual posts under the explicit exception above |

Preserve [current canonicalization and history](../src/generation/history.ts): same-project, same-format exact comparison after trimming and NFC normalization; bounded prior-output context of at most twelve items, 8,000 serialized characters, and 900-character text excerpts. The context encourages useful variation, but does not guarantee semantic uniqueness. Retention and bounded excerpts mean it is not a complete memory of everything ever produced. These are current standalone/format behaviors; planned thread generation explicitly permits individual-post reuse from project history and must not inherit conflicting per-post avoidance instructions.

Carousel copy repeated under a new theme is still duplicate copy. Identical video segment selection with different captions is still duplicate footage. Style-only rerendering belongs in the later editing/revision flow, not a paid regeneration loophole. Different settings may encourage another supported result; they do not bypass whole-output exact duplicate checks. The permitted historical reuse of individual thread posts is a separate, explicit thread-only policy.

Overlapping but nonidentical footage is a separate policy decision. Do not invent a percentage threshold or imply current exact-segment checks prevent semantic repetition. A stricter overlap policy needs its own product tradeoff, measurable definition, source-exhaustion behavior, and tests.

An unsupported slot produces no charged output under existing failed-output accounting; actual provider expenses remain recorded. This does not imply a blanket source-import refund or new refund entitlement. Preserve approved credit prices and existing reservation, settlement, and partial-failure behavior. Do not add undisclosed debits or automatic retry calls to improve a merely subjective length preference.

## 8. API, UX, and engineering dependencies

Add optional typed controls to the existing generation request and extend per-format parsing; do not add a schema engine or new settings framework. Version the accepted settings contract. Old requests with no new fields remain valid and resolve through documented defaults. Backend availability metadata must describe supported controls and values so the client does not hardcode plan checks or present unimplemented captions/themes.

Resolve defaults once at acceptance and store an immutable normalized snapshot with the work. Keep the normalized request fingerprint distinct from resolved settings: replay lookup must happen before consulting mutable account defaults. A replay of an accepted request returns its original resolution even after settings change or a settings read fails. Snapshot version, explicit/inherited origin, fallback state, source-window choices, and relevant brand resolution make the result explainable without re-reading current preferences.

The project view should consume backend-resolved availability and summaries rather than requiring extra account lookups to reconstruct what happened. Show a collapsed “Customize” area with only applicable controls, an inherited/default indicator, and clear request reset behavior. Source time inputs should explain the hard boundary. A failed source-support result should name the relevant conflict in ordinary language without exposing prompts or internal reasoning.

Treat focus, transcript, history, and brand data as bounded untrusted structured data. They do not acquire prompt authority by appearing in a settings field. Preserve existing source/identity/safety precedence, reject unknown shapes, redact raw user strings from operational logs, and apply retention/deletion cleanup to new accepted snapshots. A saved-default write must retain the verified account ownership boundary and must not alter allowances or trials.

Implementation sequencing after explicit implementation authorization: first the shared contract, saved defaults, snapshots and text controls; then source-selection enforcement and video target/editing controls; then two carousel themes and density; then captions and tested visual font/brand assets. Settings support is part of the first release of controls, not a post-launch promise. This sequence is a dependency plan only, not rollout approval.

Benchmark representative inputs before setting any new operational budget: prompt tokens, output tokens, provider latency, render CPU/memory, font loading, asset bytes, and failure rates. Compare current defaults with each new mode, multilingual cases, and maximum supported sources. Caption rendering and theme changes add real engineering/render work even without another model call. No dollar savings or cost figures are assumed here.

## 9. Acceptance plan and remaining user decisions

Acceptance should cover behavior across layers, not just enum parsing:

- Defaults: absent versus explicit Auto; per-format saves; reset without saving; brand-off and video-only paths; visible read failure; independent account isolation; replay after a settings change.
- Grounding: unsupported focus; outside-window corrections; no silent widening; user direction attempting prompt injection; no invented identity, offers, guarantees, or links.
- Limits: X thread counts 2–10, single count 1, saved/request count and numbering, numbering within each post limit, atomic N-credit reservation, M-credit success settlement and N−M release, replay without another charge, source-limited coherent shorter threads and rejection of technically broken partial output; X weighted lengths and URL budgets; UTF-16 boundaries; all named bands; short-but-valid outputs; body-only word counts and multilingual measurement choices.
- Carousel: exactly five images; density ceilings; both themes; mobile legibility; glyph fallback, wrapping, contrast, and image byte bounds.
- Video: exactly one segment in continuous mode; chronological automatic cuts; hard duration bounds; source boundaries and final-word expansion; caption timing after joins; two-line readability; Off leaving no burned captions.
- Thread originality: one directly generated coherent sequence; prompt guidance against within-thread redundancy; historical standalone/prior-thread post reuse allowed; no per-post history rejection or unique-remainder delivery; exact whole-thread protection retained; no unapproved extra AI correction call.
- Reliability: failed-slot settlement, real provider cost recording, partial success, immutable snapshots, redacted logs, cleanup, duplicate preservation across theme/caption changes, and legacy request compatibility.

The X thread product decision is confirmed: the chosen count is a maximum, up to ten; deliver fewer posts when that is what the source supports, and charge one credit per delivered post. Reserve N, settle M and release N−M exactly once. Numbering uses the actual M. Saved count and numbering remain editable before generation. Do not reopen this decision as an exact-count or all-or-nothing source-sufficiency question. Technical failures still follow the existing failure policy; they do not authorize delivery of a broken partial thread.


Do not reopen the accepted direction for optional controls, approximate length bands, saved format defaults, hard source windows, two carousel themes or Clean/Off original-language captions during implementation and acceptance. Detailed validation, multilingual measurement and rendering acceptance remain engineering/design work within that direction. Do not advertise exact multilingual word counts or unsupported visual behavior.

Stronger semantic deduplication and video-overlap rejection were not approved. Preserve current exact whole-output duplicate protection and standalone source-grounded variety guidance, apply the approved thread-only historical post reuse exception, document their limitations, and treat any stronger policy as a separate future decision. Do not invent an overlap threshold.

Previously settled boundaries—one brand per account, optional brand setup, current single-output credit prices, fixed carousel count, existing 10–60-second video bounds, and account ownership—remain unchanged. Subsequent user authorization covers this implementation; production rollout remains outside this work.
