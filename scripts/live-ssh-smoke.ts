// Opt-in live test against an already configured SSH Host. No credentials are copied.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { Main } from '../src/main.ts';
import { Endpoint, id } from '../src/protocol.ts';
import { request } from '../src/transport.ts';

const {values:v}=parseArgs({options:{config:{type:'string'},repository:{type:'string'},'allow-model-calls':{type:'boolean'}}});
if(!v['allow-model-calls']||!v.config||!v.repository)throw Error('Requires --allow-model-calls --config ENDPOINT.json --repository SAMPLE_REPO');
const target=Endpoint.parse(JSON.parse(readFileSync(v.config,'utf8')));
if(target.kind!=='ssh')throw Error('Requires an SSH endpoint');
const probe=await request(target,{type:'probe'});
if(probe.adapter!=='codex'||probe.concurrency<2)throw Error('Requires a Codex Host with concurrency >= 2');
const repo=resolve(v.repository),git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const expected=JSON.parse(readFileSync(join(repo,'export-config.json'),'utf8'));
assert.deepEqual(expected,{format:'ndjson',batchSize:37},'Requires the live-smoke sample repo');
const output=resolve('work/live-ssh',new Date().toISOString().replaceAll(':','-')+'-'+id().slice(0,8));mkdirSync(output,{recursive:true,mode:0o700});
const owner={harness:'codex',instance:'live-ssh-smoke',session:id()};
let main=new Main(join(output,'main'),owner,target,repo);main.mode(true);
let interrupted=false;
const interrupt=()=>{interrupted=true;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check:()=>Promise<boolean>,timeout=240000){const end=Date.now()+timeout;while(Date.now()<end){if(interrupted)throw Error('Live SSH test interrupted');if(await check())return;await sleep(500);}throw Error('Live SSH test timed out');}
console.log(`Live SSH output: ${output}`);
try{
  const baseCommit=git(repo,'rev-parse','HEAD');
  const input={originalRequest:'Verify two real remote workers survive main-client disconnection and return verifiable results.',constraints:['Only read and write files in this sample checkout. Do not access credentials or other projects.','Do not use the network or delegate work.'],acceptance:['The assigned JSON file matches export-config.json exactly.'],baseCommit};
  const tasks=['a','b'].map(label=>main.dispatch(label,{...input,goal:`Read export-config.json and create worker-${label}.json with exactly its format and batchSize. Verify the new file contents. Report the export format as your first discovery with export-config.json as its source.`}));
  await main.sync();
  await waitFor(async()=>{const runs=await Promise.all(tasks.map(t=>request(target,{type:'inspect',runId:t.spec.runId})));for(const r of runs)if(['failed','unknown','canceled'].includes(r.state))throw Error(r.error??r.state);return runs.every(r=>r.state==='running');},30000);
  console.log('Two remote runs observed running; closing the main client for 5 seconds.');
  main.db.close();await sleep(5000);main=new Main(join(output,'main'),owner,target,repo);
  await waitFor(async()=>{await main.sync();for(const t of main.tasks())if(['failed','unknown','canceled'].includes(t.status))throw Error(t.run?.error??t.status);return main.tasks().every(t=>t.status==='ready');});
  const duplicate=await request(target,{type:'start',key:tasks[0]!.key,spec:tasks[0]!.spec});assert.equal(duplicate.spec.runId,tasks[0]!.spec.runId);
  const artifacts=[];
  for(const [index,t] of tasks.entries()){
    const result=await main.collect(t.spec.taskId),file=`worker-${index===0?'a':'b'}.json`;
    const temp=mkdtempSync(join(tmpdir(),'rein-ssh-verify-')),verify=join(temp,'repo');git(temp,'clone','--quiet','--no-hardlinks',repo,verify);
    git(verify,'apply',join(result.directory,'changes.patch'));
    assert.deepEqual(JSON.parse(readFileSync(join(verify,file),'utf8')),expected);
    assert.equal(git(verify,'diff','--name-only'),'');assert.equal(git(verify,'ls-files','--others','--exclude-standard'),file);
    const report=main.task(t.spec.taskId).run!.report!;
    assert.equal(report.unresolved.length,0);assert.match(report.discoveries[0]?.content??'',/ndjson/i);assert.match(report.discoveries[0]?.source??'',/export-config\.json/);
    main.accept(t.spec.taskId,['Applied the SHA-256 verified patch in a clean clone; asserted exact contents and changed-file scope.']);
    main.review(t.spec.taskId,index===0?'retain':'discard',index===0?'The project export format is ndjson.':undefined,index===0?0:undefined);
    artifacts.push({runId:t.spec.runId,directory:result.directory,verification:verify});
  }
  const next=main.dispatch('followup',{...input,knowledgeIds:main.knowledge().map(k=>k.id),goal:'Use the reviewed export format.'});assert.equal(next.spec.knowledge.length,1);main.cancel(next.spec.taskId);await main.sync();assert.equal(main.task(next.spec.taskId).status,'canceled');
  const summary={kind:'live-codex-ssh',endpoint:target,checks:['two real concurrent remote workers','main client closed for 5 seconds','reconnect without duplicate execution','verified patches applied to clean local clones','reviewed fact in following snapshot','follow-up canceled before dispatch'],artifacts,tasks:main.tasks().map(t=>({taskId:t.spec.taskId,runId:t.spec.runId,status:t.status})),limitations:['Connection closure, not injected network partition or machine reboot','Scripted main-agent review','No native chat binding or automatic wake validation']};
  writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log('Live SSH model test passed.');
}finally{
  try{for(const t of main.tasks())if(!['accepted','canceled','failed','ready'].includes(t.status))main.cancel(t.spec.taskId);await main.sync();}finally{main.db.close();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
