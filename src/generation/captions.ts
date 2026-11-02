/// <reference lib="es2024.string" />
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { GenerationError, type ShortVideoContent, type Transcript } from './service.js';
import { transcriptWordSeparators } from './short-video-source.js';

const fps = 30;
export const captionLimits = { words: 600, characters: 16_000, phrases: 240, pngBytes: 256 * 1024, totalBytes: 32 * 1024 * 1024, manifestBytes: 64 * 1024, preparationMilliseconds: 30_000 };
export type CaptionCue = { startFrame: number; endFrame: number; lines: string[] };
const escapeText = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const fail = (): never => { throw new GenerationError(502, 'caption_render_failed', 'The original speech captions could not be prepared within readable limits.'); };

// Fixed-size, manually wrapped lines keep Clean captions readable without automatic font shrinking.
async function lineImage(text: string) {
  return sharp({ limitInputPixels: 4_000_000, text: { text: `<span foreground="#ffffff">${escapeText(text)}</span>`, font: 'Noto Sans Bold 44', dpi: 72, rgba: true, wrap: 'none', align: 'centre', spacing: 8 } }).timeout({ seconds: 2 }).png().toBuffer({ resolveWithObject: true });
}

export async function prepareCaptions(plan: ShortVideoContent, transcript: Transcript, directory: string, signal: AbortSignal) {
  const deadline = Date.now() + captionLimits.preparationMilliseconds;
  const check = () => { signal.throwIfAborted(); if (Date.now() > deadline) fail(); };
  const fits = async (text: string) => {
    check();
    const image = await lineImage(text);
    check();
    return image.info.width <= 600 && image.info.height <= 64;
  };
  let wordsUsed = 0, charactersUsed = 0, offset = 0;
  const cues: CaptionCue[] = [];
  const selectedWords = new Set<number>();
  const separators = transcriptWordSeparators(transcript);
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const [segmentIndex, segment] of plan.segments.entries()) {
    check();
    const duration = segment.endSeconds - segment.startSeconds;
    const firstFrame = Math.ceil(offset * fps - 1e-9);
    // Each input is trimmed to whole frames. Use their conservative total only for the final endpoint,
    // so a final word remains visible even when source/audio quantization removes the last frame.
    const lastFrame = segmentIndex === plan.segments.length - 1
      ? plan.segments.reduce((frames, cut) => frames + Math.max(1, Math.floor((cut.endSeconds - cut.startSeconds) * fps)), 0)
      : Math.ceil((offset + duration) * fps - 1e-9);
    if (lastFrame <= firstFrame) fail();
    const phrases: CaptionCue[] = [];
    let previousWordIndex = -1;
    let phrase: { start: number; end: number; lines: string[] } | undefined;
    const flush = () => {
      if (!phrase) return;
      const startFrame = Math.max(firstFrame, Math.min(lastFrame - 1, Math.floor((offset + phrase.start - segment.startSeconds) * fps + 1e-9)));
      const endFrame = Math.max(startFrame + 1, Math.min(lastFrame, Math.ceil((offset + phrase.end - segment.startSeconds) * fps - 1e-9)));
      phrases.push({ startFrame, endFrame, lines: phrase.lines });
      if (cues.length + phrases.length > captionLimits.phrases) fail();
      phrase = undefined;
    };
    for (const [wordIndex, word] of transcript.words.entries()) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start) fail();
      if (selectedWords.has(wordIndex) || word.start < segment.startSeconds || word.end > segment.endSeconds) continue;
      // An instantaneous word at adjacent cut boundaries belongs to the first cut only.
      selectedWords.add(wordIndex);
      const separator = wordIndex === previousWordIndex + 1 ? separators[wordIndex]! : ' ';
      previousWordIndex = wordIndex;
      const text = word.text.replace(/\s+/gu, ' ').trim();
      if (!text || text.length > 200 || !text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) fail();
      wordsUsed++; charactersUsed += text.length;
      if (wordsUsed > captionLimits.words || charactersUsed > captionLimits.characters) fail();
      const units = [...graphemes.segment(text)].map(part => part.segment);
      let cursor = 0;
      while (cursor < units.length) {
        check();
        let take = units.length - cursor;
        if (!await fits(units.slice(cursor).join(''))) {
          let low = 1, high = take, best = 0;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (await fits(units.slice(cursor, cursor + middle).join(''))) { best = middle; low = middle + 1; }
            else high = middle - 1;
          }
          if (!best) fail();
          take = best;
        }
        const part = units.slice(cursor, cursor + take).join('');
        const start = word.start + (word.end - word.start) * cursor / units.length;
        const end = word.start + (word.end - word.start) * (cursor + take) / units.length;
        if (phrase && (start - phrase.end >= 0.35 || end - phrase.start > 2.5)) flush();
        if (phrase) {
          const last = phrase.lines.length - 1;
          const candidate = phrase.lines[last]! + (cursor === 0 ? separator : '') + part;
          if (await fits(candidate)) phrase.lines[last] = candidate;
          else if (phrase.lines.length === 1) phrase.lines.push(part);
          else flush();
        }
        if (!phrase) phrase = { start, end, lines: [part] };
        else { phrase.start = Math.min(phrase.start, start); phrase.end = Math.max(phrase.end, end); }
        cursor += take;
        if (/[.!?।。！？؟]$/u.test(part)) flush();
      }
    }
    flush();
    // Overlapping ASR ranges share their available frames, in order, rather than hiding a word.
    for (let index = 0; index < phrases.length;) {
      let next = index + 1;
      let endFrame = phrases[index]!.endFrame;
      while (next < phrases.length && phrases[next]!.startFrame < endFrame) { endFrame = Math.max(endFrame, phrases[next]!.endFrame); next++; }
      const startFrame = phrases[index]!.startFrame;
      const count = next - index;
      if (endFrame - startFrame < count) fail();
      for (let position = 0; position < count; position++) {
        cues.push({ ...phrases[index + position]!, startFrame: startFrame + Math.floor((endFrame - startFrame) * position / count), endFrame: startFrame + Math.floor((endFrame - startFrame) * (position + 1) / count) });
      }
      index = next;
    }
    offset += duration;
  }
  if (!cues.length) fail();
  let totalBytes = 0;
  const save = async (name: string, bytes: Buffer) => {
    check();
    totalBytes += bytes.length;
    if (bytes.length > captionLimits.pngBytes || totalBytes > captionLimits.totalBytes) fail();
    await writeFile(join(directory, name), bytes, { flag: 'wx', signal });
    check();
  };
  const blank = await sharp({ create: { width: 648, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).timeout({ seconds: 2 }).png().toBuffer();
  await save('caption-blank.png', blank);
  for (const [index, cue] of cues.entries()) {
    check();
    // A soft line break keeps both manually wrapped lines in one bidi paragraph.
    const rendered = await lineImage(cue.lines.join('\u2028'));
    check();
    if (rendered.info.width > 600 || rendered.info.height > (cue.lines.length === 1 ? 64 : 136)) fail();
    const layer = { input: rendered.data, left: Math.floor((648 - rendered.info.width) / 2), top: Math.floor((160 - rendered.info.height) / 2) };
    const bytes = await sharp({ create: { width: 648, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.82 } } }).composite([layer]).timeout({ seconds: 2 }).png().toBuffer();
    await save(`caption-${index}.png`, bytes);
  }
  const manifest = ['ffconcat version 1.0'];
  const entry = (name: string, frames: number) => { if (frames > 0) manifest.push(`file ${name}`, 'option framerate 30', `duration ${(frames / fps).toFixed(9)}`); };
  let frame = 0;
  for (const [index, cue] of cues.entries()) {
    entry('caption-blank.png', cue.startFrame - frame);
    entry(`caption-${index}.png`, cue.endFrame - cue.startFrame);
    frame = cue.endFrame;
  }
  entry('caption-blank.png', Math.max(1, Math.ceil(offset * fps) - frame));
  manifest.push('file caption-blank.png', 'option framerate 30');
  const manifestText = manifest.join('\n') + '\n';
  if (Buffer.byteLength(manifestText) > captionLimits.manifestBytes) fail();
  const path = join(directory, 'captions.ffconcat');
  await writeFile(path, manifestText, { flag: 'wx', signal });
  check();
  return { path, cues };
}
