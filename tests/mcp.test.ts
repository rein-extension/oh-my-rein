import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeSession } from '../src/mcp.ts';
import { Main } from '../src/main.ts';

test('MCP tool discovery, mode and model-visible schemas use runtime session binding',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-mcp-')),config=join(root,'endpoint.json');
  writeFileSync(config,JSON.stringify({kind:'local',state:join(root,'host')}));
  const client=new Client({name:'rein-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',join(root,'main'),'--config',config,'--project',root,'--instance','test'],env:{PATH:process.env.PATH!,CODEX_THREAD_ID:'original-session'}});
  try{
    await client.connect(transport);const {tools}=await client.listTools();
    assert.equal(tools.length,23);assert.ok(tools.some(t=>t.name==='rein_dispatch'));assert.ok(tools.some(t=>t.name==='rein_continue'));assert.ok(tools.some(t=>t.name==='rein_effects_review'));
    const mode=await client.callTool({name:'rein_mode',arguments:{enabled:true}});
    const content=mode.content as {type:string;text:string}[];
    assert.equal(JSON.parse(content[0]!.text).owner.session,'original-session');
    const status=await client.callTool({name:'rein_status',arguments:{}});assert.notEqual(status.isError,true);
    // Tool input cannot replace the transport-bound owner/session.
    const dispatch=tools.find(t=>t.name==='rein_dispatch')!;
    assert.equal('owner' in (dispatch.inputSchema.properties??{}),false);
    assert.ok(tools.every(t=>t.inputSchema.additionalProperties===false));
    const record=tools.find(t=>t.name==='rein_context_record')!.inputSchema;
    assert.ok(record.required?.includes('appliesTo'));
    assert.ok(!record.required?.includes('shareWithWorkers'));
    assert.equal((record.properties?.appliesTo as {anyOf:unknown[]}).anyOf.length,2);
  }finally{await client.close();rmSync(root,{recursive:true,force:true});}
});

test('MCP request metadata binds each call without a startup session and isolates conversations',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-mcp-meta-')),config=join(root,'endpoint.json');
  writeFileSync(config,JSON.stringify({kind:'local',state:join(root,'host')}));
  const client=new Client({name:'rein-runtime-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',join(root,'main'),'--config',config,'--project',root,'--instance','test'],env:{PATH:process.env.PATH!}});
  const a=randomUUID(),b=randomUUID();
  const value=(result:any)=>JSON.parse(result.content[0].text);
  try{
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length,23,'Discovery works before thread identity is available');
    const missing=await client.callTool({name:'rein_mode',arguments:{enabled:true,session:a,owner:{session:a},_meta:{threadId:a}}});
    assert.equal(missing.isError,true,'Model-visible arguments cannot provide runtime identity');
    const invalid=await client.callTool({name:'rein_mode',arguments:{},_meta:{threadId:'not-a-thread'}});
    assert.equal(invalid.isError,true);
    const mode=await client.callTool({name:'rein_mode',arguments:{enabled:true},_meta:{threadId:a}});
    assert.equal(value(mode).owner.session,a);assert.equal(value(mode).enabled,true);
    const other=await client.callTool({name:'rein_mode',arguments:{},_meta:{threadId:b}});
    assert.equal(value(other).enabled,false);
    const parent=value(await client.callTool({name:'rein_task_create',arguments:{requestKey:'parent',taskKey:'routing',title:'Routing',goal:'Test routing',acceptance:['Routing holds']},_meta:{threadId:a}}));
    const task=await client.callTool({name:'rein_dispatch',arguments:{requestKey:'one',userTaskId:parent.userTaskId,expectedRevision:parent.revision,goal:'Test routing',originalRequest:'Test only',constraints:[],acceptance:['Routing holds'],baseCommit:'a'.repeat(40)},_meta:{threadId:a}});
    assert.notEqual(task.isError,true);const taskId=value(task).taskId;
    const [own,foreign]=await Promise.all([a,b].map(threadId=>client.callTool({name:'rein_status',arguments:{},_meta:{threadId}})));
    assert.equal(value(own).tasks.length,1);assert.equal(value(foreign).tasks.length,0);
    const cancel=await client.callTool({name:'rein_cancel',arguments:{executionId:taskId},_meta:{threadId:b}});
    assert.equal(cancel.isError,true);assert.match((cancel.content as {text:string}[])[0]!.text,/not owned/);
  }finally{await client.close();rmSync(root,{recursive:true,force:true});}
});

test('runtime metadata must agree with a fixed environment binding',()=>{
  const thread=randomUUID();assert.equal(runtimeSession({threadId:thread},thread),thread);
  assert.throws(()=>runtimeSession({threadId:randomUUID()},thread),/conflicts/);
  assert.throws(()=>runtimeSession(undefined),/No runtime-bound/);
  assert.equal(runtimeSession(undefined,'legacy-runtime-session'),'legacy-runtime-session');
  // Native IDs accepted by the earlier runtime may use any 8-4-4-4-12 hex groups.
  const legacy='12345678-abcd-0001-0002-123456789abc';
  assert.equal(runtimeSession({threadId:legacy}),legacy);
  assert.throws(()=>runtimeSession({threadId:'malformed'}));
});

test('MCP knowledge review records optional main evidence separately from worker assertions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-mcp-review-')),config=join(root,'endpoint.json'),state=join(root,'main'),target={kind:'local' as const,state:join(root,'host')};
  writeFileSync(config,JSON.stringify(target));
  const owner={harness:'codex',instance:'test',session:'review-session'},main=new Main(state,owner,target,root);main.mode(true);
  const client=new Client({name:'rein-review-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',state,'--config',config,'--project',root,'--instance','test'],env:{PATH:process.env.PATH!,CODEX_THREAD_ID:owner.session}});
  try{
    await client.connect(transport);
    for(const evidence of [undefined,['Inspected the artifact and confirmed the reported format']]){
      const t=main.dispatch(randomUUID(),{goal:'Review',originalRequest:'Review',constraints:[],acceptance:['Checked'],baseCommit:'a'.repeat(40)});
      t.status='ready';t.learning='pending';t.run={spec:t.spec,state:'succeeded',created:Date.now(),report:{summary:'Done',evidence:[],unresolved:[],discoveries:[{content:'Uses CSV',source:'output.csv',verified:true}]}};
      main.db.set('tasks',t.spec.taskId,t);
      const result=await client.callTool({name:'rein_review',arguments:{executionId:t.spec.taskId,decision:'retain',content:'Uses CSV',discovery:0,...(evidence?{verificationEvidence:evidence}:{})}});
      assert.notEqual(result.isError,true,JSON.stringify(result));
      const fact=main.knowledge().at(-1)!;
      assert.equal(fact.workerClaimedVerified,true);assert.equal(fact.verified,!!evidence);
      assert.deepEqual(fact.verification,{status:evidence?'main-reported':'unverified',evidence:evidence??[]});
      assert.deepEqual(fact.review!.by,owner);
    }
  }finally{await client.close();main.db.close();rmSync(root,{recursive:true,force:true});}
});

test('MCP context survives conversations while dispatch and corrections keep runtime ownership',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-mcp-context-')),config=join(root,'endpoint.json');
  writeFileSync(config,JSON.stringify({kind:'local',state:join(root,'host')}));
  const client=new Client({name:'rein-context-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',join(root,'main'),'--config',config,'--project',root,'--instance','test'],env:{PATH:process.env.PATH!}});
  const a=randomUUID(),b=randomUUID();
  const call=(threadId:string,name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args,_meta:{threadId}});
  const value=(result:any)=>{assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  try{
    await client.connect(transport);
    const note=value(await call(a,'rein_context_record',{appliesTo:{type:'project'},requestKey:'format',kind:'constraint',content:'Export files must use jsonl.',quote:'Please export files as jsonl.',shareWithWorkers:true}));
    assert.equal(note.recordedBy.session,a);
    const local=value(await call(a,'rein_context_record',{appliesTo:{type:'project'},requestKey:'local',kind:'preference',content:'Use concise progress updates.',quote:'Use concise progress updates.'}));
    assert.equal(local.shareWithWorkers,false);
    assert.equal(value(await call(b,'rein_context_list')).entries.length,2);
    assert.equal(value(await call(b,'rein_mode')).enabled,false);
    await call(a,'rein_mode',{enabled:true});
    const parent=value(await call(a,'rein_task_create',{requestKey:'parent',taskKey:'export',title:'Export records',goal:'Produce an export',acceptance:['Uses the requested format']}));
    const input={requestKey:'job',userTaskId:parent.userTaskId,expectedRevision:parent.revision,contextIds:[note.id],goal:'Export records',originalRequest:'Export records.',constraints:[],acceptance:['Uses the requested format'],baseCommit:'a'.repeat(40)};
    const receipt=value(await call(a,'rein_dispatch',input));
    const task=value(await call(a,'rein_status',{view:'executions',id:receipt.taskId})).execution;
    assert.equal(task.spec.userContext[0].version,1);
    assert.equal(task.spec.userContext[0].quote,undefined);
    const updated=value(await call(b,'rein_context_update',{contextId:note.id,expectedVersion:1,content:'Export files must use csv.',quote:'Use csv instead.',shareWithWorkers:true}));
    assert.equal(updated.version,2);assert.equal(updated.recordedBy.session,b);
    const stale=await call(a,'rein_context_update',{contextId:note.id,expectedVersion:1,content:'Stale correction.',quote:'Stale correction.'});
    assert.equal(stale.isError,true);
    const original=value(await call(a,'rein_status',{view:'executions',id:receipt.taskId}));
    assert.equal(original.execution.spec.userContext[0].version,1);
    assert.equal(value(await call(b,'rein_status')).tasks.length,0);
    const leak=await call(a,'rein_dispatch',{...input,requestKey:'leak',contextIds:[],originalRequest:'Export records. Use concise progress updates.'});
    assert.equal(leak.isError,true);
    value(await call(b,'rein_context_retire',{contextId:note.id,expectedVersion:2,reason:'No longer needed.'}));
    const history=value(await call(a,'rein_context_list',{contextId:note.id}));
    assert.equal(history.entry.active,false);assert.deepEqual(history.history.map((n:any)=>n.version),[1,2,3]);
    assert.equal((await call(a,'rein_dispatch',{...input,requestKey:'retired'})).isError,true);
  }finally{await client.close();rmSync(root,{recursive:true,force:true});}
});
