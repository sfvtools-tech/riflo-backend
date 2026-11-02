import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readGenerationConfig } from '../../src/generation/config.js';
import { createGenerationProviders } from '../../src/generation/providers.js';
import { safeValidationIssue, type ValidationIssue } from '../../src/generation/diagnostics.js';
import { GenerationError, generationFeatures, unknownUsage, type GenerationFeature, type ProviderRequest, type ShortVideoContent } from '../../src/generation/service.js';
import { corpusVersion, evaluationCases } from './cases.js';

export type EvaluationOptions = { paid: boolean; caseId?: string; feature?: GenerationFeature; output?: string };

export function parseEvaluationArgs(args: string[]): EvaluationOptions {
  const options: EvaluationOptions = { paid: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error('Each option may appear only once.');
    seen.add(flag);
    if (flag === '--run-paid') { options.paid = true; continue; }
    if (!['--case', '--feature', '--output'].includes(flag)) throw new Error('Supported options: --run-paid, --case, --feature, --output.');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('This option requires a value.');
    if (flag === '--case') options.caseId = value;
    if (flag === '--feature') {
      if (!generationFeatures.includes(value as GenerationFeature)) throw new Error('Unknown generation feature.');
      options.feature = value as GenerationFeature;
    }
    if (flag === '--output') options.output = value;
  }
  if (options.paid && !options.output) throw new Error('Paid evaluation requires --output pointing to a new report file.');
  if (!options.paid && options.output) throw new Error('--output requires --run-paid; dry runs only list requests.');
  return options;
}

export function selectEvaluationJobs(options: EvaluationOptions) {
  if (options.caseId && !evaluationCases.some(entry => entry.id === options.caseId)) throw new Error('Unknown evaluation case.');
  const jobs = evaluationCases
    .filter(entry => !options.caseId || entry.id === options.caseId)
    .flatMap(entry => entry.features.filter(feature => !options.feature || feature === options.feature).map(feature => ({ entry, feature })));
  if (!jobs.length) throw new Error('No evaluation requests match the selected case and feature.');
  return jobs;
}

export async function runEvaluation(options: EvaluationOptions, { env = process.env, request }: { env?: NodeJS.ProcessEnv; request?: typeof fetch } = {}) {
  const jobs = selectEvaluationJobs(options);
  if (!options.paid) return {
    dryRun: true, corpusVersion, requestCount: jobs.length,
    requests: jobs.map(({ entry, feature }) => ({ case: entry.id, feature, expected: entry.expected })),
  };
  if (!options.output) throw new Error('Paid evaluation requires a new report path.');
  if (!env.ANTHROPIC_API_KEY?.trim()) throw new Error('Paid evaluation requires ANTHROPIC_API_KEY.');
  // These providers are never invoked; evaluation starts from synthetic transcripts.
  const config = readGenerationConfig({ ...env, DEEPGRAM_API_KEY: 'unused-by-evaluation', FFMPEG_PATH: 'unused-by-evaluation' })!;
  const reportFile = await open(options.output, 'wx', 0o600);
  try {
    const providers = createGenerationProviders({ config, request, audio: async () => { throw new Error('Evaluation must not extract or transcribe audio.'); } });
    const results = [];
    for (const { entry, feature } of jobs) {
      const started = performance.now();
      let metadata: ProviderRequest = { provider: 'anthropic', model: config.textModel, rates: null, promptVersion: null };
      let outcome: 'ok' | 'insufficient_source' | 'error';
      let errorCode: string | null = null;
      let output: unknown = null;
      let validation: ValidationIssue | null = null;
      let usage = unknownUsage();
      try {
        const generated = await providers.generate(entry.transcript, { id: `${feature}-1`, feature, ordinal: 1, status: 'pending', attempts: 1, errorCode: null }, { x_posts: 0, linkedin_posts: 0, [feature]: 1 }, AbortSignal.timeout(config.stageTimeoutMilliseconds), async value => { metadata = value; }, { actualDurationSeconds: entry.durationSeconds });
        metadata = generated;
        usage = generated.usage;
        output = generated.value;
        outcome = 'ok';
      } catch (error) {
        errorCode = error instanceof GenerationError ? error.code : 'evaluation_request_failed';
        outcome = errorCode === 'insufficient_source' ? 'insufficient_source' : 'error';
        if (error instanceof GenerationError) {
          usage = error.usage;
          metadata.model = error.model ?? metadata.model;
          validation = safeValidationIssue(Object.getOwnPropertyDescriptor(error, 'validation')?.value) ?? null;
        }
      }
      const segments = feature === 'short_videos' && outcome === 'ok' ? (output as ShortVideoContent).segments : null;
      const selectedSpeech = segments ? entry.transcript.words
        .filter(word => segments.some(segment => word.start >= segment.startSeconds && word.end <= segment.endSeconds))
        .map(word => word.text).join(' ') : null;
      results.push({
        case: entry.id, feature, expected: entry.expected, outcome, errorCode, validation,
        elapsedMilliseconds: Math.round(performance.now() - started),
        provider: metadata.provider, model: metadata.model, promptVersion: metadata.promptVersion ?? null, usage, output,
        ...(selectedSpeech !== null ? { selectedSpeech } : {}),
        deterministicChecks: {
          expectedOutcome: outcome === entry.expected,
          forbiddenMarkersAbsent: output === null ? null : !(entry.forbidden ?? []).some(marker => (selectedSpeech ?? JSON.stringify(output)).includes(marker)),
        },
        humanReview: { status: 'pending', criteria: entry.review },
      });
    }
    const report = { dryRun: false, corpusVersion, createdAt: new Date().toISOString(), configuredModel: config.textModel, requestCount: jobs.length, results };
    await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally { await reportFile.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseEvaluationArgs(process.argv.slice(2));
    const report = await runEvaluation(options);
    console.log(options.paid ? `Evaluation recorded ${report.requestCount} requests. Human review is still required.` : JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Evaluation failed.');
    process.exitCode = 1;
  }
}
