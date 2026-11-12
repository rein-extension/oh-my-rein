import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { Main } from '../src/main.ts';
import { id } from '../src/protocol.ts';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'rein-user-tasks-')),state=join(root,'main'),target={kind:'local' as const,state:root},owner={harness:'codex',instance:'test',session:id()};
  const main=new Main(state,owner,target,root);main.mode(true);
  const input={goal:'Investigate a payment error',originalRequest:'Investigate the payment error.',constraints:[],acceptance:['Explain the cause'],baseCommit:'a'.repeat(40)};
  const task=main.createUserTask('payment',{taskKey:'payment',title:'Fix payments',goal:'Restore successful payments',acceptance:['Payment succeeds','Regression check passes']});
  return {root,state,target,owner,main,input,task,dispatch:{...input,userTaskId:task.id,expectedRevision:1}};
}

test('one enduring user task owns several immutable executions and survives reopening',()=>{
  const f=fixture();let reopened:Main|undefined,other:Main|undefined;
  try{
    const first=f.main.dispatch('investigate',f.dispatch),second=f.main.dispatch('verify',{...f.dispatch,goal:'Inspect regression coverage'});
    assert.equal(first.userTask?.id,second.userTask?.id);assert.notEqual(first.spec.runId,second.spec.runId);
    assert.equal(f.main.dispatch('investigate',f.dispatch).spec.runId,first.spec.runId);
    assert.equal(f.main.userTasks().length,1);assert.equal(f.main.tasks().length,2);
    assert.equal(f.main.userTaskSummary(f.task).executions.total,2);
    assert.equal('userTaskId' in first.spec,false,'Local task metadata must not widen the worker payload');
    assert.throws(()=>f.main.dispatch('bypass',{...f.input,taskKey:'payment'}),/supply its userTaskId/);
    assert.throws(()=>f.main.createUserTask('duplicate',{taskKey:'payment',title:'Duplicate',goal:'Another goal',acceptance:['done']}),/already identifies/);
    const revised=f.main.updateUserTask(f.task.id,1,{goal:'Restore payments including refunds',reason:'The user added refund handling.'});
    assert.equal(revised.revision,2);assert.equal(first.userTask?.revision,1);
    assert.equal((f.main.status({id:f.task.id,version:1}) as any).task.goal,f.task.goal);
    assert.throws(()=>f.main.updateUserTask(f.task.id,1,{title:'Stale title',reason:'Old read'}),/version changed/);
    assert.throws(()=>f.main.dispatch('stale',f.dispatch),/revision changed/);
    assert.throws(()=>f.main.dispatch('premature',{...f.dispatch,expectedRevision:2}),/confirm old/);
    reopened=new Main(f.state,f.owner,f.target,f.root);
    assert.equal(reopened.userTask(f.task.id).revision,2);assert.equal(reopened.tasks().length,2);
    other=new Main(f.state,{...f.owner,session:id()},f.target,f.root);other.mode(true);
    assert.equal(other.userTasks().length,0);assert.throws(()=>other!.userTask(f.task.id),/not owned/);
    assert.throws(()=>other!.dispatch('foreign',{...f.dispatch,expectedRevision:2}),/not owned/);
  }finally{other?.db.close();reopened?.db.close();f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('global attention includes older tasks outside the visible task page and does not export detail',()=>{
  const f=fixture();
  try{
    f.main.updateUserTask(f.task.id,1,{waitingFor:['Which payment gateway should receive refunds?'],reason:'A user decision is needed.'});
    for(let i=0;i<35;i++)f.main.createUserTask('task-'+i,{taskKey:'other-'+i,title:'Other '+i,goal:'PRIVATE_TASK_DETAIL '+ 'x'.repeat(8000),acceptance:['done']});
    const board=f.main.status() as any;
    assert.equal(board.tasks.length,10);assert.equal(board.counts.tasks,36);assert.equal(board.attention.pagination.total,36);
    assert.ok(!board.tasks.some((t:any)=>t.userTaskId===f.task.id),'The older task must be outside this page to exercise global attention');
    assert.ok(board.attention.items.some((i:any)=>i.userTaskId===f.task.id&&i.actions.includes('resolve_task_decisions')));
    assert.ok(Buffer.byteLength(JSON.stringify(board))<20000);
    assert.equal((f.main.status({view:'attention',offset:30}) as any).items.length,6);
    assert.equal((f.main.status({id:f.task.id}) as any).task.waitingFor.length,1);
    assert.throws(()=>f.main.dispatch('blocked',f.dispatch),/pending decisions/);
    const resumed=f.main.updateUserTask(f.task.id,2,{waitingFor:[],title:'Payments and refunds',reason:'The user clarified the gateway.'});
    assert.equal(resumed.revision,1,'A title or decision-list edit must not invalidate requirements');
    const exec=f.main.dispatch('answered',f.dispatch);
    assert.equal(exec.spec.goal,f.input.goal);assert.equal(JSON.stringify(exec.spec).includes('gateway'),false);
    assert.equal(f.main.userTask(f.task.id).status,'active');
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('pause holds future delivery, preserves results and resume releases it; cancel remains explicit',async()=>{
  const f=fixture();
  try{
    const a=f.main.dispatch('a',f.dispatch),b=f.main.dispatch('b',{...f.input,taskKey:'unrelated'});
    f.main.updateUserTask(f.task.id,1,{status:'paused',reason:'Pause payments while the user decides.'});
    assert.equal(f.main.task(a.spec.taskId).status,'queued');assert.equal(f.main.task(b.spec.taskId).status,'queued');
    assert.throws(()=>f.main.dispatch('paused',f.dispatch),/must be active/);
    f.main.updateUserTask(f.task.id,2,{status:'active',reason:'Resume payments.'});
    assert.equal(f.main.task(a.spec.taskId).cancelRequested,false);
    assert.ok(f.main.db.list<any>('outbox').every(c=>c.type==='start'));
    f.main.updateUserTask(f.task.id,3,{status:'canceled',reason:'Stop payment work explicitly.'});
    const board=await f.main.sync(100) as any;
    assert.equal(board.sync.state,'unavailable');assert.equal(f.main.task(a.spec.taskId).status,'cancel_requested');
    assert.ok(f.main.db.list<any>('outbox').some(c=>c.taskId===a.spec.taskId&&c.type==='cancel'&&!c.done));
    assert.ok(f.main.db.list<any>('outbox').filter(c=>c.taskId===a.spec.taskId&&c.type==='start').every(c=>c.done));
    assert.equal(f.main.userTaskSummary(f.main.userTask(f.task.id)).cancellation,'pending','Cancellation is requested, not confirmed, while offline');
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a silent Host cannot monopolize the main conversation; pending intent survives the sync deadline',async()=>{
  const f=fixture(),sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(join(f.root,'host.sock'),resolve));
  try{
    const execution=f.main.dispatch('slow-host',f.dispatch),started=Date.now();
    const board=await f.main.sync(150) as any;
    assert.ok(Date.now()-started<1500,'One sync must return without waiting indefinitely for transport or a worker');
    assert.notEqual(board.sync.state,'synced');assert.equal(f.main.task(execution.spec.taskId).status,'queued');
    assert.ok(f.main.db.list<any>('outbox').some(c=>!c.done));
    assert.equal((f.main.status() as any).tasks[0].userTaskId,f.task.id,'Local conversation state stays available offline');
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('legacy execution snapshots are preserved and surfaced explicitly as unassigned',()=>{
  const f=fixture();
  try{
    const legacy=f.main.dispatch('legacy',f.input),original=JSON.stringify(legacy.spec);
    const board=f.main.status() as any;
    assert.equal(board.counts.unassignedExecutions,1);assert.equal(board.counts.tasks,1);
    assert.ok(board.attention.items.some((i:any)=>i.executionId===legacy.spec.taskId));
    assert.equal(JSON.stringify((f.main.status({view:'executions',id:legacy.spec.taskId}) as any).execution.spec),original);
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});
