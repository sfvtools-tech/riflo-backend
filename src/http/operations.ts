import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Firestore } from 'firebase-admin/firestore';
import { ProjectError, type Project, type ImportProgress } from '../projects/service.js';
import type { GenerationBatch } from '../generation/service.js';

export type Operation = { projectId: string; kind: 'import' | 'generation'; id: string };
export type Notice = { transcriptionStage?: GenerationBatch['transcriptionStage']; transcriptReady?: boolean; preparation?: Project['preparation']; importAttempt?: number; importUpdatedAt?: number; importProgress?: ImportProgress; status: string; terminal: boolean; outcome?: 'succeeded' | 'partial' | 'failed' | 'superseded'; ready?: number; failed?: number };
export type OperationObserver = {
  check: (uid: string, operation: Operation) => Promise<void>;
  subscribe: (uid: string, operation: Operation, changed: (notice: Notice) => void, failed: (error: unknown) => void) => () => void;
};

function notice(operation: Operation, value: Project | GenerationBatch | undefined): Notice {
  if (!value || value.status === 'deleted' || (operation.kind === 'import' ? (value as Project).importOperationId : (value as GenerationBatch).id ?? 'batch') !== operation.id) return { status: 'superseded', terminal: true, outcome: 'superseded' };
  const status = value.status;
  const terminal = operation.kind === 'import' ? !['queued', 'importing'].includes(status) : ['completed', 'partial', 'failed'].includes(status);
  const slots = 'slots' in value ? value.slots : undefined;
  return { status, terminal, ...('slots' in value ? { ...(typeof value.transcriptReady === 'boolean' ? { transcriptReady: value.transcriptReady } : {}), ...(value.status === 'transcribing' && value.transcriptionStage ? { transcriptionStage: value.transcriptionStage } : {}) } : value.preparation === 'transcribing' && value.transcriptionStage ? { transcriptionStage: value.transcriptionStage } : {}), ...(operation.kind === 'import' ? { ...((value as Project).preparation ? { preparation: (value as Project).preparation } : {}), importAttempt: (value as Project).attempts, importUpdatedAt: value.updatedAt } : {}), ...(operation.kind === 'import' && status === 'importing' && (value as Project).importProgress ? { importProgress: (value as Project).importProgress } : {}), ...(terminal ? { outcome: status === 'failed' ? 'failed' as const : status === 'partial' ? 'partial' as const : 'succeeded' as const } : {}), ...(slots ? { ready: slots.filter(slot => slot.status === 'ready').length, failed: slots.filter(slot => slot.status === 'failed').length } : {}) };
}

export function firestoreOperations(db: Firestore): OperationObserver {
  const project = (uid: string, id: string) => db.collection('accounts').doc(uid).collection('projects').doc(id);
  return {
    async check(uid, operation) {
      const ref = project(uid, operation.projectId);
      const saved = (await ref.get()).data() as Project | undefined;
      if (!saved || saved.status === 'deleted') throw new ProjectError(404, 'project_not_found', 'Project not found.');
      if (operation.kind === 'import') {
        if (saved.importOperationId === operation.id) return;
        const account = db.collection('accounts').doc(uid);
        const keys = await Promise.all(['intakeKeys', 'importRetryKeys', 'sourceRestoreKeys'].map(name => account.collection(name).where('importOperationId', '==', operation.id).limit(1).get()));
        if (keys.some(result => result.docs.some(doc => doc.data().projectId === operation.projectId))) return;
      } else {
        const batch = (await ref.collection('generation').doc('batch').get()).data();
        if (batch && (batch.id ?? 'batch') === operation.id) return;
        if ((await ref.collection('generation').doc(`history-${operation.id}`).get()).exists) return;
      }
      throw new ProjectError(404, 'operation_not_found', 'Operation not found.');
    },
    subscribe(uid, operation, changed, failed) {
      const ref = project(uid, operation.projectId);
      const target = operation.kind === 'import' ? ref : ref.collection('generation').doc('batch');
      return target.onSnapshot(snapshot => changed(notice(operation, snapshot.data() as Project | GenerationBatch | undefined)), failed);
    },
  };
}

const streamHeaders = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' };

/** An accepted replay stays recoverable even when no observer slot is available. */
export function acknowledgeOperation(response: ServerResponse, operation: Operation, code: string) {
  response.writeHead(200, streamHeaders);
  const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ version: 1, operation, ...data })}\n\n`;
  response.end(frame('accepted', { refresh: true }) + frame('stream_error', { code }));
}

/** One bounded write queue: a blocked client is closed instead of accumulating notifications. */
export function streamOperation(request: IncomingMessage, response: ServerResponse, options: {
  observer: OperationObserver; uid: string; operation: Operation; accepted: boolean;
  verify: () => Promise<unknown>; expiresAt?: number; maxMilliseconds: number; heartbeatMilliseconds?: number;
  shutdown?: AbortSignal; onError?: (error: unknown) => void;
}) {
  if (request.aborted || response.destroyed || options.shutdown?.aborted) { response.end(); return Promise.resolve(); }
  return new Promise<void>(resolve => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    let previous = '';
    let heartbeat: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let verifying = false;
    let attached = false;
    let pending: Notice | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat); clearTimeout(deadline); unsubscribe?.();
      response.off('close', close); options.shutdown?.removeEventListener('abort', shutdown);
      response.end(); resolve();
    };
    const write = (event: string, data: unknown) => {
      if (closed) return;
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify({ version: 1, operation: options.operation, ...data as object })}\n\n`)) close();
    };
    const failure = (code: string) => { write('stream_error', { code }); close(); };
    const shutdown = () => failure('server_shutdown');
    const changed = (state: Notice) => {
      if (!attached) { pending = state; return; }
      const serialized = JSON.stringify(state);
      if (serialized === previous || closed) return;
      previous = serialized;
      write(state.terminal ? 'terminal' : 'changed', state);
      if (state.terminal) close();
    };
    response.on('close', close);
    options.shutdown?.addEventListener('abort', shutdown, { once: true });
    response.writeHead(200, streamHeaders);
    response.flushHeaders();
    // Subscribe first; Firestore immediately delivers committed current state, including already-terminal work.
    try {
      unsubscribe = options.observer.subscribe(options.uid, options.operation, changed, error => { options.onError?.(error); failure('observation_unavailable'); });
      if (closed) { unsubscribe(); return; }
      write(options.accepted ? 'accepted' : 'changed', { refresh: true });
      attached = true;
      if (pending) changed(pending);
      if (closed) return;
      const lifetime = Math.min(options.maxMilliseconds, options.expiresAt === undefined ? options.maxMilliseconds : options.expiresAt - Date.now());
      deadline = setTimeout(() => failure('stream_expired'), Math.max(1, lifetime));
      heartbeat = setInterval(() => {
        if (!verifying && !closed) {
          verifying = true;
          void options.verify().catch(error => {
            if (error instanceof ProjectError && error.status === 401) failure('authentication_required');
            else { options.onError?.(error); failure('observation_unavailable'); }
          }).finally(() => { verifying = false; });
        }
        if (!closed && !response.write(': heartbeat\n\n')) close();
      }, options.heartbeatMilliseconds ?? 15_000);
      if (options.shutdown?.aborted || request.aborted || response.destroyed) close();
    } catch (error) { options.onError?.(error); failure('observation_unavailable'); }
  });
}
