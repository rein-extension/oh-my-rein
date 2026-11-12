// Opt-in real main + real worker test. Never prints provider credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, openSync, closeSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
const { values:v }=parseArgs({options:{harness:{type:'string'},executable:{type:'string'},model:{type:'string'},provider:{type:'string'},settings:{type:'string'},'pi-agent-dir':{type:'string'},'runtime-dir':{type:'string'},'preflight-only':{type:'boolean'},'allow-model-calls':{type:'boolean'}}});
if((!v['allow-model-calls']&&!v['preflight-only'])||!['claude','pi'].includes(v.harness)||!v.executable)throw Error('Requires --allow-model-calls (or --preflight-only) --harness claude|pi --executable ABS [--runtime-dir installed/dist/runtime] [provider/model settings]');
const runtime=resolve(v['runtime-dir']??'dist/runtime'),extension=existsSync(join(runtime,'main.js'))?'js':'ts';
const load=name=>import(pathToFileURL(join(runtime,name+'.'+extension)).href);
const [{buildLocalPlugin},{workerInvocation},{HostConfig},{Main},{request}]=await Promise.all(['plugin','workers','protocol','main','transport'].map(load));
const root=mkdtempSync('/tmp/rein-live-harness-'),repo=join(root,'repo'),state=join(root,'host'),harness=v.harness;
console.log('Retained isolated test state: '+root);
for(const dir of [repo,state])mkdirSync(dir,{mode:0o700});
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(repo,'init','-q');writeFileSync(join(repo,'sample.json'),'{"format":"jsonl","batchSize":37}\n');git(repo,'add','.');git(repo,'-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','Baseline');const baseCommit=git(repo,'rev-parse','HEAD');
const config=HostConfig.parse({repository:repo,adapter:harness,executable:resolve(v.executable),model:v.model,provider:v.provider,settings:v.settings?resolve(v.settings):undefined,piAgentDir:v['pi-agent-dir']?resolve(v['pi-agent-dir']):undefined,sandbox:'workspace-write',permissionMode:'ask',workerPermissions:harness==='claude'?{adapter:'claude',permissionMode:'bypassPermissions',tools:['Read','Bash']}:{adapter:'pi',tools:['read','write','bash'],toolApproval:'never'}});
writeFileSync(join(state,'host.json'),JSON.stringify(config),{mode:0o600});
const endpoint=join(root,'endpoint.json'),target={kind:'local',state};writeFileSync(endpoint,JSON.stringify(target));
const mainState=join(root,'main'),instance='live-'+harness,session=randomUUID();
const credentialRoot=join(root,'provider');mkdirSync(credentialRoot);
// Reuse the worker adapter's credential-only loader; do not copy native stores.
const providerEnv=workerInvocation(config,credentialRoot).env;
if(v['preflight-only']){console.log(JSON.stringify({status:'passed',harness,workerPermissions:config.workerPermissions,checks:['explicit native permissions','explicit headless adapter invocation','provider-only environment'],modelCalls:false}));process.exit(0);}
// This smoke exercises native main lifecycle, not approval UI. These explicit
// noninteractive fixture permissions are never used as installation defaults.
const plugin=buildLocalPlugin(resolve(runtime,extension==='ts'?'..':'../..'),join(root,'plugin'),harness,{state:mainState,config:endpoint,project:repo,instance});
const nativeHome=join(root,'native');mkdirSync(nativeHome);
const env={...process.env,...providerEnv,...(harness==='claude'?{CLAUDE_CONFIG_DIR:nativeHome}:{PI_CODING_AGENT_DIR:nativeHome})};
delete env.CODEX_THREAD_ID;delete env.CLAUDE_CODE_SESSION_ID;
const log=openSync(join(root,'host.log'),'a',0o600);
const host=spawn(process.execPath,[join(runtime,'cli.'+extension),'host','serve','--state',state],{stdio:['ignore',log,log]});closeSync(log);
const main=()=>new Main(mainState,{harness,instance,session},target,repo);
const inspect=fn=>{const m=main();try{return fn(m);}finally{m.db.close();}};
async function turn(name,prompt,{resume=false,newSession=false}={}){
  const id=newSession?randomUUID():session;
  const args=harness==='claude'?['--print','--setting-sources','','--plugin-dir',plugin.plugin,'--tools','','--allowedTools','mcp__plugin_rein_rein__*','--permission-mode','dontAsk','--permission-prompts','none','--output-format','stream-json','--verbose',...(resume?['--resume',session]:['--session-id',id]),...(v.model?['--model',v.model]:[])]:['--print','--mode','json','--session-id',id,'--session-dir',join(root,'pi-sessions'),'--no-extensions','--no-mcp','--no-skills','--no-context-files','--no-prompt-templates','--no-builtin-tools','--offline','--extension',join(plugin.plugin,'index.mjs'),...(v.provider?['--provider',v.provider]:[]),...(v.model?['--model',v.model]:[])];
  await new Promise((res,rej)=>{
    const child=spawn(config.executable,args,{cwd:repo,env,detached:true,stdio:['pipe','pipe','pipe']});let output='',error='';
    let killer;const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}killer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);},240000);
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('error',error=>{clearTimeout(timer);clearTimeout(killer);rej(error);});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(killer);writeFileSync(join(root,name+'.jsonl'),output,{mode:0o600});writeFileSync(join(root,name+'.err'),error,{mode:0o600});if(code!==0)return rej(Error(name+' failed; inspect retained logs'));
      try{const events=output.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));const header=events.find(e=>harness==='claude'?e.type==='system'&&e.subtype==='init':e.type==='session');assert.equal(harness==='claude'?header.session_id:header.id,id);res();}catch(e){rej(e);}
    });child.stdin.end(prompt);
  });
  return id;
}
async function ready(){const end=Date.now()+10000;while(Date.now()<end){try{await request(target,{type:'probe'},500);return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Host did not start');}
try{
  await ready();
  await turn('dispatch',`Use Rein tools to enable mode and manage these TWO independent tasks. Create task alpha (title Alpha, goal create result.json copied exactly from sample.json, acceptance ["result.json equals sample.json"]) and task beta (title Beta, goal inspect the batchSize in sample.json without edits, acceptance ["Report batchSize 37 and no file changes"]). Record a shareable task-scoped constraint for alpha, kind constraint, content and quote "Only create result.json; leave source files unchanged". Use stable request keys. Dispatch one execution for EACH task, using its userTaskId and revision. Alpha must select its recorded contextId; beta selects no context. Every execution uses baseCommit ${baseCommit}. Constraints: only work inside this sample checkout; do not access credentials, external network, or other projects. The ${harness} worker has ${harness==='pi'?'read, write and bash':'Read and Bash'} tools. It may read fixture files and use shell commands inside its own checkout to inspect files, copy content, compare bytes and check git status. Alpha verifies result.json against sample.json including newline; Beta only inspects sample.json and git status and does not need result.json. Do not inspect environment variables or outside paths. Read the input file, carry out the task, and verify. Return immediately after both dispatch receipts. Do not wait, poll, collect, or complete tasks.`);
  const tasks=inspect(m=>m.userTasks()),executions=inspect(m=>m.tasks());assert.equal(tasks.length,2);assert.equal(executions.length,2);
  const alpha=executions.find(t=>t.spec.taskKey==='alpha'),beta=executions.find(t=>t.spec.taskKey==='beta');assert.equal(alpha.spec.userContext.length,1);assert.equal(beta.spec.userContext?.length??0,0);
  const until=Date.now()+210000;
  while(Date.now()<until){const m=main();try{await m.sync();const runs=m.tasks();
      if(runs.some(t=>['failed','unknown','canceled'].includes(t.status)))throw Error('Worker failed; inspect Host logs');if(runs.every(t=>t.status==='ready'))break;}finally{m.db.close();}await new Promise(r=>setTimeout(r,500));}
  const m=main();try{
    assert.ok(m.tasks().every(t=>t.status==='ready'),'Workers must finish');
    const a=await m.collect(alpha.spec.taskId),b=await m.collect(beta.spec.taskId);
    const verify=join(root,'verify');git(root,'clone','-q',repo,verify);git(verify,'apply',join(a.directory,'changes.patch'));assert.deepEqual(JSON.parse(readFileSync(join(verify,'result.json'),'utf8')),{format:'jsonl',batchSize:37});assert.equal(readFileSync(join(b.directory,'changes.patch'),'utf8'),'');assert.match(JSON.stringify(m.task(beta.spec.taskId).run.report),/37/);
  }finally{m.db.close();}
  await turn('resume',`Resume our Rein work. Sync once, inspect BOTH executions with full status, collect their reports and patches, then review the outcomes. The test driver independently applied Alpha's verified patch to a clean clone and checked result.json equals {"format":"jsonl","batchSize":37}; Beta's patch was checked empty and its report contains batchSize 37. Check unresolved questions before accepting each execution with one evidence entry per criterion. Record the actual verification provenance honestly. Discard reusable learning for these fixture-only outcomes. Complete each user task explicitly using its accepted execution and current version. Do not dispatch new work.`,{resume:true});
  assert.ok(inspect(m=>m.userTasks()).every(t=>t.status==='completed'),'Native main must complete both tasks');
  assert.ok(inspect(m=>m.tasks()).every(t=>t.acceptance&&t.learning),'Native main must accept and review each execution');
  const fresh=await turn('new-session','Use rein_mode with no arguments, rein_status, and rein_context_list with taskKey alpha. Report the state. Do not enable mode, create or change anything.',{newSession:true});
  const other=new Main(mainState,{harness,instance,session:fresh},target,repo);try{assert.equal(other.mode(),false);assert.equal(other.userTasks().length,0);assert.equal(other.context.page({taskKey:'alpha'}).entries.length,0);}finally{other.db.close();}
  const summary={harness,session,freshSession:fresh,baseCommit,checks:['native tool calls','runtime-owned session identity','two independent tasks','task-scoped context selection','two real model workers','verified patch applied to clean clone','read-only outcome unchanged','native session resume','collect/accept/review/task completion','new-session ownership isolation'],limits:['local Host transport, not SSH','explicit noninteractive fixture worker permissions; native approvals are a separate test','CLI lifecycle, not desktop UI or in-process /clear','no automatic wake or native-memory writeback'],status:'passed'};
  writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{
  // A failed assertion must not leave billable workers behind.
  const m=main();try{for(const t of m.tasks())if(!['ready','failed','canceled','accepted','continued'].includes(t.status)){m.cancel(t.spec.taskId);}await m.sync();}catch{}finally{m.db.close();}
  const runs=inspect(m=>m.tasks());for(const t of runs)if(t.run?.pid&&['starting','running','unknown'].includes(t.run.state))try{process.kill(t.run.pid,'SIGTERM');}catch{}
  if(host.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(()=>host.kill('SIGKILL'),5000);host.once('close',()=>{clearTimeout(timer);resolve();});host.kill('SIGTERM');});}
}
