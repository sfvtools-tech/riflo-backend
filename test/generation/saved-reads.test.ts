import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { deleteApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createFirebaseDependencies } from '../../src/firebase.js';
import { createHandler } from '../../src/http/app.js';

test('saved generation reads and private downloads survive absent AI configuration', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST,
}, async () => {
  const dependencies = createFirebaseDependencies('demo-riflo', undefined, 'demo-riflo.appspot.com');
  assert.ok(dependencies.generation, 'saved readers must not depend on provider keys');
  const app = getApp('riflo-backend');
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket('demo-riflo.appspot.com');
  const uid = `saved-reader-${randomUUID()}`;
  const projectId = randomUUID();
  const project = db.collection('accounts').doc(uid).collection('projects').doc(projectId);
  const now = Date.now();
  const blobs = [{id:'slide',feature:'carousels',type:'image/png',extension:'png'}, {id:'clip',feature:'short_videos',type:'video/mp4',extension:'mp4'}];
  const paths: string[] = [];
  const server = createServer(createHandler({...dependencies, verifyToken: async token => ({uid:token}), loadGrant: async () => null}));
  try {
    await project.set({uid,id:projectId,status:'source_expired'});
    await project.collection('generation').doc('batch').set({status:'completed',selection:{x_posts:1},slots:[],createdAt:now,updatedAt:now,errorCode:null});
    const fields = {text:'Saved content remains private.',createdAt:now,expiresAt:now+86_400_000,model:'historical-model',promptVersion:'historical-prompt'};
    await project.collection('outputs').doc('text').set({...fields,id:'text',feature:'x_posts'});
    for (const blob of blobs) {
      const path=`accounts/${uid}/projects/${projectId}/${blob.id}.${blob.extension}`;
      paths.push(path);
      await bucket.file(path).save(Buffer.from(`fixture-${blob.id}`),{resumable:false,metadata:{contentType:blob.type}});
      await project.collection('outputs').doc(blob.id).set({...fields,id:blob.id,feature:blob.feature,assets:[{id:blob.id,storagePath:path,contentType:blob.type,bytes:12,width:1,height:1}]});
    }
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const request=(path:string,owner=uid,method='GET')=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,{method,headers:{authorization:`Bearer ${owner}`,'content-type':'application/json','idempotency-key':'new-generation-key'},...(method==='POST'?{body:'{"outputs":{"x_posts":1}}'}:{})});
    const base=`/v1/projects/${projectId}`;
    for (const suffix of ['/generation','/outputs','/outputs/text','/outputs/text/download',...blobs.map(blob=>`/outputs/${blob.id}/assets/${blob.id}/download`)]) {
      const response=await request(base+suffix);
      assert.equal(response.status,200,suffix);
      assert.equal(response.headers.get('cache-control'),'no-store');
      const body=await response.text();
      assert.ok(!body.includes(`accounts/${uid}`),'private storage paths must remain internal');
      if(suffix.endsWith('/download'))assert.ok(body.includes(suffix.includes('/assets/')?`fixture-${suffix.includes('/clip/')?'clip':'slide'}`:'Saved content'));
      const other=await request(base+suffix,'other-owner');
      assert.equal(other.status,404,suffix);
    }
    const capabilities=await (await request('/v1/capabilities')).json();
    assert.equal(capabilities.data.services.generation.configured,false);
    assert.equal(capabilities.data.features.x_posts.implemented,false);
    const rejected=await request(base+'/generate',uid,'POST');
    assert.equal(rejected.status,503);
    await assert.rejects(dependencies.generation!.start(uid,projectId,{outputs:{x_posts:1}},'new-direct-start-key'),{code:'generation_not_configured'});
    assert.equal((await db.collection('generationJobs').doc(projectId).get()).exists,false);
  } finally {
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.all(paths.map(path=>bucket.file(path).delete({ignoreNotFound:true})));
    await db.recursiveDelete(db.collection('accounts').doc(uid));
    await db.terminate();
    await deleteApp(app);
  }
});
