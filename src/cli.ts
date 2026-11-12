#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join, dirname, sep } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as promptInterface } from 'node:readline/promises';
import { approvalPrompt } from './approval-prompt.ts';
import { fileURLToPath } from 'node:url';
import { HostConfig, Endpoint, MAX_FRAME, PermissionMode } from './protocol.ts';
import { listConnections } from './connections.ts';
import { validateWorkerPermissions } from './permissions.ts';
import { serve } from './host.ts';
import { request, RemoteRejection } from './transport.ts';
import { Main } from './main.ts';
import { startMcp, runtimeSession } from './mcp.ts';
import { issueBinding } from './claude-binding.ts';
import { z } from 'zod';
import { installHostConfiguration } from './host-installation.ts';

const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{
  profile:{type:'string'},'codex-home':{type:'string'},harness:{type:'string'},model:{type:'string'},provider:{type:'string'},settings:{type:'string'},'pi-agent-dir':{type:'string'},
  reason:{type:'string'},'confirm-stopped':{type:'boolean'},
  host:{type:'string'},worker:{type:'string'},'approval-policy':{type:'string'},'tools':{type:'string'},'claude-permission-mode':{type:'string'},'pi-tool-approval':{type:'string'},
  state:{type:'string'},config:{type:'string'},file:{type:'string'},repository:{type:'string'},executable:{type:'string'},adapter:{type:'string'},session:{type:'string'},instance:{type:'string'},project:{type:'string'},key:{type:'string'},task:{type:'string'},value:{type:'string'},'allow-fixture':{type:'boolean'},help:{type:'boolean'},foreground:{type:'boolean'},sandbox:{type:'string'},'permission-mode':{type:'string'},
}});
const output=(x:unknown)=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
const state=resolve(v.state??'.rein');
async function cli(){
  if(v.help||!p[0]){console.log(`Rein — development preview (Node 24)
host init --state DIR --repository ABS --executable ABS [--adapter codex|claude|pi] [--sandbox read-only|workspace-write]
  [--permission-mode ask|delegate] (approval routing; default: ask)
  [--model NAME] [--settings FILE] [--provider NAME --pi-agent-dir ABS]
  [--profile NAME --codex-home ABS]     isolated worker config from NAME.config.toml
host serve --state DIR                 foreground supervisor
host start --state DIR                 detached development supervisor
host status|drain|resume|stop --state DIR  inspect, pause new work, resume, or stop an idle Host
host inspect --state DIR --task RUN_ID   inspect an execution before recovery
host resolve --state DIR --task RUN_ID --confirm-stopped --reason TEXT
  after inspecting orphan processes and external effects; resolves unknown as canceled
  Use --config ENDPOINT.json instead of --state for a remote Host.
bridge --state DIR                     one JSON command over stdin (SSH transport)
probe --config ENDPOINT.json
main mode|dispatch|continue|sync|permissions|permission-review|status|collect|cancel|accept|review
  --state DIR --config ENDPOINT.json --project ABS --instance ID --session UUID
  dispatch --file INPUT.json --key STABLE_KEY; collect/cancel --task UUID
  status [--file {view?,id?,taskKey?,offset?,limit?}.json]   user tasks by default; view=executions for workers
main task-create|task-update|task-complete
  task-create --key STABLE_KEY --file USER_TASK.json
  task-update/task-complete --file INPUT.json
  accept --task UUID --file EVIDENCE_ARRAY.json
  review --task UUID --file REVIEW.json; mode --value ask|delegate|off
main context-list|context-record|context-update|context-retire
  context-list [--file {contextId?,taskKey?,includeInactive?,offset?,limit?}.json]
  context-record --key STABLE_KEY --file CONTEXT.json
  context-update/context-retire --file REVISION.json
mcp --state DIR --config ENDPOINT.json --project ABS --instance ID [--harness codex|claude]
  Codex uses runtime thread metadata; Claude requires the native Rein hook receipt
doctor [--harness codex|claude|pi]       local runtime and CLI checks
mode ask|delegate|off [--host HOST --worker NAME --project DIR] [--session UUID]
  Routing for the current runtime-bound conversation; never changes worker access.
worker permissions [set] [--host HOST --worker NAME --project DIR | --config ENDPOINT.json]
  codex: --sandbox read-only|workspace-write|danger-full-access --approval-policy on-request|never
  claude: --claude-permission-mode manual|acceptEdits|dontAsk|bypassPermissions --tools Read,Glob,Grep,...
  pi: --tools read,grep,find,ls,edit,write,bash --pi-tool-approval all|never
  Changes only new worker sessions. Existing sessions retain their native permissions.
No automatic wake, revision steering, or merge in this preview.`);return;}
  const selectConnection=()=>{
    if(v.config)return;
    const project=realpathSync(resolve(v.project??process.cwd()));
    const candidates=listConnections().filter(c=>!c.error&&c.project&&(c.project===project||project.startsWith(c.project+sep))&&(!v.host||c.host===v.host)&&(!v.worker||c.worker===v.worker)&&(!v.harness||c.harness===v.harness));
    const nearest=Math.max(0,...candidates.map(c=>c.project!.length));
    const matches=candidates.filter(c=>c.project!.length===nearest);
    if(matches.length!==1)throw Error('Select exactly one installed connection with --host, --worker and --project, or supply --config from rein connections');
    const connection=matches[0]!;v.config=connection.endpoint;v.instance??=connection.instance;v.project=connection.project;v.harness??=connection.harness;v.state??=join(dirname(connection.endpoint!),'main');
  };
  if(p[0]==='worker'){
    if(v['permission-mode'])throw Error('Use rein mode ask|delegate for routing; native Claude permissions use --claude-permission-mode');
    if(p[1]!=='permissions'||(p[2]&&p[2]!=='set'))throw Error('Usage: rein worker permissions [set] --host HOST --worker NAME');
    if(!v.state||v.config||v.host)selectConnection();
    const target=v.config?Endpoint.parse(JSON.parse(readFileSync(v.config,'utf8'))):{kind:'local' as const,state};
    if(v.host&&(target.kind!=='ssh'||target.destination!==v.host))throw Error('--host does not match this endpoint');
    const current=await request(target,{type:'worker-permissions',...(v.worker?{adapter:z.enum(['codex','claude','pi']).parse(v.worker)}:{})});
    if(p[2]!=='set'){
      if(v.sandbox||v['approval-policy']||v['claude-permission-mode']||v['pi-tool-approval']||v.tools)throw Error('Use worker permissions set to change native permissions');
      output(current);return;
    }
    if(!v.sandbox&&!v['approval-policy']&&!v['claude-permission-mode']&&!v['pi-tool-approval']&&!v.tools)throw Error('Specify at least one native permission option');
    const permissions={...current.permissions};
    if(permissions.adapter==='codex'){
      if(v.tools||v['claude-permission-mode']||v['pi-tool-approval'])throw Error('Codex accepts --sandbox and --approval-policy');
      if(v.sandbox)permissions.sandbox=v.sandbox;if(v['approval-policy'])permissions.approvalPolicy=v['approval-policy'];
    }else{
      if(v.sandbox||v['approval-policy'])throw Error('This worker has no Codex sandbox/approval-policy options');
      if(v.tools!==undefined)permissions.tools=v.tools.split(',').map(s=>s.trim());
      if(v['pi-tool-approval']){if(permissions.adapter!=='pi')throw Error('--pi-tool-approval requires Pi');permissions.toolApproval=v['pi-tool-approval'];}
      if(v['claude-permission-mode']){if(permissions.adapter!=='claude')throw Error('--claude-permission-mode requires Claude');permissions.permissionMode=v['claude-permission-mode'];}
    }
    output(await request(target,{type:'worker-permissions-set',permissions:validateWorkerPermissions(permissions),expectedRevision:current.revision}));return;
  }
  if(p[0]==='mode'){
    const mode=p[1];if(mode!=='off')PermissionMode.parse(mode);
    selectConnection();p[0]='main';p[1]='mode';v.value=mode;
  }
  if(p[0]==='claude-hook'){
    if(!v.project)throw Error('--project required');
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>MAX_FRAME)throw Error('Hook input too large');}
    output(issueBinding(join(state,'claude-bindings'),resolve(v.project),JSON.parse(input)));return;
  }
  if(p[0]==='host'){
    if(p[1]==='install-config'){
      if(!v.file)throw Error('--file required');
      output(installHostConfiguration(state,JSON.parse(readFileSync(v.file,'utf8'))));return;
    }
    if(['status','inspect','drain','resume','stop','resolve'].includes(p[1]!)){
      const target=v.config?Endpoint.parse(JSON.parse(readFileSync(v.config,'utf8'))):{kind:'local' as const,state};
      if(p[1]==='status'){output(await request(target,{type:'probe'}));return;}
      if(p[1]==='inspect'){if(!v.task)throw Error('--task RUN_ID required');output(await request(target,{type:'inspect',runId:v.task}));return;}
      if(p[1]==='drain'||p[1]==='resume'){output(await request(target,{type:'maintenance',enabled:p[1]==='drain'}));return;}
      if(p[1]==='resolve'){
        if(!v.task||!v.reason||!v['confirm-stopped'])throw Error('--task RUN_ID, --confirm-stopped and --reason are required after inspecting processes and external effects');
        output(await request(target,{type:'resolve',runId:v.task,confirmStopped:true,reason:v.reason}));return;
      }
      await request(target,{type:'maintenance',enabled:true});
      await request(target,{type:'shutdown'});
      for(let i=0;i<50;i++){
        await new Promise(r=>setTimeout(r,100));
        try{await request(target,{type:'probe'},500);}catch{output({shutdownAcknowledged:true,connection:'closed-or-unavailable'});return;}
      }
      throw Error('Host stop not confirmed; inspect before updating');
    }
    if(p[1]==='init'){
      if(!v.repository||!v.executable)throw Error('repository and executable required');
      const adapter=z.enum(['codex','claude','pi','fixture']).parse(v.adapter??'codex');
      if(adapter!=='codex'&&(v['approval-policy']||v.sandbox))throw Error('--sandbox/--approval-policy require Codex');
      if(adapter!=='pi'&&v['pi-tool-approval'])throw Error('--pi-tool-approval requires Pi');
      if(adapter!=='claude'&&v['claude-permission-mode'])throw Error('--claude-permission-mode requires Claude');
      if(!['claude','pi'].includes(adapter)&&v.tools)throw Error('--tools requires Claude or Pi');
      const workerPermissions=adapter==='fixture'?undefined:validateWorkerPermissions(adapter==='codex'
        ?{adapter,sandbox:v.sandbox??'read-only',approvalPolicy:v['approval-policy']??'on-request'}
        :adapter==='claude'?{adapter,permissionMode:v['claude-permission-mode']??'manual',tools:(v.tools??'Read,Glob,Grep').split(',').map(t=>t.trim())}
        :{adapter,tools:(v.tools??'read,grep,find,ls').split(',').map(t=>t.trim()),toolApproval:v['pi-tool-approval']??'all'});
      const c=HostConfig.parse({repository:resolve(v.repository),executable:resolve(v.executable),adapter,workerPermissions,sandbox:v.sandbox==='read-only'?'read-only':workerPermissions?.adapter==='codex'&&workerPermissions.sandbox!=='read-only'?'workspace-write':'read-only',permissionMode:PermissionMode.parse(v['permission-mode']??'ask'),profile:v.profile,codexHome:v['codex-home']?resolve(v['codex-home']):undefined,model:v.model,provider:v.provider,settings:v.settings?resolve(v.settings):undefined,piAgentDir:v['pi-agent-dir']?resolve(v['pi-agent-dir']):undefined});
      if(c.adapter==='fixture'&&!v['allow-fixture'])throw Error('Fixture must be explicitly allowed');
      mkdirSync(state,{recursive:true,mode:0o700});writeFileSync(join(state,'host.json'),JSON.stringify(c,null,2),{flag:'wx',mode:0o600});output(c);return;
    }
    if(p[1]==='serve'){await serve(state);return;}
    if(p[1]==='start'){
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'host','serve','--state',state],{detached:true,stdio:'ignore'});
      child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.unref();
      for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));try{output(await request({kind:'local',state},{type:'probe'}));return;}catch{}}
      throw Error('Host did not become ready; run host serve to inspect diagnostics');
    }
    throw Error('Unknown host command');
  }
  if(p[0]==='bridge'){
    const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
    for await(const line of rl){if(Buffer.byteLength(line)>MAX_FRAME)throw Error('Frame too large');
      try{process.stdout.write(JSON.stringify({ok:true,value:await request({kind:'local',state},JSON.parse(line))})+'\n');}
      catch(e){process.stdout.write(JSON.stringify({ok:false,rejected:e instanceof RemoteRejection,error:(e as Error).message})+'\n');}rl.close();break;}return;
  }
  if(p[0]==='doctor'){
    const harness=z.enum(['codex','claude','pi']).parse(v.harness??'codex');
    const executable=v.executable??harness,version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:10000});
    const help=spawnSync(executable,harness==='codex'?['exec','--help']:['--help'],{encoding:'utf8',timeout:10000});
    const required=harness==='claude'?['--bare','--restricted','--no-session-persistence','--permission-prompts']:harness==='pi'?['--no-session','--no-extensions','--no-mcp','--no-context-files']:['--ephemeral','--output-schema','--output-last-message','--sandbox'];
    output({node:process.version,harness,version:version.status===0?version.stdout.trim():'unavailable',missingWorkerFlags:required.filter(f=>!help.stdout?.includes(f)),sessionBinding:harness==='claude'?'native PreToolUse receipt':harness==='pi'?'native sessionManager.getSessionId()':'runtime MCP thread metadata or CODEX_THREAD_ID',wake:'not verified',modelAuthentication:'not tested',remote:'requires configured SSH endpoint'});return;
  }
  if(!v.config)throw Error('--config ENDPOINT.json required');const target=Endpoint.parse(JSON.parse(readFileSync(v.config,'utf8')));
  if(p[0]==='probe'){output(await request(target,{type:'probe'}));return;}
  if(!v.instance||!v.project)throw Error('--instance and --project required');
  if(p[0]==='mcp'){
    const harness=z.enum(['codex','claude']).parse(v.harness??'codex');
    await startMcp(meta=>new Main(state,{harness,instance:v.instance!,session:harness==='claude'?z.guid().parse(meta?.nativeSession):runtimeSession(meta,process.env.CODEX_THREAD_ID)},target,resolve(v.project!)),harness==='claude'?{directory:join(state,'claude-bindings'),project:resolve(v.project)}:undefined);return;
  }
  const session=v.session??process.env.CODEX_THREAD_ID;
  if(!session)throw Error('No runtime-bound session identity; CLI requires --session or CODEX_THREAD_ID.');
  const main=new Main(resolve(v.state??state),{harness:z.enum(['codex','claude','pi']).parse(v.harness??'codex'),instance:v.instance,session},target,resolve(v.project));
  if(p[0]!=='main')throw Error('Unknown command');
  const file=()=>{if(!v.file)throw Error('--file required');return JSON.parse(readFileSync(v.file,'utf8'));};
  try{switch(p[1]){
    case 'mode':if(v.value&&!['on','off','ask','delegate'].includes(v.value))throw Error('mode value must be ask, delegate, on or off');if(v.value==='ask'||v.value==='delegate')main.approvalMode(v.value);output({enabled:main.mode(v.value===undefined?undefined:v.value!=='off'),mode:main.approvalMode()});break;
    case 'task-create':if(!v.key)throw Error('--key required');output(main.createUserTask(v.key,file()));break;
    case 'task-update':{const {userTaskId,expectedVersion,...input}=file();output(main.updateUserTask(userTaskId,expectedVersion,input));break;}
    case 'task-complete':{const x=file();output(main.completeUserTask(x.userTaskId,x.expectedVersion,x.evidence,x.executionIds));break;}
    case 'dispatch':if(!v.key)throw Error('--key required');output(main.dispatch(v.key,file()));break;
    case 'permissions':if(!v.task)throw Error('--task execution ID required');output(await main.permissionRequests(v.task));break;
    case 'permission-review':{
      if(!v.task||!v.value)throw Error('--task execution ID and --value permission request ID required');
      if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('User approval requires an interactive trusted terminal; piping a decision is not supported');
      output(await main.reviewPermission(v.task,v.value,async a=>{
        const prompt=promptInterface({input:process.stdin,output:process.stdout});
        try{const answer=(await prompt.question(approvalPrompt(a)+'\nType allow, deny, or press Enter to leave pending: ')).trim();return answer==='allow'?true:answer==='deny'?false:null;}finally{prompt.close();}
      }));break;
    }
    case 'continue':if(!v.key)throw Error('--key required');output(await main.continueExecution(v.key,file()));break;
    case 'sync':output(await main.sync());break;
    case 'status':output(main.status(v.file?file():{}));break;
    case 'context-list':{const x=v.file?file():{};output(x.contextId?{entry:main.context.get(x.contextId),history:main.context.history(x.contextId)}:main.context.page(x));break;}
    case 'context-record':if(!v.key)throw Error('--key required');output(main.context.record(v.key,file()));break;
    case 'context-update':{const {contextId,expectedVersion,...input}=file();output(main.context.update(contextId,expectedVersion,input));break;}
    case 'context-retire':{const x=file();output(main.context.retire(x.contextId,x.expectedVersion,x.reason));break;}
    case 'cancel':output(main.cancel(v.task!));break;
    case 'collect':output(await main.collect(v.task!));break;
    case 'accept':output(main.accept(v.task!,file()));break;
    case 'review':{const x=file();output(main.review(v.task!,x.decision,x.content,x.discovery));break;}
    default:throw Error('Unknown main command');
  }}finally{main.db.close();}
}
cli().catch(e=>{console.error((e as Error).message);process.exitCode=1;});
