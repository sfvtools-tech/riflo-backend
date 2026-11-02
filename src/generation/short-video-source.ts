import type { Transcript } from './service.js';

// Use provider spacing only when every timed token matches, without skipping source text.
export function transcriptWordSeparators(transcript: Transcript): string[] {
  const source = transcript.text.replace(/\s+/gu, ' ').trim();
  const separators: string[] = [];
  let offset = 0;
  for (const word of transcript.words) {
    const text = word.text.replace(/\s+/gu, ' ').trim();
    const separator = source[offset] === ' ' ? ' ' : '';
    offset += separator.length;
    if (!text || !source.startsWith(text, offset)) return transcript.words.map(() => ' ');
    separators.push(separator);
    offset += text.length;
  }
  return offset === source.length ? separators : transcript.words.map(() => ' ');
}

// ASR punctuation is a conservative selection hint, not proof of a complete idea.
// Abbreviations/ellipses can still split a thought; semantic review stays in the prompt.
export function shortVideoSentences(transcript: Transcript) {
  const separators = transcriptWordSeparators(transcript);
  const sentences: Array<{ start: number; end: number; text: string; complete: boolean }> = [];
  let first = 0;
  for (let index = 0; index < transcript.words.length; index++) {
    const word = transcript.words[index]!;
    const complete = /[.!?。！？؟।॥]["'”’»」』】\])}]*$/u.test(word.text);
    if (!complete && index < transcript.words.length - 1) continue;
    const words = transcript.words.slice(first, index + 1);
    sentences.push({ start: words[0]!.start, end: word.end, text: words.map((word, position) => (position ? separators[first + position]! : '') + word.text).join(''), complete });
    first = index + 1;
  }
  return sentences;
}

export type VideoSentenceRow = [start: number | null, end: number | null, text: string];
