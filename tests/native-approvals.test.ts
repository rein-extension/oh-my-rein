import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Main } from '../src/main.ts';
import { Host, updateRun, finalizeRun } from '../src/host.ts';
import { Store } from '../src/db.ts';
import type { Run } from '../src/host.ts';
import { execute } from '../src/runner.ts';
import { id } from '../src/protocol.ts';
import { ensureApprovalKey, signApproval } from '../src/approval-authority.ts';
import { createApproval, saveApproval, decideApproval, delegateMayAllow, finishApprovals, runApprovals } from '../src/approval-store.ts';
import type { Approval } from '../src/approval-store.ts';
import { CodexNative } from '../src/codex-native.ts';
import { reinTools } from '../src/tools.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { installPiExtension } from '../src/pi-extension.ts';
import { approvalPrompt } from '../src/approval-prompt.ts';

async function until<T>(fn:()=>T|undefined){const end=Date.now()+8000;while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out waiting for test condition');}
async function fixture(mode:'ask'|'delegate'='ask',harness:'codex'|'pi'='codex',sandbox:'read-only'|'workspace-write'=mode==='ask'?'read-only':'workspace-write'){
  const root=mkdtempSync('/tmp/rein-gate-'),repo=join(root,'repo'),state=join(root,'host');mkdirSync(repo);mkdirSync(state);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');writeFileSync(join(repo,'README'),'gate test\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','init');
  const executable=join(root,'worker.mjs');
  writeFileSync(executable,'#!'+process.execPath+'\n'+readFileSync(resolve('tests/fixture-app-server.mjs'),'utf8'),{mode:0o700});
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter:'codex',executable,permissionMode:mode,sandbox,concurrency:2}));
  const host=new Host(state),target={kind:'local' as const,state},owner={harness,instance:'test',session:id()},main=new Main(join(root,'main'),owner,target,repo);main.mode(true);
  const key=ensureApprovalKey(main.state,owner.instance);writeFileSync(join(state,'approval-keys.json'),JSON.stringify({[key.keyId]:key}));
  let rejectStart=false,dropApproval=false,dropStart=false;
  const server=createServer(socket=>{let buf='';socket.on('error',()=>{});socket.on('data',b=>{
    buf+=b;if(!buf.includes('\n'))return;
    try{const c=JSON.parse(buf);if(rejectStart&&c.type==='start')throw Error('Permanent test rejection');const value=host.handle(c);if((dropApproval&&c.type==='approval-decide')||(dropStart&&c.type==='start')){socket.destroy();return;}socket.end(JSON.stringify({ok:true,value})+'\n');}
    catch(e){socket.end(JSON.stringify({ok:false,rejected:true,error:(e as Error).message})+'\n');}
  });});
  await new Promise<void>(r=>server.listen(join(state,'host.sock'),r));
  const pending:Promise<void>[]=[];
  const input={taskKey:'approval-test',goal:'command',originalRequest:'Test permission gating',constraints:[],acceptance:['Checked'],baseCommit:git('rev-parse','HEAD')};
  const launch=async(goal='command',userTaskId?:string)=>{
    const t=main.dispatch(id(),{...input,goal,...(userTaskId?{taskKey:undefined,userTaskId,expectedRevision:1}:{})});await main.sync();
    const run=host.db.get<Run>('runs',t.spec.runId)!;run.state='starting';updateRun(host.db,run);
    const finished=execute(state,t.spec.runId);pending.push(finished);
    return {t,finished,workspace:join(state,'sessions',t.spec.worker!.sessionId,'workspace')};
  };
  const approval=(runId:string)=>until(()=>runApprovals(host.db,runId)[0]);
  const receipt=(a:Approval,allow:boolean,actor:'user'|'main'='user')=>{const payload={requestId:a.id,requestHash:a.requestHash,runId:a.runId,owner,allow,actor,reason:'Trusted test interaction'};return {payload,...signApproval(main.state,owner.instance,payload)};};
  return {root,repo,state,host,target,owner,main,input,launch,approval,receipt,dropApproval:(v:boolean)=>dropApproval=v,rejectStart:(v:boolean)=>rejectStart=v,dropStart:(v:boolean)=>dropStart=v,
    async close(){for(const run of host.unsettled())host.handle({type:'cancel',runId:run.spec.runId});await Promise.all(pending);await new Promise<void>(r=>server.close(()=>r()));main.db.close();host.db.close();rmSync(root,{recursive:true,force:true});}};
}

test('native defaults persist, reject stale updates and preserve queued and resumed sessions',async()=>{
  const f=await fixture('ask','codex','workspace-write');
  try{
    const first=await f.launch('ordinary-workspace-write');await first.finished;await f.main.sync();
    const queued=f.main.dispatch(id(),f.input);await f.main.sync();
    const active=await f.launch('command'),pending=await f.approval(active.t.spec.runId);
    const before=f.host.handle({type:'worker-permissions',adapter:'codex'}) as any;
    assert.equal(before.revision,0);
    const oldId=id(),oldRun={...f.host.db.get<Run>('runs',queued.spec.runId)!,spec:{...queued.spec,runId:oldId,worker:undefined},permissions:{mode:'ask' as const,sandbox:'read-only' as const}};
    f.host.db.set('runs',oldId,oldRun);
    const permissions={adapter:'codex',sandbox:'read-only',approvalPolicy:'on-request'};
    assert.throws(()=>f.host.handle({type:'worker-permissions-set',permissions,expectedRevision:9}),/changed/);
    assert.throws(()=>f.host.handle({type:'worker-permissions',adapter:'pi'}),/does not match/);
    const configBefore=await f.main.workerPermissions();
    const configAfter=await f.main.setWorkerPermissions({requestKey:'native-defaults',targetId:configBefore.targetId,expectedRevision:configBefore.revision,changes:{adapter:'codex',sandbox:'read-only'},reason:'User requested read-only defaults for future workers'});
    assert.equal(configAfter.status,'applied');
    assert.equal(f.host.db.get<Run>('runs',oldId)!.workerPermissions,undefined,'Do not bless an old run whose permissions do not match the current Host file');
    assert.throws(()=>f.host.handle({type:'worker-permissions-set',permissions,expectedRevision:0}),/changed/);
    const reopened=new Host(f.state);
    try{assert.deepEqual((reopened.handle({type:'worker-permissions'}) as any).permissions,permissions);}finally{reopened.db.close();}
    await f.main.reviewPermission(active.t.spec.taskId,pending.id,async()=>false);await active.finished;
    assert.deepEqual(f.host.db.get<any>('worker-sessions',active.t.spec.worker!.sessionId).workerPermissions,before.permissions,'A runner must preserve permissions pinned while it was active');
    const queuedRun=f.host.db.get<Run>('runs',queued.spec.runId)!;
    assert.deepEqual(queuedRun.workerPermissions,before.permissions);
    queuedRun.state='starting';updateRun(f.host.db,queuedRun);
    const finished=execute(f.state,queued.spec.runId),a=await f.approval(queued.spec.runId);
    assert.equal(a.policy.sandbox,'workspace-write');
    await f.main.reviewPermission(queued.spec.taskId,a.id,async()=>false);await finished;
    const follow=await f.main.continueExecution(id(),{...f.input,goal:'ordinary-workspace-write',previousExecutionId:first.t.spec.taskId,message:'Continue the existing session',answers:[]});
    const continued=f.main.task(follow.executionId);await f.main.sync();
    assert.deepEqual(f.host.db.get<Run>('runs',continued.spec.runId)!.workerPermissions,before.permissions);
    const fresh=await f.launch('command'),b=await f.approval(fresh.t.spec.runId);
    assert.equal(b.policy.sandbox,'read-only');
    await f.main.reviewPermission(fresh.t.spec.taskId,b.id,async()=>false);await fresh.finished;
  }finally{await f.close();}
});

test('ask: concurrent native requests wait without side effects, user UI decisions resume only the matching operation',async()=>{
  const f=await fixture();
  try{
    const a=await f.launch(),b=await f.launch();const ar=await f.approval(a.t.spec.runId),br=await f.approval(b.t.spec.runId);
    assert.equal(f.host.unsettled().length,2,'Live approvals occupy execution slots');
    assert.equal(existsSync(join(a.workspace,'effect.txt')),false);assert.equal(existsSync(join(b.workspace,'effect.txt')),false);
    await assert.rejects(f.main.delegatePermission(a.t.spec.taskId,ar.id,true,'Seems useful'),/requires the user/);
    await assert.rejects(f.main.reviewPermission(a.t.spec.taskId,ar.id),/cannot display/);
    const pending=await f.main.reviewPermission(a.t.spec.taskId,ar.id,async()=>null);assert.ok('state' in pending&&pending.state==='pending');
    const tools=reinTools(()=>new Main(f.main.state,f.owner,f.target,f.repo));
    const spoof=await tools.find(t=>t.name==='rein_permission_review')!.execute({executionId:a.t.spec.taskId,requestId:ar.id,allow:true,actor:'user',userQuote:'Yes'});
    assert.equal(spoof.isError,true);assert.equal(f.host.db.get<Approval>('approvals',ar.id)!.state,'pending');
    await f.main.reviewPermission(a.t.spec.taskId,ar.id,async()=>false);await a.finished;
    assert.equal(existsSync(join(a.workspace,'effect.txt')),false);assert.equal(readFileSync(join(a.workspace,'decisions.log'),'utf8'),'decline\n');
    assert.equal(existsSync(join(b.workspace,'effect.txt')),false);
    await f.main.reviewPermission(b.t.spec.taskId,br.id,async()=>true);await b.finished;await f.main.sync();
    assert.equal(readFileSync(join(b.workspace,'effect.txt'),'utf8'),'approved\n');
    assert.equal(f.main.task(b.t.spec.taskId).status,'ready');
    assert.equal(f.host.db.get<Approval>('approvals',ar.id)!.result,'declined');
    assert.equal(f.host.db.get<Approval>('approvals',br.id)!.result,'completed');
    assert.equal(f.host.config.sandbox,'read-only','A single native approval does not change Host configuration');
  }finally{await f.close();}
});

test('task permission cards keep parallel work separate and review only the selected operation',async()=>{
  const f=await fixture('ask','codex','workspace-write');
  try{
    const parent=(key:string,title:string)=>f.main.createUserTask(key,{taskKey:key,title,goal:title,acceptance:['Checked']});
    const a=parent('billing','Fix billing'),b=parent('docs','Update documentation');
    const blocked=await f.launch('command',a.id),request=await f.approval(blocked.t.spec.runId);
    const ordinary=await f.launch('ordinary-workspace-write',b.id);await ordinary.finished;await f.main.sync();
    assert.equal(f.main.task(ordinary.t.spec.taskId).status,'ready','One pending task must not stall another');
    assert.equal(runApprovals(f.host.db,ordinary.t.spec.runId).length,0,'Configured operations need no artificial gate');
    assert.equal(readFileSync(join(ordinary.workspace,'ordinary.txt'),'utf8'),'inside configured boundary\n');
    const card=f.main.userTaskSummary(a).permissions.requests[0]!;
    assert.equal(card.taskTitle,'Fix billing');assert.equal(card.host,'Local Host');assert.equal(card.preview,'write effect.txt');assert.equal(card.decisionBy,'user');
    assert.equal(f.main.userTaskSummary(b).permissions.waiting,0);
    for(let i=0;i<12;i++)parent('extra-'+i,'Other work '+i);
    const board=f.main.status() as any;
    assert.ok(!board.tasks.some((t:any)=>t.userTaskId===a.id));
    assert.ok(board.attention.items.some((t:any)=>t.userTaskId===a.id&&t.permissions.waiting===1),'Waiting approval stays visible off-page');
    const wrong=await f.main.reviewTaskPermission({userTaskId:b.id,requestId:request.id},async()=>{assert.fail('Cross-task request reached user UI');});
    assert.equal((wrong as any).state,'no_pending_request');
    let prompts=0;
    await f.main.reviewTaskPermission({userTaskId:a.id},async review=>{
      prompts++;const message=approvalPrompt(review);
      assert.match(message,/Task: "Fix billing"/);assert.match(message,/Host: "Local Host"/);assert.match(message,/write effect.txt/);assert.match(message,/outside/);
      assert.equal(message.includes(request.id),false,'User should not manage opaque approval IDs');return null;
    });
    assert.equal(f.host.db.get<Approval>('approvals',request.id)!.state,'pending');
    const second=await f.launch('command',a.id);await f.approval(second.t.spec.runId);await f.main.sync();
    const choices=await f.main.reviewTaskPermission({userTaskId:a.id},async()=>{assert.fail('Multiple operations must not auto-select or batch approve');});
    assert.equal((choices as any).state,'selection_required');assert.equal((choices as any).requests.length,2);
    await f.main.reviewTaskPermission({userTaskId:a.id,requestId:request.id},async()=>{prompts++;return true;});await blocked.finished;
    assert.equal(prompts,2);assert.equal(existsSync(join(blocked.workspace,'effect.txt')),true);assert.equal(existsSync(join(second.workspace,'effect.txt')),false);
    await f.main.sync();await f.main.reviewTaskPermission({userTaskId:a.id},async()=>false);await second.finished;
    assert.equal(existsSync(join(second.workspace,'effect.txt')),false);
  }finally{await f.close();}
});

test('signed approvals bind exact operation/owner, reject forgery and conflicts; lost receipt retries do not execute twice',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId),receipt=f.receipt(a,true);
    for(const invalid of [{...receipt,signature:'forged'},{...receipt,payload:{...receipt.payload,runId:id()}},{...receipt,payload:{...receipt.payload,requestHash:'0'.repeat(64)}},{...receipt,payload:{...receipt.payload,allow:false}},{...receipt,payload:{...receipt.payload,owner:{...f.owner,session:id()}}}])assert.throws(()=>decideApproval(f.host.db,f.state,invalid));
    assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true,'main')),/real user interaction/);
    f.dropApproval(true);await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>true);await w.finished;
    assert.equal(f.main.db.get<any>('approval-outbox',a.id).done,false,'An uncertain response stays retryable');
    const reopened=new Main(f.main.state,f.owner,f.target,f.repo);f.dropApproval(false);
    try{await reopened.sync();assert.equal(reopened.db.get<any>('approval-outbox',a.id).done,true);}finally{reopened.db.close();}
    assert.equal(readFileSync(join(w.workspace,'decisions.log'),'utf8'),'accept\n');
    assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,false)),/Conflicting/);
  }finally{await f.close();}
});

test('delegate routes native file and command requests to the main without an extra path policy',async()=>{
  const f=await fixture('delegate');
  try{
    for(const goal of ['file','command','protected-file']){
      const w=await f.launch(goal),a=await f.approval(w.t.spec.runId);
      assert.equal(delegateMayAllow(a),true);
      const allow=goal!=='protected-file';
      const result=await f.main.delegatePermission(w.t.spec.taskId,a.id,allow,allow?'Required by the user task':'Not authorized by this task');
      assert.equal(result.delivery,'acknowledged');await w.finished;
      assert.equal(existsSync(join(w.workspace,'effect.txt')),allow);
      assert.equal(f.host.db.get<Approval>('approvals',a.id)!.decision!.actor,'main');
    }
    assert.equal(f.host.config.sandbox,'workspace-write');
  }finally{await f.close();}
});

test('native move details remain available for a delegated decision, including destinations outside the workspace',async()=>{
  const f=await fixture('delegate');
  try{
    const w=await f.launch('move-outside'),a=await f.approval(w.t.spec.runId);
    assert.equal(a.item!.changes[0].kind.move_path,join(realpathSync(w.workspace),'..','outside.txt'));
    assert.equal(delegateMayAllow(a),true);
    await f.main.delegatePermission(w.t.spec.taskId,a.id,false,'User requested work only inside this checkout');await w.finished;
    assert.equal(existsSync(join(w.workspace,'..','outside.txt')),false);
    assert.equal(readFileSync(join(w.workspace,'README'),'utf8'),'gate test\n');
  }finally{await f.close();}
});

test('routing changes affect future executions, not pending requests or native access',async()=>{
  const f=await fixture('ask','codex','workspace-write');
  try{
    const first=await f.launch(),a=await f.approval(first.t.spec.runId);
    f.main.approvalMode('delegate');
    await assert.rejects(f.main.delegatePermission(first.t.spec.taskId,a.id,true,'Changed route'),/requires the user/);
    const second=await f.launch(),b=await f.approval(second.t.spec.runId);
    assert.equal(b.policy.mode,'delegate');assert.equal(b.policy.sandbox,a.policy.sandbox);
    await f.main.delegatePermission(second.t.spec.taskId,b.id,true,'Authorized command');await second.finished;
    await f.main.reviewPermission(first.t.spec.taskId,a.id,async()=>false);await first.finished;
    assert.equal(existsSync(join(first.workspace,'effect.txt')),false);
    assert.equal(existsSync(join(second.workspace,'effect.txt')),true);
  }finally{await f.close();}
});

test('expired and canceled requests never run; interruption after sending approval records unknown rather than success',async()=>{
  const f=await fixture();
  try{
    const expired=await f.launch(),a=await f.approval(expired.t.spec.runId);a.expiresAt=0;f.host.db.set('approvals',a.id,a);
    assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true)),/no longer actionable/);await expired.finished;
    assert.equal(existsSync(join(expired.workspace,'effect.txt')),false);assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'expired');
    const canceled=await f.launch(),b=await f.approval(canceled.t.spec.runId);f.host.handle({type:'cancel',runId:b.runId});await canceled.finished;
    assert.equal(existsSync(join(canceled.workspace,'effect.txt')),false);assert.equal(f.host.db.get<Approval>('approvals',b.id)!.state,'canceled');
    const crash=await f.launch('crash'),c=await f.approval(crash.t.spec.runId);await f.main.reviewPermission(crash.t.spec.taskId,c.id,async()=>true);await crash.finished;
    assert.equal(f.host.db.get<Approval>('approvals',c.id)!.state,'unknown');
    assert.equal(existsSync(join(crash.workspace,'effect.txt')),true,'Effects may have occurred even without a completion receipt');
    assert.equal(f.host.db.get<Run>('runs',c.runId)!.state,'unknown');
  }finally{await f.close();}
});

test('MCP uses real elicitation response, not a model-authored approval argument',async()=>{
  const f=await fixture();
  const config=join(f.root,'endpoint.json');writeFileSync(config,JSON.stringify(f.target));
  const client=new Client({name:'approval-ui-test',version:'1'},{capabilities:{elicitation:{form:{}}}});
  let prompts=0;
  client.setRequestHandler(ElicitRequestSchema,async request=>{prompts++;assert.match(request.params.message,/write effect.txt/);return {action:'accept',content:{decision:'allow'}};});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',f.main.state,'--config',config,'--project',f.repo,'--instance',f.owner.instance],env:{PATH:process.env.PATH!,CODEX_THREAD_ID:f.owner.session}});
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);await client.connect(transport);
    const result=await client.callTool({name:'rein_permission_review',arguments:{executionId:w.t.spec.taskId,requestId:a.id}});
    assert.notEqual(result.isError,true,JSON.stringify(result));await w.finished;
    assert.equal(prompts,1);assert.equal(existsSync(join(w.workspace,'effect.txt')),true);
  }finally{await client.close();await f.close();}
});

test('MCP cancellation withdraws the user interaction and never signs a late allow',async()=>{
  const f=await fixture(),client=new Client({name:'cancel-review',version:'1'},{capabilities:{elicitation:{form:{}}}});
  const config=join(f.root,'endpoint.json');writeFileSync(config,JSON.stringify(f.target));
  let opened=false,canceled=false,respond:((v:any)=>void)|undefined;
  client.setRequestHandler(ElicitRequestSchema,async(_request,extra)=>{
    opened=true;extra.signal.addEventListener('abort',()=>{canceled=true;},{once:true});
    return new Promise<any>(resolve=>{respond=resolve;});
  });
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',f.main.state,'--config',config,'--project',f.repo,'--instance',f.owner.instance],env:{PATH:process.env.PATH!,CODEX_THREAD_ID:f.owner.session}});
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);await client.connect(transport);
    // Some clients ignore cancellation for numeric request ID 0. Verify the
    // actual wire notification and still return a late allow to exercise Rein's guard.
    const onmessage=transport.onmessage!;
    transport.onmessage=message=>{if('method' in message&&message.method==='notifications/cancelled')canceled=true;onmessage(message);};
    const controller=new AbortController();
    const review=client.callTool({name:'rein_permission_review',arguments:{executionId:w.t.spec.taskId,requestId:a.id}},undefined,{signal:controller.signal});
    const rejected=assert.rejects(review);await until(()=>opened||undefined);controller.abort();await rejected;await until(()=>canceled||undefined);
    respond!({action:'accept',content:{decision:'allow'}});
    await client.callTool({name:'rein_status',arguments:{}});
    assert.equal(f.main.db.get('approval-outbox',a.id),undefined);assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'pending');assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
    await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;
  }finally{respond?.({action:'cancel'});await client.close();await f.close();}
});

test('cancel after native acceptance preserves unknown effects independently of stopped execution',async()=>{
  const f=await fixture();
  try{
    const parent=f.main.createUserTask('effects',{taskKey:'effects',title:'Check uncertain effects',goal:'Test interrupted command',acceptance:['Checked']});
    const w=await f.launch('hold-after-accept',parent.id),a=await f.approval(w.t.spec.runId);
    await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>true);await until(()=>existsSync(join(w.workspace,'effect.txt'))||undefined);
    assert.throws(()=>f.main.reviewOperationEffects(w.t.spec.taskId,a.id,'no-effects',['Not checked']),/Confirm execution stopped/);
    f.main.cancel(w.t.spec.taskId);await f.main.sync();await w.finished;await f.main.sync();
    assert.equal(f.main.task(w.t.spec.taskId).status,'canceled');assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'unknown');
    assert.equal(f.main.taskSummary(f.main.task(w.t.spec.taskId)).operationEffects,'unknown');assert.equal(f.main.userTaskSummary(parent).permissions.unknown,1);
    assert.match(f.main.task(w.t.spec.taskId).run!.error!,/effects are unknown/);
    f.main.review(w.t.spec.taskId,'discard');
    assert.ok(f.main.userTaskSummary(parent).actions.includes('inspect_unknown_operation_effects_before_retry'),'Discarding knowledge is not proof an operation had no effects');
    await assert.rejects(f.launch('command',parent.id),/unknown operation effects/);
    assert.throws(()=>f.main.completeUserTask(parent.id,parent.version,['Checked'],[w.t.spec.taskId]),/unknown operation effects/);
    const other=f.main.createUserTask('unrelated',{taskKey:'unrelated',title:'Independent work',goal:'Independent work',acceptance:['Checked']});
    const independent=await f.launch('command',other.id),independentApproval=await f.approval(independent.t.spec.runId);
    await f.main.reviewPermission(independent.t.spec.taskId,independentApproval.id,async()=>false);await independent.finished;
    assert.throws(()=>f.main.reviewOperationEffects(independent.t.spec.taskId,a.id,'no-effects',['Other execution']),/Confirm execution stopped|No unknown operation/);
    assert.throws(()=>f.main.reviewOperationEffects(w.t.spec.taskId,id(),'no-effects',['Wrong request']),/No unknown operation/);
    assert.throws(()=>f.main.reviewOperationEffects(w.t.spec.taskId,a.id,'effects-addressed',[]));
    const evidence=[`Read ${join(w.workspace,'effect.txt')}: approved; removed the fixture effect and verified absence`];
    rmSync(join(w.workspace,'effect.txt'));assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
    const catalog=reinTools(()=>new Main(f.main.state,f.owner,f.target,f.repo));
    const reviewed=await catalog.find(t=>t.name==='rein_effects_review')!.execute({executionId:w.t.spec.taskId,requestId:a.id,disposition:'effects-addressed',evidence});
    assert.equal(reviewed.isError,undefined);assert.equal(JSON.parse(reviewed.content[0]!.text).operationEffects,'reviewed');
    assert.equal(f.main.reviewOperationEffects(w.t.spec.taskId,a.id,'effects-addressed',evidence).operationEffects,'reviewed','Identical retry is idempotent');
    assert.throws(()=>f.main.reviewOperationEffects(w.t.spec.taskId,a.id,'no-effects',['Rewrite history']),/Conflicting/);
    await f.main.sync();
    const replacement=await f.launch('command',parent.id),b=await f.approval(replacement.t.spec.runId);
    await f.main.reviewPermission(replacement.t.spec.taskId,b.id,async()=>false);await replacement.finished;await f.main.sync();
    await f.main.collect(replacement.t.spec.taskId);f.main.accept(replacement.t.spec.taskId,['Checked fixture report and patch']);f.main.review(replacement.t.spec.taskId,'discard');
    const reopened=new Main(f.main.state,f.owner,f.target,f.repo);
    try{
      assert.equal(reopened.taskSummary(reopened.task(w.t.spec.taskId)).operationEffects,'reviewed');
      assert.equal(reopened.userTaskSummary(parent).permissions.unknown,0);
      assert.ok(!reopened.userTaskSummary(parent).actions.includes('inspect_unknown_operation_effects_before_retry'));
      assert.equal(reopened.task(w.t.spec.taskId).effectsReviews![a.id]!.source,'main-reported');
      assert.equal(reopened.task(w.t.spec.taskId).run!.approvals![0]!.state,'unknown','Original Host evidence stays intact');
      assert.equal(reopened.completeUserTask(parent.id,parent.version,['Checked'],[replacement.t.spec.taskId]).status,'completed');
    }finally{reopened.db.close();}
  }finally{await f.close();}
});

test('crash after decline does not invent an approved operation or hold an execution slot',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch('crash'),a=await f.approval(w.t.spec.runId);
    await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;await f.main.sync();
    assert.equal(readFileSync(join(w.workspace,'decisions.log'),'utf8'),'decline\n');
    assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
    const approval=f.host.db.get<Approval>('approvals',a.id)!;
    assert.equal(approval.state,'resolved');assert.equal(approval.result,'not-granted');assert.match(approval.error!,/delivery was not confirmed/);
    assert.equal(f.host.db.get<Run>('runs',a.runId)!.state,'failed');
    assert.ok(!f.host.unsettled().some(r=>r.spec.runId===a.runId));
    assert.equal(f.main.taskSummary(f.main.task(w.t.spec.taskId)).operationEffects,'no_unconfirmed_approval');
  }finally{await f.close();}
});

test('terminal execution and all approval outcomes commit together with one final event',async()=>{
  const f=await fixture(),observer=new Store(f.state);
  try{
    const t=f.main.dispatch('atomic',f.input);await f.main.sync();
    const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);
    const approvals=[true,false,null].map(allow=>{
      const a=createApproval(f.host.db,run.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);
      if(allow!==null){a.state='responding';a.decision=f.receipt(a,allow).payload;saveApproval(f.host.db,a);}
      return a;
    });
    const cursor=f.host.db.eventCursor();
    const finish=()=>{
      const current=f.host.db.get<Run>('runs',run.spec.runId)!;current.state='canceled';finalizeRun(f.host.db,current);
      assert.equal(observer.get<Run>('runs',run.spec.runId)!.state,'awaiting_approval','Other connections cannot observe a partial finalization');
      assert.equal(observer.get<Approval>('approvals',approvals[0]!.id)!.state,'responding');
    };
    assert.throws(()=>f.host.db.transaction(()=>{finish();throw Error('Injected crash before commit');}),/Injected crash/);
    assert.equal(f.host.db.eventCursor(),cursor);assert.equal(observer.get<Run>('runs',run.spec.runId)!.state,'awaiting_approval');
    f.host.db.transaction(finish);
    const events=observer.events(cursor);assert.equal(events.length,1);assert.equal(events[0]!.data.state,'canceled');
    assert.deepEqual(events[0]!.data.approvals.map((a:any)=>a.state),['unknown']);
    assert.deepEqual(approvals.map(a=>observer.get<Approval>('approvals',a.id)!.state),['unknown','resolved','canceled']);
  }finally{observer.close();await f.close();}
});

test('Host restart and tick repair legacy terminal approvals without replaying decisions',async()=>{
  const f=await fixture();
  try{
    for(const recovery of ['restart','tick','surviving-worker']){
      const t=f.main.dispatch(recovery,f.input);await f.main.sync();
      const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);
      const a=createApproval(f.host.db,run.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);
      a.state='responding';a.decision=f.receipt(a,true).payload;saveApproval(f.host.db,a);
      const interrupted=f.host.db.get<Run>('runs',run.spec.runId)!;interrupted.state='canceled';
      if(recovery==='surviving-worker')interrupted.workerPid=process.pid;
      updateRun(f.host.db,interrupted);
      if(recovery==='restart'){const reopened=new Host(f.state);reopened.db.close();}else f.host.tick();
      if(recovery==='surviving-worker'){
        assert.equal(f.host.db.get<Run>('runs',run.spec.runId)!.state,'unknown');
        assert.throws(()=>f.host.handle({type:'resolve',runId:run.spec.runId,confirmStopped:true,reason:'Not actually stopped'}),/process group is still alive/);
        const stopped=f.host.db.get<Run>('runs',run.spec.runId)!;delete stopped.workerPid;f.host.db.set('runs',run.spec.runId,stopped);
        f.host.handle({type:'resolve',runId:run.spec.runId,confirmStopped:true,reason:'Removed the synthetic live-process reference; fixture never started a worker'});
      }
      assert.equal(f.host.db.get<Run>('runs',run.spec.runId)!.state,'canceled');
      assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'unknown');
      const cursor=f.host.db.eventCursor();f.host.tick();assert.equal(f.host.db.eventCursor(),cursor,'Recovery is idempotent');
      await f.main.sync();assert.equal(f.main.taskSummary(f.main.task(t.spec.taskId)).operationEffects,'unknown');
      assert.equal(f.main.reviewOperationEffects(t.spec.taskId,a.id,'no-effects',['Fixture never spawned a worker']).operationEffects,'reviewed');
    }
  }finally{await f.close();}
});

test('string cancellation reasons produce valid permission tool errors and never open a prompt',async()=>{
  const f=await fixture();
  try{
    const controller=new AbortController();controller.abort('User canceled request');
    const catalog=reinTools(()=>new Main(f.main.state,f.owner,f.target,f.repo),async()=>{assert.fail('Canceled review opened a prompt');});
    for(const [name,input] of [
      ['rein_permission_review',{executionId:id()}],
      ['rein_permission_decide',{executionId:id(),requestId:id(),allow:true,reason:'Test'}],
    ] as const){
      const result=await catalog.find(t=>t.name===name)!.execute(input,undefined,controller.signal);
      assert.equal(result.isError,true);assert.equal(result.content[0]!.text,'User canceled request');
    }
    assert.equal(f.main.db.list('approval-outbox').length,0);
  }finally{await f.close();}
});

test('terminal continuation rejection releases the reservation without claiming the previous turn continued',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;await f.main.sync();
    const next=f.main.dispatch('next',{...f.input,previousExecutionId:w.t.spec.taskId,message:'Try another authorized approach',answers:[]});
    assert.equal(f.main.task(w.t.spec.taskId).status,'ready');
    f.rejectStart(true);await f.main.sync();
    assert.equal(f.main.task(next.spec.taskId).status,'failed');assert.equal(f.main.task(w.t.spec.taskId).continuedBy,undefined);assert.equal(f.main.task(w.t.spec.taskId).status,'ready');
    f.rejectStart(false);const retry=f.main.dispatch('retry',{...f.input,previousExecutionId:w.t.spec.taskId,message:'Try again',answers:[]});await f.main.sync();
    assert.equal(f.main.task(w.t.spec.taskId).status,'continued');assert.ok(f.host.db.get('runs',retry.spec.runId));
  }finally{await f.close();}
});

test('native duplicate request IDs fail closed and pending approvals cannot replay after invocation loss',async()=>{
  const f=await fixture();
  try{
    const t=f.main.dispatch('unit',f.input);await f.main.sync();const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);
    const sent:any[]=[],engine=new CodexNative(f.host.db,t.spec.runId,f.repo,m=>sent.push(m));engine.threadId=id();engine.turnId='turn';
    const failure=assert.rejects(engine.result,/Duplicate native/);
    const frame={id:123,method:'item/commandExecution/requestApproval',params:{threadId:engine.threadId,turnId:engine.turnId,itemId:'op',command:'write result',cwd:f.repo}};
    engine.feed(JSON.stringify(frame)+'\n');engine.feed(JSON.stringify(frame)+'\n');await failure;
    assert.equal(runApprovals(f.host.db,t.spec.runId).length,1);assert.equal(sent.length,0);
    f.host.db.transaction(()=>finishApprovals(f.host.db,t.spec.runId));
    const a=runApprovals(f.host.db,t.spec.runId)[0]!;assert.equal(a.state,'canceled');assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true)),/no longer actionable/);
  }finally{await f.close();}
});

test('delegate can send an uncertain native command to the user instead',async()=>{
  const f=await fixture('delegate');
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);
    await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;
    assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
    assert.equal(f.host.db.get<Approval>('approvals',a.id)!.decision!.actor,'user');
  }finally{await f.close();}
});

test('canceling while the user reviews prevents storing or delivering a late grant',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);
    await assert.rejects(f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>{f.main.cancel(w.t.spec.taskId);return true;}),/canceled/);
    assert.equal(f.main.db.get('approval-outbox',a.id),undefined);await f.main.sync();await w.finished;
    assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
  }finally{await f.close();}
});

test('unsupported native requests remain visible as adapter limitations, never user denials; secrets stay out',async()=>{
  const f=await fixture(),old=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='synthetic-secret-native-gate-check';
  try{
    const network=await f.launch('network');await network.finished;
    assert.equal(existsSync(join(network.workspace,'effect.txt')),false);
    const records=runApprovals(f.host.db,network.t.spec.runId);assert.equal(records.length,1);const unsupported=records[0]!;
    assert.equal(unsupported.state,'unsupported');assert.equal(unsupported.result,'not-granted');assert.equal(unsupported.decision,undefined);assert.match(unsupported.error!,/network/);
    assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(unsupported,true)),/no longer actionable/);
    await f.main.sync();const summary=f.main.taskSummary(f.main.task(network.t.spec.taskId));assert.equal(summary.approvalRequests[0]!.state,'unsupported');assert.equal(summary.approvalRequests[0]!.decisionBy,null);
    assert.ok(f.main.brief().items.find(i=>i.taskId===network.t.spec.taskId)!.actions.includes('inspect_unsupported_permission_requests'));
    await f.main.reviewPermission(network.t.spec.taskId,unsupported.id,async()=>{assert.fail('Unsupported requests cannot offer approval');});
    const secret=await f.launch('secret');await secret.finished;
    assert.equal(runApprovals(f.host.db,secret.t.spec.runId).length,0);assert.equal(existsSync(join(secret.workspace,'effect.txt')),false);
    const run=f.host.db.get<Run>('runs',secret.t.spec.runId)!;assert.match(run.error!,/credential/);
    const log=readFileSync(join(f.state,'runs',secret.t.spec.runId,'worker.log'),'utf8');assert.ok(!log.includes(process.env.OPENAI_API_KEY));
  }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;await f.close();}
});

test('unsupported broad, unknown and stdin requests are audited without opening an actionable approval',async()=>{
  const f=await fixture();let engine:CodexNative|undefined;
  try{
    const t=f.main.dispatch('unsupported',f.input);await f.main.sync();const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);
    const sent:any[]=[];engine=new CodexNative(f.host.db,t.spec.runId,f.repo,m=>sent.push(m));engine.result.catch(()=>{});engine.threadId=id();engine.turnId='turn';
    for(const [i,method] of ['item/permissions/requestApproval','future/requestApproval','item/commandExecution/requestApproval','item/fileChange/requestApproval'].entries()){
      engine.feed(JSON.stringify({id:i,method,params:{threadId:engine.threadId,turnId:'turn',itemId:'op-'+i,...(i===2?{kind:'writeStdin',command:'test'}:{}),...(i===3?{grantRoot:f.repo}:{})}})+'\n');
    }
    const records=runApprovals(f.host.db,t.spec.runId);assert.equal(records.length,4);assert.ok(records.every(a=>a.state==='unsupported'&&!a.decision));
    assert.equal(engine.gates.size,0);assert.equal(f.host.db.get<Run>('runs',t.spec.runId)!.state,'running');
    assert.deepEqual(sent[0].result,{permissions:{},scope:'turn'});assert.ok(sent[1].error);assert.equal(sent[2].result.decision,'decline');assert.equal(sent[3].result.decision,'decline');
    await f.main.sync();assert.equal(f.main.taskSummary(f.main.task(t.spec.taskId)).approvalRequests.length,4);
  }finally{engine?.abort(Error('Test finished'));await f.close();}
});

test('a lost continuation acknowledgement reserves the turn until idempotent delivery is confirmed',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;await f.main.sync();
    const input={...f.input,previousExecutionId:w.t.spec.taskId,message:'Another turn',answers:[]};
    const next=f.main.dispatch('next',input);f.dropStart(true);await f.main.sync();
    assert.equal(f.main.task(w.t.spec.taskId).status,'ready');assert.equal(f.main.task(w.t.spec.taskId).continuedBy,next.spec.taskId);
    assert.throws(()=>f.main.dispatch('branch',input),/latest turn/);assert.ok(f.host.db.get('runs',next.spec.runId));
    assert.equal(f.main.task(next.spec.taskId).startRejection,undefined);
    assert.throws(()=>f.main.review(next.spec.taskId,'discard'),/requires an execution outcome/,'A lost receipt cannot be discarded as a rejected start');
    f.dropStart(false);await f.main.sync();assert.equal(f.main.task(w.t.spec.taskId).status,'continued');assert.equal(f.host.db.list('runs').length,2);
  }finally{await f.close();}
});

test('Pi user review takes the native UI choice and never accepts a tool-supplied approval',async()=>{
  const f=await fixture('ask','pi');
  try{
    const config=join(f.root,'endpoint.json');writeFileSync(config,JSON.stringify(f.target));const tools:any[]=[];
    installPiExtension({registerTool:t=>tools.push(t),registerCommand(){},on(){}},{state:f.main.state,config,project:f.repo,instance:f.owner.instance},'Test');
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);let prompts=0;
    const ctx={cwd:f.repo,sessionManager:{getSessionId:()=>f.owner.session},ui:{notify(){},async select(message:string,options:string[]){prompts++;assert.match(message,/write effect.txt/);assert.ok(options.includes('Deny'));return 'Deny';}}};
    const tool=tools.find(t=>t.name==='rein_permission_review');
    await assert.rejects(tool.execute('spoof',{executionId:w.t.spec.taskId,requestId:a.id,allow:true},undefined,undefined,ctx));assert.equal(prompts,0);
    await tool.execute('review',{executionId:w.t.spec.taskId,requestId:a.id},undefined,undefined,ctx);await w.finished;
    assert.equal(prompts,1);assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
  }finally{await f.close();}
});

test('Pi cancellation returns while its UI is open and ignores a late approval',async()=>{
  const f=await fixture('ask','pi');
  try{
    const config=join(f.root,'endpoint.json');writeFileSync(config,JSON.stringify(f.target));const tools:any[]=[];
    installPiExtension({registerTool:t=>tools.push(t),registerCommand(){},on(){}},{state:f.main.state,config,project:f.repo,instance:f.owner.instance},'Test');
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);let respond:((v:string)=>void)|undefined;
    const ctx={cwd:f.repo,sessionManager:{getSessionId:()=>f.owner.session},ui:{notify(){},select:()=>new Promise<string>(r=>{respond=r;})}};
    const controller=new AbortController(),tool=tools.find(t=>t.name==='rein_permission_review');
    const review=tool.execute('review',{executionId:w.t.spec.taskId,requestId:a.id},controller.signal,undefined,ctx);
    await until(()=>respond);controller.abort();const result=await review;
    assert.equal(JSON.parse(result.content[0].text).state,'pending');respond!('Allow this operation');await new Promise(r=>setImmediate(r));
    assert.equal(f.main.db.get('approval-outbox',a.id),undefined);assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'pending');assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
    await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>false);await w.finished;
  }finally{await f.close();}
});

test('new required context while reviewing invalidates a stale grant',async()=>{
  const f=await fixture();
  try{
    const w=await f.launch(),a=await f.approval(w.t.spec.runId);
    await assert.rejects(f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>{
      f.main.context.record('new-rule',{kind:'constraint',content:'Do not write files',quote:'Do not write files',shareWithWorkers:true,requiredForTask:true,appliesTo:{type:'task',taskKey:f.input.taskKey}});return true;
    }),/context changed/);
    assert.equal(f.main.db.get('approval-outbox',a.id),undefined);assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,'pending');
    assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
  }finally{await f.close();}
});

test('unknown effects block queued sibling starts and allows, but not denials or independent tasks',async()=>{
  const f=await fixture('delegate');
  try{
    const parent=f.main.createUserTask('guard',{taskKey:'guard',title:'Guard retry',goal:'Guard retry',acceptance:['Checked']});
    const input={...f.input,taskKey:undefined,userTaskId:parent.id,expectedRevision:1};
    const first=f.main.dispatch('first',input),sibling=f.main.dispatch('sibling',input);await f.main.sync();
    for(const t of [first,sibling]){const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);}
    const uncertain=createApproval(f.host.db,first.spec.runId,'item/commandExecution/requestApproval',{command:'effect'},f.repo);
    uncertain.state='responding';uncertain.decision=f.receipt(uncertain,true).payload;saveApproval(f.host.db,uncertain);
    const pending=createApproval(f.host.db,sibling.spec.runId,'item/commandExecution/requestApproval',{command:'next effect'},f.repo);
    await f.main.sync();
    const queued=f.main.dispatch('queued',input);
    const stopped=f.host.db.get<Run>('runs',first.spec.runId)!;stopped.state='failed';finalizeRun(f.host.db,stopped);
    // The Main has not consumed the failure event yet. Delivery must refresh it.
    await f.main.sync();assert.equal(f.host.db.get('runs',queued.spec.runId),undefined);
    assert.equal(f.main.dispatch('queued',input).spec.runId,queued.spec.runId,'Idempotent receipt is still readable');
    assert.throws(()=>f.main.dispatch('new',input),/unknown operation effects/);
    await assert.rejects(f.main.delegatePermission(sibling.spec.taskId,pending.id,true,'Retry'),/unknown operation effects/);
    await assert.rejects(f.main.reviewPermission(sibling.spec.taskId,pending.id,async()=>true),/unknown operation effects/);
    assert.equal(f.main.db.get('approval-outbox',pending.id),undefined,'Blocked allow must not be signed into the outbox');
    await f.main.delegatePermission(sibling.spec.taskId,pending.id,false,'Stop further effects');
    assert.equal(f.host.db.get<Approval>('approvals',pending.id)!.state,'denied');
    const independent=f.main.dispatch('independent',{...f.input,taskKey:'independent'});await f.main.sync();
    assert.ok(f.host.db.get('runs',independent.spec.runId),'Other tasks still progress');
    f.main.reviewOperationEffects(first.spec.taskId,uncertain.id,'no-effects',['Synthetic fixture: no native command was executed']);
    await f.main.sync();assert.ok(f.host.db.get('runs',queued.spec.runId));
  }finally{await f.close();}
});

test('a late sibling failure blocks an already queued allow until effects review',async()=>{
  const f=await fixture('delegate');
  try{
    const first=f.main.dispatch('first',f.input),second=f.main.dispatch('second',f.input);await f.main.sync();
    for(const t of [first,second]){const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);}
    const a=createApproval(f.host.db,first.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);
    const b=createApproval(f.host.db,second.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);
    a.state='responding';a.decision=f.receipt(a,true).payload;saveApproval(f.host.db,a);await f.main.sync();
    const receipt=f.receipt(b,true,'main');f.main.db.set('approval-outbox',b.id,{executionId:second.spec.taskId,receipt,done:false});
    const stopped=f.host.db.get<Run>('runs',first.spec.runId)!;stopped.state='failed';finalizeRun(f.host.db,stopped);
    await f.main.sync();assert.equal(f.host.db.get<Approval>('approvals',b.id)!.state,'pending');
    assert.equal(f.main.db.get<any>('approval-outbox',b.id).done,false);
    f.main.reviewOperationEffects(first.spec.taskId,a.id,'no-effects',['Fixture had no native process']);await f.main.sync();
    assert.equal(f.host.db.get<Approval>('approvals',b.id)!.state,'approved');
  }finally{await f.close();}
});

test('a sibling failure during user review cannot become a late allow',async()=>{
  const f=await fixture();
  try{
    const first=f.main.dispatch('first',f.input),second=f.main.dispatch('second',f.input);await f.main.sync();
    for(const t of [first,second]){const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);}
    const a=createApproval(f.host.db,first.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);
    a.state='responding';a.decision=f.receipt(a,true).payload;saveApproval(f.host.db,a);
    const b=createApproval(f.host.db,second.spec.runId,'item/commandExecution/requestApproval',{command:'test'},f.repo);await f.main.sync();
    await assert.rejects(f.main.reviewPermission(second.spec.taskId,b.id,async()=>{
      const run=f.host.db.get<Run>('runs',first.spec.runId)!;run.state='failed';finalizeRun(f.host.db,run);return true;
    }),/unknown operation effects/);
    assert.equal(f.main.db.get('approval-outbox',b.id),undefined);
    await f.main.reviewPermission(second.spec.taskId,b.id,async()=>false);
    assert.equal(f.host.db.get<Approval>('approvals',b.id)!.state,'denied');
  }finally{await f.close();}
});

test('unversioned queued policies retain their hashes and require user review after upgrade',async()=>{
  const f=await fixture('delegate');let finished:Promise<void>|undefined;
  try{
    const t=f.main.dispatch('legacy',f.input);await f.main.sync();
    const run=f.host.db.get<Run>('runs',t.spec.runId)!;delete run.permissions!.version;updateRun(f.host.db,run);
    // A native-defaults edit may pin old access, but must not version its policy.
    f.host.handle({type:'worker-permissions-set',expectedRevision:0,permissions:{adapter:'codex',sandbox:'read-only',approvalPolicy:'on-request'}});
    const pinned=f.host.db.get<Run>('runs',t.spec.runId)!;assert.equal(pinned.permissions!.version,undefined);assert.equal(pinned.workerPermissions!.adapter,'codex');
    pinned.state='starting';updateRun(f.host.db,pinned);finished=execute(f.state,t.spec.runId);
    const a=await f.approval(t.spec.runId),before=JSON.stringify(a);
    assert.equal(a.policy.version,undefined);assert.equal(delegateMayAllow(a),false);
    const result=await f.main.delegatePermission(t.spec.taskId,a.id,true,'Upgraded main');assert.equal((result as any).state,'user_required');
    assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true,'main')),/does not support/);
    assert.equal(JSON.stringify(f.host.db.get('approvals',a.id)),before);
    await f.main.reviewPermission(t.spec.taskId,a.id,async review=>{assert.match(review.review!.reason!,/Legacy/);return true;});await finished;
    const after=f.host.db.get<Approval>('approvals',a.id)!;assert.equal(after.requestHash,a.requestHash);assert.equal(after.policy.version,undefined);assert.equal(after.result,'completed');
    const fresh=await f.launch(),current=await f.approval(fresh.t.spec.runId);assert.equal(current.policy.version,2);assert.equal(delegateMayAllow(current),true);
    await f.main.delegatePermission(fresh.t.spec.taskId,current.id,false,'No further work');await fresh.finished;
  }finally{await f.close();await finished;}
});
