import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Main } from '../src/main.ts';
import { Host } from '../src/host.ts';
import { id, hash, MAX_FRAME } from '../src/protocol.ts';
import type { Result } from '../src/protocol.ts';

const input={goal:'Inspect sample',originalRequest:'Read sample',constraints:[],acceptance:['Value checked'],baseCommit:'a'.repeat(40)};
function fixture(){
  const root=mkdtempSync('/tmp/rein-reliability-'),owner={harness:'codex',instance:'test',session:id()},target={kind:'local' as const,state:root};
  const main=new Main(join(root,'main'),owner,target,root);main.mode(true);
  return {root,owner,target,main,close(){main.db.close();rmSync(root,{recursive:true,force:true});}};
}
function delivered(main:Main){for(const c of main.db.list<any>('outbox'))main.db.set('outbox',c.id,{...c,done:true});}
function ready(main:Main,task:ReturnType<Main['dispatch']>){
  const report:Result={summary:'Checked',evidence:['Read sample'],discoveries:[],unresolved:[]},json=JSON.stringify(report);
  const artifacts={'report.json':{hash:hash(json),size:Buffer.byteLength(json)},'changes.patch':{hash:hash(''),size:0}};
  const directory=join(main.state,'artifacts',task.spec.runId);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'report.json'),json);writeFileSync(join(directory,'changes.patch'),'');
  main.db.set('tasks',task.spec.taskId,{...task,status:'ready',learning:'pending',run:{spec:task.spec,state:'succeeded',created:1,report,artifacts},checked:{'report.json':artifacts['report.json'].hash,'changes.patch':artifacts['changes.patch'].hash}});
}
async function serverAt(root:string,handler:(command:any,reply:(value:unknown,error?:string)=>void)=>void){
  const sockets=new Set<Socket>();
  const server=createServer({allowHalfOpen:true},socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let data='',handled=false;
    socket.on('data',chunk=>{data+=chunk;if(handled||!data.includes('\n'))return;handled=true;
      handler(JSON.parse(data),(value,error)=>socket.end(JSON.stringify(error?{ok:false,error}:{ok:true,value})+'\n'));
    });
  });
  await new Promise<void>(resolve=>server.listen(join(root,'host.sock'),resolve));
  return async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));};
}

test('new mandatory context atomically revises only its task, blocks stale acceptance and cannot be omitted',()=>{
  const f=fixture();
  try{
    const parent=f.main.createUserTask('parent',{taskKey:'sample',title:'Sample',goal:input.goal,acceptance:input.acceptance});
    const other=f.main.createUserTask('other',{taskKey:'other',title:'Other',goal:'Independent',acceptance:['Done']});
    const task=f.main.dispatch('old',{...input,userTaskId:parent.id,expectedRevision:1});ready(f.main,task);
    const note=f.main.context.record('new',{kind:'constraint',content:'Also check backup.json',quote:'Also check backup.json',appliesTo:{type:'task',taskKey:'sample'},shareWithWorkers:true});
    assert.equal(note.requiredForTask,true);assert.equal(f.main.userTask(parent.id).revision,2);assert.equal(f.main.userTask(parent.id).version,2);
    assert.equal(f.main.userTask(other.id).revision,1);
    assert.throws(()=>f.main.accept(task.spec.taskId,['Read original sample only']),/revision changed/);
    assert.throws(()=>f.main.dispatch('missing',{...input,userTaskId:parent.id,expectedRevision:2}),/Required task context/);
    assert.ok(f.main.contextChanges(task.spec).missingRequired.includes(note.id));
    const fresh=f.main.dispatch('fresh',{...input,userTaskId:parent.id,expectedRevision:2,contextIds:[note.id]});ready(f.main,fresh);
    f.main.cancel(task.spec.taskId);f.main.db.set('tasks',task.spec.taskId,{...f.main.task(task.spec.taskId),status:'canceled'});f.main.review(task.spec.taskId,'discard');
    f.main.accept(fresh.spec.taskId,['Checked sample and backup']);f.main.review(fresh.spec.taskId,'discard');
    const done=f.main.completeUserTask(parent.id,2,['Checked both files'],[fresh.spec.taskId]);assert.equal(done.status,'completed');
    f.main.context.update(note.id,1,{content:'Also check archive.json',quote:'Use archive instead of backup',shareWithWorkers:true});
    const reopened=f.main.userTask(parent.id);assert.equal(reopened.status,'active');assert.equal(reopened.revision,3);assert.equal(reopened.completion,undefined);
    assert.throws(()=>f.main.completeUserTask(parent.id,reopened.version,['Old evidence'],[fresh.spec.taskId]),/current revision/);
  }finally{f.close();}
});

test('optional notes do not revise requirements; private mandatory notes block dispatch without leaking',()=>{
  const f=fixture();
  try{
    const parent=f.main.createUserTask('parent',{taskKey:'sample',title:'Sample',goal:input.goal,acceptance:input.acceptance});
    for(const note of [{kind:'preference'}, {kind:'decision',requiredForTask:false}])f.main.context.record(id(),{...note,content:'Optional background',quote:'Optional background',appliesTo:{type:'task',taskKey:'sample'}});
    assert.equal(f.main.userTask(parent.id).revision,1);
    const task=f.main.dispatch('unchanged',{...input,userTaskId:parent.id,expectedRevision:1});ready(f.main,task);f.main.accept(task.spec.taskId,['Checked']);
    const secret=f.main.context.record('private',{kind:'constraint',content:'Private business constraint',quote:'Do not send this to workers',appliesTo:{type:'task',taskKey:'sample'}});
    assert.throws(()=>f.main.dispatch('private-omitted',{...input,userTaskId:parent.id,expectedRevision:2}),/Required task context/);
    assert.throws(()=>f.main.dispatch('private-selected',{...input,userTaskId:parent.id,expectedRevision:2,contextIds:[secret.id]}),/local-only/);
    const before=f.main.userTask(parent.id).revision;
    assert.throws(()=>f.main.context.record('invalid',{kind:'constraint',content:'Invalid',quote:'Invalid',appliesTo:{type:'project'},requiredForTask:true}),/task-scoped/);
    assert.equal(f.main.userTask(parent.id).revision,before);
    f.main.context.retire(secret.id,1,'No longer applies');assert.equal(f.main.userTask(parent.id).revision,3);
    const fresh=f.main.dispatch('retired',{...input,userTaskId:parent.id,expectedRevision:3});assert.equal(fresh.spec.userContext,undefined);
  }finally{f.close();}
});

test('legacy unassigned executions are invalidated by required-set changes, while another conversation stays isolated',()=>{
  const f=fixture(),other=new Main(f.main.state,{...f.owner,session:id()},f.target,f.root);
  try{
    const task=f.main.dispatch('legacy',{...input,taskKey:'sample'});ready(f.main,task);
    const n=f.main.context.record('new',{kind:'constraint',content:'Cross-check backup',quote:'Cross-check backup',appliesTo:{type:'task',taskKey:'sample'},shareWithWorkers:true});
    assert.throws(()=>f.main.accept(task.spec.taskId,['Original only']),/user context changed/);
    f.main.context.retire(n.id,1,'Withdrawn');
    assert.equal(f.main.contextChanges(task.spec).requiredSetChanged,true);
    assert.throws(()=>f.main.accept(task.spec.taskId,['Original only']),/user context changed/);
    other.mode(true);assert.doesNotThrow(()=>other.dispatch('same-label',{...input,taskKey:'sample'}));
  }finally{other.db.close();f.close();}
});

test('overlapping sync cannot regress cursor, execution state, handled receipts or sync status',async()=>{
  const f=fixture(),other=new Main(f.main.state,f.owner,f.target,f.root),task=f.main.dispatch('race',input);delivered(f.main);
  const running={seq:1,run:task.spec.runId,data:{spec:task.spec,state:'running',created:1}},finished={seq:2,run:task.spec.runId,data:{spec:task.spec,state:'succeeded',created:1,report:{summary:'Done',evidence:[],discoveries:[],unresolved:[]}}};
  const seen=Promise.withResolvers<void>();let release:()=>void=()=>{},calls=0;
  const close=await serverAt(f.root,(_,reply)=>{if(++calls===1){release=()=>reply([running]);seen.resolve();}else reply(calls===2?[running,finished]:[]);});
  try{
    const slow=f.main.sync();await seen.promise;await other.sync();const status=other.db.get('sync-status',other.binding);release();await slow;
    assert.equal(f.main.db.get('cursor','host'),2);assert.equal(f.main.task(task.spec.taskId).status,'ready');assert.equal(f.main.task(task.spec.taskId).lastEventSeq,2);
    assert.ok(f.main.db.list<any>('incoming').every(e=>e.handled));assert.deepEqual(f.main.db.get('sync-status',f.main.binding),status);
    // A previously ingested older receipt can never overwrite a newer applied run.
    f.main.db.set('incoming','1',{...running,handled:false});await f.main.sync();assert.equal(f.main.task(task.spec.taskId).status,'ready');
  }finally{await close();other.db.close();f.close();}
});

test('a late failed start cannot reopen canceled intent or leave a permanent sync-pending action',async()=>{
  const f=fixture(),other=new Main(f.main.state,f.owner,f.target,f.root),task=f.main.dispatch('race',input);
  const seen=Promise.withResolvers<void>();let reject:()=>void=()=>{};
  const close=await serverAt(f.root,(cmd,reply)=>{if(cmd.type==='start'){reject=()=>reply(null,'Lost acknowledgement');seen.resolve();}else reply(cmd.type==='cancel'?{confirmed:true}:[]);});
  try{
    const slow=f.main.sync();await seen.promise;other.cancel(task.spec.taskId);reject();await slow;await other.sync();
    assert.ok(f.main.db.list<any>('outbox').every(c=>c.done));assert.equal(other.task(task.spec.taskId).status,'canceled');
    assert.ok(other.brief().items.every(i=>!i.actions.includes('sync_pending_commands')));
  }finally{await close();other.db.close();f.close();}
});

test('cancel receipt cannot complete a task before its final approvals reconcile after event loss',async()=>{
  const f=fixture(),epoch=id(),requestId=id();
  const parent=f.main.createUserTask('parent',{taskKey:'cancel-race',title:'Cancel race',goal:input.goal,acceptance:input.acceptance});
  const accepted=f.main.dispatch('accepted',{...input,userTaskId:parent.id,expectedRevision:1});ready(f.main,accepted);
  f.main.accept(accepted.spec.taskId,['Inspected fixture']);f.main.review(accepted.spec.taskId,'discard');
  const interrupted=f.main.dispatch('interrupted',{...input,userTaskId:parent.id,expectedRevision:1});delivered(f.main);
  f.main.db.set('tasks',interrupted.spec.taskId,{...interrupted,status:'running',run:{spec:interrupted.spec,state:'running',created:1,approvals:[{id:requestId,state:'responding',method:'item/commandExecution/requestApproval'}]}});
  f.main.cancel(interrupted.spec.taskId);
  let disconnected=true,reconciled=false;
  const close=await serverAt(f.root,(cmd,reply)=>{
    if(cmd.type==='cancel')return reply({confirmed:true,state:cmd.runId===interrupted.spec.runId?'canceled':'not-started'});
    if(disconnected)return reply(null,'Disconnected after cancel acknowledgement');
    if(cmd.type==='events')return reply({epoch,head:5,events:[],nextCursor:cmd.after,hasMore:false});
    if(cmd.type==='reconcile'){
      reconciled=true;assert.deepEqual(cmd.runIds,[interrupted.spec.runId]);
      return reply({epoch,cursor:5,runs:[{runId:interrupted.spec.runId,data:{spec:interrupted.spec,state:'canceled',created:1,approvals:[{id:requestId,state:'unknown',method:'item/commandExecution/requestApproval'}]}}]});
    }
    assert.fail('Unexpected command '+cmd.type);
  });
  try{
    await f.main.sync();
    assert.equal(f.main.task(interrupted.spec.taskId).status,'canceled');
    assert.equal(f.main.task(interrupted.spec.taskId).run!.state,'running');
    assert.ok(f.main.brief().items.find(i=>i.taskId===interrupted.spec.taskId)!.actions.includes('sync_execution_final_state'));
    assert.throws(()=>f.main.completeUserTask(parent.id,1,['Checked'],[accepted.spec.taskId]),/Sync final execution/);
    disconnected=false;await f.main.sync();assert.equal(reconciled,true,'Canceled executions with stale snapshots remain eligible for reconciliation');
    assert.equal(f.main.task(interrupted.spec.taskId).learning,'pending');
    f.main.review(interrupted.spec.taskId,'discard');
    assert.throws(()=>f.main.completeUserTask(parent.id,1,['Checked'],[accepted.spec.taskId]),/unknown operation effects/);
    f.main.reviewOperationEffects(interrupted.spec.taskId,requestId,'no-effects',['Transport fixture did not execute any operation']);
    // An explicit no-run tombstone does not require a nonexistent final report.
    const neverStarted=f.main.dispatch('not-started',{...input,userTaskId:parent.id,expectedRevision:1});f.main.cancel(neverStarted.spec.taskId);await f.main.sync();
    assert.equal(f.main.task(neverStarted.spec.taskId).cancelConfirmedNotStarted,true);
    assert.equal(f.main.completeUserTask(parent.id,1,['Checked'],[accepted.spec.taskId]).status,'completed');
  }finally{await close();f.close();}
});

test('missing-run legacy records require the exact settled rejection evidence before outcome review',()=>{
  const f=fixture();
  try{
    for(const scenario of ['queued','unknown','pending','never-attempted','different-error','observed-run']){
      const t=f.main.dispatch(scenario,input),cmd=f.main.db.list<any>('outbox').find(c=>c.taskId===t.spec.taskId)!;
      t.status=['queued','unknown'].includes(scenario)?scenario:'failed';t.learning='pending';t.error='Unconfirmed delivery';
      if(scenario==='observed-run')t.lastEventSeq=1;
      f.main.db.set('tasks',t.spec.taskId,t);
      f.main.db.set('outbox',cmd.id,{...cmd,done:scenario!=='pending',attempts:scenario==='never-attempted'?0:1,error:scenario==='different-error'?'Different failure':t.error});
      assert.throws(()=>f.main.review(t.spec.taskId,'discard'),/requires an execution outcome or a confirmed start rejection/,scenario);
      assert.equal(f.main.task(t.spec.taskId).learning,'pending');assert.equal(f.main.task(t.spec.taskId).startRejection,undefined);
    }
  }finally{f.close();}
});

test('byte-bounded event pages drain large old snapshots and reports, including a single oversized report',async()=>{
  const f=fixture();writeFileSync(join(f.root,'host.json'),JSON.stringify({repository:f.root,adapter:'fixture',executable:process.execPath}));const host=new Host(f.root);
  let pages=0;
  const close=await serverAt(f.root,(cmd,reply)=>{try{const value=host.handle(cmd);if(cmd.type==='events'){pages++;assert.ok(Buffer.byteLength(JSON.stringify({ok:true,value}))<MAX_FRAME);}reply(value);}catch(e){reply(null,(e as Error).message);}});
  try{
    // All specs are legal Main dispatches. Old stored events contain full specs.
    for(let i=0;i<30;i++){
      const task=f.main.dispatch('large-'+i,{...input,constraints:Array(24).fill('x'.repeat(7900))});
      host.handle({type:'start',key:task.key,spec:task.spec});
      const report={summary:'Done',evidence:Array(10).fill('\u4e2d'.repeat(4000)),discoveries:[],unresolved:[]};
      const run={spec:task.spec,state:'succeeded',created:1,report};host.db.set('runs',task.spec.runId,run);host.db.event(task.spec.runId,run);
    }
    delivered(f.main);
    const first=host.handle({type:'events',after:0,page:true}) as any;assert.equal(first.hasMore,true);assert.ok(first.nextCursor>0);
    await f.main.sync();assert.ok(pages>=2);assert.ok(f.main.tasks().every(t=>t.status==='ready'));assert.equal(f.main.db.get('cursor','host'),60);
    const huge=f.main.dispatch('huge',input);delivered(f.main);
    const report:Result={summary:'Large report',evidence:Array(60).fill('\u4e2d'.repeat(12000)),discoveries:[],unresolved:['Still needs confirmation']};
    const json=JSON.stringify(report),artifacts={'report.json':{hash:hash(json),size:Buffer.byteLength(json)},'changes.patch':{hash:hash(''),size:0}};
    const directory=join(f.root,'runs',huge.spec.runId);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'report.json'),json);writeFileSync(join(directory,'changes.patch'),'');
    const run={spec:huge.spec,state:'succeeded',created:1,report,artifacts};host.db.set('runs',huge.spec.runId,run);host.db.event(huge.spec.runId,run);
    await f.main.sync();assert.equal(f.main.task(huge.spec.taskId).run?.reportOmitted,true);
    assert.throws(()=>f.main.accept(huge.spec.taskId,['Checked']),/full report/);
    await f.main.collect(huge.spec.taskId);assert.deepEqual(f.main.task(huge.spec.taskId).run?.report,report);
    assert.throws(()=>f.main.accept(huge.spec.taskId,['Checked']),/unresolved/);
  }finally{await close();host.db.close();f.close();}
});

test('new Main can read a legacy Host that rejects paged events',async()=>{
  const f=fixture();let legacy=0;
  const close=await serverAt(f.root,(cmd,reply)=>{if(cmd.page)reply(null,JSON.stringify([{code:'unrecognized_keys',keys:['page']}]));else {legacy++;reply([]);}});
  try{await f.main.sync();assert.equal(legacy,1);assert.equal(f.main.db.get<any>('sync-status',f.main.binding).state,'synced');}
  finally{await close();f.close();}
});

test('upgrade repairs a legacy regressed ledger and closes resurrected canceled intent while offline',async()=>{
  const f=fixture();let upgraded:Main|undefined;
  try{
    const task=f.main.dispatch('old-race',input),canceled=f.main.dispatch('old-cancel',input);delivered(f.main);f.main.cancel(canceled.spec.taskId);
    // Reproduce the persisted damage created by the old races, not just new calls.
    f.main.db.set('tasks',task.spec.taskId,{...task,status:'running'});
    const running={spec:task.spec,state:'running',created:1},succeeded={...running,state:'succeeded',report:{summary:'Done',evidence:[],discoveries:[],unresolved:[]}};
    f.main.db.set('incoming','1',{seq:1,run:task.spec.runId,data:running,handled:true});f.main.db.set('incoming','2',{seq:2,run:task.spec.runId,data:succeeded,handled:true});f.main.db.set('cursor','host',1);
    for(const c of f.main.db.list<any>('outbox'))if(c.taskId===canceled.spec.taskId)f.main.db.set('outbox',c.id,{...c,done:c.type==='cancel',error:'Old stale reply'});
    f.main.db.set('tasks',canceled.spec.taskId,{...f.main.task(canceled.spec.taskId),status:'canceled'});
    f.main.db.set('migrations','incoming-sequence-v1',false);
    upgraded=new Main(f.main.state,f.owner,f.target,f.root);await upgraded.sync(100);
    assert.equal(upgraded.db.get('cursor','host'),2);assert.equal(upgraded.task(task.spec.taskId).status,'ready');
    assert.equal(upgraded.task(task.spec.taskId).lastEventSeq,2);assert.ok(upgraded.db.list<any>('incoming').every(e=>e.handled));
    assert.ok(upgraded.db.list<any>('outbox').every(c=>c.done));assert.equal(upgraded.task(canceled.spec.taskId).status,'canceled');
  }finally{upgraded?.db.close();f.close();}
});

test('overview reads each collection once and keeps global attention outside the visible page',()=>{
  const f=fixture();
  try{
    f.main.db.transaction(()=>{for(let i=0;i<1000;i++){
      const parentId=id();f.main.db.set('user-tasks',parentId,{id:parentId,owner:f.owner,taskKey:'task-'+i,title:'Task '+i,goal:'Inspect',acceptance:['Done'],version:1,revision:1,status:'active',waitingFor:i===0?['Decision required']:[],createdAt:i,updatedAt:i});
      for(let j=0;j<2;j++){const taskId=id();f.main.db.set('tasks',taskId,{spec:{...input,taskId,runId:id(),revision:1,owner:f.owner,taskKey:'task-'+i,knowledge:[]},key:id(),status:'running',cancelRequested:false,userTask:{id:parentId,revision:1}});}
    }});
    const owned=f.main.db.owned.bind(f.main.db),scoped=f.main.db.scoped.bind(f.main.db),counts:Record<string,number>={};
    f.main.db.owned=((bucket:any,owner:any)=>{counts[bucket]=(counts[bucket]??0)+1;return owned(bucket,owner);}) as typeof f.main.db.owned;
    f.main.db.scoped=((bucket:any,scope:any)=>{counts[bucket]=(counts[bucket]??0)+1;return scoped(bucket,scope);}) as typeof f.main.db.scoped;
    const board=f.main.status() as any;
    assert.equal(board.tasks.length,10);assert.equal(board.counts.executions,2000);assert.equal(board.pagination.total,1000);
    assert.ok(board.attention.items.some((i:any)=>i.taskKey==='task-0'));
    assert.deepEqual(counts,{'tasks':1,'user-tasks':1,'user-context':1,'knowledge':1});
  }finally{f.close();}
});
