import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Main } from '../src/main.ts';
import { Endpoint, id } from '../src/protocol.ts';
import { request } from '../src/transport.ts';

const [configFile,baseCommit]=process.argv.slice(2);
if(!configFile||!baseCommit)throw Error('Usage: node scripts/ssh-smoke.ts ENDPOINT.json BASE_COMMIT');
const endpoint=Endpoint.parse(JSON.parse(readFileSync(configFile,'utf8')));
if(endpoint.kind!=='ssh')throw Error('This test requires real SSH');
const probe=await request(endpoint,{type:'probe'});
if(probe.adapter!=='fixture')throw Error('Smoke test only runs against an explicitly configured fixture Host');
const root=resolve('work/ssh-smoke-'+Date.now());mkdirSync(root,{recursive:true});
const owner={harness:'codex',instance:'rein-development',session:process.env.CODEX_THREAD_ID??id()};
let main=new Main(root,owner,endpoint,resolve('.'));main.mode(true);
const input={originalRequest:'Verify SSH disconnection and result return with deterministic fixtures',constraints:['Test checkout only'],acceptance:['Patch contains the assigned result'],baseCommit};
const a=main.dispatch('one',{...input,goal:'slow SSH worker one'}),b=main.dispatch('two',{...input,goal:'slow SSH worker two'});
await main.sync();
const active=await Promise.all([a,b].map(t=>request(endpoint,{type:'inspect',runId:t.spec.runId})));
assert.ok(active.every(r=>r.state==='running'),'Both remote workers must be observed running concurrently');
// Every SSH bridge exits after one request. Close the local ledger as well: no client connection remains.
main.db.close();await new Promise(r=>setTimeout(r,3500));
main=new Main(root,owner,endpoint,resolve('.'));
for(let i=0;i<30;i++){await main.sync();if(main.tasks().every(t=>t.status==='ready'))break;await new Promise(r=>setTimeout(r,200));}
assert.deepEqual(main.tasks().map(t=>t.status),['ready','ready']);
const repeated=await request(endpoint,{type:'start',key:a.key,spec:a.spec});assert.equal(repeated.spec.runId,a.spec.runId);
for(const task of [a,b]){const artifacts=await main.collect(task.spec.taskId);assert.match(readFileSync(join(artifacts.directory,'changes.patch'),'utf8'),/result.txt/);main.accept(task.spec.taskId,['Inspected hash-verified patch containing assigned result.txt']);}
main.review(a.spec.taskId,'retain','SSH fixture produces result.txt',0);main.review(b.spec.taskId,'discard');
const next=main.dispatch('followup',{...input,goal:'Use prior verified discovery'});assert.equal(next.spec.knowledge.length,1);
main.cancel(next.spec.taskId);await main.sync();assert.equal(main.task(next.spec.taskId).status,'canceled');
const report={date:new Date().toISOString(),endpoint,owner,checks:['real SSH transport','two concurrent fixture workers','no client connection while execution continues','durable original-session result recovery','duplicate start returns same run','artifact hashes and patches','acceptance separate from learning','reviewed knowledge in next task','cancel before dispatch'],tasks:main.tasks().map(t=>({taskId:t.spec.taskId,runId:t.spec.runId,status:t.status})),limitations:['deterministic fixtures, no model calls','not a full network partition or machine reboot','native Codex plugin session propagation and wake remain unverified']};
writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));main.db.close();console.log(JSON.stringify({ok:true,result:join(root,'result.json'),...report},null,2));
