import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {Main} from '../src/main.ts';
import {Host,updateRun} from '../src/host.ts';
import type {Run} from '../src/host.ts';
import {execute} from '../src/runner.ts';
import {id} from '../src/protocol.ts';
import {ensureApprovalKey,signApproval} from '../src/approval-authority.ts';
import {runApprovals,decideApproval,saveApproval,finishApprovals} from '../src/approval-store.ts';
import type {Approval} from '../src/approval-store.ts';
import {ToolNative} from '../src/tool-native.ts';
import workerGate from '../src/pi-worker-gate.ts';

async function until<T>(fn:()=>T|undefined){const end=Date.now()+8000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out');}
async function fixture(adapter:'claude'|'pi',mode:'ask'|'delegate'='ask'){
  const root=mkdtempSync('/tmp/rein-tool-'),repo=join(root,'repo'),state=join(root,'host');mkdirSync(repo);mkdirSync(state);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');writeFileSync(join(repo,'README'),'tool gate test\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','base');
  const executable=join(root,'worker.mjs');writeFileSync(executable,'#!'+process.execPath+'\n'+readFileSync(resolve('tests/fixture-tool-worker.mjs'),'utf8'),{mode:0o700});
  const workerPermissions=adapter==='claude'?{adapter,permissionMode:'manual',tools:['Write']}:{adapter,toolApproval:'all',tools:['write']};
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter,executable,workerPermissions,permissionMode:mode,...(adapter==='pi'?{provider:'deepseek'}:{}),concurrency:2}));
  const host=new Host(state),target={kind:'local' as const,state},owner={harness:'codex',instance:'test',session:id()};
  let main=new Main(join(root,'main'),owner,target,repo);main.mode(true);
  const key=ensureApprovalKey(main.state,owner.instance);writeFileSync(join(state,'approval-keys.json'),JSON.stringify({[key.keyId]:key}));
  let drop=false;
  const server=createServer(socket=>{let buf='';socket.on('error',()=>{});socket.on('data',b=>{buf+=b;if(!buf.includes('\n'))return;try{const c=JSON.parse(buf),value=host.handle(c);if(drop&&c.type==='approval-decide'){socket.destroy();return;}socket.end(JSON.stringify({ok:true,value})+'\n');}catch(e){socket.end(JSON.stringify({ok:false,rejected:true,error:(e as Error).message})+'\n');}});});
  await new Promise<void>(r=>server.listen(join(state,'host.sock'),r));const pending:Promise<void>[]=[];
  const input={taskKey:'tool-test',goal:'write',originalRequest:'Test tool gating',constraints:[],acceptance:['Checked'],baseCommit:git('rev-parse','HEAD')};
  const launch=async(goal='write',previousExecutionId?:string)=>{
    const t=main.dispatch(id(),{...input,goal,...(previousExecutionId?{previousExecutionId,message:'Continue this test',answers:[]}:{})});await main.sync();
    const run=host.db.get<Run>('runs',t.spec.runId)!;run.state='starting';updateRun(host.db,run);
    const finished=execute(state,t.spec.runId);pending.push(finished);return {t,finished,workspace:join(state,'sessions',t.spec.worker!.sessionId,'workspace')};
  };
  const receipt=(a:Approval,allow:boolean)=>{const payload={requestId:a.id,requestHash:a.requestHash,runId:a.runId,owner,allow,actor:'user' as const,reason:'Trusted test UI'};return {payload,...signApproval(main.state,owner.instance,payload)};};
  return {root,repo,state,host,input,owner,launch,receipt,get main(){return main;},drop:(v:boolean)=>drop=v,
    reopen(){main.db.close();main=new Main(join(root,'main'),owner,target,repo);},approval:(runId:string)=>until(()=>runApprovals(host.db,runId)[0]),
    async close(){for(const run of host.unsettled())host.handle({type:'cancel',runId:run.spec.runId});await Promise.all(pending);await new Promise<void>(r=>server.close(()=>r()));main.db.close();host.db.close();rmSync(root,{recursive:true,force:true});}};
}

for(const adapter of ['claude','pi'] as const){
  test(adapter+': parallel approvals, client reopen, exact once grant, deny and same-session next turn',async()=>{
    const f=await fixture(adapter);try{
      const a=await f.launch(),b=await f.launch(),ar=await f.approval(a.t.spec.runId),br=await f.approval(b.t.spec.runId);
      assert.equal(existsSync(join(a.workspace,'effect.txt')),false);assert.equal(existsSync(join(b.workspace,'effect.txt')),false);
      f.reopen();await f.main.sync();assert.equal(f.main.task(a.t.spec.taskId).status,'awaiting_approval');
      await assert.rejects(f.main.delegatePermission(a.t.spec.taskId,ar.id,true,'Test'),/requires the user/);
      await f.main.reviewPermission(a.t.spec.taskId,ar.id,async()=>false);await a.finished;
      assert.equal(existsSync(join(a.workspace,'effect.txt')),false);assert.equal(existsSync(join(b.workspace,'effect.txt')),false);
      await f.main.reviewPermission(b.t.spec.taskId,br.id,async()=>true);await b.finished;await f.main.sync();
      assert.equal(readFileSync(join(b.workspace,'effect.txt'),'utf8'),'approved\n');
      assert.equal(f.host.db.get<Approval>('approvals',ar.id)!.result,'not-granted');assert.equal(f.host.db.get<Approval>('approvals',br.id)!.result,'completed');
      assert.equal(f.main.task(b.t.spec.taskId).status,'ready',f.main.task(b.t.spec.taskId).run?.error);
      if(adapter==='claude'){const decision=JSON.parse(readFileSync(join(b.workspace,'decisions.log'),'utf8'));assert.deepEqual(Object.keys(decision).sort(),['behavior','updatedInput']);}
      const follow=await f.launch('write',a.t.spec.taskId),next=await f.approval(follow.t.spec.runId);
      assert.equal(follow.workspace,a.workspace);assert.notEqual(next.id,ar.id);assert.equal(existsSync(join(a.workspace,'effect.txt')),false);
      await f.main.reviewPermission(follow.t.spec.taskId,next.id,async()=>true);await follow.finished;await f.main.sync();
      assert.equal(f.main.task(follow.t.spec.taskId).run!.nativeSessionId,f.main.task(a.t.spec.taskId).run!.nativeSessionId);
      assert.equal(f.main.task(follow.t.spec.taskId).run!.report!.summary,'continued');
    }finally{await f.close();}
  });
  test(adapter+': lost decision acknowledgement is idempotent and delegate can approve exact tool inputs',async()=>{
    const f=await fixture(adapter,'delegate');try{
      const w=await f.launch(),a=await f.approval(w.t.spec.runId);f.drop(true);
      await f.main.delegatePermission(w.t.spec.taskId,a.id,true,'Authorized fixture write');await w.finished;
      f.drop(false);await f.main.sync();
      assert.equal(readFileSync(join(w.workspace,'decisions.log'),'utf8').trim().split('\n').length,1);
      assert.equal(f.host.db.get<Approval>('approvals',a.id)!.decision!.actor,'main');assert.equal(f.main.task(w.t.spec.taskId).status,'ready');
    }finally{await f.close();}
  });
  test(adapter+': cancellation rejects late approvals; expiry declines without a fabricated user decision',async()=>{
    const f=await fixture(adapter);try{
      const w=await f.launch(),a=await f.approval(w.t.spec.runId);
      await assert.rejects(f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>{f.main.cancel(w.t.spec.taskId);return true;}),/canceled/);
      await f.main.sync();await w.finished;await f.main.sync();assert.equal(existsSync(join(w.workspace,'effect.txt')),false);
      assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true)),/no longer actionable/);
      const e=await f.launch(),expired=await f.approval(e.t.spec.runId);expired.expiresAt=Date.now()-1;saveApproval(f.host.db,expired);await e.finished;
      assert.equal(existsSync(join(e.workspace,'effect.txt')),false);assert.equal(f.host.db.get<Approval>('approvals',expired.id)!.state,'expired');assert.equal(f.host.db.get<Approval>('approvals',expired.id)!.decision,undefined);
    }finally{await f.close();}
  });
  test(adapter+': invocation loss never replays permission; approved effects remain unknown',async()=>{
    const f=await fixture(adapter);try{
      for(const allow of [false,true]){
        const w=await f.launch('crash'),a=await f.approval(w.t.spec.runId);await f.main.reviewPermission(w.t.spec.taskId,a.id,async()=>allow);await w.finished;
        assert.equal(existsSync(join(w.workspace,'effect.txt')),allow);
        assert.equal(f.host.db.get<Approval>('approvals',a.id)!.state,allow?'unknown':'resolved');
        assert.equal(f.host.db.get<Run>('runs',a.runId)!.state,allow?'unknown':'failed');
        const count=readFileSync(join(w.workspace,'decisions.log'),'utf8');decideApproval(f.host.db,f.state,{payload:f.host.db.get<Approval>('approvals',a.id)!.decision!,...signApproval(f.main.state,f.owner.instance,f.host.db.get<Approval>('approvals',a.id)!.decision!)});
        assert.equal(readFileSync(join(w.workspace,'decisions.log'),'utf8'),count);
      }
    }finally{await f.close();}
  });
  test(adapter+': unsupported tools and duplicate callbacks cannot obtain permission',async()=>{
    const f=await fixture(adapter);try{
      const w=await f.launch('unsupported');await w.finished;
      assert.equal(existsSync(join(w.workspace,'effect.txt')),false);assert.equal(runApprovals(f.host.db,w.t.spec.runId)[0]!.state,'unsupported');
      const d=await f.launch('duplicate');await d.finished;assert.equal(existsSync(join(d.workspace,'effect.txt')),false);
      const a=runApprovals(f.host.db,d.t.spec.runId)[0]!;assert.equal(a.state,'canceled');assert.throws(()=>decideApproval(f.host.db,f.state,f.receipt(a,true)),/no longer actionable/);
    }finally{await f.close();}
  });
  test(adapter+': provider secrets in native inputs never reach the approval ledger',async()=>{
    const name=adapter==='claude'?'ANTHROPIC_API_KEY':'DEEPSEEK_API_KEY',prior=process.env[name];process.env[name]='synthetic-rein-native-secret';
    const f=await fixture(adapter);try{
      const w=await f.launch('secret');await w.finished;
      assert.equal(existsSync(join(w.workspace,'effect.txt')),false);assert.equal(runApprovals(f.host.db,w.t.spec.runId).length,0);
      assert.match(f.host.db.get<Run>('runs',w.t.spec.runId)!.error!,/credential/);
      assert.ok(!readFileSync(join(f.state,'runs',w.t.spec.runId,'worker.log'),'utf8').includes(process.env[name]!));
    }finally{await f.close();if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
  });
}

test('Claude withdraws a request without converting it to a user rejection',async()=>{
  const f=await fixture('claude');try{const w=await f.launch('withdraw');await w.finished;assert.equal(runApprovals(f.host.db,w.t.spec.runId)[0]!.state,'canceled');assert.equal(existsSync(join(w.workspace,'effect.txt')),false);}finally{await f.close();}
});

test('Pi never sends a model prompt until the trusted extension and native session agree',async()=>{
  const f=await fixture('pi');let engine:ToolNative|undefined;try{
    const t=f.main.dispatch(id(),f.input);await f.main.sync();const run=f.host.db.get<Run>('runs',t.spec.runId)!;run.state='running';updateRun(f.host.db,run);
    const sent:any[]=[];engine=new ToolNative(f.host.db,t.spec.runId,f.repo,'pi',m=>sent.push(m));const failure=assert.rejects(engine.result,/session identity mismatch/);
    const session=id();await engine.start('prompt',{},session);engine.feed(JSON.stringify({type:'response',id:'rein:state',success:true,data:{sessionId:session}})+'\n');
    assert.deepEqual(sent.map(m=>m.type),['get_state']);
    engine.feed(JSON.stringify({type:'extension_ui_request',method:'notify',message:'rein-ready:'+JSON.stringify({version:1,sessionId:id()})})+'\n');await failure;
    assert.deepEqual(sent.map(m=>m.type),['get_state']);assert.equal(runApprovals(f.host.db,t.spec.runId).length,0);
  }finally{engine?.abort(Error('Test done'));await f.close();}
});

test('Pi tool extension blocks before effects and ignores late UI acceptance after abort',async()=>{
  const handlers=new Map<string,Function>();workerGate({on:(event,fn)=>{handlers.set(event,fn);}});
  const controller=new AbortController(),notifications:string[]=[],session=id();let answer!:(allow:boolean)=>void;
  const ctx={mode:'rpc',hasUI:true,cwd:'/checkout',signal:controller.signal,sessionManager:{getSessionId:()=>session},ui:{notify:(m:string)=>notifications.push(m),confirm:async(title:string,message:string)=>{assert.equal(title,'Rein tool approval');assert.equal(JSON.parse(message).sessionId,session);return new Promise<boolean>(r=>{answer=r;});}}};
  handlers.get('session_start')!({},ctx);assert.match(notifications[0]!,/^rein-ready:/);
  const pending=handlers.get('tool_call')!({toolName:'bash',toolCallId:'op',input:{command:'write effect'}},ctx);controller.abort();answer(true);
  assert.equal((await pending).block,true);
  assert.equal((await handlers.get('tool_call')!({}, {...ctx,mode:'print'})).block,true);
  for(const allow of [true,false])assert.equal((await handlers.get('tool_call')!({toolName:'read',toolCallId:'op',input:{}},{...ctx,signal:undefined,ui:{...ctx.ui,confirm:async()=>allow}}))?.block,allow?undefined:true);
});
