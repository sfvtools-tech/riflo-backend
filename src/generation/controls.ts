import type { Firestore } from 'firebase-admin/firestore';
import { ProjectError } from '../projects/service.js';
import type { GenerationFeature, Selection } from './service.js';

// All advertised controls are enforced by provider, validation and rendering.
export const generationControlsAvailable = true;
export const controlsBodyLimit = 12_000;
export type Length = 'auto' | 'short' | 'medium' | 'long';
export type FormatControls = {
  x_posts: { length?: 'auto' | 'short' | 'standard'; mode?: 'single' | 'thread'; maxPosts?: number; numbering?: 'include' | 'exclude' };
  linkedin_posts: { length?: Length };
  blogs: { length?: Length };
  newsletters: { length?: Length };
  carousels: { density?: 'auto' | 'standard' | 'light'; theme?: 'auto' | 'dark' | 'light' };
  short_videos: { duration?: 'auto' | 15 | 30 | 45 | 60; editing?: 'auto' | 'continuous'; captions?: 'clean' | 'off' };
};
export type GenerationDefaults = Partial<FormatControls>;
export type GenerationControls = { focus?: string; sourceWindow?: { startSeconds: number; endSeconds: number }; formats?: GenerationDefaults };
export type ControlsSnapshot = GenerationControls & {
  version: 1;
  status: 'resolved' | 'unavailable';
  formats: GenerationDefaults;
  origins: Partial<Record<GenerationFeature, Record<string, 'explicit' | 'saved' | 'builtin'>>>;
};
export type ControlsContext = { request: GenerationControls; snapshot: ControlsSnapshot };
export type ControlsAvailability = {
  version: 1; available: boolean; threadAvailable: boolean; choices: typeof controlChoices; focusMaxCharacters: number;
  defaults: GenerationDefaults; builtins: GenerationDefaults; defaultsStatus: 'resolved' | 'unavailable';
};
export const controlChoices = {
  x_posts: { length: ['auto', 'short', 'standard'], mode: ['single', 'thread'], maxPosts: [2, 3, 4, 5, 6, 7, 8, 9, 10], numbering: ['include', 'exclude'] },
  linkedin_posts: { length: ['auto', 'short', 'medium', 'long'] },
  blogs: { length: ['auto', 'short', 'medium', 'long'] },
  newsletters: { length: ['auto', 'short', 'medium', 'long'] },
  carousels: { density: ['auto', 'standard', 'light'], theme: ['auto', 'dark', 'light'] },
  short_videos: { duration: ['auto', 15, 30, 45, 60], editing: ['auto', 'continuous'], captions: ['clean', 'off'] },
} as const;
export const builtinControls: GenerationDefaults = {
  x_posts: { length: 'auto', mode: 'single' }, linkedin_posts: { length: 'auto' },
  blogs: { length: 'auto' }, newsletters: { length: 'auto' },
  carousels: { density: 'auto', theme: 'auto' },
  short_videos: { duration: 'auto', editing: 'auto', captions: 'off' },
};
function invalid(message = 'Choose supported generation controls.'): never {
  throw new ProjectError(400, 'invalid_generation_controls', message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function parseGenerationDefaults(value: unknown): GenerationDefaults {
  const input = object(value);
  if (Object.keys(input).some(key => !Object.hasOwn(controlChoices, key))) invalid();
  const result: Record<string, Record<string, unknown>> = {};
  // Stable field order is part of normalized request fingerprinting.
  for (const feature of Object.keys(controlChoices) as GenerationFeature[]) {
    if (!Object.hasOwn(input, feature)) continue;
    const supplied = object(input[feature]);
    const choices = controlChoices[feature] as Record<string, readonly unknown[]>;
    if (Object.keys(supplied).some(key => !Object.hasOwn(choices, key))) invalid();
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(choices)) {
      if (!Object.hasOwn(supplied, key)) continue;
      if (!choices[key]!.includes(supplied[key])) invalid();
      fields[key] = supplied[key];
    }
    if (Object.keys(fields).length) result[feature] = fields;
  }
  return result as GenerationDefaults;
}
export function parseGenerationControls(value: unknown, selection: Selection): GenerationControls {
  if (value === undefined) return {};
  const input = object(value);
  if (Object.keys(input).some(key => !['focus', 'sourceWindow', 'formats'].includes(key))) invalid();
  const result: GenerationControls = {};
  if (Object.hasOwn(input, 'focus')) {
    if (typeof input.focus !== 'string' || input.focus.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.focus)) {
      invalid('Focus must be at most 500 characters.');
    }
    if (input.focus.trim()) result.focus = input.focus.trim();
  }
  if (Object.hasOwn(input, 'sourceWindow')) {
    const window = object(input.sourceWindow);
    if (Object.keys(window).length !== 2 ||
        typeof window.startSeconds !== 'number' || typeof window.endSeconds !== 'number' ||
        !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) ||
        window.startSeconds < 0 || window.endSeconds <= window.startSeconds) {
      invalid('Choose a finite, ordered source window.');
    }
    if ((selection.short_videos ?? 0) > 0 && window.endSeconds - window.startSeconds < 10) {
      invalid('A video source window must span at least ten seconds.');
    }
    result.sourceWindow = { startSeconds: window.startSeconds, endSeconds: window.endSeconds };
  }
  if (Object.hasOwn(input, 'formats')) {
    const formats = object(input.formats);
    if (Object.keys(formats).some(feature => !(selection[feature as GenerationFeature] ?? 0))) invalid('Only customize selected formats.');
    const parsed = parseGenerationDefaults(formats);
    if (Object.keys(parsed).length) result.formats = parsed;
  }
  return result;
}
export function validateControlsWindow(controls: GenerationControls, duration: number | null | undefined) {
  if (controls.sourceWindow && (!Number.isFinite(duration) || controls.sourceWindow.endSeconds > duration!)) invalid('The source window must fit within the original video.');
}
export async function readGenerationDefaults(uid: string, read?: GenerationDefaultsService['get']): Promise<{ status: 'resolved' | 'unavailable'; defaults: GenerationDefaults }> {
  try { return { status: 'resolved' as const, defaults: read ? await read(uid) ?? {} : {} }; }
  catch { return { status: 'unavailable' as const, defaults: {} }; }
}
export function resolveGenerationControls(request: GenerationControls, selection: Selection, saved: Awaited<ReturnType<typeof readGenerationDefaults>>): ControlsSnapshot {
  const formats: Record<string, Record<string, unknown>> = {};
  const origins: ControlsSnapshot['origins'] = {};
  for (const feature of Object.keys(controlChoices) as GenerationFeature[]) {
    if (!(selection[feature] ?? 0)) continue;
    const explicit = request.formats?.[feature] as Record<string, unknown> | undefined;
    const defaults = saved.defaults[feature] as Record<string, unknown> | undefined;
    const builtin = builtinControls[feature] as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    const fieldOrigins: Record<string, 'explicit' | 'saved' | 'builtin'> = {};
    for (const key of Object.keys(controlChoices[feature])) {
      let origin: 'explicit' | 'saved' | 'builtin' = 'builtin';
      let value = builtin[key];
      if (explicit && Object.hasOwn(explicit, key)) {
        origin = 'explicit';
        value = explicit[key];
      } else if (defaults && Object.hasOwn(defaults, key)) {
        origin = 'saved';
        value = defaults[key];
      }
      if (value !== undefined) {
        fields[key] = value;
        fieldOrigins[key] = origin;
      }
    }
    if (feature === 'x_posts' && fields.mode === 'thread' && (fields.maxPosts === undefined || fields.numbering === undefined)) {
      invalid('Choose the maximum posts and numbering before generating a thread.');
    }
    formats[feature] = fields;
    origins[feature] = fieldOrigins;
  }
  return { version: 1, status: saved.status, ...(request.focus ? { focus: request.focus } : {}), ...(request.sourceWindow ? { sourceWindow: { ...request.sourceWindow } } : {}), formats: formats as GenerationDefaults, origins };
}
export function createGenerationDefaultsService(store: { read(uid: string): Promise<unknown>; save(uid: string, defaults: GenerationDefaults): Promise<void> }) {
  return {
    async get(uid: string): Promise<GenerationDefaults | null> {
      const saved = await store.read(uid);
      if (saved === null || saved === undefined) return null;
      try { return parseGenerationDefaults(saved); }
      catch { throw new ProjectError(503, 'generation_defaults_unavailable', 'Generation defaults are temporarily unavailable.'); }
    },
    async replace(uid: string, input: unknown) {
      const defaults = parseGenerationDefaults(input);
      await store.save(uid, defaults);
      return defaults;
    },
  };
}
export type GenerationDefaultsService = ReturnType<typeof createGenerationDefaultsService>;
export function createGenerationDefaultsStore(db: Firestore) {
  const ref = (uid: string) => db.collection('accounts').doc(uid).collection('settings').doc('generation');
  return {
    read: async (uid: string) => (await ref(uid).get()).data() ?? null,
    save: async (uid: string, defaults: GenerationDefaults) => { await ref(uid).set(defaults); },
  };
}
