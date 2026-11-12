import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Host } from '../src/host.ts';
import { installHostConfiguration } from '../src/host-installation.ts';

function fixture(){
  const state=mkdtempSync('/tmp/rein-maint-');
  const config={repository:'/project',adapter:'fixture',executable:process.execPath,concurrency:2,sandbox:'read-only'};
  writeFileSync(join(state,'host.json'),JSON.stringify(config));
  const host=new Host(state);
  const spec={taskId:randomUUID(),runId:randomUUID(),revision:1,owner:{harness:'test',instance:'test',session:'test'},goal:'test',originalRequest:'test',constraints:[],acceptance:['done'],baseCommit:'a'.repeat(40),knowledge:[]};
  return {state,config,host,spec,close(){host.db.close();rmSync(state,{recursive:true,force:true});}};
}

test('drain preserves delivery receipts; recovery requires unknown state, explicit confirmation and stopped processes',async()=>{
  const f=fixture();
  const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  await once(worker,'spawn');
  try{
    const run:any=f.host.handle({type:'start',key:'one',spec:f.spec});
    assert.throws(()=>f.host.handle({type:'resolve',runId:f.spec.runId,confirmStopped:true,reason:'inspected'}),/Only an unknown/);
    f.host.handle({type:'maintenance',enabled:true});
    assert.equal((f.host.handle({type:'start',key:'one',spec:f.spec}) as any).spec.runId,f.spec.runId);
    assert.throws(()=>f.host.handle({type:'start',key:'two',spec:{...f.spec,runId:randomUUID()}}),/draining/);
    assert.throws(()=>f.host.handle({type:'shutdown'}),/queued, active or unknown/);
    run.state='unknown';run.workerPid=worker.pid;f.host.db.set('runs',f.spec.runId,run);
    assert.throws(()=>f.host.handle({type:'resolve',runId:f.spec.runId,reason:'inspected'}));
    assert.throws(()=>f.host.handle({type:'resolve',runId:f.spec.runId,confirmStopped:true,reason:'inspected'}),/process group is still alive/);
    const exited=once(worker,'exit');process.kill(-worker.pid!,'SIGKILL');await exited;
    run.pid=process.pid;f.host.db.set('runs',f.spec.runId,run);
    assert.throws(()=>f.host.handle({type:'resolve',runId:f.spec.runId,confirmStopped:true,reason:'inspected'}),/Runner process is still alive/);
    delete run.pid;f.host.db.set('runs',f.spec.runId,run);
    const resolved:any=f.host.handle({type:'resolve',runId:f.spec.runId,confirmStopped:true,reason:'Inspected orphan processes and external effects'});
    assert.equal(resolved.state,'canceled');assert.ok(resolved.recovery);
    assert.equal(f.host.unsettled().length,0);
    assert.equal(f.host.db.events(0).at(-1)!.data.state,'canceled');
    assert.throws(()=>f.host.handle({type:'start',key:'different',spec:f.spec}),/draining|tombstone/);
    assert.deepEqual(f.host.handle({type:'shutdown'}),{stopping:true});
    assert.throws(()=>f.host.handle({type:'maintenance',enabled:false}),/stopping/);
  }finally{if(worker.exitCode===null&&worker.signalCode===null){const exited=once(worker,'exit');process.kill(-worker.pid!,'SIGKILL');await exited;}f.close();}
});

test('configuration installation blocks live/unsettled Hosts and resumes a journal without losing execution history',()=>{
  const f=fixture();
  const plan={config:{...f.config,sandbox:'workspace-write'},receipt:{digest:'b'.repeat(64),release:'/runtime/new',bridgeCli:'/runtime/original/cli.js',bridgeNode:process.execPath}};
  try{
    f.host.db.set('supervisor','owner',{pid:process.pid});
    assert.throws(()=>installHostConfiguration(f.state,plan),/Stop the Host/);
    f.host.db.set('supervisor','owner',{pid:0});
    const run:any=f.host.handle({type:'start',key:'one',spec:f.spec});
    assert.throws(()=>installHostConfiguration(f.state,plan),/Settle queued/);
    run.state='unknown';f.host.db.set('runs',f.spec.runId,run);
    assert.throws(()=>installHostConfiguration(f.state,plan),/Settle queued/);
    f.host.handle({type:'resolve',runId:f.spec.runId,confirmStopped:true,reason:'Verified stopped'});
    installHostConfiguration(f.state,plan);
    assert.equal(JSON.parse(readFileSync(join(f.state,'host.json'),'utf8')).sandbox,'workspace-write');
    assert.equal(f.host.db.get<any>('runs',f.spec.runId).state,'canceled');
    assert.ok(existsSync(join(f.state,'backups')));
    // Simulate interruption after the config rename and before receipt replacement.
    const next={...plan,receipt:{...plan.receipt,digest:'c'.repeat(64)}};
    writeFileSync(join(f.state,'pending-installation.json'),JSON.stringify(next));
    assert.throws(()=>installHostConfiguration(f.state,plan),/same package and options/);
    installHostConfiguration(f.state,next);
    assert.equal(existsSync(join(f.state,'pending-installation.json')),false);
    assert.equal(JSON.parse(readFileSync(join(f.state,'installation.json'),'utf8')).digest,'c'.repeat(64));
    assert.throws(()=>installHostConfiguration(f.state,{...plan,config:{...plan.config,repository:'/other'}}),/cannot change/);
  }finally{f.close();}
});
