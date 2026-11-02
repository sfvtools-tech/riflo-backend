import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const { scripts } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

// Exercise the actual dev command with inert replacements: no .env or application imports.
for (const scenario of ['SIGINT', 'api', 'worker', 'clean-exit', 'stubborn'] as const) {
  test(`combined dev starts both and stops both on ${scenario}`, { timeout: 20_000, skip: process.platform === 'win32' }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'riflo-dev-test-'));
    const pids: number[] = [];
    let output = '';
    await symlink(new URL('node_modules', root), join(cwd, 'node_modules'), 'dir');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({
      private: true,
      scripts: { dev: scripts.dev.replace(scripts['dev:api'], 'node fixture.cjs api').replace(scripts['dev:worker'], 'node fixture.cjs worker') },
    }));
    await writeFile(join(cwd, 'fixture.cjs'), `
      const { existsSync } = require('node:fs');
      const name = process.argv[2];
      if (${scenario === 'stubborn'} && name === 'worker') process.on('SIGTERM', () => {});
      console.log('READY ' + name + ' ' + process.pid);
      setInterval(() => {
        if (existsSync('exit-' + name)) process.exit(${scenario === 'clean-exit' ? 0 : 7});
      }, 25);
    `);
    const child = spawn('npm', ['run', 'dev'], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        NPM_CONFIG_USERCONFIG: join(cwd, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(cwd, 'global.npmrc'),
        NPM_CONFIG_CACHE: join(cwd, 'cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false', NO_COLOR: '1',
      },
    });
    let finished = false;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => { finished = true; resolve(code); });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
    try {
      const deadline = Date.now() + 10_000;
      while (!/\[api\] READY api \d+/.test(output) || !/\[worker\] READY worker \d+/.test(output)) {
        assert.ok(Date.now() < deadline, `Both fixtures must start:\n${output}`);
        await delay(25);
      }
      pids.push(...[...output.matchAll(/READY (?:api|worker) (\d+)/g)].map((match) => Number(match[1])));
      if (scenario === 'SIGINT') process.kill(-child.pid!, 'SIGINT');
      else await writeFile(join(cwd, `exit-${scenario === 'clean-exit' || scenario === 'stubborn' ? 'api' : scenario}`), '');
      const shutdownDeadline = Date.now() + 8_000;
      while (!finished) {
        assert.ok(Date.now() < shutdownDeadline, `Dev supervisor must stop:\n${output}`);
        await delay(25);
      }
      const exitCode = await closed;
      if (scenario !== 'SIGINT') assert.notEqual(exitCode, 0, output);
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Fixture ${pid} must stop:\n${output}`);
      }
    } finally {
      // Only this test's detached process group, never an existing developer process.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('dev watchers reload imported code, inherit trace flags, release ports and stop old children', { timeout: 35_000, skip: process.platform === 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'riflo-watch-test-'));
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  const entries: { name: string; pid: number; version: number }[] = [];
  let output = '';
  let exited = false;
  await symlink(new URL('node_modules', root), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, '.env'), 'WATCH_FIXTURE=loaded\n');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: {
      dev: scripts.dev.replace('src/server.ts', 'api.ts').replace('src/worker.ts', 'worker.ts'),
      'dev:api': scripts['dev:api'].replace('src/server.ts', 'api.ts'),
      'dev:worker': scripts['dev:worker'].replace('src/worker.ts', 'worker.ts'),
    },
  }));
  for (const name of ['api', 'worker']) {
    await writeFile(join(cwd, `${name}-version.ts`), 'export const version: number = 1;\n');
    await writeFile(join(cwd, `${name}.ts`), `
      import { createServer } from 'node:net';
      import { existsSync } from 'node:fs';
      import { version } from './${name}-version.js';
      const name = '${name}';
      const timer = setInterval(() => {}, 1000);
      const server = name === 'api' ? createServer().listen(${port}, '127.0.0.1', ready) : undefined;
      if (!server) ready();
      function ready() {
        console.log('WATCH_READY ' + JSON.stringify({ name, pid: process.pid, version,
          trace: process.env.RIFLO_WORKER_TRACE, envFile: process.env.WATCH_FIXTURE }));
      }
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        if (name === 'worker' && existsSync('stubborn-worker')) return;
        clearInterval(timer);
        server?.close();
      });
    `);
  }
  const child = spawn('npm', ['run', 'dev'], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, RIFLO_WORKER_TRACE: '1',
      NPM_CONFIG_USERCONFIG: join(cwd, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(cwd, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(cwd, 'cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false', NO_COLOR: '1',
    },
  });
  child.once('close', () => { exited = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
  const refreshEntries = () => {
    entries.splice(0, entries.length, ...[...output.matchAll(/WATCH_READY (\{[^\n]+\})/g)].map((match) => {
      const entry = JSON.parse(match[1]);
      assert.equal(entry.trace, '1');
      assert.equal(entry.envFile, 'loaded');
      return entry;
    }));
  };
  const waitFor = async (condition: () => boolean, onWaiting?: () => Promise<void>) => {
    const deadline = Date.now() + 12_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, output);
      await onWaiting?.();
      await delay(onWaiting ? 250 : 25);
      refreshEntries();
    }
  };
  try {
    await waitFor(() => entries.length === 2);
    const firstApi = entries.find((entry) => entry.name === 'api')!;
    const firstWorker = entries.find((entry) => entry.name === 'worker')!;
    // tsx registers imported-file watchers asynchronously after the child starts.
    // Observe a real reload rather than treating child READY as watcher readiness.
    await waitFor(() => entries.some((entry) => entry.name === 'api' && entry.version === 2),
      () => writeFile(join(cwd, 'api-version.ts'), 'export const version: number = 2;\n'));
    assert.equal(entries.filter((entry) => entry.name === 'worker').length, 1, output);
    assert.throws(() => process.kill(firstApi.pid, 0), { code: 'ESRCH' });
    await writeFile(join(cwd, 'stubborn-worker'), '');
    await writeFile(join(cwd, 'worker-version.ts'), 'export const version: number = 2;\n');
    await waitFor(() => entries.some((entry) => entry.name === 'worker' && entry.version === 2));
    assert.throws(() => process.kill(firstWorker.pid, 0), { code: 'ESRCH' });
    await rm(join(cwd, 'stubborn-worker'));
    process.kill(-child.pid!, 'SIGINT');
    await waitFor(() => exited);
    for (const { pid } of entries) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, output);
    await new Promise<void>((resolve, reject) => portProbe.once('error', reject).listen(port, '127.0.0.1', () => portProbe.close(() => resolve())));
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
