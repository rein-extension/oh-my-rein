import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Main } from '../src/main.ts';
import { Host, HostPaused, readConfig, updateRun } from '../src/host.ts';
import type { Run } from '../src/host.ts';
import { execute } from '../src/runner.ts';
import { id, MAX_FRAME, Report } from '../src/protocol.ts';
import type { HostSettings } from '../src/protocol.ts';
import { Redactor, workerEnvironment } from '../src/worker-environment.ts';
import { installHostConfiguration } from '../src/host-installation.ts';
import { hostConfigDigest, legacyHostConfigDigest } from '../src/permissions.ts';
import type { WorkerSession } from '../src/worker-session.ts';
import { reinTools } from '../src/tools.ts';

async function fixture(adapter:'codex'|'claude'|'pi'='codex',permissionMode:HostSettings['permissionMode']='read-only'){
  const root=mkdtempSync('/tmp/rein-turns-'),repo=join(root,'repo'),state=join(root,'host');mkdirSync(repo);mkdirSync(state);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');writeFileSync(join(repo,'README'),'test\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','init');
  const executable=join(root,'fake-worker.mjs');
  writeFileSync(executable,`#!${process.execPath}
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
let input='';for await(const c of process.stdin)input+=c;
const spec=JSON.parse(input.trim().split('\\n').at(-1)),args=process.argv.slice(2),adapter=${JSON.stringify(adapter)};
const arg=k=>args[args.indexOf(k)+1];
const resume=spec.worker.turn>1;
if(spec.goal==='long-running check')await new Promise(r=>setTimeout(r,350));
let nativeId=resume?(adapter==='codex'?args.at(-2):adapter==='claude'?arg('--resume'):JSON.parse(readFileSync(arg('--session'),'utf8').split('\\n')[0]).id):(adapter==='codex'?randomUUID():arg('--session-id'));
const file=adapter==='codex'?join(process.env.CODEX_HOME,'sessions',nativeId+'.jsonl'):adapter==='claude'?join(process.env.CLAUDE_CONFIG_DIR,'projects','fake',nativeId+'.jsonl'):resume?arg('--session'):join(arg('--session-dir'),nativeId+'.jsonl');
let remembered=resume?JSON.parse(readFileSync(file,'utf8').split('\\n')[0]).remembered:randomUUID();
mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({type:'session',id:nativeId,remembered})+'\\n');
if(resume&&!readFileSync('progress.txt','utf8').includes(remembered))throw Error('Workspace or history lost');
writeFileSync('progress.txt',remembered+' turn '+spec.worker.turn+' '+(spec.worker.answers?.[0]?.answer??''));
const secret=process.env.OPENAI_API_KEY??'no provider',leaked=process.env.REIN_UNRELATED_SECRET??'not inherited';
const report={summary:spec.goal==='env'?secret+' '+leaked:'remembered '+remembered,evidence:spec.goal==='oversize'?['x'.repeat(17*1024*1024)]:['Checked workspace'],discoveries:spec.goal==='discover'?[{content:'The fixture writes progress.txt',source:'progress.txt',verified:true}]:[],unresolved:[],questions:resume||['finish','discover','long-running check'].includes(spec.goal)?[]:spec.goal==='permission'?[{id:'write',text:'May I update the output?',permission:{operation:'write file',target:'result.csv',reason:'Produce the requested output',scope:'workspace-write'}}]:[{id:'format',text:'Which format?'}]};
let output;
if(adapter==='codex'){writeFileSync(arg('--output-last-message'),JSON.stringify(report));output=JSON.stringify({type:'thread.started',thread_id:nativeId})+'\\n'+JSON.stringify({type:'result',summary:report.summary})+'\\n';}
else if(adapter==='claude')output=JSON.stringify({type:'result',subtype:'success',session_id:nativeId,result:JSON.stringify(report)});
else output=[{type:'session',id:nativeId},{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(report)}]}},{type:'agent_settled',aborted:false}].map(x=>JSON.stringify(x)).join('\\n');
const cut=output.indexOf(secret)+4;process.stdout.write(output.slice(0,cut));await new Promise(r=>setTimeout(r,5));process.stdout.write(output.slice(cut));
`,{mode:0o700});
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter,executable,permissionMode,concurrency:2,sandbox:'workspace-write'}));
  const host=new Host(state),target={kind:'local' as const,state},owner={harness:'codex',instance:'test',session:id()},main=new Main(join(root,'main'),owner,target,repo);main.mode(true);
  const parent=main.createUserTask('task',{taskKey:'example',title:'Example',goal:'Deliver chosen format',acceptance:['Correct format']});
  const input={userTaskId:parent.id,expectedRevision:1,goal:'Ask format',originalRequest:'Ask me before choosing a format',constraints:[],acceptance:['Correct format'],baseCommit:git('rev-parse','HEAD')};
  const server=createServer(socket=>{let buf='';socket.on('error',()=>{});socket.on('data',b=>{buf+=b;if(!buf.includes('\n'))return;try{socket.end(JSON.stringify({ok:true,value:host.handle(JSON.parse(buf))})+'\n');}catch(e){socket.end(JSON.stringify({ok:false,rejected:!(e instanceof HostPaused),error:(e as Error).message})+'\n');}});});
  await new Promise<void>(resolve=>server.listen(join(state,'host.sock'),resolve));
  const run=async(task:ReturnType<Main['dispatch']>)=>{const r=host.db.get<Run>('runs',task.spec.runId)!;r.state='starting';updateRun(host.db,r);await execute(state,task.spec.runId);};
  return {root,repo,state,host,target,owner,main,parent,input,run,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));main.db.close();host.db.close();rmSync(root,{recursive:true,force:true});}};
}

for(const adapter of ['codex','claude','pi'] as const)test(`${adapter}: durable questions resume one native session, retain workspace and immutable turn artifacts`,async()=>{
  const f=await fixture(adapter);
  try{
    const first=f.main.dispatch('first',f.input);await f.main.sync();await f.run(first);await f.main.sync();
    const old=f.main.task(first.spec.taskId);assert.equal(old.status,'waiting_input');assert.ok(old.run?.nativeSessionId);
    assert.equal(f.host.unsettled().length,0,'Waiting for user input releases execution capacity');
    const artifact=await f.main.collect(first.spec.taskId),patch=readFileSync(join(artifact.directory,'changes.patch'),'utf8');
    await assert.rejects(f.main.continueExecution('bad',{...f.input,previousExecutionId:first.spec.taskId,message:'Continue',answers:[]}),/every pending question/);
    const revised=f.main.context.record('format',{kind:'constraint',content:'Use CSV',quote:'CSV please',shareWithWorkers:true,appliesTo:{type:'task',taskKey:'example'}});
    const followup={goal:'Deliver CSV',originalRequest:'CSV please',constraints:['Use CSV'],acceptance:['Correct format'],expectedRevision:2,previousExecutionId:first.spec.taskId,message:'The user chose CSV',answers:[{questionId:'format',answer:'CSV'}],contextIds:[revised.id]};
    const receipt=await f.main.continueExecution('answer',followup),second=f.main.task(receipt.executionId);
    assert.equal((await f.main.continueExecution('answer',followup)).executionId,receipt.executionId);
    await assert.rejects(f.main.continueExecution('branch',followup),/latest turn/);
    assert.equal(second.spec.worker?.sessionId,first.spec.worker?.sessionId);assert.equal(second.spec.worker?.turn,2);
    assert.equal(f.main.task(first.spec.taskId).status,'continued');
    // Lost local cursor/event receipts are repaired from Host state, not by rerunning.
    await f.run(second);f.main.db.set('cursor','host',999999);await f.main.sync();
    const result=f.main.task(second.spec.taskId);assert.equal(result.status,'ready');assert.equal(result.run?.nativeSessionId,old.run?.nativeSessionId);
    assert.equal(result.run?.report?.summary,old.run?.report?.summary,'Native conversation history survives');
    const final=await f.main.collect(second.spec.taskId);assert.match(readFileSync(join(final.directory,'changes.patch'),'utf8'),/turn 2 CSV/);
    assert.equal(readFileSync(join(artifact.directory,'changes.patch'),'utf8'),patch);
    const other=new Main(f.main.state,{...f.owner,session:id()},f.target,f.repo);other.mode(true);
    try{await assert.rejects(other.continueExecution('hijack',followup),/not owned/);}finally{other.db.close();}
    f.main.review(first.spec.taskId,'discard');f.main.review(second.spec.taskId,'discard');f.main.accept(second.spec.taskId,['Inspected cumulative CSV patch']);
    assert.equal(f.main.completeUserTask(f.parent.id,2,['CSV checked'],[second.spec.taskId]).status,'completed');
  }finally{await f.close();}
});

test('worker environment excludes unrelated secrets and scrubs known credentials across log chunks and reports',async()=>{
  const f=await fixture(),oldKey=process.env.OPENAI_API_KEY,oldSecret=process.env.REIN_UNRELATED_SECRET;
  process.env.OPENAI_API_KEY='synthetic-provider-credential-for-test';process.env.REIN_UNRELATED_SECRET='synthetic-unrelated-credential';
  try{
    const t=f.main.dispatch('env',{...f.input,goal:'env'});await f.main.sync();await f.run(t);await f.main.sync();
    assert.equal(f.main.task(t.spec.taskId).status,'waiting_input');
    const root=join(f.state,'runs',t.spec.runId),report=readFileSync(join(root,'report.json'),'utf8'),log=readFileSync(join(root,'worker.log'),'utf8');
    for(const value of [report,log]){assert.ok(!value.includes(process.env.OPENAI_API_KEY));assert.ok(!value.includes(process.env.REIN_UNRELATED_SECRET));assert.match(value,/REDACTED/);}
    assert.match(report,/not inherited/);
    const env=workerEnvironment(join(f.root,'isolated'));assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.SSH_AUTH_SOCK,undefined);
    const r=new Redactor(['overlapping-secret']);let out='';for(const char of 'xoverlapping-secrety')out+=r.push(char);out+=r.push('',true);assert.equal(out,'x[REDACTED]y');
  }finally{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;if(oldSecret===undefined)delete process.env.REIN_UNRELATED_SECRET;else process.env.REIN_UNRELATED_SECRET=oldSecret;await f.close();}
});

test('oversized reports fail before publication; legacy inspection and duplicate acknowledgements remain frame bounded',async()=>{
  const f=await fixture();
  try{
    const t=f.main.dispatch('large',{...f.input,goal:'oversize'});await f.main.sync();await f.run(t);await f.main.sync();
    assert.equal(f.main.task(t.spec.taskId).status,'failed');assert.match(f.main.task(t.spec.taskId).run!.error!,/size limit/);
    assert.equal(existsSync(join(f.state,'runs',t.spec.runId,'report.json')),false);
    const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='succeeded';run.report={summary:'Legacy',evidence:['x'.repeat(17*1024*1024)],discoveries:[],unresolved:[]};f.host.db.set('runs',t.spec.runId,run);
    for(const command of [{type:'inspect',runId:t.spec.runId},{type:'start',key:t.key,spec:t.spec}]){
      const result=f.host.handle(command) as any;assert.equal(result.reportOmitted,true);assert.ok(Buffer.byteLength(JSON.stringify(result))<MAX_FRAME);
    }
    assert.equal(Report.safeParse(run.report).success,false);
    assert.throws(()=>f.host.handle({type:'start',key:id(),spec:{...t.spec,runId:id(),taskId:id(),worker:{sessionId:id(),turn:1},constraints:Array(50).fill('x'.repeat(8000))}}),/snapshot exceeds/);
  }finally{await f.close();}
});

test('reconciliation heals missing events and malformed receipts; Host replacement blocks pending delivery',async()=>{
  const f=await fixture();
  try{
    const t=f.main.dispatch('lost',f.input);await f.main.sync();await f.run(t);
    const head=f.host.db.eventCursor();f.main.db.set('cursor','host',head);
    f.main.db.set('incoming',String(head),{seq:head,run:t.spec.runId,data:{snapshot:{taskId:t.spec.taskId,digest:'bad'},state:'running'},handled:false});
    await f.main.sync();assert.equal(f.main.task(t.spec.taskId).status,'waiting_input');assert.equal(f.main.db.pendingIncoming().length,0);
    const pending=f.main.dispatch('new',f.input);f.host.db.set('host','epoch',id());
    const status=await f.main.sync() as any;assert.equal(status.sync.state,'unavailable');assert.match(status.sync.error,/identity changed/);
    assert.equal(f.host.db.get('runs',pending.spec.runId),undefined);
  }finally{await f.close();}
});

test('pause holds undelivered work, preserves completed results and resumes without duplicate execution',async()=>{
  const f=await fixture();
  try{
    const t=f.main.dispatch('held',f.input);
    f.main.updateUserTask(f.parent.id,1,{status:'paused',reason:'Pause scheduling'});await f.main.sync();
    assert.equal(f.host.db.get('runs',t.spec.runId),undefined);assert.equal(f.main.task(t.spec.taskId).status,'queued');
    assert.ok(f.main.db.list<any>('outbox').every(c=>c.type==='start'&&c.attempts===0));
    f.main.updateUserTask(f.parent.id,2,{status:'active',reason:'Resume scheduling'});await f.main.sync();await f.run(t);await f.main.sync();
    const ready=f.main.task(t.spec.taskId);assert.equal(ready.status,'waiting_input');
    const report=ready.run!.report;f.main.updateUserTask(f.parent.id,3,{status:'paused',reason:'Discuss another task'});await f.main.sync();
    assert.deepEqual(f.main.task(t.spec.taskId).run!.report,report);assert.equal(f.main.task(t.spec.taskId).cancelRequested,false);
    f.main.updateUserTask(f.parent.id,4,{status:'active',reason:'Continue discussion'});await f.main.sync();
    assert.equal(f.host.db.list('runs').length,1);assert.equal(f.main.task(t.spec.taskId).status,'waiting_input');
  }finally{await f.close();}
});

test('missing native session fails the new turn instead of silently starting a fresh conversation',async()=>{
  const f=await fixture();
  try{
    const t=f.main.dispatch('first',f.input);await f.main.sync();await f.run(t);await f.main.sync();
    const original=f.main.task(t.spec.taskId),native=original.run!.nativeSessionId!;
    rmSync(join(f.state,'sessions',t.spec.worker!.sessionId,'codex-home','sessions',native+'.jsonl'));
    const next=await f.main.continueExecution('next',{...f.input,previousExecutionId:t.spec.taskId,message:'Use CSV',answers:[{questionId:'format',answer:'CSV'}]});
    await f.run(f.main.task(next.executionId));await f.main.sync();
    const failed=f.main.task(next.executionId);assert.equal(failed.status,'failed');assert.match(failed.run!.error!,/session is missing/);
    assert.match(readFileSync(join(f.state,'sessions',t.spec.worker!.sessionId,'workspace','progress.txt'),'utf8'),/turn 1/);
  }finally{await f.close();}
});

test('revoking shared context prevents resuming a native history that still contains it',async()=>{
  const f=await fixture();
  try{
    const note=f.main.context.record('note',{kind:'constraint',content:'This task uses the confidential prototype format',quote:'This task uses the confidential prototype format',shareWithWorkers:true,requiredForTask:false,appliesTo:{type:'task',taskKey:'example'}});
    const t=f.main.dispatch('first',{...f.input,contextIds:[note.id]});await f.main.sync();await f.run(t);await f.main.sync();
    f.main.context.update(note.id,1,{content:note.content,quote:note.quote,shareWithWorkers:false,requiredForTask:false});
    await assert.rejects(f.main.continueExecution('next',{...f.input,previousExecutionId:t.spec.taskId,message:'Use CSV',answers:[{questionId:'format',answer:'CSV'}]}),/history contains context now marked local-only/);
    assert.equal(f.main.tasks().length,1);
  }finally{await f.close();}
});

for(const boundary of ['queued','acceptance'] as const)test(`revocation after continuation ${boundary} checks historical context IDs even when the text changes`,async()=>{
  const f=await fixture();let reopened:Main|undefined;
  try{
    const note=f.main.context.record('short',{kind:'constraint',content:'CSV',quote:'CSV',shareWithWorkers:true,requiredForTask:false,appliesTo:{type:'task',taskKey:'example'}});
    const first=f.main.dispatch('first',{...f.input,contextIds:[note.id]});await f.main.sync();await f.run(first);await f.main.sync();
    const second=f.main.dispatch('second',{...f.input,previousExecutionId:first.spec.taskId,message:'Use CSV',answers:[{questionId:'format',answer:'CSV'}]});
    assert.equal(second.spec.userContext?.length??0,0);
    if(boundary==='acceptance'){await f.main.sync();await f.run(second);await f.main.sync();await f.main.collect(second.spec.taskId);}
    f.main.context.update(note.id,1,{content:'JSONL',quote:'Keep this local now',shareWithWorkers:false,requiredForTask:false});
    reopened=new Main(f.main.state,f.owner,f.target,f.repo);
    const changes=reopened.contextChanges(second.spec);assert.deepEqual(changes.localOnly,[note.id]);
    if(boundary==='queued'){
      await reopened.sync();assert.equal(f.host.db.get('runs',second.spec.runId),undefined);
      assert.equal(reopened.task(second.spec.taskId).status,'blocked_context');
      assert.equal(reopened.db.list<any>('outbox').find(c=>c.taskId===second.spec.taskId).attempts,0);
    }else assert.throws(()=>reopened!.accept(second.spec.taskId,['Checked']),/native worker history contains local-only/);
    // Revocation is confined to the session which received the note.
    const independent=reopened.dispatch('independent',{...f.input,goal:'finish'});await reopened.sync();
    assert.ok(f.host.db.get('runs',independent.spec.runId));
  }finally{reopened?.db.close();await f.close();}
});

async function retainDiscovery(f:Awaited<ReturnType<typeof fixture>>,verificationEvidence?:string[]){
  const source=f.main.dispatch('discovery',{...f.input,goal:'discover'});await f.main.sync();await f.run(source);await f.main.sync();await f.main.collect(source.spec.taskId);
  f.main.accept(source.spec.taskId,['Checked fixture output']);
  f.main.review(source.spec.taskId,'retain','The fixture writes progress.txt',0,verificationEvidence);
  return f.main.knowledge()[0]!;
}

for(const boundary of ['enqueue','queued','acceptance','completion'] as const)test(`invalidated knowledge cannot disappear from native history at ${boundary}`,async()=>{
  const f=await fixture();let reopened:Main|undefined;
  try{
    const fact=await retainDiscovery(f);
    const first=f.main.dispatch('first',{...f.input,goal:'finish',knowledgeIds:[fact.id]});await f.main.sync();await f.run(first);await f.main.sync();
    const followup={...f.input,goal:'finish',previousExecutionId:first.spec.taskId,message:'Continue without selecting the old fact',knowledgeIds:[]};
    if(boundary==='enqueue'){
      f.main.invalidate(fact.id,1);
      assert.throws(()=>f.main.dispatch('second',followup),/history references knowledge changed/);
    }else{
      const second=f.main.dispatch('second',followup);assert.deepEqual(second.spec.knowledge,[]);
      if(boundary!=='queued'){
        await f.main.sync();await f.run(second);await f.main.sync();await f.main.collect(second.spec.taskId);
        if(boundary==='completion'){
          f.main.accept(second.spec.taskId,['Checked']);f.main.review(first.spec.taskId,'discard');f.main.review(second.spec.taskId,'discard');
        }
      }
      const invalidated=f.main.invalidate(fact.id,1);assert.ok(invalidated.affected.includes(second.spec.taskId));
      reopened=new Main(f.main.state,f.owner,f.target,f.repo);
      assert.deepEqual(reopened.contextChanges(second.spec).knowledge,[fact.id]);
      if(boundary==='queued'){
        await reopened.sync();assert.equal(f.host.db.get('runs',second.spec.runId),undefined);assert.equal(reopened.task(second.spec.taskId).status,'blocked_context');
      }else if(boundary==='acceptance')assert.throws(()=>reopened!.accept(second.spec.taskId,['Checked']),/knowledge changed/);
      else assert.throws(()=>reopened!.completeUserTask(f.parent.id,1,['Checked'],[second.spec.taskId]),/context changed/);
    }
    const fresh=f.main.dispatch('fresh',{...f.input,goal:'finish'});await f.main.sync();await f.run(fresh);await f.main.sync();await f.main.collect(fresh.spec.taskId);
    assert.equal(f.main.accept(fresh.spec.taskId,['Checked in a fresh session']).status,'accepted');
    assert.notEqual(fresh.spec.worker!.sessionId,first.spec.worker!.sessionId);
  }finally{reopened?.db.close();await f.close();}
});

test('missing or cross-owner ancestry fails closed and future turns do not contaminate earlier evidence',async()=>{
  const f=await fixture();
  try{
    const first=f.main.dispatch('first',{...f.input,goal:'finish'});await f.main.sync();await f.run(first);await f.main.sync();
    const fact=await retainDiscovery(f);
    const second=f.main.dispatch('second',{...f.input,goal:'finish',previousExecutionId:first.spec.taskId,message:'Continue',knowledgeIds:[fact.id]});
    f.main.invalidate(fact.id,1);
    assert.deepEqual(f.main.contextChanges(first.spec).knowledge,[],'Later selections are not ancestors');
    const stored=f.main.task(first.spec.taskId);stored.spec.owner={...f.owner,session:id()};f.main.db.set('tasks',first.spec.taskId,stored);
    assert.equal(f.main.contextChanges(second.spec).historyMissing,true);await f.main.sync();
    assert.equal(f.host.db.get('runs',second.spec.runId),undefined);
  }finally{await f.close();}
});

for(const scope of ['project','task'] as const)for(const boundary of ['enqueue','queued','acceptance','completion'] as const)test(`${scope} context revisions remain native-session dependencies at ${boundary}`,async()=>{
  const f=await fixture();let reopened:Main|undefined;
  try{
    const note=f.main.context.record('rule',{kind:'constraint',content:'Export as CSV',quote:'Export as CSV',shareWithWorkers:true,requiredForTask:false,appliesTo:scope==='project'?{type:'project'}:{type:'task',taskKey:'example'}});
    const first=f.main.dispatch('first',{...f.input,goal:'finish',contextIds:[note.id]});await f.main.sync();await f.run(first);await f.main.sync();
    const followup={...f.input,goal:'finish',previousExecutionId:first.spec.taskId,message:'Continue the export',contextIds:[]};
    const revise=()=>f.main.context.update(note.id,1,{content:'Export as JSONL',quote:'Export as JSONL',shareWithWorkers:true,requiredForTask:false});
    if(boundary==='enqueue'){
      revise();assert.throws(()=>f.main.dispatch('second',followup),/history contains changed or retired user context/);
      assert.equal(f.main.tasks().length,1);assert.equal(f.main.task(first.spec.taskId).continuedBy,undefined);
    }else{
      const second=f.main.dispatch('second',followup);assert.equal(second.spec.userContext,undefined);
      if(boundary!=='queued'){
        await f.main.sync();await f.run(second);await f.main.sync();await f.main.collect(second.spec.taskId);
        if(boundary==='completion'){
          f.main.accept(second.spec.taskId,['Checked']);f.main.review(first.spec.taskId,'discard');f.main.review(second.spec.taskId,'discard');
        }
      }
      revise();reopened=new Main(f.main.state,f.owner,f.target,f.repo);
      assert.deepEqual(reopened.contextChanges(second.spec).userContext,[note.id]);
      if(boundary==='queued'){
        await reopened.sync();assert.equal(f.host.db.get('runs',second.spec.runId),undefined);assert.equal(reopened.task(second.spec.taskId).status,'blocked_context');
      }else if(boundary==='acceptance')assert.throws(()=>reopened!.accept(second.spec.taskId,['Checked']),/user context changed/);
      else assert.throws(()=>reopened!.completeUserTask(f.parent.id,1,['Checked'],[second.spec.taskId]),/context changed/);
    }
    const unrelated=f.main.dispatch('unrelated',{...f.input,goal:'finish'});assert.deepEqual(f.main.contextChanges(unrelated.spec).userContext,[]);
    await f.main.sync();assert.ok(f.host.db.get('runs',unrelated.spec.runId));
  }finally{reopened?.db.close();await f.close();}
});

test('an explicitly corrected context version supersedes older history and is inherited by subsequent turns',async()=>{
  const f=await fixture();
  try{
    const note=f.main.context.record('rule',{kind:'constraint',content:'Use CSV',quote:'Use CSV',shareWithWorkers:true,appliesTo:{type:'project'}});
    const first=f.main.dispatch('first',{...f.input,goal:'finish',contextIds:[note.id]});await f.main.sync();await f.run(first);await f.main.sync();
    f.main.context.update(note.id,1,{content:'Use JSONL',quote:'Use JSONL',shareWithWorkers:true});
    const second=f.main.dispatch('second',{...f.input,goal:'finish',previousExecutionId:first.spec.taskId,message:'Use the corrected JSONL requirement',contextIds:[note.id]});
    await f.main.sync();await f.run(second);await f.main.sync();
    const third=f.main.dispatch('third',{...f.input,goal:'finish',previousExecutionId:second.spec.taskId,message:'Finish with the corrected requirement'});
    await f.main.sync();await f.run(third);await f.main.sync();await f.main.collect(third.spec.taskId);
    assert.equal(first.spec.userContext![0]!.version,1);assert.equal(second.spec.userContext![0]!.version,2);assert.equal(third.spec.userContext,undefined);
    assert.deepEqual(f.main.contextChanges(first.spec).userContext,[note.id]);assert.deepEqual(f.main.contextChanges(third.spec).userContext,[]);
    f.main.accept(third.spec.taskId,['Checked']);for(const t of [first,second,third])f.main.review(t.spec.taskId,'discard');
    assert.equal(f.main.completeUserTask(f.parent.id,1,['Checked'],[third.spec.taskId]).status,'completed');
  }finally{await f.close();}
});

test('retiring previously selected optional context requires a fresh session',async()=>{
  const f=await fixture();
  try{
    const note=f.main.context.record('rule',{kind:'constraint',content:'Use CSV',quote:'Use CSV',shareWithWorkers:true,appliesTo:{type:'project'}});
    const first=f.main.dispatch('first',{...f.input,goal:'finish',contextIds:[note.id]});await f.main.sync();await f.run(first);await f.main.sync();
    f.main.context.retire(note.id,1,'Withdraw this agreement');
    assert.throws(()=>f.main.dispatch('second',{...f.input,previousExecutionId:first.spec.taskId,message:'Continue'}),/changed or retired/);
    const fresh=f.main.dispatch('fresh',{...f.input,goal:'finish'});await f.main.sync();await f.run(fresh);await f.main.sync();await f.main.collect(fresh.spec.taskId);
    assert.equal(f.main.accept(fresh.spec.taskId,['Checked fresh work']).status,'accepted');
  }finally{await f.close();}
});

for(const record of ['current','legacy','canceled-legacy'] as const)test(`${record}: rejected continuation can be reviewed without inventing a worker result and no longer blocks task completion`,async()=>{
  const f=await fixture();let reopened:Main|undefined;
  try{
    const first=f.main.dispatch('first',{...f.input,goal:'finish'});await f.main.sync();await f.run(first);await f.main.sync();await f.main.collect(first.spec.taskId);
    f.main.accept(first.spec.taskId,['Checked']);f.main.review(first.spec.taskId,'discard');
    f.host.config.model='different-model';writeFileSync(join(f.state,'host.json'),JSON.stringify(f.host.config));
    const rejected=f.main.dispatch('rejected',{...f.input,goal:'finish',previousExecutionId:first.spec.taskId,message:'Continue'});await f.main.sync();
    const failed=f.main.task(rejected.spec.taskId);assert.equal(failed.status,'failed');assert.equal(failed.run,undefined);assert.equal(failed.learning,'pending');
    assert.equal(failed.startRejection!.source,'host');assert.match(failed.startRejection!.reason,/configuration changed/);assert.ok(failed.startRejection!.recordedAt);
    assert.equal(f.main.task(first.spec.taskId).continuedBy,undefined);
    if(record!=='current'){delete failed.startRejection;f.main.db.set('tasks',failed.spec.taskId,failed);}
    if(record==='canceled-legacy'){f.main.cancel(failed.spec.taskId);await f.main.sync();assert.equal(f.main.task(failed.spec.taskId).status,'canceled');}
    const replacement=f.main.dispatch('replacement',{...f.input,goal:'finish'});await f.main.sync();await f.run(replacement);await f.main.sync();await f.main.collect(replacement.spec.taskId);
    f.main.accept(replacement.spec.taskId,['Checked']);f.main.review(replacement.spec.taskId,'discard');
    reopened=new Main(f.main.state,f.owner,f.target,f.repo);
    assert.throws(()=>reopened!.completeUserTask(f.parent.id,1,['Checked'],[replacement.spec.taskId]),/unreviewed/);
    assert.throws(()=>reopened!.review(failed.spec.taskId,'retain','Invented discovery',0),/no worker discoveries/);
    assert.throws(()=>reopened!.accept(failed.spec.taskId,['Checked']),/not ready/);
    await assert.rejects(reopened.collect(failed.spec.taskId),/No published artifacts/);
    const review=reinTools(()=>new Main(f.main.state,f.owner,f.target,f.repo)).find(t=>t.name==='rein_review')!;
    const result=await review.execute({executionId:failed.spec.taskId,decision:'discard'});assert.notEqual(result.isError,true,JSON.stringify(result));
    const reviewed=reopened.task(failed.spec.taskId);assert.equal(reviewed.learning,'discarded');assert.equal(reviewed.run,undefined);
    assert.equal(reviewed.startRejection!.source,record==='current'?'host':'legacy-ledger');assert.match(reviewed.startRejection!.reason,/configuration changed/);
    assert.throws(()=>reopened!.review(failed.spec.taskId,'discard'),/already been reviewed/);
    assert.equal(reopened.completeUserTask(f.parent.id,1,['Checked'],[replacement.spec.taskId]).status,'completed');
  }finally{reopened?.db.close();await f.close();}
});

test('retention separates worker claims, main review and main-reported validation, including legacy knowledge',async()=>{
  for(const evidence of [undefined,['Read the collected patch and checked progress.txt was created']]){
    const f=await fixture();
    try{
      const fact=await retainDiscovery(f,evidence);
      assert.equal(fact.workerClaimedVerified,true);assert.equal(fact.verified,!!evidence);
      assert.deepEqual(fact.review?.by,f.owner);assert.ok(fact.review!.at>0);
      assert.deepEqual(fact.verification,{status:evidence?'main-reported':'unverified',evidence:evidence??[]});
      const forwarded=f.main.dispatch('selected',{...f.input,knowledgeIds:[fact.id]});assert.equal(forwarded.spec.knowledge[0]!.verified,!!evidence);
      const legacy={...fact,id:id(),verified:true};delete legacy.verification;delete legacy.review;delete legacy.workerClaimedVerified;
      f.main.db.set('knowledge',legacy.id,legacy);
      const normalized=f.main.knowledgeEntry(legacy.id);assert.equal(normalized.workerClaimedVerified,true);assert.equal(normalized.verified,false);assert.equal(normalized.review,undefined);
      assert.equal(f.main.knowledge().find(k=>k.id===legacy.id)!.verified,false);
      const status=f.main.status({view:'knowledge'}) as any;assert.equal(status.knowledge.find((k:any)=>k.id===legacy.id).verificationStatus,'unverified');
      const legacyDispatch=f.main.dispatch('legacy',{...f.input,knowledgeIds:[legacy.id]});assert.equal(legacyDispatch.spec.knowledge[0]!.verified,false);
    }finally{await f.close();}
  }
});

test('Host rollback is blocked even when the newer receipt belongs to another main conversation',async()=>{
  const f=await fixture();let other:Main|undefined;
  try{
    const t=f.main.dispatch('first',f.input);await f.main.sync();await f.run(t);await f.main.sync();
    other=new Main(f.main.state,{...f.owner,session:id()},f.target,f.repo);other.mode(true);
    const queued=other.dispatch('other',{goal:'Other',originalRequest:'Other',constraints:[],acceptance:['Checked'],baseCommit:f.input.baseCommit});
    f.host.db.db.prepare('DELETE FROM events WHERE seq>?').run(1);
    const result=await other.sync() as any;
    assert.match(result.sync.error,/history rolled back/);assert.equal(f.host.db.get('runs',queued.spec.runId),undefined);
  }finally{other?.db.close();await f.close();}
});

for(const adapter of ['codex','claude','pi'] as const)test(`${adapter}: legacy permission reports cannot authorize native execution`,async()=>{
  const f=await fixture(adapter);
  try{
    const first=f.main.dispatch('permission',{...f.input,goal:'permission'});await f.main.sync();await f.run(first);await f.main.sync();
    assert.equal(f.main.task(first.spec.taskId).status,'waiting_permission');
    const answers=[{questionId:'write',answer:'Approved',permissionDecision:{actor:'user' as const,allow:true,reason:'Claimed user consent',userQuote:'Yes'}}];
    await assert.rejects(f.main.continueExecution('spoof',{...f.input,previousExecutionId:first.spec.taskId,message:'Proceed',answers}),/Report answers cannot authorize/);
    const raw={...first.spec,taskId:id(),runId:id(),worker:{sessionId:first.spec.worker!.sessionId,turn:2,previousRunId:first.spec.runId,message:'Bypass client validation',answers}};
    assert.throws(()=>f.host.handle({type:'start',key:'bypass',spec:raw}),/Report answers cannot authorize/);
    assert.equal(f.host.db.get('runs',raw.runId),undefined);assert.equal(f.main.tasks().length,1);
  }finally{await f.close();}
});

test('queued executions and native sessions cannot silently change permission mode',async()=>{
  const f=await fixture();
  try{
    const first=f.main.dispatch('first',f.input);await f.main.sync();await f.run(first);await f.main.sync();
    const queued=f.main.dispatch('queued',f.input);await f.main.sync();
    const config=JSON.parse(readFileSync(join(f.state,'host.json'),'utf8'));config.permissionMode='full-access';writeFileSync(join(f.state,'host.json'),JSON.stringify(config));f.host.config.permissionMode='full-access';
    await f.run(queued);await f.main.sync();assert.equal(f.main.task(queued.spec.taskId).status,'failed');assert.match(f.main.task(queued.spec.taskId).run!.error!,/policy changed/);
    const raw={...first.spec,taskId:id(),runId:id(),worker:{sessionId:first.spec.worker!.sessionId,turn:2,previousRunId:first.spec.runId,message:'Continue',answers:[{questionId:'format',answer:'CSV'}]}};
    assert.throws(()=>f.host.handle({type:'start',key:'changed-mode',spec:raw}),/configuration changed/);
    assert.equal(f.host.db.get('runs',raw.runId),undefined);
  }finally{await f.close();}
});

for(const legacy of [false,true])test(`a worker finishes after two simulated hours with ${legacy?'an old timeout in host.json':'a new Host config'}`,async t=>{
  const f=await fixture();
  try{
    if(legacy)writeFileSync(join(f.state,'host.json'),JSON.stringify({...f.host.config,timeoutMs:1800000}));
    const task=f.main.dispatch('long',{...f.input,goal:'long-running check'});
    await f.main.sync();
    const running=f.run(task);
    const now=Date.now.bind(Date),twoHours=2*60*60*1000;
    const clock=t.mock.method(Date,'now',()=>now()+twoHours);
    try{await running;}finally{clock.mock.restore();}
    const run=f.host.db.get<Run>('runs',task.spec.runId)!;
    assert.ok(run.finished!-run.created>=twoHours);
    assert.equal(run.state,'succeeded',run.error);
    assert.ok(run.artifacts?.['changes.patch']);
  }finally{await f.close();}
});

for(const migration of ['current','legacy','interrupted-legacy'] as const)test(`${migration}: removing the old timeout preserves native resume and checks the runner configuration`,async()=>{
  const f=await fixture();
  try{
    const first=f.main.dispatch('first',f.input);await f.main.sync();await f.run(first);await f.main.sync();
    const native=f.main.task(first.spec.taskId).run!.nativeSessionId,session=f.host.db.get<WorkerSession>('worker-sessions',first.spec.worker!.sessionId)!;
    const config=readConfig(f.state),original={...config,timeoutMs:60000};
    writeFileSync(join(f.state,'host.json'),JSON.stringify(original));
    const plan={config:{...config,concurrency:3},receipt:{digest:'a'.repeat(64),release:'/test/runtime',bridgeCli:'/test/runtime/cli.js',bridgeNode:process.execPath}};
    if(migration!=='current'){session.configDigest=legacyHostConfigDigest(original);f.host.db.set('worker-sessions',session.id,session);}
    const unknown={...session,id:id(),configDigest:'unknown-prior-configuration'};f.host.db.set('worker-sessions',unknown.id,unknown);
    if(migration==='interrupted-legacy'){
      // Files advanced but the SQLite transaction rolled back before commit.
      writeFileSync(join(f.state,'pending-installation.json'),JSON.stringify({...plan,previousConfig:original}));
      writeFileSync(join(f.state,'host.json'),JSON.stringify(plan.config));
    }
    installHostConfiguration(f.state,plan);f.host.config=readConfig(f.state);f.host.handle({type:'maintenance',enabled:false});
    assert.equal(f.host.config.timeoutMs,undefined);
    assert.equal(f.host.db.get<WorkerSession>('worker-sessions',session.id)!.configDigest,hostConfigDigest(plan.config));
    assert.equal(f.host.db.get<WorkerSession>('worker-sessions',unknown.id)!.configDigest,unknown.configDigest,'Unknown digests cannot be migrated by assumption');
    const receipt=await f.main.continueExecution('next',{...f.input,previousExecutionId:first.spec.taskId,message:'Use CSV',answers:[{questionId:'format',answer:'CSV'}]});
    const next=f.main.task(receipt.executionId);await f.run(next);await f.main.sync();
    assert.equal(f.main.task(next.spec.taskId).status,'ready');assert.equal(f.main.task(next.spec.taskId).run!.nativeSessionId,native);
  }finally{await f.close();}
});

test('session compatibility still rejects execution configuration changes and unprovable legacy hashes',async()=>{
  const f=await fixture();
  try{
    const first=f.main.dispatch('first',f.input);await f.main.sync();await f.run(first);await f.main.sync();
    const original={...f.host.config},raw={...first.spec,taskId:id(),runId:id(),worker:{sessionId:first.spec.worker!.sessionId,turn:2,previousRunId:first.spec.runId,message:'Continue',answers:[{questionId:'format',answer:'CSV'}]}};
    const changes:Partial<HostSettings>[]=[{repository:'/other'},{adapter:'pi'},{executable:'/other/bin'},{sandbox:'read-only'},{permissionMode:'delegate'},{model:'other-model'},{provider:'other-provider'},{profile:'other-profile'},{codexHome:'/other/codex'},{settings:'/other/settings.json'},{piAgentDir:'/other/pi'}];
    for(const change of changes){f.host.config={...original,...change};assert.throws(()=>f.host.handle({type:'start',key:id(),spec:raw}),/configuration changed/,JSON.stringify(change));}
    const session=f.host.db.get<WorkerSession>('worker-sessions',first.spec.worker!.sessionId)!;
    session.configDigest=legacyHostConfigDigest(original);f.host.db.set('worker-sessions',session.id,session);
    f.host.config={...original,concurrency:3};assert.throws(()=>f.host.handle({type:'start',key:id(),spec:raw}),/configuration changed/,'Unmanaged legacy edits have no provable previous config');
    f.host.config=original;f.host.handle({type:'start',key:id(),spec:raw});
    assert.equal(f.host.db.get<WorkerSession>('worker-sessions',session.id)!.configDigest,hostConfigDigest(original),'Matching legacy configs migrate on continuation');
  }finally{await f.close();}
});

test('legacy permission reports survive reopening and do not block an unrelated worker',async()=>{
  const f=await fixture();let reopened:Main|undefined;
  try{
    const waiting=f.main.dispatch('permission',{...f.input,goal:'permission'});await f.main.sync();await f.run(waiting);await f.main.sync();
    const other=f.main.createUserTask('independent',{taskKey:'independent',title:'Independent',goal:'Finish separately',acceptance:['Done']});
    const second=f.main.dispatch('independent',{...f.input,userTaskId:other.id,goal:'finish'});await f.main.sync();await f.run(second);await f.main.sync();
    assert.equal(f.main.task(second.spec.taskId).status,'ready');assert.equal(f.main.task(waiting.spec.taskId).status,'waiting_permission');
    reopened=new Main(f.main.state,f.owner,f.target,f.repo);
    const report=reopened.taskSummary(reopened.task(waiting.spec.taskId));
    assert.equal(report.permissions?.mode,'read-only');assert.equal(report.questions[0]!.permission!.target,'result.csv');
    assert.ok(reopened.brief().items.some(i=>i.actions.includes('replace_legacy_permission_worker')));
    reopened.cancel(waiting.spec.taskId);await reopened.sync();assert.equal(reopened.task(waiting.spec.taskId).status,'canceled');
    assert.equal(reopened.task(second.spec.taskId).status,'ready');
    await assert.rejects(reopened.continueExecution('late',{...f.input,previousExecutionId:waiting.spec.taskId,message:'Late approval',answers:[{questionId:'write',answer:'Yes',permissionDecision:{actor:'user',allow:true,reason:'User reply',userQuote:'Yes'}}]}),/not ready/);
  }finally{reopened?.db.close();await f.close();}
});
