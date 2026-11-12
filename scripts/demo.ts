import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Main } from '../src/main.ts';
import { Store } from '../src/db.ts';
import type { Run } from '../src/host.ts';
import { id } from '../src/protocol.ts';
import { request } from '../src/transport.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let interrupted=false;
const interrupt=()=>{interrupted=true;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
async function waitFor(check:()=>Promise<boolean>,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(interrupted)throw Error('Demo interrupted');if(await check())return;await sleep(100);}
  throw Error('Timed out; inspect host.log in the output directory');
}

async function demo(){
  if(process.platform==='win32')throw Error('This demo requires macOS or Linux.');
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('Please use Node.js 24.x.');
  execFileSync('git',['--version'],{stdio:'ignore'});
  const root=mkdtempSync(join(tmpdir(),'rein-demo-')),repo=join(root,'repo'),hostState=join(root,'host');
  const output=resolve('work/demos',new Date().toISOString().replaceAll(':','-')+'-'+id().slice(0,8));
  mkdirSync(repo);mkdirSync(hostState);mkdirSync(output,{recursive:true});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');writeFileSync(join(repo,'README.md'),'Rein demo repository\n');git('add','.');
  git('-c','user.name=Rein Demo','-c','user.email=demo@example.invalid','commit','-qm','Demo baseline');
  const baseCommit=git('rev-parse','HEAD');
  writeFileSync(join(hostState,'host.json'),JSON.stringify({repository:repo,adapter:'fixture',executable:process.execPath,concurrency:2,sandbox:'read-only'}));
  const target={kind:'local' as const,state:hostState},owner={harness:'demo',instance:'rein-demo',session:id()};
  let main:Main|undefined;
  const host=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'host','serve','--state',hostState],{env:{...process.env,REIN_ALLOW_FIXTURE:'1'},stdio:['ignore','pipe','pipe']});
  let hostLog='';host.stdout.on('data',b=>{hostLog=(hostLog+b).slice(-32000);});host.stderr.on('data',b=>{hostLog=(hostLog+b).slice(-32000);});
  host.on('error',e=>{hostLog+=e.message;});
  console.log('\n  Oh My Rein — Every task builds context.\n');
  console.log('  Local workflow demo · No API key · No model calls · No SSH required\n');
  try{
    await waitFor(async()=>{if(host.exitCode!==null)throw Error(hostLog);try{await request(target,{type:'probe'},500);return true;}catch{return false;}});
    console.log('  [1/6] Host ready. Created an isolated sample Git repository.');
    main=new Main(join(output,'main'),owner,target,repo);main.mode(true);
    const input={originalRequest:'Demonstrate independent execution, result retrieval, and context reuse with two workers',constraints:['Work only in the sample repository'],acceptance:['result.txt contains the assigned task content'],baseCommit};
    const goalA=main.createUserTask('task-a',{taskKey:'demo-a',title:'Demo task A',goal:'Produce and verify the A result',acceptance:['The A result is verified']});
    const goalB=main.createUserTask('task-b',{taskKey:'demo-b',title:'Demo task B',goal:'Produce and verify the B result',acceptance:['The B result is verified']});
    const a=main.dispatch('worker-a',{...input,userTaskId:goalA.id,expectedRevision:goalA.revision,goal:'slow demo worker A'}),b=main.dispatch('worker-b',{...input,userTaskId:goalB.id,expectedRevision:goalB.revision,goal:'slow demo worker B'});
    await main.sync();
    await waitFor(async()=>{const runs=await Promise.all([a,b].map(t=>request(target,{type:'inspect',runId:t.spec.runId})));return runs.every(r=>r.state==='running');});
    console.log('  [2/6] Two test workers are running in separate workspaces.');
    main.db.close();main=undefined;
    console.log('  [3/6] Main client disconnected. Workers keep running...');
    await sleep(2800);
    main=new Main(join(output,'main'),owner,target,repo);
    await waitFor(async()=>{await main!.sync();const tasks=main!.tasks();const failed=tasks.find(t=>['failed','unknown'].includes(t.status));if(failed)throw Error(failed.run?.error??'Worker failed');return tasks.every(t=>t.status==='ready');});
    const artifactDirs:string[]=[];
    for(const t of [a,b]){
      const result=await main.collect(t.spec.taskId);
      const patch=readFileSync(join(result.directory,'changes.patch'),'utf8');
      assert.ok(patch.includes(t.spec.goal)&&patch.includes('result.txt'));
      main.accept(t.spec.taskId,['The demo checked the hash-verified patch and confirmed result.txt contains the task content']);artifactDirs.push(result.directory);
    }
    console.log('  [4/6] Reconnected. Both reports and patches verified and accepted by the demo.');
    main.review(a.spec.taskId,'retain','The sample project writes execution results to result.txt.',0);main.review(b.spec.taskId,'discard');
    main.completeUserTask(goalB.id,1,['Verified B result in the collected patch'],[b.spec.taskId]);
    const next=main.dispatch('followup',{...input,userTaskId:goalA.id,expectedRevision:goalA.revision,knowledgeIds:main.knowledge().map(k=>k.id),goal:'Check the result file using the prior discovery'});
    assert.equal(next.spec.knowledge.length,1);
    writeFileSync(join(output,'next-task.json'),JSON.stringify(next.spec,null,2));
    console.log('  [5/6] A reviewed discovery is now part of the next task\'s context.');
    main.cancel(next.spec.taskId);await main.sync();assert.equal(main.task(next.spec.taskId).status,'canceled');
    main.completeUserTask(goalA.id,1,['Verified A result; optional follow-up canceled before start'],[a.spec.taskId]);
    writeFileSync(join(output,'summary.json'),JSON.stringify({kind:'deterministic-local-demo',modelCalls:0,checks:['concurrent workers','client reconnect','verified patches','reviewed discovery reuse','cancel before dispatch','multiple executions under one user task','explicit user-task completion'],artifacts:artifactDirs,userTasks:main.userTasks().map(t=>({id:t.id,title:t.title,status:t.status})),executions:main.tasks().map(t=>({id:t.spec.taskId,userTaskId:t.userTask?.id,status:t.status})),knowledge:main.knowledge()},null,2));
    console.log('  [6/6] Follow-up cancellation confirmed. Cleaning up demo processes.');
    console.log(`\n  Results saved to: ${output}\n  Explore summary.json, next-task.json, and main/artifacts/.\n`);
  } finally {
    // Stop only the Host created by this demo; runners are independent and are canceled separately.
    if(host.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');for(let i=0;i<40&&host.exitCode===null&&host.signalCode===null;i++)await sleep(50);if(host.exitCode===null&&host.signalCode===null)host.kill('SIGKILL');}
    main?.db.close();writeFileSync(join(output,'host.log'),hostLog);
    const db=new Store(hostState);
    const active=()=>db.list<Run>('runs').filter(r=>!['succeeded','failed','canceled'].includes(r.state));
    db.transaction(()=>{for(const r of active())db.set('cancels',r.spec.runId,{at:Date.now()});});
    for(let i=0;i<60&&active().length;i++)await sleep(100);
    const remaining=active();db.close();
    if(remaining.length)console.error(`Some execution states need inspection. Temporary directory preserved: ${root}`);
    else rmSync(root,{recursive:true,force:true});
  }
}
demo().catch(e=>{console.error(`\nDemo did not complete: ${(e as Error).message}`);process.exitCode=1;}).finally(()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);});
