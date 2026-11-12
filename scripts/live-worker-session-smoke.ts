// Opt-in real native worker continuation. Uses an isolated local Host/checkout;
// no user configuration is modified and no credentials are written by this test.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Main } from '../src/main.ts';
import { HostConfig, Endpoint, id } from '../src/protocol.ts';
import { request } from '../src/transport.ts';

const {values:v}=parseArgs({options:{harness:{type:'string'},executable:{type:'string'},model:{type:'string'},provider:{type:'string'},settings:{type:'string'},'pi-agent-dir':{type:'string'},profile:{type:'string'},'codex-home':{type:'string'},'key-file':{type:'string'},endpoint:{type:'string'},repository:{type:'string'},'allow-model-calls':{type:'boolean'}}});
if(!v['allow-model-calls']||!v.executable||!['codex','claude','pi'].includes(v.harness??''))throw Error('Use --allow-model-calls --harness codex|claude|pi --executable ABS and explicit provider configuration');
mkdirSync('work/live-worker-sessions',{recursive:true});
if(v.endpoint&&!v.repository)throw Error('SSH testing requires --repository for a clean local copy of the remote sample repository');
const root=mkdtempSync(resolve('work/live-worker-sessions',v.harness+'-')),repo=v.repository?resolve(v.repository):join(root,'repo'),state=join(root,'host');if(!v.repository)mkdirSync(repo);mkdirSync(state);
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!v.repository){git(repo,'init','-q');writeFileSync(join(repo,'README'),'Isolated native session test\n');git(repo,'add','.');git(repo,'-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','Fixture');}
const config=HostConfig.parse({repository:repo,adapter:v.harness,executable:resolve(v.executable),model:v.model,provider:v.provider,settings:v.settings,piAgentDir:v['pi-agent-dir'],profile:v.profile,codexHome:v['codex-home'],sandbox:'workspace-write'});
writeFileSync(join(state,'host.json'),JSON.stringify(config),{mode:0o600});
const env={...process.env};if(v['key-file'])env.DEEPSEEK_API_KEY=readFileSync(v['key-file'],'utf8').trim();
const fd=openSync(join(root,'host.log'),'a',0o600),host=v.endpoint?undefined:spawn(process.execPath,[resolve('src/cli.ts'),'host','serve','--state',state],{env,stdio:['ignore',fd,fd]});closeSync(fd);
const target=v.endpoint?Endpoint.parse(JSON.parse(readFileSync(v.endpoint,'utf8'))):{kind:'local' as const,state};
const owner={harness:'codex',instance:'live-worker-session',session:id()},ledger=join(root,'main');let main=new Main(ledger,owner,target,repo);main.mode(true);
const delay=()=>new Promise(r=>setTimeout(r,500));
async function outcome(executionId:string){
  const until=Date.now()+190000;
  while(Date.now()<until){await main.sync();const t=main.task(executionId);if(['ready','waiting_input'].includes(t.status))return t;if(['failed','unknown','canceled'].includes(t.status))throw Error(t.run?.error??t.status);await delay();}
  throw Error('Native worker turn timeout');
}
try{
  const deadline=Date.now()+20000;while(true){try{await request(target,{type:'probe'},target.kind==='ssh'?3000:500);break;}catch(e){if(Date.now()>deadline)throw e;await delay();}}
  const parent=main.createUserTask('task',{taskKey:'export',title:'Export nonce',goal:'Deliver selected format and remembered value',acceptance:['result.json contains the remembered nonce and user-selected format']});
  const nonce=id(),first=main.dispatch('first',{userTaskId:parent.id,expectedRevision:1,goal:'Ask the user which output format to use before doing any work',originalRequest:`Remember the synthetic value ${nonce} in this conversation. Do not write it to any file. Ask exactly one question with id format and text "Which format should I use?" in the report questions field. Stop after asking.`,constraints:['Do not edit any files in this first turn. Do not access credentials, other directories or the network.'],acceptance:['Wait for the user format decision'],baseCommit:git(repo,'rev-parse','HEAD')});
  await main.sync();const asked=await outcome(first.spec.taskId);assert.equal(asked.status,'waiting_input');assert.equal(asked.run?.report?.questions?.[0]?.id,'format');
  const before=await main.collect(first.spec.taskId);assert.equal(readFileSync(join(before.directory,'changes.patch'),'utf8'),'');
  console.log(v.harness+': first turn asked a question; native session recorded');
  main.db.close();main=new Main(ledger,owner,target,repo);
  const second=await main.continueExecution('answer',{previousExecutionId:first.spec.taskId,expectedRevision:1,message:'Use CSV. Continue the same session.',answers:[{questionId:'format',answer:'CSV'}],goal:'Write result.json containing the remembered nonce and selected format',originalRequest:'Use the synthetic value from the previous conversation turn. Create result.json with exactly two keys: nonce (the previous value) and format ("CSV"). Read it back to verify. Return no questions and no unresolved items when verified.',constraints:['Only create result.json. Do not access credentials, other directories or the network.'],acceptance:['result.json contains the remembered nonce and format CSV']});
  const done=await outcome(second.executionId);assert.equal(done.status,'ready');assert.equal(done.run?.nativeSessionId,asked.run?.nativeSessionId);
  const artifacts=await main.collect(second.executionId),verify=join(root,'verify');git(root,'clone','-q',repo,verify);git(verify,'apply',join(artifacts.directory,'changes.patch'));
  assert.deepEqual(JSON.parse(readFileSync(join(verify,'result.json'),'utf8')),{nonce,format:'CSV'});
  assert.equal(main.task(first.spec.taskId).status,'continued');
  const summary={harness:v.harness,transport:target.kind,status:'passed',workerSessionId:first.spec.worker!.sessionId,nativeSessionId:done.run!.nativeSessionId,turns:2,checks:['structured worker question','exact native session retained','prior nonce recalled without resending','main ledger reopened between turns','same checkout continued','cumulative patch independently applied','first-turn artifact unchanged'],limits:[target.kind==='local'?'local Host, not SSH':'SSH connection closure, not injected network partition or machine reboot','scripted main driver; not a natural-language routing evaluation','no active-turn steering, native permission interaction or automatic wake']};
  writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));console.log('Evidence: '+root);
}finally{
  for(const t of main.tasks())if(!['ready','waiting_input','continued','accepted','failed','canceled'].includes(t.status))main.cancel(t.spec.taskId);
  await main.sync();main.db.close();if(host&&host.exitCode===null){host.kill('SIGTERM');await once(host,'exit');}
}
