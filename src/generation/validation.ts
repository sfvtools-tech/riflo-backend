import { shortVideoSentences, transcriptWordSeparators, type VideoSentenceRow } from './short-video-source.js';
/// <reference lib="es2024.string" />
import twitterText from 'twitter-text';
import { GenerationError, type LongFormContent, type Transcript, type CarouselContent, type XThreadContent } from './service.js';
import { carouselLimits, carouselTextLimits, longFormLimits, shortVideoLimits } from './config.js';
import type { ValidationIssue, LengthViolation } from './diagnostics.js';
import { validateControlsWindow, type ControlsSnapshot, type FormatControls } from './controls.js';

function invalid(message: string, validation: ValidationIssue, code = 'invalid_generated_output') {
  const error = new GenerationError(502, code, message);
  error.validation = validation;
  return error;
}

// Preserve the public first issue while supplying every hard-length violation to
// the one correction call. Called only after all nonlength checks have passed.
function throwLengthErrors(errors: GenerationError[], threadNumbering?: 'include' | 'exclude', postCount?: number) {
  if (!errors.length) return;
  const first = errors[0]!;
  first.lengthViolations = errors.map(error => {
    const issue = error.validation!;
    const path = issue.field === 'slideTitle' || issue.field === 'slideBody'
      ? `slides[${issue.index}].${issue.field === 'slideTitle' ? 'title' : 'body'}`
      : issue.index !== undefined && issue.field === 'text' ? `posts[${issue.index}]` : issue.field;
    const violation: LengthViolation = { ...issue, path };
    if (threadNumbering !== undefined) {
      const reserve = threadNumbering === 'include' ? `${issue.index! + 1}/${postCount} `.length : 0;
      Object.assign(violation, { numberingCharacters: reserve, rawActual: issue.actual! - reserve, rawLimit: issue.limit! - reserve });
    }
    return violation;
  });
  throw first;
}

export function shortVideoDuration(content: { segments: Array<{ startSeconds: number; endSeconds: number }> }) {
  return content.segments.reduce((seconds, segment) => seconds + segment.endSeconds - segment.startSeconds, 0);
}

export function eligibleTranscript(transcript: Transcript, controls?: ControlsSnapshot, actualDurationSeconds?: number): Transcript {
  if (!controls?.sourceWindow) return transcript;
  validateControlsWindow(controls, actualDurationSeconds);
  const source = validateTranscript(transcript, actualDurationSeconds!);
  const { startSeconds, endSeconds } = controls.sourceWindow;
  const separators = transcriptWordSeparators(source);
  const selected = source.words.map((word, index) => ({ word, index })).filter(({ word }) => word.start >= startSeconds && word.end <= endSeconds);
  const words = selected.map(({ word }) => word);
  if (!words.length) throw new GenerationError(422, 'source_window_empty', 'The selected source window contains no complete spoken words.');
  return { text: selected.map(({ word, index }, position) => (position ? index === selected[position - 1]!.index + 1 ? separators[index]! : ' ' : '') + word.text).join(''), words };
}

// Enumerate exact usable timestamps for constrained selection, using all source
// words so an overlap outside a requested window cannot disappear from the check.
export function shortVideoBoundaries(transcript: Transcript, actualDurationSeconds: number, controls?: ControlsSnapshot) {
  const source = validateTranscript(transcript, actualDurationSeconds);
  if (controls?.sourceWindow) validateControlsWindow(controls, actualDurationSeconds);
  const window = controls?.sourceWindow ?? { startSeconds: 0, endSeconds: actualDurationSeconds };
  const candidates = [...new Set(source.words.flatMap(word => [word.start, word.end]))].sort((a, b) => a - b);
  const safe = new Set<number>();
  let cursor = 0;
  let latestEnd = -1;
  for (const boundary of candidates) {
    while (cursor < source.words.length && source.words[cursor]!.start < boundary) {
      latestEnd = Math.max(latestEnd, source.words[cursor++]!.end);
    }
    if (latestEnd <= boundary && boundary >= window.startSeconds && boundary <= Math.min(window.endSeconds, actualDurationSeconds)) safe.add(boundary);
  }
  const sentences = shortVideoSentences(source);
  const eligible = sentences.filter(sentence => sentence.complete && sentence.start >= window.startSeconds && sentence.end <= Math.min(window.endSeconds, actualDurationSeconds));
  const startSeconds = [...new Set(eligible.map(sentence => sentence.start).filter(time => safe.has(time)))];
  const endSeconds = [...new Set(eligible.map(sentence => sentence.end).filter(time => safe.has(time)))];
  if (!startSeconds.length || !endSeconds.length) throw new GenerationError(422, controls?.sourceWindow ? 'source_window_conflict' : 'insufficient_source', 'The source contains no usable punctuated sentence boundaries.');
  const starts = new Set(startSeconds);
  const ends = new Set(endSeconds);
  const rows: VideoSentenceRow[] = sentences.map(sentence => [starts.has(sentence.start) ? sentence.start : null, ends.has(sentence.end) ? sentence.end : null, sentence.text]);
  return { startSeconds, endSeconds, sentences: rows };

}

export function prepareProviderShortVideoSelection(value: unknown, transcript: Transcript, actualDurationSeconds: number, boundaries: ReturnType<typeof shortVideoBoundaries>, controls?: ControlsSnapshot) {
  const prepared = prepareShortVideoSelection(value, transcript, actualDurationSeconds, controls);
  for (const [index, segment] of prepared.content.segments.entries()) {
    for (const field of ['startSeconds', 'endSeconds'] as const) {
      if (!boundaries[field].includes(segment[field])) throw invalid('The clip must use an allowed sentence boundary.', { reason: 'word_boundary', field, index, actual: segment[field] });
    }
  }
  return prepared;
}

export function validateShortVideo(value: unknown, transcript: Transcript, actualDurationSeconds: number, controls?: ControlsSnapshot) {
  return checkShortVideo(value, transcript, actualDurationSeconds, false, controls);
}

export function prepareShortVideoSelection(value: unknown, transcript: Transcript, actualDurationSeconds: number, controls?: ControlsSnapshot) {
  return checkShortVideo(value, transcript, actualDurationSeconds, true, controls);
}

function checkShortVideo(value: unknown, transcript: Transcript, actualDurationSeconds: number, checkTranscript: boolean, controls?: ControlsSnapshot) {
  if (controls?.sourceWindow) validateControlsWindow(controls, actualDurationSeconds);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The clip selection is invalid.', { reason: 'invalid_shape', field: 'segments' });
  const plan = value as Record<string, unknown>;
  const legacy = Object.keys(plan).length === 3 && Object.hasOwn(plan, 'status') && Object.hasOwn(plan, 'startSeconds') && Object.hasOwn(plan, 'endSeconds');
  if (!legacy && (Object.keys(plan).length !== 2 || !Object.hasOwn(plan, 'status') || !Array.isArray(plan.segments))) throw invalid('The clip selection is invalid.', { reason: 'invalid_shape', field: 'segments' });
  // Saved single-range plans predate the segment list; normalize only at this boundary.
  const segments = legacy ? plan.status === 'insufficient_source' && plan.startSeconds === null && plan.endSeconds === null ? [] : [{ startSeconds: plan.startSeconds, endSeconds: plan.endSeconds }] : plan.segments as unknown[];
  if (plan.status === 'insufficient_source') {
    if (segments.length !== 0) throw invalid('An insufficient source response must not select a clip.', { reason: 'insufficient_source_has_content', field: 'segments', actual: segments.length, limit: 0 });
    throw new GenerationError(422, 'insufficient_source', 'The source does not contain a suitable clip.');
  }
  if (plan.status !== 'ok') throw invalid('The clip selection is invalid.', { reason: 'invalid_status', field: 'status' });
  const maxSegments = controls?.formats.short_videos?.editing === 'continuous' ? 1 : 3;
  if (segments.length < 1 || segments.length > maxSegments) throw invalid('The clip selection does not match the accepted editing choice.', { reason: 'item_count', field: 'segments', actual: segments.length, limit: maxSegments });
  if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) throw invalid('The clip selection is invalid.', { reason: 'invalid_source_duration', field: 'sourceDuration' });
  if (checkTranscript) transcript = validateTranscript(transcript, actualDurationSeconds);
  let previousEnd = -1;
  let previousWord = -1;
  const selectedSegments = segments.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The clip selection is invalid.', { reason: 'invalid_shape', field: 'segment', index });
    const segment = value as Record<string, unknown>;
    const { startSeconds, endSeconds } = segment;
    if (Object.keys(segment).length !== 2 || typeof startSeconds !== 'number' || typeof endSeconds !== 'number' || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > actualDurationSeconds) throw invalid('The clip ranges must be within the source and in their original order.', { reason: 'invalid_timestamps', field: 'segment', index });
    const start = startSeconds;
    const end = endSeconds;
    const window = controls?.sourceWindow;
    if (window && (start < window.startSeconds || end > window.endSeconds)) throw invalid('The selected clip must stay inside the source window.', { reason: 'invalid_timestamps', field: 'segment', index }, 'source_window_conflict');
    if (start < previousEnd) throw invalid('The clip ranges must be within the source and in their original order.', { reason: 'out_of_order', field: 'segment', index });
    const first = transcript.words.findIndex((word, wordIndex) => wordIndex > previousWord && word.start === start);
    if (first < 0) throw invalid('The clip must start at an original word boundary.', { reason: 'word_boundary', field: 'startSeconds', index, actual: start });
    const last = transcript.words.findLastIndex((word, wordIndex) => wordIndex >= first && word.end === end);
    if (last < first) throw invalid('The clip must end at an original word boundary.', { reason: 'word_boundary', field: 'endSeconds', index, actual: end });
    // Reject ambiguous cuts: expanding them can add an orphan opening or unfinished clause.
    // Even an exact word timestamp can intersect another word outside this slice.
    for (const [field, boundary] of [['startSeconds', start], ['endSeconds', end]] as const) {
      const crossing = transcript.words.filter(word => word.start < boundary && word.end > boundary);
      if (crossing.length) throw invalid('The clip must not cut through an overlapping word.', { reason: 'word_crosses_boundary', field, index, actual: boundary }, window && crossing.some(word => word.start < window.startSeconds || word.end > window.endSeconds) ? 'source_window_conflict' : 'invalid_generated_output');
    }
    const selected = transcript.words.slice(first, last + 1);
    // Speech timings can overlap; every word must still fit inside the selected range.
    if (selected.some((word, wordIndex) => !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < start || word.end > end || word.end < word.start || (wordIndex > 0 && word.start < selected[wordIndex - 1]!.start))) throw invalid('The selected transcript timing is invalid.', { reason: 'invalid_timestamps', field: 'wordTiming', index });
    previousEnd = end;
    previousWord = last;
    return { startSeconds: start, endSeconds: end };
  });
  const content = { status: 'ok' as const, segments: selectedSegments };
  const duration = shortVideoDuration(content);
  if (duration < shortVideoLimits.minSeconds - 1e-9 || duration > shortVideoLimits.maxSeconds + 1e-9) throw invalid('The combined clip exceeds its timing limits.', { reason: 'duration_limit', field: 'segments', actual: duration, limit: duration < shortVideoLimits.minSeconds ? shortVideoLimits.minSeconds : shortVideoLimits.maxSeconds });
  return { content, text: `Original video clip: ${selectedSegments.map(({ startSeconds, endSeconds }) => `${startSeconds}–${endSeconds}`).join(', ')} seconds` };
}

export function validateShortPost(value: unknown, feature: 'x_posts' | 'linkedin_posts') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The generated post did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  const content = value as Record<string, unknown>;
  if (Object.keys(content).length !== 2 || !['ok', 'insufficient_source'].includes(content.status as string) || typeof content.text !== 'string') throw invalid('The generated post did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  if (content.status === 'insufficient_source') {
    if (content.text !== '') throw invalid('An insufficient source response must not invent content.', { reason: 'insufficient_source_has_content', field: 'text' });
    throw new GenerationError(422, 'insufficient_source', 'The source does not contain enough material for this post.');
  }
  return validatePost({ text: content.text }, feature);
}

export function validatePost(value: unknown, feature: 'x_posts' | 'linkedin_posts') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as { text?: unknown }).text !== 'string') throw invalid('The generated post did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  return checkPost(value, feature);
}

function checkPost(value: unknown, feature: 'x_posts' | 'linkedin_posts', lengths?: GenerationError[]) {
  if (!value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') throw invalid('The generated post did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  const text = (value as { text: string }).text.trim().normalize('NFC');
  if (!text) throw invalid('The generated post does not meet the platform limits.', { reason: 'empty_text', field: 'text' });
  if (text.includes('\u0000') || !text.isWellFormed() || (feature === 'x_posts' && twitterText.hasInvalidCharacters(text))) throw invalid('The generated post does not meet the platform limits.', { reason: 'invalid_characters', field: 'text' });
  if (text.startsWith('```')) throw invalid('The generated post does not meet the platform limits.', { reason: 'unsupported_markup', field: 'text' });
  const measured = feature === 'x_posts' ? twitterText.parseTweet(text) : { weightedLength: text.length, valid: text.length <= 3000 };
  const limit = feature === 'x_posts' ? 280 : 3000;
  if (measured.weightedLength > limit) {
    const error = invalid('The generated post does not meet the platform limits.', { reason: 'character_limit', field: 'text', actual: measured.weightedLength, limit });
    if (lengths) lengths.push(error); else throwLengthErrors([error]);
  }
  if (measured.weightedLength <= limit && !measured.valid) throw invalid('The generated post does not meet the platform limits.', { reason: 'invalid_characters', field: 'text' });
  return text;
}

export function validateXThread(value: unknown, settings: FormatControls['x_posts']) {
  if (!Number.isInteger(settings.maxPosts) || settings.maxPosts! < 2 || settings.maxPosts! > 10 || !['include', 'exclude'].includes(settings.numbering!)) throw new GenerationError(502, 'invalid_generation_controls', 'The accepted thread settings are invalid.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The thread did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  const input = value as Record<string, unknown>;
  const normalized = Object.hasOwn(input, 'kind') || Object.hasOwn(input, 'numbering');
  const keys = normalized ? ['status', 'kind', 'posts', 'numbering'] : ['status', 'posts'];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) || !Array.isArray(input.posts) || (normalized && (input.kind !== 'thread' || input.numbering !== settings.numbering))) throw invalid('The thread did not match the required format.', { reason: 'invalid_shape', field: 'post' });
  if (input.status === 'insufficient_source') {
    if (input.posts.length) throw invalid('An unsupported source must not contain thread posts.', { reason: 'insufficient_source_has_content', field: 'post' });
    throw new GenerationError(422, 'insufficient_source', 'The source does not support a coherent thread.');
  }
  if (input.status !== 'ok') throw invalid('The thread status is invalid.', { reason: 'invalid_status', field: 'status' });
  if (input.posts.length < 1 || input.posts.length > settings.maxPosts!) throw invalid('The thread exceeds its requested maximum.', { reason: 'item_count', field: 'post', actual: input.posts.length, limit: settings.maxPosts });
  // A length failure must not hide another field that makes correction ineligible.
  const lengths: GenerationError[] = [];
  const posts = input.posts.map(post => {
    const text = checkPost({ text: post }, 'x_posts', []);
    if (/^\d+\/\d+\s/u.test(text)) throw invalid('Thread numbering is added automatically; return unnumbered posts.', { reason: 'unsupported_markup', field: 'text' });
    return text;
  });
  const rendered = posts.map((post, index) => {
    const before = lengths.length;
    const text = checkPost({ text: settings.numbering === 'include' ? `${index + 1}/${posts.length} ${post}` : post }, 'x_posts', lengths);
    if (lengths.length > before) lengths[before]!.validation!.index = index;
    return text;
  });
  throwLengthErrors(lengths, settings.numbering, posts.length);
  const content: XThreadContent = { status: 'ok', kind: 'thread', posts, numbering: settings.numbering! };
  return { content, text: rendered.join('\n\n') };
}

export function validateTranscript(value: unknown, durationSeconds: number): Transcript {
  const transcript = value as Transcript | null;
  if (!transcript || typeof transcript.text !== 'string' || !Array.isArray(transcript.words)) throw invalid('The source could not be transcribed into usable text.', { reason: 'invalid_shape', field: 'transcript' }, 'invalid_transcript');
  if (!transcript.text.trim()) throw invalid('The source could not be transcribed into usable text.', { reason: 'empty_text', field: 'text' }, 'invalid_transcript');
  if (transcript.text.length > 100_000) throw invalid('The source could not be transcribed into usable text.', { reason: 'character_limit', field: 'text', actual: transcript.text.length, limit: 100_000 }, 'invalid_transcript');
  if (transcript.words.length === 0 || transcript.words.length > 12_000) throw invalid('The source could not be transcribed into usable text.', { reason: 'item_count', field: 'words', actual: transcript.words.length, limit: 12_000 }, 'invalid_transcript');
  let previousStart = -1;
  for (const [index, word] of transcript.words.entries()) {
    if (!word || typeof word.text !== 'string') throw invalid('The transcript timing is invalid.', { reason: 'invalid_shape', field: 'wordText', index }, 'invalid_transcript');
    if (!word.text) throw invalid('The transcript timing is invalid.', { reason: 'empty_text', field: 'wordText', index }, 'invalid_transcript');
    if (word.text.length > 200) throw invalid('The transcript timing is invalid.', { reason: 'character_limit', field: 'wordText', index, actual: word.text.length, limit: 200 }, 'invalid_transcript');
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < previousStart || word.end < word.start || word.start < 0 || word.end > durationSeconds + 1) throw invalid('The transcript timing is invalid.', { reason: 'invalid_timestamps', field: 'wordTiming', index }, 'invalid_transcript');
    previousStart = word.start;
  }
  const result = { text: transcript.text.trim(), words: transcript.words.map(({ text, start, end }) => ({ text, start, end })) };
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 750_000) throw invalid('The transcript exceeds the supported size.', { reason: 'byte_limit', field: 'transcript', actual: bytes, limit: 750_000 }, 'invalid_transcript');
  return result;
}

export function validateLongForm(value: unknown, feature: 'blogs' | 'newsletters') {
  const keys = feature === 'blogs' ? ['status', 'title', 'bodyMarkdown'] : ['status', 'subject', 'previewText', 'bodyMarkdown'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('The generated content did not match the required format.', { reason: 'invalid_shape', field: 'bodyMarkdown' });
  const content = value as Record<string, unknown>;
  if (Object.keys(content).length !== keys.length || keys.some((key) => typeof content[key] !== 'string') || Object.keys(content).some((key) => !keys.includes(key)) || !['ok', 'insufficient_source'].includes(content.status as string)) throw invalid('The generated content did not match the required format.', { reason: 'invalid_shape', field: 'bodyMarkdown' });
  const fields = keys.filter((key) => key !== 'status');
  if (content.status === 'insufficient_source') {
    if (fields.some((key) => content[key] !== '')) throw invalid('An insufficient source response must not invent content.', { reason: 'insufficient_source_has_content', field: 'bodyMarkdown' });
    throw new GenerationError(422, 'insufficient_source', 'The source does not contain enough material for this format.');
  }
  const normalized = Object.fromEntries(keys.map((key) => [key, (content[key] as string).trim().normalize('NFC')])) as Record<string, string>;
  const body = normalized.bodyMarkdown!;
  const limits = longFormLimits[feature];
  const wordCount = body.split(/\s+/u).filter(Boolean).length;
  for (const field of fields as Array<'title' | 'subject' | 'previewText' | 'bodyMarkdown'>) {
    if (!normalized[field]) throw invalid('The generated content exceeds the format limits or contains unsupported markup.', { reason: 'empty_text', field });
    if (/<[^>]+>|!\[|\]\(|https?:\/\/|www\.|\u0000/i.test(normalized[field]!)) throw invalid('The generated content exceeds the format limits or contains unsupported markup.', { reason: 'unsupported_markup', field });
  }
  const lengths: GenerationError[] = [];
  if (body.length > limits.maxCharacters) lengths.push(invalid('The generated content exceeds the format limits or contains unsupported markup.', { reason: 'character_limit', field: 'bodyMarkdown', actual: body.length, limit: limits.maxCharacters }));
  if (wordCount > limits.maxWords) lengths.push(invalid('The generated content exceeds the format limits or contains unsupported markup.', { reason: 'word_limit', field: 'bodyMarkdown', actual: wordCount, limit: limits.maxWords }));
  if (feature === 'blogs') {
    if (normalized.title!.length > longFormLimits.blogs.titleCharacters) lengths.push(invalid('The generated title is too long.', { reason: 'character_limit', field: 'title', actual: normalized.title!.length, limit: longFormLimits.blogs.titleCharacters }));
    throwLengthErrors(lengths);
    return { text: `${normalized.title}\n\n${body}`, content: normalized as LongFormContent };
  }
  for (const [field, limit] of [['subject', longFormLimits.newsletters.subjectCharacters], ['previewText', longFormLimits.newsletters.previewCharacters]] as const) {
    if (normalized[field]!.length > limit) lengths.push(invalid('The generated newsletter heading is too long.', { reason: 'character_limit', field, actual: normalized[field]!.length, limit }));
  }
  throwLengthErrors(lengths);
  return { text: `Subject: ${normalized.subject}\nPreview: ${normalized.previewText}\n\n${body}`, content: normalized as LongFormContent };
}

export function validateCarousel(value: unknown, controls?: ControlsSnapshot) {
  const limits = carouselTextLimits(controls?.formats.carousels?.density);
  const plan = value as CarouselContent | null;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== 2 || !['ok', 'insufficient_source'].includes(plan.status) || !Array.isArray(plan.slides)) throw invalid('The carousel plan did not match the required format.', { reason: 'invalid_shape', field: 'slides' });
  if (plan.status === 'insufficient_source') {
    if (plan.slides.length !== 0) throw invalid('An insufficient source response must not invent slides.', { reason: 'insufficient_source_has_content', field: 'slides', actual: plan.slides.length, limit: 0 });
    throw new GenerationError(422, 'insufficient_source', 'The source cannot support five useful slides.');
  }
  if (plan.slides.length !== carouselLimits.slides) throw invalid('The carousel must contain exactly five slides.', { reason: 'item_count', field: 'slides', actual: plan.slides.length, limit: carouselLimits.slides });
  // A length failure must not hide another field that makes correction ineligible.
  const lengths: GenerationError[] = [];
  const slides = plan.slides.map((slide, index) => {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide) || Object.keys(slide).length !== 2 || typeof slide.title !== 'string' || typeof slide.body !== 'string') throw invalid('The slide content is invalid.', { reason: 'invalid_shape', field: 'slides', index });
    const title = slide.title.trim().normalize('NFC');
    const body = slide.body.trim().normalize('NFC');
    const unsupported = /<[^>]+>|[\x00-\x1f\x7f]|https?:\/\/|www\.|!\[|\]\(|```|\*\*|__|^#{1,6}\s/m;
    for (const [field, text, characters, words] of [['slideTitle', title, limits.titleCharacters, limits.titleWords], ['slideBody', body, limits.bodyCharacters, limits.bodyWords]] as const) {
      if (!text.isWellFormed()) throw invalid('The slide text contains invalid characters.', { reason: 'invalid_characters', field, index });
      if (!text) throw invalid('The slide text exceeds the supported limits.', { reason: 'empty_text', field, index });
      if (text.length > characters) lengths.push(invalid('The slide text exceeds the supported limits.', { reason: 'character_limit', field, index, actual: text.length, limit: characters }));
      const count = text.split(/\s+/u).length;
      if (count > words) lengths.push(invalid('The slide text exceeds the supported limits.', { reason: 'word_limit', field, index, actual: count, limit: words }));
      if (unsupported.test(text)) throw invalid('The slide text exceeds the supported limits.', { reason: 'unsupported_markup', field, index });
    }
    return { title, body };
  });
  throwLengthErrors(lengths);
  return { content: { status: 'ok' as const, slides }, text: slides.map((slide, index) => `${index + 1}. ${slide.title}\n${slide.body}`).join('\n\n') };
}
