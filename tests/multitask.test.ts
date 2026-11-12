import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Main } from '../src/main.ts';
import { id, TaskSpec } from '../src/protocol.ts';

function setup(){
  const root=mkdtempSync(join(tmpdir(),'rein-multitask-')),owner={harness:'codex',instance:'test',session:id()},target={kind:'local' as const,state:join(root,'host')},project=join(root,'project'),state=join(root,'main');
  const main=new Main(state,owner,target,project);main.mode(true);
  const input={goal:'Implement export',originalRequest:'Implement the export task.',constraints:[],acceptance:['Matches its own requirements'],baseCommit:'a'.repeat(40)};
  return {root,owner,target,project,state,main,input};
}

test('task requirements remain scoped across parallel work and conversation restarts',()=>{
  const f=setup();let other:Main|undefined;
  try{
    const a=f.main.context.record('a-format',{appliesTo:{type:'task',taskKey:'export-a'},kind:'constraint',content:'Export A uses JSONL.',quote:'Use JSONL for export A.',shareWithWorkers:true});
    const b=f.main.context.record('b-format',{appliesTo:{type:'task',taskKey:'export-b'},kind:'constraint',content:'Export B uses JSONL.',quote:'Use JSONL for export B.',shareWithWorkers:true});
    const taskA=f.main.dispatch('a',{...f.input,taskKey:'export-a',contextIds:[a.id]});
    const taskB=f.main.dispatch('b',{...f.input,taskKey:'export-b',contextIds:[b.id]});
    assert.throws(()=>f.main.dispatch('cross',{...f.input,taskKey:'export-b',contextIds:[a.id]}),/different taskKey/);
    assert.throws(()=>f.main.dispatch('unbound',{...f.input,contextIds:[a.id]}),/different taskKey/);
    f.main.context.update(a.id,1,{content:'Export A uses CSV.',quote:'Change only export A to CSV.',shareWithWorkers:true});
    assert.deepEqual(f.main.contextChanges(taskA.spec).userContext,[a.id]);
    assert.deepEqual(f.main.contextChanges(taskB.spec).userContext,[]);
    assert.equal(f.main.context.get(b.id).version,1);
    assert.deepEqual(f.main.context.page({taskKey:'export-b'}).entries.map(n=>n.id),[b.id]);
    assert.throws(()=>f.main.context.update(a.id,2,{content:'Move to B.',quote:'Move to B.',appliesTo:{type:'task',taskKey:'export-b'}}),/unrecognized_keys/);
    other=new Main(f.state,{...f.owner,session:id()},f.target,f.project);other.mode(true);
    assert.equal(other.context.list().length,0);
    assert.throws(()=>other!.context.get(a.id),/scope/);
    assert.throws(()=>other!.dispatch('same-label',{...f.input,taskKey:'export-a',contextIds:[a.id]}),/scope/);
    assert.throws(()=>f.main.context.record('personal',{kind:'preference',content:'A global preference.',quote:'Always do this.',appliesTo:{type:'personal'}}));
  }finally{other?.db.close();f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('overview is bounded, details are explicit, and old project records retain their scope',()=>{
  const f=setup();
  try{
    const legacy=f.main.context.record('legacy',{kind:'decision',content:'A'.repeat(7000),quote:'B'.repeat(7000),shareWithWorkers:true,appliesTo:{type:'project'}});
    const {appliesTo,...old}=legacy;f.main.db.set('user-context',legacy.id,old);f.main.db.set('user-context-history',`${legacy.id}:1`,old);
    assert.deepEqual(f.main.context.get(legacy.id).appliesTo,{type:'project'});
    for(let i=0;i<37;i++)f.main.dispatch('job-'+i,{...f.input,taskKey:'job-'+i,originalRequest:'PRIVATE_DETAIL_MARKER '+ 'x'.repeat(20000),contextIds:i===0?[legacy.id]:[]});
    const board=f.main.status() as any;
    const overview=f.main.status({view:'executions'}) as any;
    assert.equal(overview.executions.length,10);assert.equal(overview.pagination.total,37);assert.equal(overview.pagination.nextOffset,10);
    assert.equal(board.memory.personal.authority,'harness');assert.equal(board.memory.personal.writeback,'unverified');
    assert.equal(board.memory.project.authority,'rein-fallback');
    assert.doesNotMatch(JSON.stringify(overview),/PRIVATE_DETAIL_MARKER/);
    assert.ok(Buffer.byteLength(JSON.stringify(overview))<16000,'Overview must stay bounded despite large histories');
    const next=f.main.status({view:'executions',offset:10}) as any;
    assert.equal(next.executions.some((t:any)=>overview.executions.some((p:any)=>p.taskId===t.taskId)),false);
    const last=f.main.status({view:'executions',offset:30}) as any;assert.equal(last.executions.length,7);assert.equal(last.pagination.nextOffset,null);
    const filtered=f.main.status({view:'executions',taskKey:'job-0'}) as any;assert.equal(filtered.executions.length,1);
    const detail=f.main.status({view:'executions',id:filtered.executions[0].taskId}) as any;assert.match(detail.execution.spec.originalRequest,/PRIVATE_DETAIL_MARKER/);
    assert.deepEqual(TaskSpec.parse(detail.execution.spec),detail.execution.spec);
    assert.throws(()=>f.main.status({limit:26}));
    const page=f.main.context.page();assert.equal(page.entries[0]!.preview.length,240);assert.equal(page.entries[0]!.truncated,true);
    assert.equal(f.main.context.get(legacy.id).content.length,7000);
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});
