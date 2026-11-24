import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createLifecycleStore } from '../access/lifecycle-firestore.js';
import { isLifecycle, LifecycleError, resolveAccess, type LifecycleCommand } from '../access/lifecycle.js';
import { plans } from '../access/plans.js';
import { createId } from '../shared/id.js';

const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseRequest(value: unknown): { eventId: string; command: LifecycleCommand } {
  if (!object(value) || Object.keys(value).some(key => !['eventId', 'command'].includes(key)) || !identity(value.eventId) || !object(value.command)) {
    throw new Error('Provide an eventId and command in the request file.');
  }
  const command = value.command;
  const period = command.type === 'activate_paid' || command.type === 'renew';
  const keys = ['type', 'expectedRevision', ...(period ? ['plan', 'periodId', 'startsAt', 'expiresAt'] : [])];
  if (Object.keys(command).some(key => !keys.includes(key)) || !Number.isSafeInteger(command.expectedRevision) || (command.expectedRevision as number) < 0
    || !['activate_paid', 'renew', 'upgrade', 'cancel', 'downgrade', 'withdraw'].includes(command.type as string)) {
    throw new Error('Provide a supported lifecycle command and its expectedRevision.');
  }
  if (period && (typeof command.plan !== 'string' || !Object.hasOwn(plans, command.plan) || !identity(command.periodId)
    || !date(command.startsAt) || !date(command.expiresAt)
    || Date.parse(command.expiresAt) <= Date.parse(command.startsAt))) {
    throw new Error('Provide a plan, a new periodId, and ordered start/end dates.');
  }
  return { eventId: value.eventId, command: command as LifecycleCommand };
}

export function expiry(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  if (!date(normalized)) throw new Error('Use YYYY-MM-DD (midnight UTC at the start of that day) or a UTC ISO timestamp for --until.');
  return new Date(normalized).toISOString();
}

export function planRequest(value: unknown, plan: keyof typeof plans, until: string, now = Date.now()): ReturnType<typeof parseRequest> | null {
  if (value != null && !isLifecycle(value)) throw new Error('Existing manual access requires explicit migration; it was not overwritten.');
  if (value?.withdrawn) throw new Error('Access was explicitly withdrawn; ordinary plan assignment cannot undo it.');
  if (Date.parse(until) <= now) throw new Error('--until must be in the future.');
  const expectedRevision = value?.revision ?? 0;
  const paid = value?.paid;
  let command: LifecycleCommand;
  if (paid && Date.parse(paid.grant.expiresAt) > now) {
    if (paid.cancelAtPeriodEnd) throw new LifecycleError(409, 'lifecycle_conflict', 'The active paid period is cancelled. Use --request with a new eventId and the current expectedRevision for an intentional change.');
    if (Date.parse(paid.grant.startsAt) > now) throw new Error('A paid period is already scheduled.');
    if (Date.parse(paid.grant.expiresAt) !== Date.parse(until)) throw new Error('An active plan change must keep the current expiry; it cannot extend or reset the allowance period.');
    if ((paid.nextPlan ?? paid.plan) === plan) return null;
    if (paid.nextPlan) throw new LifecycleError(409, 'lifecycle_conflict', 'A downgrade is already scheduled. Reversing it is not supported; keep the scheduled plan or assign higher after this period expires.');
    command = { type: plan === 'higher' ? 'upgrade' : 'downgrade', expectedRevision };
  } else {
    command = { type: 'activate_paid', plan, expectedRevision, periodId: createId(), startsAt: new Date(now).toISOString(), expiresAt: until };
  }
  return { eventId: createId(), command };
}

export async function main(args: string[]) {
  const { values } = parseArgs({ args, options: { project: { type: 'string' }, uid: { type: 'string' }, request: { type: 'string' }, plan: { type: 'string' }, until: { type: 'string' } }, strict: true, allowPositionals: false });
  if (!values.project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(values.project) || !values.uid || values.uid.length > 128 || values.uid.includes('/') || values.uid === '.' || values.uid === '..') {
    throw new Error('Usage: access:admin -- --project <Firebase project ID> --uid <Firebase UID> [--plan lower|higher --until <UTC expiry> | --request <JSON file>]');
  }
  if ([values.request, values.plan, values.until].some(value => value === '') || values.request && (values.plan || values.until) || !!values.plan !== !!values.until || values.plan && !Object.hasOwn(plans, values.plan)) {
    throw new Error('Provide --plan lower|higher with --until, or --request, not both.');
  }
  const until = values.until ? expiry(values.until) : undefined;
  let request = values.request ? parseRequest(JSON.parse(await readFile(values.request, 'utf8'))) : undefined;
  // Keep Auth and Firestore on the same target when testing locally.
  if (!!process.env.FIRESTORE_EMULATOR_HOST !== !!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Set both Auth and Firestore emulator hosts, or neither.');
  console.error(`Target: project=${values.project} uid=${values.uid} ${process.env.FIRESTORE_EMULATOR_HOST ? `emulators firestore=${process.env.FIRESTORE_EMULATOR_HOST} auth=${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : 'LIVE Firebase'}`);
  const app = initializeApp({ projectId: values.project });
  const db = getFirestore(app);
  try {
    await getAuth(app).getUser(values.uid);
    const store = createLifecycleStore(db);
    if (values.plan && until) request = planRequest(await store.get(values.uid), values.plan as keyof typeof plans, until) ?? undefined;
    if (request) await store.transition(values.uid, request.eventId, request.command);
    // A replay can return an older receipt; always show the account's current state.
    const record = await store.get(values.uid);
    if (record !== null && !isLifecycle(record)) throw new Error('Existing access requires explicit migration; it was not overwritten.');
    console.log(JSON.stringify({ project: values.project, uid: values.uid, revision: record?.revision ?? 0, lifecycle: resolveAccess(record, Date.now()).lifecycle, ...(request ? { eventId: request.eventId } : {}) }, null, 2));
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof LifecycleError ? `${error.code}: ${error.message}` : error instanceof SyntaxError ? 'The request file must contain valid JSON.' : error instanceof Error ? error.message : 'Account access operation failed.');
    process.exitCode = 1;
  });
}
