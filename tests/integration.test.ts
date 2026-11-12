import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Main } from '../src/main.ts';
import { Host } from '../src/host.ts';
import { request } from '../src/transport.ts';
import { id } from '../src/protocol.ts';
import type { Spec } from '../src/protocol.ts';

const delay=(ms=50)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>Promise<boolean>,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay();}throw Error('Timed out waiting for condition');}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'rein-')),repo=join(root,'repo'),state=join(root,'host');mkdirSync(repo);mkdirSync(state);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');writeFileSync(join(repo,'README.md'),'fixture\n');git('add','.');git('-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','initial');
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter:'fixture',executable:process.execPath,concurrency:2,sandbox:'read-only'}));
  const owner={harness:'codex',instance:'test',session:id()},target={kind:'local' as const,state};
  const input={goal:'one',originalRequest:'create result',constraints:['only fixture'],acceptance:['result created'],baseCommit:git('rev-parse','HEAD')};
  const main=new Main(join(root,'main'),owner,target,repo);main.mode(true);
  return {root,repo,state,target,owner,input,main};
}
async function start(state:string){
  const child=spawn(process.execPath,[resolve('src/cli.ts'),'host','serve','--state',state],{env:{...process.env,REIN_ALLOW_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>errors+=b.toString());
  await until(async()=>{if(child.exitCode!==null)throw Error(errors);try{await request({kind:'local',state},{type:'probe'},500);return true;}catch{return false;}});
  return child;
}
async function stop(child:ReturnType<typeof spawn>){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}}

test('unknown recovery survives restart, releases capacity and never relaunches the uncertain execution',async()=>{
  const f=fixture();let host:ReturnType<typeof spawn>|undefined;
  try{
    const config=JSON.parse(readFileSync(join(f.state,'host.json'),'utf8'));writeFileSync(join(f.state,'host.json'),JSON.stringify({...config,concurrency:1}));
    const uncertain=f.main.dispatch('uncertain',f.input),next=f.main.dispatch('next',f.input),seed=new Host(f.state);
    seed.handle({type:'start',key:uncertain.key,spec:uncertain.spec});
    // This is the real restart ambiguity: persistence happened before a runner PID.
    seed.db.set('runs',uncertain.spec.runId,{spec:uncertain.spec,state:'starting',created:1});seed.db.close();
    host=await start(f.state);await f.main.sync();
    assert.equal((await request(f.target,{type:'inspect',runId:uncertain.spec.runId})).state,'unknown');
    assert.equal((await request(f.target,{type:'inspect',runId:next.spec.runId})).state,'prepared');
    const resolved=await request(f.target,{type:'resolve',runId:uncertain.spec.runId,confirmStopped:true,reason:'Test verified no runner, worker, workspace or external effects were created'});
    assert.equal(resolved.state,'canceled');assert.ok(resolved.recovery);
    await until(async()=>{await f.main.sync();return f.main.task(next.spec.taskId).status==='ready';});
    assert.equal(f.main.task(uncertain.spec.taskId).status,'canceled');
    await stop(host);host=await start(f.state);
    const old=await request(f.target,{type:'start',key:uncertain.key,spec:uncertain.spec});assert.equal(old.state,'canceled');
    assert.equal((await request(f.target,{type:'inspect',runId:uncertain.spec.runId})).pid,undefined);
  }finally{if(host)await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('durable dispatch, two workers, restart, artifact verification and learned context',async()=>{
  const f=fixture();let host=await start(f.state);
  try {
    const a=f.main.dispatch('a',{...f.input,goal:'slow one'}),b=f.main.dispatch('b',{...f.input,goal:'slow two'});
    assert.equal(f.main.dispatch('a',{...f.input,goal:'slow one'}).spec.runId,a.spec.runId);
    assert.throws(()=>f.main.dispatch('a',{...f.input,goal:'different'}),/conflict/);
    await f.main.sync();
    await until(async()=>{const x=await request(f.target,{type:'inspect',runId:a.spec.runId});const y=await request(f.target,{type:'inspect',runId:b.spec.runId});return x.state==='running'&&y.state==='running';});
    host.kill('SIGKILL');await once(host,'exit'); // detached runners must survive a supervisor crash
    await delay(2800);host=await start(f.state);
    await until(async()=>{await f.main.sync();return f.main.tasks().every(t=>t.status==='ready');});
    assert.throws(()=>f.main.accept(a.spec.taskId,['checked']),/retrieved/);
    const artifacts=await f.main.collect(a.spec.taskId);assert.match(readFileSync(join(artifacts.directory,'changes.patch'),'utf8'),/result.txt/);
    f.main.accept(a.spec.taskId,['Inspected the patch and result.txt']);
    f.main.review(a.spec.taskId,'retain','This fixture creates result.txt',0);
    const isolated=f.main.dispatch('unrelated',{...f.input,taskKey:'independent'});
    assert.equal(isolated.spec.knowledge.length,0,'Retaining a discovery must not broadcast it to unrelated work');
    f.main.cancel(isolated.spec.taskId);
    const next=f.main.dispatch('next',{...f.input,knowledgeIds:f.main.knowledge().map(k=>k.id)});assert.equal(next.spec.knowledge.length,1);
    f.main.db.close();
    const reopened=new Main(join(f.root,'main'),f.owner,f.target,f.repo);assert.equal(reopened.knowledge().length,1);assert.equal(reopened.task(a.spec.taskId).status,'accepted');
    reopened.cancel(next.spec.taskId);await reopened.sync();assert.equal(reopened.task(next.spec.taskId).status,'canceled');reopened.db.close();
  }finally{await stop(host);try{f.main.db.close();}catch{}rmSync(f.root,{recursive:true,force:true});}
});

test('correcting task A during concurrent execution leaves task B valid and independently acceptable',async()=>{
  const f=fixture(),host=await start(f.state);
  try{
    const a=f.main.context.record('a',{appliesTo:{type:'task',taskKey:'a'},kind:'constraint',content:'Task A uses original format.',quote:'Use the original format for A.',shareWithWorkers:true});
    const b=f.main.context.record('b',{appliesTo:{type:'task',taskKey:'b'},kind:'constraint',content:'Task B uses original format.',quote:'Use the original format for B.',shareWithWorkers:true});
    const one=f.main.dispatch('one',{...f.input,goal:'slow A',taskKey:'a',contextIds:[a.id]});
    const two=f.main.dispatch('two',{...f.input,goal:'slow B',taskKey:'b',contextIds:[b.id]});await f.main.sync();
    await until(async()=>{const x=await request(f.target,{type:'inspect',runId:one.spec.runId}),y=await request(f.target,{type:'inspect',runId:two.spec.runId});return x.state==='running'&&y.state==='running';});
    f.main.context.update(a.id,1,{content:'Task A uses corrected format.',quote:'Correct A only.',shareWithWorkers:true});
    await until(async()=>{await f.main.sync();return f.main.tasks().every(t=>t.status==='ready');});
    await f.main.collect(one.spec.taskId);await f.main.collect(two.spec.taskId);
    assert.throws(()=>f.main.accept(one.spec.taskId,['checked']),/user context changed/);
    assert.equal(f.main.accept(two.spec.taskId,['Checked B independently']).status,'accepted');
    f.main.cancel(one.spec.taskId);await f.main.sync();
    assert.equal(f.main.task(one.spec.taskId).status,'canceled');assert.equal(f.main.task(two.spec.taskId).status,'accepted');
    assert.equal(f.main.context.get(b.id).version,1);
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('one conversation adds work during execution, revises only A, and explicitly completes multi-run user tasks',async()=>{
  const f=fixture(),host=await start(f.state);
  try{
    const a=f.main.createUserTask('payments',{taskKey:'payments',title:'Fix payments',goal:'Restore payments',acceptance:['Payment fix and regression verification are delivered']});
    const b=f.main.createUserTask('homepage',{taskKey:'homepage',title:'Speed up homepage',goal:'Improve homepage speed',acceptance:['Homepage result is delivered']});
    const old=f.main.dispatch('diagnose',{...f.input,userTaskId:a.id,expectedRevision:1,goal:'slow payment investigation'});
    const home=f.main.dispatch('speed',{...f.input,userTaskId:b.id,expectedRevision:1,goal:'slow homepage optimization'});
    const submitted=await f.main.submit('speed',{...f.input,userTaskId:b.id,expectedRevision:1,goal:'slow homepage optimization'});
    assert.equal(submitted.executionId,home.spec.taskId);assert.equal(submitted.delivery.length,0);
    assert.ok(await request(f.target,{type:'inspect',runId:home.spec.runId}),'Submit attempts delivery without a separate model sync call');
    await until(async()=>{const x=await request(f.target,{type:'inspect',runId:old.spec.runId}),y=await request(f.target,{type:'inspect',runId:home.spec.runId});return x.state==='running'&&y.state==='running';});
    const revised=f.main.updateUserTask(a.id,1,{goal:'Restore payments including refunds',reason:'The user added refunds while the workers were running.'});
    const c=f.main.createUserTask('docs',{taskKey:'docs',title:'Document setup',goal:'Explain setup',acceptance:['Setup instructions are delivered']});
    const docs=f.main.dispatch('document',{...f.input,userTaskId:c.id,expectedRevision:1,goal:'write setup instructions'});
    assert.equal(f.main.userTask(b.id).revision,1);
    assert.throws(()=>f.main.dispatch('unsafe-replacement',{...f.input,userTaskId:a.id,expectedRevision:2}),/confirm old/);
    await f.main.sync();
    await until(async()=>{await f.main.sync();return [old,home,docs].every(e=>f.main.task(e.spec.taskId).status==='ready');});
    await f.main.collect(old.spec.taskId);
    assert.throws(()=>f.main.accept(old.spec.taskId,['Inspected old result']),/revision changed/);
    f.main.cancel(old.spec.taskId);await f.main.sync();f.main.review(old.spec.taskId,'discard');
    const fix=f.main.dispatch('fix',{...f.input,userTaskId:a.id,expectedRevision:2,goal:'implement payment and refund fix'});
    const verify=f.main.dispatch('verify',{...f.input,userTaskId:a.id,expectedRevision:2,goal:'verify payment and refund behavior'});
    assert.equal(f.main.userTaskSummary(revised).executions.total,3);
    await f.main.sync();
    // The other user tasks can finish while A's follow-up executions are pending.
    for(const e of [home,docs]){await f.main.collect(e.spec.taskId);f.main.accept(e.spec.taskId,['Verified the fixture patch']);f.main.review(e.spec.taskId,'discard');}
    assert.equal(f.main.userTask(b.id).status,'active','Accepting a worker result must not complete the user task');
    assert.throws(()=>f.main.completeUserTask(b.id,1,['done'],[docs.spec.taskId]),/this task/);
    assert.equal(f.main.completeUserTask(b.id,1,['Inspected homepage result'],[home.spec.taskId]).status,'completed');
    await until(async()=>{await f.main.sync();return [fix,verify].every(e=>f.main.task(e.spec.taskId).status==='ready');});
    assert.throws(()=>f.main.completeUserTask(a.id,2,['done'],[fix.spec.taskId]),/unaccepted|unreviewed/);
    for(const e of [fix,verify]){
      const artifact=await f.main.collect(e.spec.taskId);assert.match(readFileSync(join(artifact.directory,'changes.patch'),'utf8'),/result.txt/);
      f.main.accept(e.spec.taskId,['Verified result.txt contains the assigned execution goal']);f.main.review(e.spec.taskId,'discard');
    }
    assert.throws(()=>f.main.completeUserTask(a.id,2,['done'],[old.spec.taskId]),/current revision/);
    const done=f.main.completeUserTask(a.id,2,['Inspected both fix and verification results'],[fix.spec.taskId,verify.spec.taskId]);
    assert.equal(done.status,'completed');assert.equal(done.completion?.executionIds.length,2);
    const reopened=f.main.updateUserTask(a.id,done.version,{goal:'Also support partial refunds',reason:'The user added a new requirement after completion.'});
    assert.equal(reopened.status,'active');assert.equal(reopened.revision,3);assert.equal(reopened.completion,undefined);
    assert.throws(()=>f.main.completeUserTask(a.id,reopened.version,['old work'],[fix.spec.taskId]),/current revision/);
    assert.equal(f.main.userTask(b.id).status,'completed');assert.equal(f.main.userTask(c.id).status,'active');
    assert.equal(f.main.userTasks().length,3);assert.equal(f.main.tasks().length,5);
    const repeat=f.main.updateUserTask(b.id,2,{status:'active',reason:'The user explicitly requested another iteration of the same task.'});
    assert.equal(repeat.goal,b.goal);assert.equal(repeat.revision,2);assert.equal(repeat.completion,undefined);
    assert.throws(()=>f.main.completeUserTask(b.id,repeat.version,['old result'],[home.spec.taskId]),/current revision/);
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('cancellation tombstone rejects late launch and live cancellation is confirmed',async()=>{
  const f=fixture();const host=await start(f.state);
  try{
    const t=f.main.dispatch('a',{...f.input,goal:'slow cancel'});
    await request(f.target,{type:'cancel',runId:t.spec.runId});
    await assert.rejects(request(f.target,{type:'start',key:'late',spec:t.spec}),/tombstone/);
    f.main.cancel(t.spec.taskId);await f.main.sync();
    const active=f.main.dispatch('b',{...f.input,goal:'slow active'});await f.main.sync();
    await until(async()=>(await request(f.target,{type:'inspect',runId:active.spec.runId})).state==='running');
    f.main.cancel(active.spec.taskId);await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.task(active.spec.taskId).status==='canceled';});
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('one malformed event does not block another run; owner binding cannot be spoofed',async()=>{
  const f=fixture();const host=new Host(f.state);
  try{
    const a=f.main.dispatch('a',f.input),b=f.main.dispatch('b',f.input);
    host.db.event(a.spec.runId,{spec:{...a.spec,revision:2},state:'succeeded'});
    host.db.event(b.spec.runId,{spec:b.spec,state:'succeeded',created:Date.now(),report:{summary:'ok',evidence:[],discoveries:[],unresolved:[]}});
    host.db.close();const processHost=await start(f.state);
    try{await f.main.sync();assert.equal(f.main.task(b.spec.taskId).learning,'pending');
      const other=new Main(join(f.root,'main'),{...f.owner,session:id()},f.target,f.repo);
      assert.equal(other.tasks().length,0);assert.throws(()=>other.task(b.spec.taskId),/owned/);other.db.close();
    }finally{for(const t of f.main.tasks())f.main.cancel(t.spec.taskId);await f.main.sync();await delay(500);await stop(processHost);}
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('changed knowledge prevents accepting stale execution',async()=>{
  const f=fixture();const host=await start(f.state);
  try{
    const first=f.main.dispatch('first',f.input);await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.task(first.spec.taskId).status==='ready';});
    f.main.review(first.spec.taskId,'retain','original fact',0);
    const next=f.main.dispatch('next',{...f.input,knowledgeIds:f.main.knowledge().map(k=>k.id)});await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.task(next.spec.taskId).status==='ready';});
    await f.main.collect(next.spec.taskId);
    const k=f.main.knowledge()[0]!;f.main.invalidate(k.id,k.version);
    assert.throws(()=>f.main.accept(next.spec.taskId,['checked']),/knowledge changed/);
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a user correction blocks queued snapshots and rejects already completed results built with old context',async()=>{
  const f=fixture(),host=await start(f.state);
  try{
    const note=f.main.context.record('constraint',{appliesTo:{type:'project'},kind:'constraint',content:'Use format A.',quote:'Use A for this task.',shareWithWorkers:true});
    const queued=f.main.dispatch('queued',{...f.input,contextIds:[note.id]});
    f.main.context.update(note.id,1,{content:'Use format B.',quote:'Correction: use B.',shareWithWorkers:true});
    await f.main.sync();assert.equal(f.main.task(queued.spec.taskId).status,'blocked_context');
    assert.equal(await request(f.target,{type:'inspect',runId:queued.spec.runId}),null);
    f.main.cancel(queued.spec.taskId);await f.main.sync();assert.equal(f.main.task(queued.spec.taskId).status,'canceled');
    const running=f.main.dispatch('fresh',{...f.input,contextIds:[note.id]});await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.task(running.spec.taskId).status==='ready';});
    await f.main.collect(running.spec.taskId);
    f.main.context.update(note.id,2,{content:'Use format C.',quote:'New correction: use C.',shareWithWorkers:true});
    assert.throws(()=>f.main.accept(running.spec.taskId,['checked']),/user context changed/);
    assert.equal(f.main.task(running.spec.taskId).spec.userContext?.[0]?.content,'Use format B.');
    const next=f.main.dispatch('latest',{...f.input,contextIds:[note.id]});assert.equal(next.spec.userContext?.[0]?.content,'Use format C.');
    f.main.cancel(next.spec.taskId);await f.main.sync();
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a correction after a lost start acknowledgement does not erase or duplicate the existing remote run',async()=>{
  const f=fixture(),host=await start(f.state);
  try{
    const note=f.main.context.record('constraint',{appliesTo:{type:'project'},kind:'constraint',content:'Use A.',quote:'Use A.',shareWithWorkers:true});
    const t=f.main.dispatch('uncertain',{...f.input,goal:'slow existing run',contextIds:[note.id]});
    // Host accepted the start, but the local outbox has not received its acknowledgement.
    await request(f.target,{type:'start',key:t.key,spec:t.spec});
    f.main.context.update(note.id,1,{content:'Use B.',quote:'Correction: B.',shareWithWorkers:true});
    await f.main.sync();
    assert.ok((await request(f.target,{type:'inspect',runId:t.spec.runId})).spec);
    assert.equal(f.main.tasks().length,1);
    assert.ok(f.main.brief().items[0]?.actions.includes('inspect_and_cancel_old_run_before_replacement'));
    f.main.cancel(t.spec.taskId);await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.task(t.spec.taskId).status==='canceled';});
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('a second supervisor cannot take over a live Host',async()=>{
  const f=fixture();const host=await start(f.state);
  try{
    const second=spawn(process.execPath,[resolve('src/cli.ts'),'host','serve','--state',f.state],{stdio:['ignore','pipe','pipe']});
    let error='';second.stderr.on('data',b=>error+=b.toString());const [code]=await once(second,'exit');
    assert.equal(code,1);assert.match(error,/lock is active/);
    assert.equal((await request(f.target,{type:'probe'})).protocol,1);
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('corrupt artifact blocks only its task; canceling finished work confirms stop without erasing outcome',async()=>{
  const f=fixture();const host=await start(f.state);
  try{
    const a=f.main.dispatch('a',f.input),b=f.main.dispatch('b',f.input);await f.main.sync();
    await until(async()=>{await f.main.sync();return f.main.tasks().every(t=>t.status==='ready');});
    writeFileSync(join(f.state,'runs',a.spec.runId,'changes.patch'),'corrupt');
    await assert.rejects(f.main.collect(a.spec.taskId),/hash mismatch|Empty artifact/);
    assert.throws(()=>f.main.accept(a.spec.taskId,['claimed']),/retrieved/);
    await f.main.collect(b.spec.taskId);assert.equal(f.main.accept(b.spec.taskId,['checked']).status,'accepted');
    f.main.cancel(a.spec.taskId);await f.main.sync();assert.equal(f.main.task(a.spec.taskId).status,'canceled');
    assert.equal(f.main.task(a.spec.taskId).run?.state,'succeeded');
  }finally{await stop(host);f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});
