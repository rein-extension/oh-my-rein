// Opt-in, billable model test. Credentials are supplied by the caller's environment.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Main } from '../src/main.ts';
import { Store } from '../src/db.ts';
import type { Run } from '../src/host.ts';
import { id } from '../src/protocol.ts';
import { request } from '../src/transport.ts';

const {values:v}=parseArgs({options:{executable:{type:'string'},profile:{type:'string'},'allow-model-calls':{type:'boolean'}}});
if(!v['allow-model-calls']||!v.executable)throw Error('Requires --allow-model-calls --executable ABS [--profile NAME]. Uses your provider credentials and quota.');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let interrupted=false;
const interrupt=()=>{interrupted=true;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
async function waitFor(check:()=>Promise<boolean>,timeout=240000){
  const until=Date.now()+timeout;
  while(Date.now()<until){if(interrupted)throw Error('Live test interrupted');if(await check())return;await sleep(500);}
  throw Error('Live test timed out');
}

async function smoke(){
  const root=mkdtempSync(join(tmpdir(),'rein-live-')),repo=join(root,'repo'),state=join(root,'host');
  const output=resolve('work/live',new Date().toISOString().replaceAll(':','-')+'-'+id().slice(0,8));
  mkdirSync(repo);mkdirSync(state,{mode:0o700});mkdirSync(output,{recursive:true,mode:0o700});
  console.log(`Live model test output: ${output}`);
  console.log(`Host state: ${state}`);
  const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(repo,'init','-q');
  writeFileSync(join(repo,'export-config.json'),JSON.stringify({format:'ndjson',batchSize:37}));
  writeFileSync(join(repo,'README.md'),'Isolated Rein integration test repository. Only inspect or edit files inside this checkout.\n');
  git(repo,'add','.');git(repo,'-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','Baseline');
  const baseCommit=git(repo,'rev-parse','HEAD');
  writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter:'codex',executable:resolve(v.executable!),profile:v.profile,concurrency:1,sandbox:'workspace-write'}),{mode:0o600});
  const target={kind:'local' as const,state},owner={harness:'codex',instance:'live-smoke',session:id()};
  const log=openSync(join(output,'host.log'),'a',0o600);
  const host=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'host','serve','--state',state],{stdio:['ignore',log,log]});closeSync(log);
  let hostError:Error|undefined;host.on('error',e=>{hostError=e;});
  let main:Main|undefined;
  const evidence:unknown[]=[];
  try {
    await waitFor(async()=>{if(hostError)throw hostError;if(host.exitCode!==null)throw Error('Host exited; inspect host.log');try{await request(target,{type:'probe'},500);return true;}catch{return false;}},10000);
    main=new Main(join(output,'main'),owner,target,repo);main.mode(true);
    const goals=[
      'Read export-config.json. Report its export format as your first discovery, citing the file. Do not change files.',
      'Read export-config.json. Report its batchSize as your first discovery, citing the file. Explain how it pairs with the export format in the supplied reviewed knowledge. Do not change files.',
      'Using the two supplied reviewed knowledge entries, create plan.json containing exactly the JSON keys format and batchSize with their recorded values. Do not read export-config.json for this task. Verify plan.json by reading it. Do not modify other files.',
    ];
    for(let i=0;i<goals.length;i++){
      const task:ReturnType<Main['dispatch']>=main.dispatch(`round-${i+1}`,{knowledgeIds:main.knowledge().map(k=>k.id),goal:goals[i]!,originalRequest:'Validate three real executions and reviewed project context reuse.',constraints:['Only access the sample checkout; do not access credentials, network, or other projects.','Do not invoke other agents.'],acceptance:[i===2?'plan.json contains the export format and batch size from reviewed context.':'The requested project fact is accurately reported with file evidence.'],baseCommit});
      assert.equal(task.spec.knowledge.length,i);
      writeFileSync(join(output,`task-${i+1}.json`),JSON.stringify(task.spec,null,2));
      await main.sync();
      // Close and reopen the caller while the independent Host continues execution.
      main.db.close();main=undefined;await sleep(1500);
      main=new Main(join(output,'main'),owner,target,repo);
      await waitFor(async()=>{await main!.sync();const t=main!.task(task.spec.taskId);if(['failed','unknown','canceled'].includes(t.status))throw Error(`Round ${i+1}: ${t.run?.error??t.status}`);return t.status==='ready';});
      const result=await main.collect(task.spec.taskId),report=main.task(task.spec.taskId).run!.report!;
      assert.equal(report.unresolved.length,0,'Worker reported unresolved requirements');
      const patch=readFileSync(join(result.directory,'changes.patch'),'utf8');
      if(i<2){
        assert.equal(patch,'','Read-only task changed the checkout');
        assert.match(report.discoveries[0]?.content??'',i===0?/ndjson/i:/\b37\b/);
        assert.match(report.discoveries[0]?.source??'',/export-config\.json/);
      }else{
        const verify=join(root,'verification');git(root,'clone','--quiet','--no-hardlinks',repo,verify);
        git(verify,'apply',join(result.directory,'changes.patch'));
        assert.deepEqual(JSON.parse(readFileSync(join(verify,'plan.json'),'utf8')),{format:'ndjson',batchSize:37});
        assert.equal(git(verify,'diff','--name-only'),'','Existing files changed');
        assert.equal(git(verify,'ls-files','--others','--exclude-standard'),'plan.json');
      }
      main.accept(task.spec.taskId,[i===2?'Applied the verified patch to a clean clone and asserted exact plan.json values and file scope.':'Compared the first discovery to the fixture file and verified the patch is empty.']);
      if(i<2)main.review(task.spec.taskId,'retain',i===0?'The project export format is ndjson.':'The project export batch size is 37.',0);
      else main.review(task.spec.taskId,'discard');
      evidence.push({round:i+1,taskId:task.spec.taskId,runId:task.spec.runId,contextEntries:task.spec.knowledge.length,artifacts:result.directory,summary:report.summary,status:'accepted'});
      console.log(`Round ${i+1}/3 passed: ${task.spec.knowledge.length} prior context entries, verified output.`);
    }
    writeFileSync(join(output,'summary.json'),JSON.stringify({kind:'live-codex-local',profile:v.profile,hostState:state,checks:['real model execution','client reopen','structured report','verified patch applied to clean clone','two reviewed facts supplied to third execution'],limitations:['Scripted review, not autonomous main-agent review','No real SSH or native chat binding in this test','Does not establish complete memory isolation or prove which evidence the model used'],runs:evidence},null,2));
  } finally {
    main?.db.close();
    if(host.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');for(let i=0;i<40&&host.exitCode===null&&host.signalCode===null;i++)await sleep(50);if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');}
    const db=new Store(state);
    const active=()=>db.list<Run>('runs').filter(r=>!['succeeded','failed','canceled'].includes(r.state));
    db.transaction(()=>{for(const r of active())db.set('cancels',r.spec.runId,{at:Date.now()});});
    for(let i=0;i<60&&active().length;i++)await sleep(100);
    const remaining=active();db.close();
    if(remaining.length)console.error('Unconfirmed runs remain; inspect retained Host state.');
  }
}
smoke().catch(e=>{console.error((e as Error).message);process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
