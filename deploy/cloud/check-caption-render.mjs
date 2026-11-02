#!/usr/bin/env node
// Probe the target release's real Sharp/Pango caption path before stopping services.
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = process.argv[2];
if (!release) throw new Error('Usage: check-caption-render.mjs RELEASE_DIRECTORY');
const { prepareCaptions } = await import(pathToFileURL(join(resolve(release), 'dist/generation/captions.js')));
const fixtures = JSON.parse(await readFile(new URL('./caption-font-fixtures.json', import.meta.url), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'riflo-font-gate-'));
try {
  for (const [name, text] of Object.entries(fixtures)) {
    const destination = join(directory, name);
    await mkdir(destination);
    // One ASR token exercises grapheme wrapping even for scripts without spaces.
    const result = await prepareCaptions({ status: 'ok', segments: [{ startSeconds: 0, endSeconds: 5 }] },
      { text, words: [{ text, start: 0, end: 4 }] }, destination, AbortSignal.timeout(30_000));
    if (!result.cues.length) throw new Error(`No captions for ${name}`);
    console.log(`Caption raster OK: ${name} (${result.cues.length} cues)`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
