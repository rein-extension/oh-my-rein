// Opt-in end-to-end test: real main-agent tool calls, real workers, a user
// correction, native CLI resume, then a fresh conversation using saved context.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Main } from '../src/main.ts';
import { Store } from '../src/db.ts';
import { HostConfig, id } from '../src/protocol.ts';
import type { Run } from '../src/host.ts';
import { request } from '../src/transport.ts';

const {values:v}=parseArgs({options:{executable:{type:'string'},profile:{type:'string'},'codex-home':{type:'string'},'allow-model-calls':{type:'boolean'},'parallel-tasks':{type:'boolean'},conversation:{type:'boolean'}}});
if(!v['allow-model-calls']||!v.executable||!v.profile)throw Error('Requires --allow-model-calls --executable ABS --profile NAME [--codex-home DIR]. Uses provider credentials from your environment.');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let interrupted=false,active:ReturnType<typeof spawn>|undefined;
const terminate=()=>{if(active?.pid)try{process.kill(-active.pid,'SIGTERM');}catch{}};
const interrupt=()=>{interrupted=true;terminate();};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
async function until(fn:()=>Promise<boolean>,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(interrupted)throw Error('Interrupted');if(await fn())return;await sleep(500);}throw Error('Timed out waiting for worker');}

async function smoke(){
  const root=mkdtempSync(join(tmpdir(),'rein-context-live-')),repo=join(root,'repo'),hostState=join(root,'host');
  const output=resolve(v.conversation?'work/live-conversation':v['parallel-tasks']?'work/live-multitask':'work/live-context',new Date().toISOString().replaceAll(':','-')+'-'+id().slice(0,8));
  const mainHome=join(output,'codex-home'),mainState=join(output,'main'),endpoint=join(output,'endpoint.json');
  for(const p of [repo,hostState,mainHome])mkdirSync(p,{recursive:true,mode:0o700});
  const sourceHome=resolve(v['codex-home']??process.env.CODEX_HOME??join(homedir(),'.codex'));
  const settings=HostConfig.parse({repository:repo,adapter:v.conversation?'fixture':'codex',executable:resolve(v.executable!),profile:v.profile,codexHome:sourceHome,concurrency:v['parallel-tasks']||v.conversation?2:1,sandbox:'workspace-write'});
  const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(repo,'init','-q');writeFileSync(join(repo,'README.md'),'An isolated export-planning test project.\n');git(repo,'add','.');git(repo,'-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','Baseline');
  const baseCommit=git(repo,'rev-parse','HEAD'),target={kind:'local' as const,state:hostState};
  writeFileSync(endpoint,JSON.stringify(target));writeFileSync(join(hostState,'host.json'),JSON.stringify(settings),{mode:0o600});
  const tools=['rein_mode','rein_status','rein_sync','rein_dispatch','rein_collect','rein_accept','rein_review','rein_invalidate','rein_context_list','rein_context_record','rein_context_update','rein_context_retire','rein_cancel','rein_task_create','rein_task_update','rein_task_complete'];
  const cli=resolve('src/cli.ts'),instance='live-context-main';
  const provider=readFileSync(join(sourceHome,`${v.profile}.config.toml`),'utf8');
  const config=provider+`\n[mcp_servers.rein]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cli,'mcp','--state',mainState,'--config',endpoint,'--project',repo,'--instance',instance])}\nenabled_tools = ${JSON.stringify(tools)}\ndefault_tools_approval_mode = "approve"\nrequired = true\n`;
  writeFileSync(join(mainHome,'config.toml'),config,{mode:0o600});
  const instructions=readFileSync('plugins/shared/skills/rein/SKILL.md','utf8')+'\nFor this isolated test, only use Rein tools and read the sample project or collected artifacts. Do not inspect credentials, other projects, previous chat files or logs. The main agent must not edit the checkout or generate the worker patch itself. Keep user-facing replies brief. Do not spawn agents through any other tools.';
  const mainEnv:NodeJS.ProcessEnv={...process.env,CODEX_HOME:mainHome};delete mainEnv.CODEX_THREAD_ID;
  const log=openSync(join(output,'host.log'),'a',0o600);
  const releases=join(root,'releases');mkdirSync(releases);
  const host=spawn(process.execPath,[cli,'host','serve','--state',hostState],{env:{...process.env,...(v.conversation?{REIN_ALLOW_FIXTURE:'1',REIN_FIXTURE_RELEASE_DIR:releases}:{})},stdio:['ignore',log,log]});closeSync(log);
  let hostError:Error|undefined;host.on('error',e=>{hostError=e;});
  const turnEvidence:unknown[]=[],roundEvidence:unknown[]=[];let turn=0;
  let monitor:ReturnType<typeof setInterval>|undefined,monitorDb:Store|undefined,maxRunning=0;
  const observer=(session:string)=>new Main(mainState,{harness:'codex',instance,session},target,repo);
  async function converse(prompt:string,session?:string){
    if(interrupted)throw Error('Interrupted');turn++;
    const prefix=join(output,`turn-${turn}`),args=['exec','-c','approval_policy="never"','-c','sandbox_mode="read-only"','-c','features.memories=false','-c','features.shell_snapshot=false','-c','features.plugins=false','-c','features.multi_agent=false','-c',`developer_instructions=${JSON.stringify(instructions)}`];
    if(session)args.push('resume',session);
    args.push('--json','--output-last-message',prefix+'.txt','-');
    writeFileSync(prefix+'-prompt.txt',prompt,{mode:0o600});
    const child=spawn(settings.executable,args,{cwd:repo,env:mainEnv,detached:true,stdio:['pipe','pipe','pipe']});active=child;
    let out='',err='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;terminate();if(child.pid)setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1000).unref();},180000);
    child.stdout!.on('data',b=>{out+=b;if(out.length>16*1024*1024)terminate();});child.stderr!.on('data',b=>{err=(err+b).slice(-1000000);});
    child.stdin!.on('error',()=>{});child.stdin!.end(prompt);
    let code:number|null;
    try{code=await new Promise<number|null>((res,rej)=>{child.once('error',rej);child.once('close',res);});}
    finally{clearTimeout(timer);active=undefined;if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}}
    writeFileSync(prefix+'.jsonl',out,{mode:0o600});writeFileSync(prefix+'.stderr',err,{mode:0o600});
    assert.equal(code,0,timedOut?'Main agent timed out':`Main agent failed; see ${prefix}.stderr`);
    const events=out.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const thread=events.find(e=>e.type==='thread.started')?.thread_id as string|undefined;assert.ok(thread,'CLI did not emit a thread identity');
    if(session)assert.equal(thread,session,'Native resume changed thread identity');
    const calls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>e.item.tool);
    turnEvidence.push({turn,thread,calls});console.log(`Main-agent turn ${turn} finished (${calls.length} MCP calls).`);
    return thread;
  }
  async function complete(session:string,priorCount:number,format:string,taskKey?:string,filename='plan.json'){
    let main=observer(session),task:ReturnType<Main['task']>;
    try{const tasks=main.tasks().filter(t=>!taskKey||t.spec.taskKey===taskKey);assert.equal(tasks.length,priorCount+1,'Main agent must dispatch exactly one new execution for this task');task=tasks.at(-1)!;}finally{main.db.close();}
    await until(async()=>{const run=await request(target,{type:'inspect',runId:task.spec.runId});if(run&&['failed','canceled','unknown'].includes(run.state))throw Error(run.error??run.state);return run?.state==='succeeded';});
    for(let attempt=0;attempt<2;attempt++){
      main=observer(session);let finished:boolean;
      try{const t=main.task(task.spec.taskId);finished=t.status==='accepted'&&t.learning!=='pending';}finally{main.db.close();}
      if(finished)break;
      await converse('Please sync Rein, collect the result, inspect the actual report and patch, and finish acceptance and the outcome review if the requirements are met. Do not merge or edit the original checkout.',session);
    }
    main=observer(session);
    try{
      task=main.task(task.spec.taskId);assert.equal(task.status,'accepted','Main agent did not accept the verified task');assert.notEqual(task.learning,'pending','Outcome review was omitted');
      const dir=join(mainState,'artifacts',task.spec.runId),verify=join(root,`verify-${roundEvidence.length+1}`);git(root,'clone','--quiet','--no-hardlinks',repo,verify);git(verify,'apply',join(dir,'changes.patch'));
      assert.deepEqual(JSON.parse(readFileSync(join(verify,filename),'utf8')),{format,batchSize:25});
      assert.equal(git(verify,'diff','--name-only'),'');assert.equal(git(verify,'ls-files','--others','--exclude-standard'),filename);
      assert.ok(task.spec.userContext?.length,'Task omitted user-context references');
      assert.ok(!task.spec.userContext.some(n=>n.kind==='preference'),'Local conversation preference was exported');
      assert.doesNotMatch(JSON.stringify(task.spec),/concise progress|progress updates|conversation.{0,20}preference/i,'Local-only preference leaked through another task field');
      assert.equal(git(repo,'status','--porcelain'),'','Main agent modified the source checkout');
      if(taskKey)for(const ref of task.spec.userContext){const note=main.context.get(ref.id);assert.equal(note.appliesTo.type,'task');assert.equal(note.appliesTo.type==='task'?note.appliesTo.taskKey:null,taskKey);}
      roundEvidence.push({session,taskKey:task.spec.taskKey,taskId:task.spec.taskId,runId:task.spec.runId,context:task.spec.userContext,artifactDirectory:dir,status:task.status,learning:task.learning});
      return task;
    }finally{main.db.close();}
  }
  console.log(`Context continuity live test: ${output}`);
  try{
    await until(async()=>{if(hostError)throw hostError;try{await request(target,{type:'probe'},500);return true;}catch{return false;}},10000);
    if(v.conversation){
      const session=await converse(`Enable Rein. In this isolated fixture project, manage two independent user tasks: Payments (taskKey payments) and Homepage (taskKey homepage). For each, delegate one execution to add only result.txt containing that execution's exact goal followed by a newline. Use clean commit ${baseCommit}. These are workflow-test outputs, not real payment or homepage code. The Host is a deterministic fixture and will stay busy until the external test driver releases it. Queue both, sync to send, then return to me without waiting or polling. Do not complete the user tasks yet, edit the original checkout, or access the test driver's files.`);
      let main=observer(session);let payments:string,homepage:string,firstRun:string;
      try{
        assert.equal(main.userTasks().length,2);assert.equal(main.tasks().length,2);
        payments=main.userTasks().find(t=>t.taskKey==='payments')!.id;homepage=main.userTasks().find(t=>t.taskKey==='homepage')!.id;
        firstRun=main.tasks().find(e=>e.userTask?.id===payments)!.spec.runId;
        const calls=(turnEvidence.at(-1) as {calls:string[]}).calls;assert.ok(calls.filter(c=>c==='rein_sync').length<=3,'Main agent polled instead of yielding');
      }finally{main.db.close();}
      await until(async()=>{const db=new Store(hostState);try{return db.list<Run>('runs').filter(r=>r.state==='running').length===2;}finally{db.close();}},10000);
      await converse('While those tasks are running, explain briefly what an isolated Git checkout means. This is just a discussion; do not create, change or stop any task.',session);
      main=observer(session);
      try{assert.equal(main.userTasks().length,2);assert.equal(main.tasks().length,2);assert.ok(main.userTasks().every(t=>t.version===1));}finally{main.db.close();}
      await converse(`Pause Payments only; Homepage should continue. Also start a separate Setup task (taskKey setup): delegate one execution producing only result.txt with its exact goal followed by a newline, from the same clean commit ${baseCommit}. Submit it and return without waiting for completion. Do not edit the original checkout.`,session);
      main=observer(session);
      try{
        assert.equal(main.userTask(payments).status,'paused');assert.equal(main.userTask(homepage).status,'active');assert.equal(main.userTask(homepage).version,1);
        assert.equal(main.userTasks().length,3);assert.equal(main.tasks().length,3);
      }finally{main.db.close();}
      await until(async()=>(await request(target,{type:'inspect',runId:firstRun})).state==='canceled',10000);
      await converse('Resume Payments with a revised goal that explicitly includes refunds. Keep its task identity and use a new execution with the corrected goal. Its output remains only result.txt containing the new execution goal followed by a newline. Homepage and Setup are unchanged. Sync once and return without waiting for results.',session);
      main=observer(session);
      try{
        assert.equal(main.userTask(payments).status,'active');assert.ok(main.userTask(payments).revision>=2);assert.match(main.userTask(payments).goal,/refund/i);
        assert.equal(main.userTask(homepage).version,1);assert.equal(main.tasks().length,4);
        const paymentRuns=main.tasks().filter(e=>e.userTask?.id===payments);assert.equal(paymentRuns.length,2);assert.notEqual(paymentRuns[0]!.userTask!.revision,paymentRuns[1]!.userTask!.revision);
        for(const execution of main.tasks())writeFileSync(join(releases,execution.spec.runId),'release');
      }finally{main.db.close();}
      await until(async()=>{const db=new Store(hostState);try{return db.list<Run>('runs').length===4&&db.list<Run>('runs').every(r=>['succeeded','canceled'].includes(r.state));}finally{db.close();}},15000);
      await converse('Please sync, inspect and verify the delivered reports and patches. Accept valid executions and review every outcome, including the canceled one. If each current user task meets its overall completion criteria, explicitly complete it with evidence from its current accepted executions. Do not merge or edit the original checkout.',session);
      main=observer(session);
      try{
        assert.ok(main.userTasks().every(t=>t.status==='completed'),'The main agent must explicitly complete each verified user task');
        assert.equal(main.tasks().filter(e=>e.status==='accepted').length,3);assert.equal(main.tasks().filter(e=>e.status==='canceled').length,1);
        assert.ok(main.tasks().every(e=>e.learning!=='pending'));
        for(const [index,execution] of main.tasks().filter(e=>e.status==='accepted').entries()){
          const verify=join(root,`verify-conversation-${index}`),patch=join(mainState,'artifacts',execution.spec.runId,'changes.patch');
          git(root,'clone','--quiet','--no-hardlinks',repo,verify);git(verify,'apply',patch);
          assert.equal(readFileSync(join(verify,'result.txt'),'utf8'),execution.spec.goal+'\n');
          assert.equal(git(verify,'diff','--name-only'),'');assert.equal(git(verify,'ls-files','--others','--exclude-standard'),'result.txt');
        }
        assert.equal(git(repo,'status','--porcelain'),'');
        writeFileSync(join(output,'summary.json'),JSON.stringify({kind:'real-main-conversation-with-controlled-workers',profile:v.profile,hostState,turns:turnEvidence,taskCount:main.userTasks().length,executionCount:main.tasks().length,overview:main.status(),checks:['main returned while two workers remained running','ordinary discussion created no task and changed no task definition','pause targeted Payments only','a third task was submitted during existing work','resume reused user task identity with a new requirement revision and execution','three patches independently applied and verified','worker acceptance did not implicitly finish tasks; main explicitly completed them'],limitations:['Real Codex/DeepSeek main agent; deterministic fixture workers, not real coding workers','Explicit task names and controlled outputs; not a broad intent-routing evaluation','Local Host; no SSH, desktop lifecycle or automatic wake tested','Driver supplies user turns and releases workers; native memories disabled']},null,2));
      }finally{main.db.close();}
      console.log('Conversational multi-task live test passed.');return;
    }
    if(v['parallel-tasks']){
      monitorDb=new Store(hostState);monitor=setInterval(()=>{maxRunning=Math.max(maxRunning,monitorDb!.list<Run>('runs').filter(r=>r.state==='running').length);},100);
      const session=await converse(`Enable Rein. I have two independent tasks, Export A and Export B, with stable task labels export-a and export-b. Remember their requirements separately; these are task-specific requirements, not project-wide rules, and may be shared with their assigned workers. A must add only a-plan.json with exactly format="jsonl" and batchSize=25. B must add only b-plan.json with exactly format="jsonl" and batchSize=25. Run both tasks in parallel from clean commit ${baseCommit}, then collect, inspect, accept and review each result independently. Do not edit or merge into the original checkout.`);
      let main=observer(session);let aKey:string,bKey:string;
      try{const tasks=main.tasks();assert.equal(tasks.length,2);aKey='export-a';bKey='export-b';assert.deepEqual(tasks.map(t=>t.spec.taskKey).sort(),[aKey,bKey]);}finally{main.db.close();}
      const a=await complete(session,0,'jsonl',aKey,'a-plan.json'),b=await complete(session,0,'jsonl',bKey,'b-plan.json');
      assert.ok(maxRunning>=2,'Did not observe two real worker runs active together');
      await converse('Change only Export A: its format must now be csv; its batch size stays unchanged. Update A’s remembered requirement, leaving B’s requirements untouched. Repeat both tasks independently from the same clean baseline, using their saved requirements. Each still adds only its own named plan file. Review and accept both returned results without merging them.',session);
      const a2=await complete(session,1,'csv',aKey,'a-plan.json'),b2=await complete(session,1,'jsonl',bKey,'b-plan.json');
      const oldFormat=a.spec.userContext!.find(n=>/jsonl/i.test(n.content))!;assert.ok(oldFormat);
      assert.ok(a2.spec.userContext!.some(n=>n.id===oldFormat.id&&n.version>oldFormat.version&&/csv/i.test(n.content)));
      assert.deepEqual(b2.spec.userContext,b.spec.userContext,'Correction of A changed B’s saved requirements');
      main=observer(session);let overviewBytes:number,fullTaskBytes:number;
      try{assert.equal(main.tasks().length,4);overviewBytes=Buffer.byteLength(JSON.stringify(main.status()));fullTaskBytes=Buffer.byteLength(JSON.stringify(main.tasks()));}finally{main.db.close();}
      writeFileSync(join(output,'summary.json'),JSON.stringify({kind:'real-main-parallel-task-isolation',profile:v.profile,hostState,maxRunning,turns:turnEvidence,rounds:roundEvidence,overviewBytes,fullTaskBytes,checks:['one main conversation controls two independent task keys','two real workers observed running concurrently','four patches applied and independently verified','A correction preserves its note identity and changes its version','B requirements and output remain unchanged','compact tool receipts and explicit task inspection'],limitations:['Controlled local CLI test; no new SSH or desktop lifecycle validation','Task keys are chosen by the model; ambiguous natural-language routing still requires clarification','Same project and Host; multi-project routing is not implemented','Native personal memory is disabled in this isolated test; no native writeback claim','Host observation and optional follow-up turns are supplied by the test driver']},null,2));
      console.log('Parallel task isolation live test passed.');return;
    }
    const first=await converse(`Enable Rein for this project. Remember this reusable project-wide agreement for future exports: the export format must be jsonl and batch size must be 25; these requirements may be shared with workers. Also remember, for conversations in this test project only, that I prefer concise progress updates; never share that preference with workers. Delegate one task to create plan.json containing exactly the JSON keys format and batchSize using these requirements. Only plan.json may be added. Use clean base commit ${baseCommit}. Review its returned artifacts and accept if correct. Do not edit or merge into the original checkout.`);
    const firstTask=await complete(first,0,'jsonl');let main=observer(first);
    let formatId:string;
    try{const notes=main.context.list();const format=notes.find(n=>/jsonl/i.test(n.content));assert.ok(format);formatId=format.id;assert.ok(notes.some(n=>n.kind==='preference'&&!n.shareWithWorkers));}finally{main.db.close();}
    await converse('Correction to the project-wide export agreement: use csv instead of jsonl for the export format. Keep the batch size at 25. Update the remembered requirement and use the correction for future workers. Delegate a new task to produce plan.json with exactly format and batchSize under the corrected requirements, using the same clean baseline. Review and accept its returned result if correct; do not merge it.',first);
    const secondTask=await complete(first,1,'csv');main=observer(first);
    try{const note=main.context.get(formatId);assert.ok(note.version>1&&/csv/i.test(note.content));assert.equal(main.context.list().filter(n=>/jsonl/i.test(n.content)&&!/instead|replace|no longer/i.test(n.content)).length,0,'Contradictory old note remains active');assert.ok(secondTask.spec.userContext?.some(n=>n.id===formatId&&n.version===note.version));assert.equal(firstTask.spec.userContext?.find(n=>n.id===formatId)?.version,1);}finally{main.db.close();}
    // A completely new CLI thread gets no earlier native conversation. Only the
    // same project's persisted Rein ledger provides the corrected requirements.
    const fresh=await converse(`Enable Rein in this new conversation. Using the project requirements already saved in Rein, delegate one task to create plan.json containing exactly format and batchSize. Do not ask me to repeat their values. Only plan.json may be added; base commit ${baseCommit}. Inspect and accept the worker's result if correct, without editing or merging the original checkout.`);
    assert.notEqual(fresh,first);await complete(fresh,0,'csv');
    writeFileSync(join(output,'summary.json'),JSON.stringify({kind:'real-main-user-context-continuity',profile:v.profile,hostState,turns:turnEvidence,rounds:roundEvidence,checks:['actual main-agent MCP dispatch, collection, acceptance and review','explicit user requirements retained','local-only preference excluded from selected worker context','versioned user correction','native CLI resume keeps thread identity','fresh conversation reuses corrected project context','three real worker patches independently verified'],limitations:['Controlled sample project, not broad reliability evaluation','User/driver follow-up turns trigger synchronization; automatic wake not tested','Local Host; SSH with this new context schema not tested here','Conversation quote provenance is supplied by the main agent, not transcript-authenticated','Desktop plugin lifecycle, native memory writeback and portable installation remain unverified']},null,2));
    console.log('Context continuity live test passed.');
  }finally{
    if(monitor)clearInterval(monitor);monitorDb?.close();
    terminate();
    if(host.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');for(let i=0;i<40&&host.exitCode===null&&host.signalCode===null;i++)await sleep(50);if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');}
    const db=new Store(hostState);const activeRuns=()=>db.list<Run>('runs').filter(r=>!['succeeded','failed','canceled'].includes(r.state));
    db.transaction(()=>{for(const r of activeRuns())db.set('cancels',r.spec.runId,{at:Date.now()});});for(let i=0;i<60&&activeRuns().length;i++)await sleep(100);
    const remaining=activeRuns().length;db.close();if(remaining)console.error('Unconfirmed workers remain; inspect '+hostState);
  }
}
smoke().catch(e=>{console.error((e as Error).message);process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
