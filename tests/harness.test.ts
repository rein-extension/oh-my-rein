import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { issueBinding, consumeBinding } from '../src/claude-binding.ts';
import { installPiExtension } from '../src/pi-extension.ts';
import { Main } from '../src/main.ts';
import { HostConfig } from '../src/protocol.ts';
import { workerInvocation, saveWorkerReport } from '../src/workers.ts';
import { belongsToProject } from '../src/project-scope.ts';

test('Claude native receipts bind concurrent sessions, normalized arguments, tool and project; reject replay/forgery',()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-claude-')),directory=join(root,'bindings'),a=randomUUID(),b=randomUUID();
  const issue=(session:string,input:unknown={})=>issueBinding(directory,root,{hook_event_name:'PreToolUse',session_id:session,cwd:root,tool_name:'mcp__plugin_rein_rein__rein_status',tool_input:input}).hookSpecificOutput.updatedInput;
  try{
    const x=issue(a),y=issue(b,{view:'attention'});
    const {_reinBinding:tx,...ax}=x,{_reinBinding:ty,...ay}=y;
    assert.equal(consumeBinding(directory,root,'rein_status',ay,ty),b);
    assert.equal(consumeBinding(directory,root,'rein_status',ax,tx),a);
    assert.throws(()=>consumeBinding(directory,root,'rein_status',ax,tx),/consumed/);
    assert.throws(()=>consumeBinding(directory,root,'rein_status',{},randomUUID()),/Unknown/);
    const z=issue(a);assert.throws(()=>consumeBinding(directory,root,'rein_cancel',{},z._reinBinding),/does not match/);
    const changed=issue(a);assert.throws(()=>consumeBinding(directory,root,'rein_status',{limit:1},changed._reinBinding),/does not match/);
    assert.throws(()=>issueBinding(directory,root,{hook_event_name:'PreToolUse',session_id:a,cwd:root,agent_id:'subagent'}),/cannot be delegated/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Pi extension uses current native session per call across switch/resume; shares project context but isolates tasks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-pi-')),config=join(root,'endpoint.json');writeFileSync(config,JSON.stringify({kind:'local',state:join(root,'offline')}));
  const tools:any[]=[];const events:Record<string,Function>={},commands:Record<string,any>={};let session=randomUUID();const a=session;
  const ctx={cwd:root,sessionManager:{getSessionId:()=>session},ui:{notify:()=>{}}};
  installPiExtension({registerTool:t=>tools.push(t),registerCommand:(n,c)=>commands[n]=c,on:(n,h)=>events[n]=h},{state:join(root,'main'),config,project:root,instance:'test'},'instructions');
  const call=async(name:string,args:unknown={})=>JSON.parse((await tools.find(t=>t.name===name).execute('call',args,undefined,undefined,ctx)).content[0].text);
  try{
    assert.equal(tools.length,23);assert.ok(tools.some(t=>t.name==='rein_effects_review'));assert.equal((await call('rein_mode')).enabled,false);
    const record=tools.find(t=>t.name==='rein_context_record').parameters;
    assert.ok(record.required.includes('appliesTo'));
    assert.ok(!record.required.includes('shareWithWorkers'));
    assert.equal(record.properties.appliesTo.anyOf.length,2);
    assert.equal(record.additionalProperties,false);
    await commands.rein.handler('on',ctx);
    const task=await call('rein_task_create',{requestKey:'one',taskKey:'one',title:'One',goal:'First task',acceptance:['Works']});
    await call('rein_context_record',{requestKey:'project',kind:'constraint',content:'Keep compatibility',quote:'Keep compatibility',appliesTo:{type:'project'}});
    session=randomUUID();assert.equal((await call('rein_mode')).enabled,false);assert.equal((await call('rein_status')).tasks.length,0);
    assert.equal((await call('rein_context_list')).entries.length,1);
    await assert.rejects(call('rein_task_update',{userTaskId:task.userTaskId,expectedVersion:1,status:'canceled',reason:'Other chat'}),/not owned/);
    session=a;assert.equal((await call('rein_mode')).enabled,true);assert.equal((await call('rein_status')).tasks.length,1);
    await assert.rejects(call('rein_status',{session:randomUUID()}),/Unrecognized key/);
    const injection=await events.before_agent_start({systemPrompt:'Original'},ctx);assert.match(injection.systemPrompt,/instructions/);
    assert.match(injection.systemPrompt,/First task/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Pi status and off retain cached workers, pagination and the last successful sync across a disconnect',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-pi-status-')),state=join(root,'main'),config=join(root,'endpoint.json');
  const target={kind:'local' as const,state:join(root,'offline')};
  writeFileSync(config,JSON.stringify(target));
  const owner={harness:'pi',instance:'test',session:randomUUID()},main=new Main(state,owner,target,root);
  const commands:Record<string,any>={},notices:string[]=[];
  let session=owner.session;
  const ctx={cwd:root,sessionManager:{getSessionId:()=>session},ui:{notify:(message:string)=>notices.push(message)}};
  installPiExtension({registerTool(){},registerCommand:(name,command)=>commands[name]=command,on(){}},{state,config,project:root,instance:'test'},'instructions');
  const run=async(action:string)=>{await commands.rein.handler(action,ctx);return notices.at(-1)!;};
  try{
    assert.match(await run('on'),/Host unavailable/);
    const task=main.createUserTask('payment',{taskKey:'payment',title:'Fix payments',goal:'Fix payments',acceptance:['Payment succeeds']});
    const other=main.createUserTask('tests',{taskKey:'tests',title:'Speed up tests',goal:'Investigate slow tests',acceptance:['Find the slowest test']});
    for(let i=0;i<11;i++)main.dispatch('worker-'+i,{userTaskId:i===10?other.id:task.id,expectedRevision:1,goal:'Inspect '+i,
      originalRequest:'Inspect the code',constraints:[],acceptance:['Report findings'],baseCommit:'a'.repeat(40)});
    // Legacy ledgers recorded the time of a successful sync only in "at".
    const previous=Date.UTC(2026,0,1);
    main.db.set('sync-status',main.binding,{state:'synced',at:previous});
    assert.match(await run('off'),/11 queued/);
    const before=main.syncRecord();
    const first=await run('status');
    assert.match(first,/Rein off/);assert.match(first,/Fix payments/);assert.match(first,/Speed up tests/);
    assert.match(first,/Inspect 10 · queued/);assert.match(first,/More: \/rein status 2/);
    assert.match(await run('status 2'),/Inspect 0 · queued/);
    assert.match(await run('status 0'),/Usage:/);
    assert.deepEqual(main.syncRecord(),before,'Neither disabling nor browsing workers attempts delivery or sync');
    assert.ok(main.tasks().every(t=>!t.cancelRequested));
    const generation=main.db.get<number>('sync-generation',main.binding)??0;
    const receipt=JSON.parse(await run('sync'));
    assert.equal(receipt.mode,false);assert.equal(receipt.sync.state,'unavailable');
    assert.equal(main.db.get('sync-generation',main.binding),generation+1,'An explicit sync makes one pass');
    const offline=main.syncRecord();assert.equal(offline.state,'unavailable');assert.equal(offline.lastSyncedAt,previous);
    const stale=await run('');assert.match(stale,/Last complete sync: 2026-01-01/);assert.match(stale,/Last attempt: unavailable/);
    assert.deepEqual(main.syncRecord(),offline);
    session=randomUUID();
    const fresh=await run('status');assert.match(fresh,/none recorded/);assert.doesNotMatch(fresh,/Fix payments|Speed up tests/);
  }finally{main.db.close();rmSync(root,{recursive:true,force:true});}
});

test('worker adapters isolate native state, import credentials only and reject failed/truncated reports',()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-workers-'));
  const report={summary:'Done',evidence:['Checked'],discoveries:[],unresolved:[]};
  try{
    const settings=join(root,'settings.json');writeFileSync(settings,JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'test-key',DANGEROUS_OPTION:'ignored'},hooks:{bad:true}}));
    const c=workerInvocation(HostConfig.parse({repository:root,adapter:'claude',executable:'claude',permissionMode:'read-only',settings}),root);
    assert.ok(c.args.includes('--bare'));assert.ok(c.args.includes('--restricted'));assert.equal(c.env.ANTHROPIC_AUTH_TOKEN,'test-key');assert.equal(c.env.DANGEROUS_OPTION,undefined);assert.equal(c.args.includes('test-key'),false);assert.ok(c.args.includes('Read,Glob,Grep'));
    const auth=join(root,'auth');mkdirSync(auth);writeFileSync(join(auth,'auth.json'),JSON.stringify({deepseek:{type:'api_key',key:'test-pi-key'}}));
    const p=workerInvocation(HostConfig.parse({repository:root,adapter:'pi',executable:'pi',permissionMode:'read-only',provider:'deepseek',piAgentDir:auth}),root);
    assert.equal(p.env.DEEPSEEK_API_KEY,'test-pi-key');assert.ok(p.args.includes('--no-extensions'));assert.ok(p.args.includes('--no-session'));assert.ok(!p.args.includes('bash'));
    assert.throws(()=>saveWorkerReport('claude',root,JSON.stringify({type:'result',subtype:'error',is_error:true,result:JSON.stringify(report)})),/did not finish/);
    saveWorkerReport('claude',root,JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify(report)}));assert.deepEqual(JSON.parse(readFileSync(join(root,'report.json'),'utf8')),report);rmSync(join(root,'report.json'));
    const events=[{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(report)}]}},{type:'agent_settled',aborted:false}];
    saveWorkerReport('pi',root,events.map(e=>JSON.stringify(e)).join('\n'));rmSync(join(root,'report.json'));
    events[1]!.aborted=true;assert.throws(()=>saveWorkerReport('pi',root,events.map(e=>JSON.stringify(e)).join('\n')),/did not finish/);
    assert.throws(()=>saveWorkerReport('pi',root,JSON.stringify(events[0])),/did not finish/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('native adapters allow project subdirectories and internal symlinks but isolate other checkouts',async()=>{
  const root=mkdtempSync('/tmp/rein-paths-'),project=join(root,'project'),outside=join(root,'outside'),nested=join(project,'worktree');
  mkdirSync(join(project,'packages'),{recursive:true});mkdirSync(outside);mkdirSync(nested);writeFileSync(join(nested,'.git'),'gitdir: elsewhere');
  symlinkSync(join(project,'packages'),join(project,'inside-link'));symlinkSync(outside,join(project,'escape'));symlinkSync(project,join(root,'project-link'));
  const config=join(root,'endpoint.json');writeFileSync(config,JSON.stringify({kind:'local',state:join(root,'offline')}));
  const events:Record<string,Function>={},tools:any[]=[],notices:string[]=[],session=randomUUID();
  const ctx={cwd:join(project,'packages'),sessionManager:{getSessionId:():string=>session},ui:{notify:(message:string)=>notices.push(message)}};
  installPiExtension({registerTool:t=>tools.push(t),registerCommand(){},on:(name,fn)=>events[name]=fn},{state:join(root,'main'),config,project,instance:'test'},'instructions');
  const call=async()=>JSON.parse((await tools.find(t=>t.name==='rein_status').execute('call',{},undefined,undefined,ctx)).content[0].text);
  try{
    assert.equal((await call()).mode,false);assert.equal(await events.before_agent_start({systemPrompt:'normal'},ctx),undefined);assert.equal(notices.length,0);
    for(const path of [project,join(project,'packages'),join(project,'inside-link'),join(root,'project-link','packages')]){
      assert.equal(belongsToProject(path,project),true);
      const receipt=issueBinding(join(root,'bindings'),project,{hook_event_name:'PreToolUse',session_id:session,cwd:path,tool_name:'mcp__plugin_rein_rein__rein_status',tool_input:{}}).hookSpecificOutput.updatedInput;
      const {_reinBinding,...args}=receipt;assert.equal(consumeBinding(join(root,'bindings'),project,'rein_status',args,_reinBinding),session);
    }
    for(const path of [outside,join(project,'escape'),nested,join(root,'missing')]){
      ctx.cwd=path;assert.equal(belongsToProject(path,project),false);
      assert.equal(await events.before_agent_start({systemPrompt:'normal'},ctx),undefined,'An unrelated project must not interrupt native chat');
      await assert.rejects(call(),/different project/);
      assert.throws(()=>issueBinding(join(root,'bindings'),project,{hook_event_name:'PreToolUse',session_id:session,cwd:path}),/different project/);
    }
    ctx.cwd=project;ctx.sessionManager.getSessionId=()=> 'invalid-native-id';
    await assert.doesNotReject(()=>events.before_agent_start({systemPrompt:'normal'},ctx));assert.equal(notices.length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
