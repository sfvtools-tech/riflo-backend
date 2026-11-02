import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { evaluationCases } from '../../evals/generation/cases.js';
import { parseEvaluationArgs, runEvaluation, selectEvaluationJobs } from '../../evals/generation/run.js';
import { generationFeatures } from '../../src/generation/service.js';
import { shortVideoBoundaries, validateTranscript } from '../../src/generation/validation.js';

const env = { ANTHROPIC_API_KEY: 'private-evaluation-test-key', ANTHROPIC_TEXT_MODEL: 'test-model' };

async function withReport(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'riflo-evaluation-test-'));
  try { await run(join(directory, 'report.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function response(output: unknown, raw = false) {
  return Response.json({ id: 'eval-response', type: 'message', role: 'assistant', model: 'resolved-evaluation-model', content: [{ type: 'text', text: raw ? output : JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
}

test('evaluation fixtures cover six formats and retain valid timestamps including exact duration edges', () => {
  assert.equal(new Set(evaluationCases.map(entry => entry.id)).size, evaluationCases.length);
  assert.deepEqual([...new Set(evaluationCases.flatMap(entry => entry.features))].sort(), [...generationFeatures].sort());
  for (const entry of evaluationCases) assert.deepEqual(validateTranscript(entry.transcript, entry.durationSeconds), entry.transcript);
  assert.equal(evaluationCases.find(entry => entry.id === 'exact-ten-seconds')!.durationSeconds, 10);
  assert.ok(evaluationCases.find(entry => entry.id === 'under-ten-seconds')!.durationSeconds < 10);
});

test('dry evaluation never reads credentials or invokes a provider', async () => {
  const options = parseEvaluationArgs(['--case', 'useful-source', '--feature', 'x_posts']);
  const forbiddenEnv = new Proxy({}, { get() { throw Error('Dry run accessed environment.'); } });
  const report = await runEvaluation(options, { env: forbiddenEnv, request: async () => { throw Error('Dry run made a request.'); } });
  assert.equal(report.dryRun, true);
  assert.equal(report.requestCount, 1);
  const cli = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'evals/generation/run.ts', '--case', 'useful-source', '--feature', 'x_posts'], { env: { ...process.env, ...env } });
  assert.equal(JSON.parse(cli.stdout).dryRun, true);
  assert.ok(!cli.stdout.includes(env.ANTHROPIC_API_KEY));
});

test('evaluation options reject invalid filters and require explicit paid output', () => {
  for (const args of [['--run-paid'], ['--case'], ['--feature', 'unknown'], ['--unknown'], ['--case', 'thin-source', '--case', 'useful-source'], ['--output', 'report.json']]) assert.throws(() => parseEvaluationArgs(args));
  assert.throws(() => selectEvaluationJobs({ paid: false, caseId: 'unknown' }));
  assert.throws(() => selectEvaluationJobs({ paid: false, caseId: 'exact-ten-seconds', feature: 'blogs' }));
});

test('mocked opt-in evaluation uses all real generation contracts and private non-overwriting reports', async () => {
  await withReport(async path => {
    const source = evaluationCases.find(entry => entry.id === 'useful-source')!;
    const boundaries = shortVideoBoundaries(source.transcript, source.durationSeconds);
    const clipEnd = boundaries.endSeconds.find(end => end >= 10 && end <= 60)!;
    const outputs = [
      { status: 'ok', text: 'A clear handoff needs an owner.' },
      { status: 'ok', text: 'A clear handoff needs an owner.' },
      { status: 'ok', title: 'Clear handoffs', bodyMarkdown: 'Assign an owner until the next person accepts the request.' },
      { status: 'ok', subject: 'Clear handoffs', previewText: 'Assign an owner.', bodyMarkdown: 'Keep one owner until the next person accepts the request.' },
      { status: 'ok', slides: Array.from({ length: 5 }, (_, index) => ({ title: `Step ${index + 1}`, body: 'Keep one owner for each handoff.' })) },
      { status: 'ok', segments: [{ startSeconds: 0, endSeconds: clipEnd }] },
    ];
    let calls = 0;
    await runEvaluation({ paid: true, caseId: 'useful-source', output: path }, { env, request: async () => response(outputs[calls++]) });
    const report = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(calls, 6);
    assert.equal(report.requestCount, 6);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const result of report.results) {
      assert.equal(result.outcome, 'ok');
      assert.equal(result.model, 'resolved-evaluation-model');
      assert.ok(result.promptVersion);
      assert.equal(result.usage.inputTokens, 100);
      assert.equal(result.deterministicChecks.expectedOutcome, true);
      assert.equal(result.humanReview.status, 'pending');
      assert.ok(Number.isFinite(result.elapsedMilliseconds) && result.elapsedMilliseconds >= 0);
    }
    assert.ok(!(await readFile(path, 'utf8')).includes(env.ANTHROPIC_API_KEY));
    await assert.rejects(runEvaluation({ paid: true, caseId: 'useful-source', output: path }, { env, request: async () => { throw Error('Must not request when report already exists.'); } }), { code: 'EEXIST' });
    assert.equal(calls, 6);
  });
});

test('evaluation retains safe validation measurements beside failed model usage', async () => {
  await withReport(async path => {
    await runEvaluation({ paid: true, caseId: 'useful-source', feature: 'x_posts', output: path }, {
      env, request: async () => response({ status: 'ok', text: '界'.repeat(141) }),
    });
    const result = JSON.parse(await readFile(path, 'utf8')).results[0];
    assert.equal(result.outcome, 'error');
    assert.equal(result.errorCode, 'invalid_generated_output');
    assert.deepEqual(result.validation, { reason: 'character_limit', field: 'text', actual: 282, limit: 280 });
    assert.equal(result.usage.outputTokens, 40);
    assert.equal(result.model, 'resolved-evaluation-model');
    assert.equal(result.promptVersion, 'short-posts-v5+length-correction-v2');
    assert.equal(result.output, null);
    assert.equal(result.humanReview.status, 'pending');
  });
});

test('clip injection checks inspect selected speech rather than only timestamp JSON', async () => {
  const entry = evaluationCases.find(value => value.id === 'source-injection')!;
  const marker = entry.transcript.words.find(word => word.text.includes('EVAL_INJECTION_CANARY'))!;
  const boundaries = shortVideoBoundaries(entry.transcript, entry.durationSeconds);
  const startSeconds = boundaries.startSeconds.find(start => start <= marker.start)!;
  const endSeconds = boundaries.endSeconds.find(end => end >= marker.end && end - startSeconds >= 10 && end - startSeconds <= 60)!;
  assert.ok(Number.isFinite(startSeconds) && Number.isFinite(endSeconds));
  const segments = [{ startSeconds, endSeconds }];
  await withReport(async path => {
    await runEvaluation({ paid: true, caseId: entry.id, feature: 'short_videos', output: path }, {
      env, request: async () => response({ status: 'ok', segments }),
    });
    const result = JSON.parse(await readFile(path, 'utf8')).results[0];
    assert.equal(result.outcome, 'ok');
    assert.equal(result.deterministicChecks.expectedOutcome, true);
    assert.equal(JSON.stringify(result.output).includes('EVAL_INJECTION_CANARY'), false);
    assert.match(result.selectedSpeech, /EVAL_INJECTION_CANARY/);
    assert.equal(result.deterministicChecks.forbiddenMarkersAbsent, false);
    assert.equal(result.humanReview.status, 'pending');
  });
});

test('evaluation separates abstention, malformed provider output and visible forbidden markers from human review', async () => {
  for (const scenario of ['insufficient', 'malformed', 'injection'] as const) {
    await withReport(async path => {
      const output = scenario === 'insufficient' ? { status: 'insufficient_source', text: '' } : scenario === 'malformed' ? 'private-malformed-provider-body {' : { status: 'ok', text: 'EVAL_INJECTION_CANARY' };
      await runEvaluation({ paid: true, caseId: scenario === 'injection' ? 'source-injection' : 'thin-source', feature: 'x_posts', output: path }, { env, request: async () => response(output, scenario === 'malformed') });
      const raw = await readFile(path, 'utf8');
      const result = JSON.parse(raw).results[0];
      assert.equal(result.model, 'resolved-evaluation-model');
      assert.equal(result.promptVersion, 'short-posts-v5');
      assert.equal(result.humanReview.status, 'pending');
      if (scenario === 'insufficient') {
        assert.equal(result.outcome, 'insufficient_source');
        assert.equal(result.deterministicChecks.expectedOutcome, true);
      } else if (scenario === 'malformed') {
        assert.equal(result.outcome, 'error');
        assert.equal(result.deterministicChecks.expectedOutcome, false);
        assert.ok(!raw.includes('private-malformed-provider-body'));
      } else assert.equal(result.deterministicChecks.forbiddenMarkersAbsent, false);
    });
  }
});
