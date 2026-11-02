import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../../src/http/app.js';
import { ProjectError, type ProjectService } from '../../src/projects/service.js';
import { featureIds, quotaKeys } from '../../src/access/policy.js';

test('source restoration authenticates commands, preserves replay and returns its exact import operation', async () => {
  let active = true, configured = true, replay = false, errorCode = '', calls = 0;
  const grant = {status:'active',startsAt:'2026-10-01T00:00:00Z',expiresAt:'2026-11-01T00:00:00Z',features:[...featureIds],limits:Object.fromEntries(quotaKeys.map(key=>[key,1800]))};
  const projects = {restoreSource:async(uid:string,id:string,key:string,authorize?:()=>Promise<void>)=>{
    calls++;assert.equal(uid,'owner');assert.equal(id,'project');assert.equal(key,'restore-key');
    if(!replay)await authorize?.();
    if(errorCode)throw new ProjectError(409,errorCode,'Import the original video as a new project.');
    return {id,importOperationId:'restore-operation',status:'queued'};
  }} as unknown as ProjectService;
  const server=createServer(createHandler({
    verifyToken:async()=>({uid:'owner'}),loadGrant:async()=>active?grant:null,now:()=>new Date('2026-10-18T00:00:00Z'),
    get intakeConfigured(){return configured;},projects,
    operations:{
      check:async(uid,operation)=>{assert.equal(uid,'owner');assert.deepEqual(operation,{projectId:'project',kind:'import',id:'restore-operation'});},
      subscribe:(_uid,_operation,changed)=>{queueMicrotask(()=>changed({status:'source_ready',terminal:true,outcome:'succeeded'}));return()=>{};},
    },
  }));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects/project/restore-source`;
  const request=(method='POST',auth=true)=>fetch(url,{method,headers:{...(auth?{Authorization:'Bearer token'}:{}),'Idempotency-Key':'restore-key'}});
  try {
    let response=await request('GET');assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'POST');
    response=await request('POST',false);assert.equal(response.status,401);assert.equal(calls,0);
    response=await request();assert.equal(response.status,202);assert.equal((await response.json()).data.importOperationId,'restore-operation');
    active=false;response=await request();assert.equal(response.status,403);
    replay=true;response=await request();assert.equal(response.status,202);replay=false;active=true;
    configured=false;response=await request();assert.equal(response.status,503);configured=true;
    for(const code of ['source_changed','source_identity_unverified','source_restore_not_available']) {
      errorCode=code;response=await request();assert.equal(response.status,409);const body=await response.json();assert.equal(body.error.code,code);assert.match(body.error.message,/new project/);
    }
    errorCode='';response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer token','Idempotency-Key':'restore-key',Accept:'text/event-stream'}});
    assert.equal(response.status,200);const stream=await response.text();assert.match(stream,/event: accepted/);assert.match(stream,/restore-operation/);assert.match(stream,/succeeded/);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
