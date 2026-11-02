import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { SourceDownload } from './source.js';

export class SourceProcessError extends Error {
  constructor(public code: string, public reason: 'unavailable' | 'restricted' | 'challenge' | null = null) { super(code); }
}
export type SourceProcessOptions = {
  executable: string; args: string[]; nodePath: string; ffmpegPath: string;
  signal?: AbortSignal; timeoutMilliseconds: number; maxOutputBytes?: number;
};

export async function startSourceProcess(options: SourceProcessOptions): Promise<SourceDownload> {
  if (process.platform === 'win32' || ![options.executable, options.nodePath, options.ffmpegPath].every(isAbsolute) || !Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds <= 0 || (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0))) {
    throw new SourceProcessError('source_process_configuration');
  }
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'riflo-source-tool-'));
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(options.executable, options.args, {
      cwd: directory, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: [...new Set([dirname(options.nodePath), dirname(options.ffmpegPath), '/usr/bin', '/bin'])].join(':'),
        HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', TZ: 'UTC', PYTHONSAFEPATH: '1',
      },
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new SourceProcessError('source_process_configuration');
  }
  let failure: SourceProcessError | undefined;
  let closed = false;
  let stderr = '';
  let stderrBytes = 0;
  let outputBytes = 0;
  let force: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  void finished.catch(() => undefined);
  function kill(signal: NodeJS.Signals) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* The group may already have exited. */ }
  }
  const stop = (error: SourceProcessError) => {
    failure ??= error;
    kill('SIGTERM');
    force ??= setTimeout(() => kill('SIGKILL'), 500);
  };
  const abort = () => stop(new SourceProcessError('source_process_interrupted'));
  const output = new Transform({ transform(chunk: Buffer, _encoding, done) {
    outputBytes += chunk.length;
    if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
      const error = new SourceProcessError('source_process_output_limit');
      stop(error); done(error); return;
    }
    done(null, chunk);
  } });
  child.stdout.pipe(output);
  child.stdout.on('error', () => stop(new SourceProcessError('source_process_failed')));
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) { stop(new SourceProcessError('source_process_output_limit')); return; }
    stderr += chunk.toString('utf8');
  });
  child.on('error', () => { failure ??= new SourceProcessError('source_process_unavailable'); });
  child.on('close', (code) => {
    closed = true;
    clearTimeout(deadline); clearTimeout(force);
    options.signal?.removeEventListener('abort', abort);
    if (!failure && /No supported JavaScript runtime|No usable challenge solver.*script|challenge solver script distribution.*(?:missing|not installed)/i.test(stderr)) {
      failure = new SourceProcessError('source_process_configuration');
    }
    if (!failure && code !== 0) {
      const reason = /bot|captcha|challenge/i.test(stderr) ? 'challenge'
        : /sign.?in|age.restrict|members.only|premium|login|required authentication/i.test(stderr) ? 'restricted'
        : /private|unavailable|removed|not available|404/i.test(stderr) ? 'unavailable' : null;
      failure = new SourceProcessError('source_process_failed', reason);
    }
    if (failure) rejectFinished(failure); else resolveFinished();
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  deadline = setTimeout(() => stop(new SourceProcessError('source_process_timeout')), options.timeoutMilliseconds);
  let cleaning: Promise<void> | undefined;
  return {
    body: Readable.toWeb(output) as ReadableStream<Uint8Array>, finished,
    cleanup() {
      return cleaning ??= (async () => {
        if (!closed) stop(new SourceProcessError('source_process_interrupted'));
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([finished.catch(() => undefined), new Promise<void>(resolve => { wait = setTimeout(resolve, 1500); })]);
        clearTimeout(wait); clearTimeout(deadline);
        // Descendants can outlive their parent; terminate the group before deleting scratch files.
        kill('SIGKILL'); clearTimeout(force);
        child.stdout.unpipe(output); child.stdout.destroy(); child.stderr.destroy(); output.destroy();
        options.signal?.removeEventListener('abort', abort);
        await rm(directory, { recursive: true, force: true });
      })();
    },
  };
}
