const reasons = ['invalid_shape', 'invalid_status', 'insufficient_source_has_content', 'empty_text', 'invalid_characters', 'unsupported_markup', 'character_limit', 'word_limit', 'item_count', 'invalid_timestamps', 'out_of_order', 'word_boundary', 'word_crosses_boundary', 'duration_limit', 'invalid_source_duration', 'byte_limit'] as const;
const fields = ['post', 'status', 'text', 'title', 'subject', 'previewText', 'bodyMarkdown', 'slides', 'slideTitle', 'slideBody', 'segments', 'sourceDuration', 'segment', 'transcript', 'words', 'wordText', 'wordTiming', 'startSeconds', 'endSeconds'] as const;

export type ValidationIssue = {
  reason: typeof reasons[number];
  field: typeof fields[number];
  actual?: number;
  limit?: number;
  index?: number;
};

export type LengthViolation = ValidationIssue & { path: string; rawActual?: number; rawLimit?: number; numberingCharacters?: number };

// Persist only known labels and measurements, never model or source text.
export function safeValidationIssue(value: unknown): ValidationIssue | undefined {
  try {
    const issue = value as ValidationIssue | null;
    if (!issue) return undefined;
    const { reason, field } = issue;
    if (!reasons.includes(reason) || !fields.includes(field)) return undefined;
    const safe: ValidationIssue = { reason, field };
    for (const key of ['actual', 'limit', 'index'] as const) {
      const number = issue[key];
      if (typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER) safe[key] = number;
    }
    return safe;
  } catch { return undefined; }
}
