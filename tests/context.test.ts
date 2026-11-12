import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Main } from '../src/main.ts';
import { id, TaskSpec } from '../src/protocol.ts';

function setup(){
  const root=mkdtempSync(join(tmpdir(),'rein-context-')),state=join(root,'main'),project=join(root,'repo');
  const owner={harness:'codex',instance:'test',session:id()},target={kind:'local' as const,state:join(root,'host')};
  const main=new Main(state,owner,target,project);main.mode(true);
  const input={goal:'Prepare an export',originalRequest:'Create an export plan',constraints:[],acceptance:['Matches the selected context'],baseCommit:'a'.repeat(40)};
  return {root,state,project,owner,target,main,input};
}

test('user context is independent of worker outcomes and only explicitly selected shareable entries leave the main',()=>{
  const f=setup();
  try{
    const personal=f.main.context.record('private',{appliesTo:{type:'project'},kind:'preference',content:'Explain progress briefly.',quote:'Keep progress updates short.'});
    const shared=f.main.context.record('format',{appliesTo:{type:'project'},kind:'constraint',content:'Export records as JSONL.',quote:'Use JSONL for this project and tell delegated workers.',shareWithWorkers:true});
    assert.equal(f.main.tasks().length,0);assert.equal(f.main.knowledge().length,0);
    assert.equal(personal.shareWithWorkers,false);assert.deepEqual(personal.recordedBy,f.owner);
    assert.equal(f.main.context.record('private',{appliesTo:{type:'project'},kind:'preference',content:personal.content,quote:personal.quote}).id,personal.id);
    assert.throws(()=>f.main.context.record('private',{appliesTo:{type:'project'},kind:'preference',content:'Different',quote:'Different'}),/conflict/);
    assert.equal(f.main.dispatch('no-context',f.input).spec.userContext,undefined);
    assert.throws(()=>f.main.dispatch('private',{...f.input,contextIds:[personal.id]}),/local-only/);
    assert.throws(()=>f.main.dispatch('duplicate',{...f.input,contextIds:[shared.id,shared.id]}),/Duplicate/);
    assert.throws(()=>f.main.dispatch('leaky-excerpt',{...f.input,originalRequest:`Please export. ${personal.quote}`,contextIds:[shared.id]}),/local-only/);
    assert.throws(()=>f.main.dispatch('leaky-constraint',{...f.input,constraints:[personal.content]}),/local-only/);
    const task=f.main.dispatch('selected',{...f.input,contextIds:[shared.id]});
    assert.deepEqual(task.spec.userContext?.map(n=>n.id),[shared.id]);
    assert.equal(task.spec.userContext?.[0]?.origin,'user_statement');
    assert.equal('quote' in task.spec.userContext![0]!,false);
    assert.ok(!JSON.stringify(task.spec).includes(personal.content));
    assert.deepEqual(TaskSpec.parse(task.spec),task.spec);
    const changed=f.main.context.update(shared.id,1,{content:'Export records as CSV.',quote:'Correction: use CSV.',shareWithWorkers:true});
    assert.equal(changed.version,2);assert.equal(task.spec.userContext?.[0]?.version,1);
    assert.deepEqual(f.main.contextChanges(task.spec).userContext,[shared.id]);
    assert.ok(f.main.brief().items.find(t=>t.taskId===task.spec.taskId)?.actions.includes('reconcile_context_before_further_work'));
    const next=f.main.dispatch('new',{...f.input,contextIds:[shared.id]});
    assert.equal(next.spec.userContext?.[0]?.content,'Export records as CSV.');
    f.main.context.update(shared.id,2,{content:changed.content,quote:'Keep this local now.',shareWithWorkers:false});
    assert.deepEqual(f.main.context.changed(next.spec.userContext),[shared.id]);
    assert.throws(()=>f.main.dispatch('revoked',{...f.input,contextIds:[shared.id]}),/local-only/);
  }finally{f.main.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('context survives a new conversation in the same project, with versioned corrections and scope isolation',()=>{
  const f=setup();let reopened:Main|undefined,other:Main|undefined;
  try{
    const note=f.main.context.record('goal',{appliesTo:{type:'project'},kind:'goal',content:'Support CSV exports.',quote:'Build a CSV exporter.',shareWithWorkers:true});
    const task=f.main.dispatch('first',{...f.input,contextIds:[note.id]});f.main.db.close();
    reopened=new Main(f.state,{...f.owner,session:id()},f.target,f.project);
    assert.equal(reopened.mode(),false);assert.equal(reopened.context.list()[0]?.id,note.id);
    assert.equal(reopened.tasks().length,0);assert.throws(()=>reopened!.task(task.spec.taskId),/not owned/);
    const current=reopened.context.update(note.id,1,{content:'Support JSONL exports.',quote:'Change the project to JSONL.',shareWithWorkers:true});
    assert.equal(current.recordedBy.session,reopened.owner.session);
    assert.throws(()=>reopened!.context.update(note.id,1,{content:'stale overwrite',quote:'old turn'}),/version changed/);
    assert.equal(reopened.context.history(note.id)[0]?.content,note.content);
    other=new Main(f.state,{...f.owner,instance:'unrelated-harness-instance'},f.target,f.project);
    assert.equal(other.context.list().length,0);assert.throws(()=>other!.context.get(note.id),/scope/);
    assert.throws(()=>other!.context.retire(note.id,2,'not mine'),/scope/);
    reopened.context.retire(note.id,2,'The export project was canceled.');
    assert.equal(reopened.context.list().length,0);assert.equal(reopened.context.list(true).length,1);
    assert.deepEqual(reopened.context.history(note.id).map(n=>n.version),[1,2,3]);
    assert.throws(()=>reopened!.context.select([note.id]),/inactive/);
  }finally{try{f.main.db.close();}catch{}reopened?.db.close();other?.db.close();rmSync(f.root,{recursive:true,force:true});}
});
