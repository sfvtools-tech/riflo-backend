import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { startSourceProcess } from '../../src/sources/process.js';

const start = (script: string, options: { signal?: AbortSignal; timeoutMilliseconds?: number; maxOutputBytes?: number } = {}) => startSourceProcess({
  executable: process.execPath, args: ['-e', script], nodePath: process.execPath,
  ffmpegPath: process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg', timeoutMilliseconds: 2000, ...options,
});

test('source subprocesses receive a private working home and no inherited credentials or proxy options', async () => {
  const previous = process.env.RIFLO_TEST_PRIVATE_SECRET;
  process.env.RIFLO_TEST_PRIVATE_SECRET = 'do-not-inherit';
  try {
    const download = await start('process.stdout.write(JSON.stringify({home:process.env.HOME,cwd:process.cwd(),secret:process.env.RIFLO_TEST_PRIVATE_SECRET,google:process.env.GOOGLE_APPLICATION_CREDENTIALS,proxy:process.env.HTTPS_PROXY,nodeOptions:process.env.NODE_OPTIONS}));');
    const metadata = JSON.parse(await new Response(download.body).text());
    await download.finished;
    assert.equal(metadata.secret, undefined);
    assert.equal(metadata.google, undefined);
    assert.equal(metadata.proxy, undefined);
    assert.equal(metadata.nodeOptions, undefined);
    assert.equal(typeof metadata.home, 'string');
    assert.notEqual(metadata.home, process.env.HOME);
    await download.cleanup();
    await assert.rejects(access(metadata.home));
  } finally {
    if (previous === undefined) delete process.env.RIFLO_TEST_PRIVATE_SECRET;
    else process.env.RIFLO_TEST_PRIVATE_SECRET = previous;
  }
});

test('media stdout is not proof of successful subprocess completion and stderr stays private', async () => {
  const download = await start('process.stdout.write("partial-media");process.stderr.write("private-downloader-details");process.exitCode=7;');
  try {
    const reads = Promise.allSettled([new Response(download.body).text(), download.finished]);
    const results = await reads;
    assert.equal(results[1]!.status, 'rejected');
    if (results[1]!.status === 'rejected') assert.ok(!String(results[1]!.reason).includes('private-downloader-details'));
  } finally { await download.cleanup(); }
});

test('source process output limits reject oversized metadata and deadlines stop hanging children', async () => {
  for (const options of [
    { script: 'process.stdout.write("x".repeat(100));', maxOutputBytes: 16, timeoutMilliseconds: 2000 },
    { script: 'setInterval(()=>{},1000);', maxOutputBytes: undefined, timeoutMilliseconds: 40 },
    { script: 'process.stderr.write("x".repeat(70000));setInterval(()=>{},1000);', maxOutputBytes: undefined, timeoutMilliseconds: 2000 },
  ]) {
    const download = await start(options.script, options);
    try {
      const results = await Promise.allSettled([new Response(download.body).arrayBuffer(), download.finished]);
      assert.equal(results[1]!.status, 'rejected');
    } finally { await download.cleanup(); }
  }
});

test('unavailable executables and invalid command configuration fail safely', async () => {
  await assert.rejects(startSourceProcess({ executable: 'relative-tool', args: [], nodePath: process.execPath, ffmpegPath: '/not-invoked', timeoutMilliseconds: 1000 }), { code: 'source_process_configuration' });
  const download = await startSourceProcess({ executable: '/missing-private-tool-path', args: [], nodePath: process.execPath, ffmpegPath: '/not-invoked', timeoutMilliseconds: 1000 });
  try {
    await assert.rejects(download.finished, (error: unknown) => {
      assert.equal((error as { code: string }).code, 'source_process_unavailable');
      assert.ok(!String(error).includes('missing-private-tool-path'));
      return true;
    });
  } finally { await download.cleanup(); }
});

test('cancelling a source process terminates its child group, including a parent that ignores termination', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  const download = await start('const {spawn}=require("node:child_process");process.on("SIGTERM",()=>{});const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.on("spawn",()=>process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})+"\\n"));setInterval(()=>{},1000);', { signal: controller.signal, timeoutMilliseconds: 5000 });
  const reader = download.body.getReader();
  try {
    const first = await reader.read();
    const pids = JSON.parse(Buffer.from(first.value!).toString()) as { parent: number; child: number };
    controller.abort();
    await assert.rejects(download.finished);
    await download.cleanup();
    for (const pid of [pids.parent, pids.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await reader.cancel().catch(() => undefined);
    await download.cleanup();
  }
});
