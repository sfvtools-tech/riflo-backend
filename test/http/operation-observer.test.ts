import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { firestoreOperations, type Notice } from '../../src/http/operations.js';

test('Firestore observation watches only the scoped domain document and projects safe committed counts', async () => {
  const records = new Map<string, any>([
    ['accounts/alice/projects/project', { id: 'project', status: 'source_ready', importOperationId: 'import-id' }],
    ['accounts/alice/projects/project/generation/batch', { id: 'batch-id', status: 'generating', slots: [{ status: 'ready', text: 'secret output' }, { status: 'pending' }], workerId: 'secret-worker', privateCredential: 'secret-key' }],
    ['accounts/alice/projects/project/generation/history-old', { id: 'old', status: 'completed' }],
  ]);
  const listened: string[] = [];
  let callback: ((snapshot: any) => void) | undefined;
  let detached = 0;
  const doc = (path: string): any => ({
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    onSnapshot: (changed: any) => { listened.push(path); callback = changed; return () => { detached++; }; },
  });
  const collection = (path: string): any => ({ doc: (id: string) => doc(`${path}/${id}`) });
  const observer = firestoreOperations({ collection } as unknown as Firestore);
  const operation = { projectId: 'project', kind: 'generation' as const, id: 'batch-id' };
  await observer.check('alice', operation);
  await assert.rejects(observer.check('bob', operation), { code: 'project_not_found' });
  const states: Notice[] = [];
  const unsubscribe = observer.subscribe('alice', operation, state => states.push(state), () => assert.fail('Unexpected listener failure'));
  callback!({ data: () => records.get('accounts/alice/projects/project/generation/batch') });
  assert.deepEqual(states[0], { status: 'generating', terminal: false, ready: 1, failed: 0 });
  callback!({ data: () => ({ id: 'batch-id', status: 'partial', slots: [{ status: 'ready' }, { status: 'failed' }] }) });
  assert.deepEqual(states[1], { status: 'partial', terminal: true, outcome: 'partial', ready: 1, failed: 1 });
  callback!({ data: () => ({ id: 'newer-batch', status: 'queued', slots: [] }) });
  assert.deepEqual(states[2], { status: 'superseded', terminal: true, outcome: 'superseded' });
  assert.deepEqual(listened, ['accounts/alice/projects/project/generation/batch']);
  unsubscribe(); assert.equal(detached, 1);
  await observer.check('alice', { ...operation, id: 'old' });
  await assert.rejects(observer.check('alice', { ...operation, id: 'unknown' }), { code: 'operation_not_found' });
});

test('superseded restoration observation requires an owned matching restoration key', async () => {
  const records = new Map<string, any>([
    ['accounts/alice/projects/project', {status:'source_ready',importOperationId:'newer-operation'}],
    ['accounts/alice/projects/other', {status:'source_ready',importOperationId:'other-operation'}],
    ['accounts/alice/sourceRestoreKeys/accepted', {projectId:'project',importOperationId:'restored-operation'}],
  ]);
  const collection = (path:string):any => ({
    doc:(id:string)=>({collection:(name:string)=>collection(`${path}/${id}/${name}`),get:async()=>({data:()=>records.get(`${path}/${id}`)})}),
    where:(field:string,operator:string,value:string)=>{
      assert.equal(field,'importOperationId');assert.equal(operator,'==');
      return {limit:(count:number)=>{assert.equal(count,1);return {get:async()=>({docs:[...records].filter(([key,saved])=>key.startsWith(`${path}/`)&&saved[field]===value).map(([,saved])=>({data:()=>saved}))})};}};
    },
  });
  const observer=firestoreOperations({collection} as unknown as Firestore);
  const operation={projectId:'project',kind:'import' as const,id:'restored-operation'};
  await observer.check('alice',operation);
  await assert.rejects(observer.check('bob',operation),{code:'project_not_found'});
  await assert.rejects(observer.check('alice',{...operation,projectId:'other'}),{code:'operation_not_found'});
  await assert.rejects(observer.check('alice',{...operation,id:'unknown'}),{code:'operation_not_found'});
  records.set('accounts/alice/projects/project',{status:'deleted'});
  await assert.rejects(observer.check('alice',operation),{code:'project_not_found'});
});
