import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Host} from '../src/host.ts';
import {Main} from '../src/main.ts';
import {id,WorkerPermissionsUpdate} from '../src/protocol.ts';
import {reinTools} from '../src/tools.ts';
import {installPiExtension} from '../src/pi-extension.ts';
import {issueBinding} from '../src/claude-binding.ts';

async function fixture(adapter:'codex'|'claude'|'pi'='codex'){
  const root=realpathSync(mkdtempSync('/tmp/rein-config-')),repo=join(root,'repo'),state=join(root,'host'),mainState=join(root,'main');mkdirSync(repo);mkdirSync(state);
  const permissions=adapter==='codex'?{adapter,sandbox:'read-only',approvalPolicy:'on-request'}:adapter==='claude'?{adapter,permissionMode:'manual',tools:['Read']}:{adapter,tools:['read']};
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter,executable:process.execPath,workerPermissions:permissions,permissionMode:'ask'}));
  const host=new Host(state),target={kind:'local' as const,state},owner={harness:'codex',instance:'test',session:id()},config=join(root,'endpoint.json');writeFileSync(config,JSON.stringify(target));
  let drop=false,oldHost=false,beforeSet:undefined|(()=>void),holdRead=false,releaseRead:undefined|(()=>void);let writes=0;
  const server=createServer({allowHalfOpen:true},s=>{let buf='';s.on('error',()=>{});s.on('data',b=>{buf+=b;if(!buf.includes('\n'))return;
    try{const c=JSON.parse(buf);
      if(c.type==='worker-permissions'&&holdRead){holdRead=false;releaseRead=()=>s.end(JSON.stringify({ok:true,value:host.handle(c)})+'\n');return;}
      if(c.type==='worker-permissions-set'){writes++;beforeSet?.();}const result:any=host.handle(c);
      if(c.type==='worker-permissions'&&oldHost)delete result.updateProtocol;
      if(c.type==='worker-permissions-set'&&drop){s.destroy();return;}s.end(JSON.stringify({ok:true,value:result})+'\n');
    }catch(e){s.end(JSON.stringify({ok:false,rejected:true,error:(e as Error).message})+'\n');}
  });});await new Promise<void>(r=>server.listen(join(state,'host.sock'),r));
  const main=()=>new Main(mainState,owner,target,repo),catalog=()=>reinTools(()=>main());
  const call=(name:string,args:unknown={})=>catalog().find(t=>t.name===name)!.execute(args);
  const get=async()=>value(await call('rein_worker_permissions'));
  const input=(snapshot:any,changes:unknown,key=id())=>({requestKey:key,targetId:snapshot.targetId,expectedRevision:snapshot.revision,changes,reason:'User requested this worker configuration in the main conversation'});
  return {root,repo,state,mainState,host,target,owner,config,main,catalog,call,get,input,get writes(){return writes;},drop:(v:boolean)=>drop=v,oldHost:(v:boolean)=>oldHost=v,beforeSet:(fn:()=>void)=>beforeSet=fn,holdRead:()=>holdRead=true,get readHeld(){return !!releaseRead;},releaseRead:()=>{releaseRead?.();releaseRead=undefined;},
    async close(){await new Promise<void>(r=>server.close(()=>r()));host.db.close();rmSync(root,{recursive:true,force:true});}};
}
const value=(result:any)=>{assert.notEqual(result.isError,true,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};

for(const adapter of ['codex','claude','pi'] as const)test(adapter+': conversation tool patches only requested settings and preserves routing and mode',async()=>{
  const f=await fixture(adapter);try{
    const before=await f.get();assert.equal(before.repository,f.repo);assert.equal(before.project,f.repo);assert.equal(before.adapter,adapter);assert.equal(before.sharedAcrossConversations,true);
    const changes=adapter==='codex'?{adapter,sandbox:'workspace-write'}:{adapter,tools:adapter==='claude'?['Read','Edit']:['read','write']};
    const result=value(await f.call('rein_worker_permissions_set',f.input(before,changes)));
    assert.equal(result.status,'applied');assert.deepEqual(result.change.before,before.permissions);assert.deepEqual(result.change.after,{...before.permissions,...changes});
    assert.deepEqual(result.current.permissions,result.change.after);assert.equal(result.current.revision,1);assert.equal(result.current.existingSessions,'unchanged');assert.equal(result.current.appliesTo,'new-worker-sessions');
    assert.equal(result.approvalRouting,'unchanged');assert.deepEqual(result.change.owner,f.owner);assert.equal(result.change.source,'main-request');
    if(adapter==='pi')assert.equal(result.current.permissions.toolApproval,undefined,'Adding a tool must not silently enable a legacy Pi gate');
    const m=f.main();try{assert.equal(m.mode(),false);assert.equal(m.approvalMode(),'ask');await m.sync();}finally{m.db.close();}
    assert.equal(f.writes,1);assert.equal((f.host.handle({type:'probe'}) as any).permissions.mode,'ask');
    const reopened=new Host(f.state);try{assert.deepEqual((reopened.handle({type:'worker-permissions'}) as any).permissions,result.change.after);}finally{reopened.db.close();}
  }finally{await f.close();}
});

test('wrong target, stale revision, wrong adapter and invalid fields cannot change worker defaults',async()=>{
  const f=await fixture(),other=await fixture();try{
    const s=await f.get(),foreign=await other.get();
    for(const input of [
      {...f.input(s,{adapter:'codex',sandbox:'workspace-write'}),targetId:foreign.targetId},
      {...f.input(s,{adapter:'codex',sandbox:'workspace-write'}),expectedRevision:10},
      f.input(s,{adapter:'pi',tools:['bash']}),f.input(s,{adapter:'codex'}),
      f.input(s,{adapter:'codex',mode:'delegate'}),f.input(s,{adapter:'codex',sandbox:'full-access'}),
      {...f.input(s,{adapter:'codex',sandbox:'workspace-write'}),owner:{...f.owner,session:id()}},
    ])assert.equal((await f.call('rein_worker_permissions_set',input)).isError,true);
    assert.equal(f.writes,0);assert.equal((await f.get()).revision,0);
    // A different conversation changes the shared defaults after our read.
    const m=new Main(f.mainState,{...f.owner,session:id()},f.target,f.repo);
    try{await m.setWorkerPermissions(WorkerPermissionsUpdate.parse(f.input(s,{adapter:'codex',sandbox:'workspace-write'})));}finally{m.db.close();}
    const stale=await f.call('rein_worker_permissions_set',f.input(s,{adapter:'codex',approvalPolicy:'never'}));assert.equal(stale.isError,true);assert.match(stale.content[0]!.text,/changed/);
    assert.equal((await f.get()).permissions.approvalPolicy,'on-request');
  }finally{await f.close();await other.close();}
});

test('Host CAS catches intervening edits, and retries never resurrect a rejected change',async()=>{
  const f=await fixture();try{
    const s=await f.get(),input=f.input(s,{adapter:'codex',approvalPolicy:'never'});let fired=false;
    f.beforeSet(()=>{if(fired)return;fired=true;f.host.handle({type:'worker-permissions-set',expectedRevision:s.revision,permissions:{...s.permissions,sandbox:'workspace-write'}});});
    assert.equal((await f.call('rein_worker_permissions_set',input)).isError,true);assert.equal((await f.get()).permissions.approvalPolicy,'on-request');
    assert.equal((await f.call('rein_worker_permissions_set',input)).isError,true);assert.equal(f.writes,1);
  }finally{await f.close();}
});

test('lost configuration acknowledgement survives Main reopen; exact retry recovers the receipt without reverting a newer change',async()=>{
  const f=await fixture();try{
    const original=await f.get(),input=f.input(original,{adapter:'codex',sandbox:'workspace-write'});f.drop(true);
    const uncertain=value(await f.call('rein_worker_permissions_set',input));assert.equal(uncertain.status,'unknown');assert.equal((await f.get()).revision,1);
    const m=f.main();try{await m.sync();}finally{m.db.close();}assert.equal(f.writes,1,'Ordinary sync must not retry configuration writes');
    const saved=await f.get();f.host.handle({type:'worker-permissions-set',permissions:{...saved.permissions,sandbox:'read-only'},expectedRevision:saved.revision});f.drop(false);
    const recovered=value(await f.call('rein_worker_permissions_set',input));assert.equal(recovered.status,'applied');assert.equal(recovered.change.revision,1);assert.equal(recovered.change.after.sandbox,'workspace-write');
    assert.equal(recovered.current.revision,2);assert.equal(recovered.current.permissions.sandbox,'read-only','A retry must not overwrite a newer edit');
    value(await f.call('rein_worker_permissions_set',input));assert.equal(f.writes,2,'Confirmed local receipt needs no further write');
    const conflict=await f.call('rein_worker_permissions_set',{...input,changes:{adapter:'codex',sandbox:'danger-full-access'}});assert.equal(conflict.isError,true);assert.match(conflict.content[0]!.text,/key content conflict/);
    const stored=f.host.db.list<any>('worker-permission-changes')[0]!;assert.equal(stored.receipt.reason,input.reason);
  }finally{await f.close();}
});

test('identical overlapping configuration tool calls commit only one revision',async()=>{
  const f=await fixture();try{
    const input=f.input(await f.get(),{adapter:'codex',sandbox:'workspace-write'});
    const results=await Promise.all([f.call('rein_worker_permissions_set',input),f.call('rein_worker_permissions_set',input)]);
    assert.ok(results.every(r=>value(r).status==='applied'));assert.equal((await f.get()).revision,1);assert.equal(f.host.db.list('worker-permission-changes').length,1);
  }finally{await f.close();}
});

test('an identical request committed during a delayed read recovers instead of reporting a stale revision',async()=>{
  const f=await fixture();let delayed:Promise<any>|undefined;try{
    const input=f.input(await f.get(),{adapter:'codex',sandbox:'workspace-write'});f.holdRead();delayed=f.call('rein_worker_permissions_set',input);
    const end=Date.now()+3000;while(!f.readHeld&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(f.readHeld);
    assert.equal(value(await f.call('rein_worker_permissions_set',input)).status,'applied');f.releaseRead();
    assert.equal(value(await delayed).status,'applied');assert.equal((await f.get()).revision,1);assert.equal(f.writes,1);
  }finally{f.releaseRead();await delayed;await f.close();}
});

test('cancellation, old runtime and replaced Host identity cannot silently apply settings',async()=>{
  const f=await fixture();try{
    const s=await f.get(),input=f.input(s,{adapter:'codex',sandbox:'workspace-write'}),controller=new AbortController();controller.abort('Canceled');
    const tool=f.catalog().find(t=>t.name==='rein_worker_permissions_set')!;assert.equal((await tool.execute(input,undefined,controller.signal)).isError,true);assert.equal(f.writes,0);
    f.oldHost(true);const unsupported=await f.call('rein_worker_permissions_set',input);assert.equal(unsupported.isError,true);assert.match(unsupported.content[0]!.text,/Update the Host/);assert.equal(f.writes,0);f.oldHost(false);
    f.host.db.set('host','epoch',id());const replaced=await f.call('rein_worker_permissions_set',input);assert.equal(replaced.isError,true);assert.match(replaced.content[0]!.text,/target changed/);
    const fresh=await f.get();f.beforeSet(()=>f.host.db.set('host','epoch',id()));
    assert.equal((await f.call('rein_worker_permissions_set',f.input(fresh,{adapter:'codex',sandbox:'workspace-write'}))).isError,true);assert.equal((await f.get()).revision,0);
  }finally{await f.close();}
});

for(const harness of ['codex','claude','pi'] as const)test(harness+': permission configuration works through the bound plugin interface without a shell tool',async()=>{
  const f=await fixture('pi'),owner={...f.owner,harness};let client:Client|undefined;
  try{
    let call:(name:string,args?:Record<string,unknown>)=>Promise<any>;
    if(harness==='pi'){
      const tools:any[]=[];installPiExtension({registerTool:t=>tools.push(t),registerCommand(){},on(){}},{state:f.mainState,config:f.config,project:f.repo,instance:owner.instance},'test');
      const ctx={cwd:f.repo,sessionManager:{getSessionId:()=>owner.session},ui:{notify(){}}};
      call=(name,args={})=>tools.find(t=>t.name===name).execute(id(),args,undefined,undefined,ctx);
    }else{
      client=new Client({name:'worker-config-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('src/cli.ts'),'mcp','--state',f.mainState,'--config',f.config,'--project',f.repo,'--instance',owner.instance,'--harness',harness],env:{PATH:process.env.PATH!,...(harness==='codex'?{CODEX_THREAD_ID:owner.session}:{})}}));
      call=(name,args={})=>client!.callTool({name,arguments:harness==='claude'?issueBinding(join(f.mainState,'claude-bindings'),f.repo,{hook_event_name:'PreToolUse',session_id:owner.session,cwd:f.repo,tool_name:'mcp__plugin_rein_rein__'+name,tool_input:args}).hookSpecificOutput.updatedInput:args});
    }
    const s=value(await call('rein_worker_permissions'));
    const result=value(await call('rein_worker_permissions_set',f.input(s,{adapter:'pi',toolApproval:'all'})));
    assert.equal(result.current.permissions.toolApproval,'all');assert.deepEqual(result.current.permissions.tools,['read']);assert.deepEqual(result.change.owner,owner);
    assert.equal((f.host.handle({type:'probe'}) as any).permissions.mode,'ask');
  }finally{await client?.close();await f.close();}
});
