export type GenerationConfig = {
  anthropicKey: string; deepgramKey: string; ffmpegPath: string; textModel: string; videoModel: string; newsletterModel: string; transcriptionModel: string;
  transcriptionLanguage: string; maxOutputTokens: number; longFormMaxOutputTokens?: number; stageTimeoutMilliseconds: number;
  videoRates: GenerationConfig['rates'];
  newsletterRates: GenerationConfig['rates'];
  rates: {
    inputMicrosPerMillion: number | null; outputMicrosPerMillion: number | null;
    cacheReadMicrosPerMillion: number | null; cacheWriteMicrosPerMillion: number | null;
    transcriptionMicrosPerMinute: number | null;
  };
};

function integer(value: string | undefined, fallback: number | null, name: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new Error(`${name} must be a nonnegative whole number within its supported range.`);
  return number;
}
// Standard synchronous API prices verified 2026-10-31 against Anthropic model docs.
// Cache-write TTL is not retained in our usage shape, so its rate stays unknown.
function modelRates(env: NodeJS.ProcessEnv, model: string, prefix: string, fallback?: GenerationConfig['rates']): GenerationConfig['rates'] {
  const known = model === 'claude-sonnet-5-5' ? [2_000_000, 10_000_000, 100_000] : model === 'claude-opus-5-5' ? [4_000_000, 20_000_000, 200_000] : [];
  return {
    inputMicrosPerMillion: integer(env[`${prefix}INPUT_MICROS_PER_MILLION`], fallback?.inputMicrosPerMillion ?? known[0] ?? null, `${prefix}INPUT_MICROS_PER_MILLION`),
    outputMicrosPerMillion: integer(env[`${prefix}OUTPUT_MICROS_PER_MILLION`], fallback?.outputMicrosPerMillion ?? known[1] ?? null, `${prefix}OUTPUT_MICROS_PER_MILLION`),
    cacheReadMicrosPerMillion: integer(env[`${prefix}CACHE_READ_MICROS_PER_MILLION`], fallback?.cacheReadMicrosPerMillion ?? known[2] ?? null, `${prefix}CACHE_READ_MICROS_PER_MILLION`),
    cacheWriteMicrosPerMillion: integer(env[`${prefix}CACHE_WRITE_MICROS_PER_MILLION`], fallback?.cacheWriteMicrosPerMillion ?? null, `${prefix}CACHE_WRITE_MICROS_PER_MILLION`),
    transcriptionMicrosPerMinute: integer(env.DEEPGRAM_MICROS_PER_MINUTE, null, 'DEEPGRAM_MICROS_PER_MINUTE'),
  };
}
export function readGenerationConfig(env: NodeJS.ProcessEnv): GenerationConfig | undefined {
  if (!env.ANTHROPIC_API_KEY && !env.DEEPGRAM_API_KEY) return undefined;
  if (!env.ANTHROPIC_API_KEY?.trim() || !env.DEEPGRAM_API_KEY?.trim() || !env.FFMPEG_PATH?.trim()) throw new Error('Generation requires ANTHROPIC_API_KEY, DEEPGRAM_API_KEY and FFMPEG_PATH.');
  const textModel = env.ANTHROPIC_TEXT_MODEL ?? 'claude-sonnet-5-5';
  const videoModel = env.ANTHROPIC_VIDEO_MODEL ?? 'claude-opus-5-5';
  const newsletterModel = env.ANTHROPIC_NEWSLETTER_MODEL ?? 'claude-opus-5-5';
  const transcriptionModel = env.DEEPGRAM_MODEL ?? 'nova-3';
  const transcriptionLanguage = env.DEEPGRAM_LANGUAGE ?? 'multi';
  if (![textModel, videoModel, newsletterModel, transcriptionModel].every(model => /^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) || !/^[a-z-]{2,20}$/.test(transcriptionLanguage)) throw new Error('Generation model and language settings are invalid.');
  const maxOutputTokens = integer(env.GENERATION_MAX_OUTPUT_TOKENS, 1200, 'GENERATION_MAX_OUTPUT_TOKENS', 8192)!;
  const stageTimeoutMilliseconds = integer(env.GENERATION_STAGE_TIMEOUT_MS, 180_000, 'GENERATION_STAGE_TIMEOUT_MS', 600_000)!;
  const longFormMaxOutputTokens = integer(env.GENERATION_LONG_FORM_MAX_OUTPUT_TOKENS, 4096, 'GENERATION_LONG_FORM_MAX_OUTPUT_TOKENS', 8192)!;
  if (longFormMaxOutputTokens < 256 || maxOutputTokens < 256 || stageTimeoutMilliseconds < 1000) throw new Error('Generation token and timeout bounds are too small.');
  const rates = modelRates(env, textModel, 'ANTHROPIC_');
  return {
    anthropicKey: env.ANTHROPIC_API_KEY, deepgramKey: env.DEEPGRAM_API_KEY, ffmpegPath: env.FFMPEG_PATH,
    textModel, videoModel, newsletterModel, transcriptionModel, transcriptionLanguage, maxOutputTokens, stageTimeoutMilliseconds,
    longFormMaxOutputTokens,
    rates,
    videoRates: modelRates(env, videoModel, 'ANTHROPIC_VIDEO_', videoModel === textModel ? rates : undefined),
    newsletterRates: modelRates(env, newsletterModel, 'ANTHROPIC_NEWSLETTER_', newsletterModel === textModel ? rates : undefined),
  };
}

export const longFormLimits = {
  blogs: { maxWords: 1200, maxCharacters: 16_000, titleCharacters: 120 },
  newsletters: { maxWords: 1500, maxCharacters: 21_000, subjectCharacters: 100, previewCharacters: 160 },
};

export const carouselLimits = { slides: 5, titleCharacters: 80, titleWords: 12, bodyCharacters: 240, bodyWords: 45, width: 1080, height: 1080, maxImageBytes: 5_000_000 };
const lightCarouselLimits = { titleCharacters: 60, titleWords: 9, bodyCharacters: 160, bodyWords: 28 };
export const carouselTextLimits = (density?: 'auto' | 'standard' | 'light') => density === 'light' ? lightCarouselLimits : carouselLimits;

export const shortVideoLimits = { minSeconds: 10, maxSeconds: 60, width: 720, height: 1280, framesPerSecond: 30, maxBytes: 100_000_000 };
