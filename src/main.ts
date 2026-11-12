import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db.ts';
import { z } from 'zod';
import { id, canonical, hash, TaskSpec, Report, Owner, terminal, KnowledgeSelection, StatusQuery, UserTaskInput, UserTaskUpdate, Answers, assertSize, MAX_SPEC_BYTES, MAX_REPORT_BYTES, MAX_ARTIFACT_BYTES } from './protocol.ts';
import type { Binding, Target, Spec } from './protocol.ts';
import type { Run } from './host.ts';
import { request, RemoteRejection } from './transport.ts';
import { signApproval } from './approval-authority.ts';
import type { Approval } from './approval-store.ts';
import type { ApprovalSummary } from './approval-operation.ts';
import { ContextStore } from './context.ts';
import type { ContextSnapshot } from './context.ts';
import { validatePermissionAnswers } from './permissions.ts';
import { PermissionPolicy, PermissionMode } from './protocol.ts';
import { memoryPolicy } from './memory-policy.ts';
import {readWorkerPermissions,setWorkerPermissions} from './worker-config.ts';
import type {WorkerPermissionsUpdate} from './protocol.ts';

// `tasks` and TaskSpec.taskId remain legacy execution storage/wire names. The
// local parent reference is immutable and never exports the user's whole goal.
type StartRejection={source:'host'|'legacy-ledger';reason:string;recordedAt?:number};
type EffectsReview={runId:string;by:Binding;at:number;source:'main-reported';disposition:'no-effects'|'effects-addressed';evidence:string[]};
type Task={spec:Spec;key:string;status:string;cancelRequested:boolean;cancelConfirmedNotStarted?:boolean;continuedBy?:string;requiredContextRevision?:number;lastEventSeq?:number;userTask?:{id:string;revision:number};run?:Run;startRejection?:StartRejection;checked?:Record<string,string>;acceptance?:string[];learning?:string;error?:string;effectsReviews?:Record<string,EffectsReview>};
export type UserTask=z.infer<typeof UserTaskInput>&{
  id:string;owner:Binding;version:number;revision:number;status:'active'|'paused'|'completed'|'canceled';
  waitingFor:string[];createdAt:number;updatedAt:number;reason?:string;
  completion?:{revision:number;evidence:string[];executionIds:string[];at:number};
};
const VerificationEvidence=z.array(z.string().trim().min(1).max(4000)).min(1).max(30);
type Knowledge={id:string;version:number;content:string;source:string;verified:boolean;scope:string;active:boolean;workerClaimedVerified?:boolean;review?:{by:Binding;at:number};verification?:{status:'unverified'|'main-reported';evidence:string[]}};
// Legacy `verified` was copied from the worker. Do not promote it to main
// validation evidence, including when reading a ledger written by an old client.
function knowledgeProvenance(k:Knowledge):Knowledge{
  const verification=k.verification??{status:'unverified' as const,evidence:[]};
  return {...k,workerClaimedVerified:k.workerClaimedVerified??k.verified,verification,verified:verification.status==='main-reported'&&verification.evidence.length>0};
}
type Outbox={id:string;taskId:string;type:'start'|'cancel';done:boolean;attempts:number;error?:string};
type ApprovalOutbox={executionId:string;receipt:{payload:any;keyId:string;signature:string};done:boolean;error?:string};
type SyncRecord={state:'synced'|'partial'|'unavailable'|'not_synced';at?:number;lastSyncedAt?:number|null;error?:string};
export type PermissionReview=Approval&{presentation?:{taskTitle:string;host:string;executionGoal:string}};
export type PermissionPrompt=(request:PermissionReview,signal?:AbortSignal)=>Promise<boolean|null>;

// Some harness UIs cannot close an existing dialog. Stop awaiting it on abort
// and consume any late response without turning it into an authorization.
function awaitApproval(prompt:PermissionPrompt,review:PermissionReview,signal?:AbortSignal):Promise<boolean|null>{
  if(!signal)return prompt(review);
  if(signal.aborted)return Promise.resolve(null);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);resolve(null);};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>signal.aborted?null:prompt(review,signal)).then(value=>{
      signal.removeEventListener('abort',abort);resolve(signal.aborted?null:value);
    },error=>{signal.removeEventListener('abort',abort);signal.aborted?resolve(null):reject(error);});
  });
}
type Incoming={seq:number;run:string;data:any;handled:boolean;error?:string};
type Overview={tasks:Task[];byRun:Map<string,Task>;parents:UserTask[];context:ContextSnapshot;knowledge:Map<string,Knowledge>;pending:Map<string,Outbox[]>;parentsById:Map<string,UserTask>;byParent:Map<string,Task[]>};
export class Main {
  db:Store;state:string;owner:Binding;target:Target;binding:string;scope:string;context:ContextStore;
  constructor(state:string,owner:Binding,target:Target,project:string) {
    this.state=state;this.owner=Owner.parse(owner);this.target=target;this.db=new Store(state);
    this.binding=hash(canonical(owner));this.scope=hash(canonical({harness:owner.harness,instance:owner.instance,project}));
    this.context=new ContextStore(this.db,this.scope,this.owner);
    const identity=hash(canonical(target)),known=this.db.get<string>('endpoint','id');
    if(known&&known!==identity)throw Error('This ledger is bound to another Host endpoint');
    const oldProject=this.db.get<string>('endpoint','project');
    if(oldProject&&oldProject!==project)throw Error('This ledger is bound to another project');
    this.db.set('endpoint','project',project);
    this.db.set('endpoint','id',identity);
    this.migrateIncoming();
  }
  private migrateIncoming(){
    this.db.transaction(()=>{
      if(this.db.get<boolean>('migrations','incoming-sequence-v1'))return;
      let cursor=this.db.get<number>('cursor','host')??0;
      // Older clients could mark a newer event handled, then apply a late older
      // reply. Replay their persisted receipts once, preserving accepted intent.
      for(const event of this.db.list<Incoming>('incoming')){
        cursor=Math.max(cursor,event.seq);
        const taskId=event.data?.snapshot?.taskId??event.data?.spec?.taskId;
        const task=taskId?this.db.get<Task>('tasks',taskId):undefined;
        if(task&&task.lastEventSeq===undefined&&event.handled)this.db.set('incoming',String(event.seq),{...event,handled:false});
      }
      this.db.set('cursor','host',cursor);
      this.db.set('migrations','incoming-sequence-v1',true);
    });
  }
  mode(on?:boolean){if(on!==undefined)this.db.set('mode',this.binding,on);return this.db.get<boolean>('mode',this.binding)??false;}
  hostLabel(){return this.target.kind==='ssh'?this.target.destination:'Local Host';}
  syncRecord(){
    const record=this.db.get<SyncRecord>('sync-status',this.binding)??{state:'not_synced' as const};
    return {...record,lastSyncedAt:record.lastSyncedAt??(record.state==='synced'?record.at:null)??null};
  }
  workerStates(tasks=this.tasks()){
    const counts:Record<string,number>={};
    for(const task of tasks)counts[task.status]=(counts[task.status]??0)+1;
    return counts;
  }
  approvalMode(mode?:z.infer<typeof PermissionMode>,fallback:z.infer<typeof PermissionMode>='ask'){if(mode!==undefined)this.db.set('approval-mode',this.binding,PermissionMode.parse(mode));return this.db.get<z.infer<typeof PermissionMode>>('approval-mode',this.binding)??fallback;}
  workerPermissions(){return readWorkerPermissions(this.target,this.db.get<string>('endpoint','project')!);}
  setWorkerPermissions(input:z.infer<typeof WorkerPermissionsUpdate>,signal?:AbortSignal){return setWorkerPermissions(this.db,this.target,this.db.get<string>('endpoint','project')!,this.owner,input,signal);}
  tasks(){return this.db.owned<Task>('tasks',this.owner);}
  task(taskId:string){const t=this.db.get<Task>('tasks',taskId);if(!t||canonical(t.spec.owner)!==canonical(this.owner))throw Error('Task is not owned by this session');return t;}
  userTasks(){return this.db.owned<UserTask>('user-tasks',this.owner);}
  userTask(taskId:string){const t=this.db.get<UserTask>('user-tasks',taskId);if(!t||canonical(t.owner)!==canonical(this.owner))throw Error('User task is not owned by this session');return t;}
  private saveUserTask(t:UserTask){this.db.set('user-tasks',t.id,t);this.db.set('user-task-history',`${t.id}:${t.version}`,t);return t;}
  createUserTask(key:string,raw:unknown){
    const input=UserTaskInput.parse(raw);z.string().min(1).max(200).parse(key);
    return this.db.transaction(()=>{
      const requestKey=this.binding+':'+key,digest=hash(canonical(input)),prior=this.db.get<{id:string;digest:string}>('user-task-requests',requestKey);
      if(prior){if(prior.digest!==digest)throw Error('User task request key content conflict');return this.userTask(prior.id);}
      if(this.userTasks().some(t=>t.taskKey===input.taskKey))throw Error('This taskKey already identifies a user task; read and reuse it');
      const now=Date.now(),task=this.saveUserTask({...input,id:id(),owner:this.owner,version:1,revision:1,status:'active',waitingFor:[],createdAt:now,updatedAt:now});
      this.db.set('user-task-requests',requestKey,{id:task.id,digest});return task;
    });
  }
  updateUserTask(taskId:string,expectedVersion:number,raw:unknown){
    const input=UserTaskUpdate.parse(raw);
    return this.db.transaction(()=>{
      const prior=this.userTask(taskId);if(prior.version!==expectedVersion)throw Error('User task version changed; reload before editing');
      const revised=(input.goal!==undefined&&input.goal!==prior.goal)||(input.acceptance!==undefined&&canonical(input.acceptance)!==canonical(prior.acceptance))||(prior.status==='completed'&&input.status==='active');
      if(prior.status==='completed'&&!revised&&input.status!==undefined)throw Error('Reopen the completed task as active before changing its lifecycle');
      const task:UserTask={...prior,...input,version:prior.version+1,revision:prior.revision+Number(revised),updatedAt:Date.now()};
      if(revised){delete task.completion;if(prior.status==='completed'&&!input.status)task.status='active';}
      // Pause stops future delivery; already delivered workers may finish and
      // their results stay reviewable. Cancellation is a separate operation.
      if(input.status==='canceled')for(const e of this.tasks().filter(e=>e.userTask?.id===taskId&&!['accepted','continued','canceled','failed'].includes(e.status)))this.cancelExecution(e);
      return this.saveUserTask(task);
    });
  }
  completeUserTask(taskId:string,expectedVersion:number,evidence:string[],executionIds:string[]){
    const proof=z.array(z.string().trim().min(1).max(4000)).min(1).max(30).parse(evidence);
    const ids=z.array(z.guid()).min(1).max(50).refine(xs=>new Set(xs).size===xs.length,'Duplicate execution selection').parse(executionIds);
    return this.db.transaction(()=>{
      const task=this.userTask(taskId);
      if(task.version!==expectedVersion)throw Error('User task version changed; reload before completion');
      if(task.status!=='active'||task.waitingFor.length)throw Error('Task must be active with no pending decisions before completion');
      if(proof.length!==task.acceptance.length)throw Error('Provide evidence for every user-task completion criterion, in order');
      const executions=this.tasks().filter(e=>e.userTask?.id===taskId);
      if(executions.some(e=>this.needsFinalSnapshot(e)))throw Error('Sync final execution states and approval cleanup; uncertain or unreviewed executions cannot complete the task');
      if(executions.some(e=>this.unreviewedEffects(e).length))throw Error('Inspect and record unknown operation effects before completing the task');
      if(executions.some(e=>!['accepted','continued','canceled','failed'].includes(e.status)||e.learning==='pending'||(e.run&&!e.learning)))throw Error('Resolve active, uncertain, unaccepted or unreviewed executions before completing the task');
      for(const executionId of ids){
        const e=this.task(executionId);
        if(e.userTask?.id!==taskId||e.userTask.revision!==task.revision||e.status!=='accepted')throw Error('Completion evidence must reference accepted executions of this task at its current revision');
        const changes=this.contextChanges(e.spec);
        if(this.hasContextChanges(changes))throw Error('Completion evidence context changed; run and validate fresh work');
      }
      return this.saveUserTask({...task,status:'completed',version:task.version+1,updatedAt:Date.now(),completion:{revision:task.revision,evidence:proof,executionIds:ids,at:Date.now()}});
    });
  }
  private executionActive(e:Task){return !['accepted','continued','ready','waiting_input','waiting_permission','failed','canceled'].includes(e.status);}
  private parentChanges(e:Task,overview?:Overview){
    if(!e.userTask)return {stale:false,paused:false};
    const t=overview?.parentsById.get(e.userTask.id)??this.userTask(e.userTask.id);return {stale:t.revision!==e.userTask.revision,paused:t.status!=='active'};
  }
  private overview():Overview{
    const tasks=this.tasks(),parents=this.userTasks(),byParent=new Map<string,Task[]>(),pending=new Map<string,Outbox[]>();
    for(const t of tasks)if(t.userTask){const group=byParent.get(t.userTask.id)??[];group.push(t);byParent.set(t.userTask.id,group);}
    for(const c of this.db.list<Outbox>('outbox'))if(!c.done){const group=pending.get(c.taskId)??[];group.push(c);pending.set(c.taskId,group);}
    return {tasks,byRun:new Map(tasks.map(t=>[t.spec.runId,t])),parents,byParent,pending,context:this.context.snapshot(),knowledge:new Map(this.db.scoped<Knowledge>('knowledge',this.scope).map(k=>[k.id,knowledgeProvenance(k)])),parentsById:new Map(parents.map(t=>[t.id,t]))};
  }
  userTaskSummary(t:UserTask,overview=this.overview()){
    const executions=overview.byParent.get(t.id)??[],actions=new Set(this.brief(executions,overview).items.flatMap(i=>i.actions));
    const permissions=executions.flatMap(e=>(e.run?.approvals??[]).filter(a=>['pending','unknown','unsupported'].includes(a.state)&&!(a.state==='unknown'&&this.effectsReview(e,a.id))).map(a=>this.permissionCard(e,a,t.title)));
    if(t.waitingFor.length&&t.status!=='completed'&&t.status!=='canceled')actions.add('resolve_task_decisions');
    if(t.status==='active'&&!executions.some(e=>this.executionActive(e))&&!t.waitingFor.length)actions.add('decide_next_execution_or_complete_task');
    return {userTaskId:t.id,taskKey:t.taskKey,title:t.title,goal:t.goal.slice(0,240),goalTruncated:t.goal.length>240,
      version:t.version,revision:t.revision,status:t.status,cancellation:t.status==='canceled'?(executions.some(e=>e.cancelRequested&&e.status!=='canceled')?'pending':'confirmed'):null,
      waitingFor:t.waitingFor.slice(0,2).map(s=>s.slice(0,160)),waitingCount:t.waitingFor.length,
      permissions:{waiting:permissions.filter(p=>p.state==='pending').length,unknown:permissions.filter(p=>p.state==='unknown').length,unsupported:permissions.filter(p=>p.state==='unsupported').length,requests:permissions.slice(0,3),total:permissions.length},
      executions:{total:executions.length,active:executions.filter(e=>this.executionActive(e)).length,ready:executions.filter(e=>e.status==='ready').length,accepted:executions.filter(e=>e.status==='accepted').length,unreviewed:executions.filter(e=>e.learning==='pending').length},
      actions:[...actions]};
  }
  knowledge(){return this.db.scoped<Knowledge>('knowledge',this.scope).filter(k=>k.active).map(knowledgeProvenance);}
  knowledgeEntry(knowledgeId:string){const k=this.db.get<Knowledge>('knowledge',knowledgeId);if(!k||k.scope!==this.scope)throw Error('Knowledge scope mismatch or missing entry');return knowledgeProvenance(k);}
  private effectsReview(t:Task,requestId:string){const review=t.effectsReviews?.[requestId];return review?.runId===t.spec.runId?review:undefined;}
  private confirmedStartRejection(t:Task):StartRejection|undefined{
    if(t.startRejection)return t.startRejection;
    // Older ledgers lack a structured rejection. Require the exact settled
    // start receipt; missing runs or transport errors alone prove nothing.
    if(!t.run&&['failed','canceled'].includes(t.status)&&t.learning==='pending'&&!t.lastEventSeq&&t.error){
      const receipt=this.db.list<Outbox>('outbox').find(c=>c.taskId===t.spec.taskId&&c.type==='start'&&c.done&&c.attempts>0&&c.error===t.error);
      if(receipt)return {source:'legacy-ledger',reason:receipt.error!};
    }
  }
  private needsFinalSnapshot(t:Task){
    if(!t.run)return !this.confirmedStartRejection(t)&&!t.cancelConfirmedNotStarted;
    return !terminal(t.run.state)||t.run.state==='unknown'||!!t.run.approvals?.some(a=>['pending','approved','denied','responding'].includes(a.state));
  }
  private unreviewedEffects(t:Task){return (t.run?.approvals??[]).filter(a=>a.state==='unknown'&&!this.effectsReview(t,a.id));}
  private executionScope(t:Task){return {userTaskId:t.userTask?.id,taskKey:t.spec.taskKey,sessionId:t.spec.worker?.sessionId};}
  private relatedExecutions(scope:{userTaskId?:string;taskKey?:string;sessionId?:string},exclude?:string){
    return this.tasks().filter(t=>t.spec.taskId!==exclude&&(scope.userTaskId?t.userTask?.id===scope.userTaskId||(!t.userTask&&!!scope.taskKey&&t.spec.taskKey===scope.taskKey):
      (!!scope.taskKey&&t.spec.taskKey===scope.taskKey)|| (!!scope.sessionId&&t.spec.worker?.sessionId===scope.sessionId)));
  }
  private assertEffectsSettled(scope:Parameters<Main['relatedExecutions']>[0],exclude?:string){
    for(const t of this.relatedExecutions(scope,exclude)){
      if(this.unreviewedEffects(t).length)throw Error('Inspect and review unknown operation effects before retrying or allowing more work in this task: '+t.spec.taskId);
      if((t.cancelRequested||['canceled','failed','unknown'].includes(t.status))&&this.needsFinalSnapshot(t))throw Error('Confirm the uncertain execution stopped and sync its final operation outcomes before more work in this task: '+t.spec.taskId);
    }
  }
  private async refreshRelatedEffects(t:Task,deadline:number){
    // Read current Host snapshots before delivering new work or an allow. A
    // queued start must not overtake a sibling's final unknown-effects event.
    const peers=this.relatedExecutions(this.executionScope(t),t.spec.taskId).filter(peer=>this.needsFinalSnapshot(peer)&&
      (!!peer.run||this.db.list<Outbox>('outbox').some(c=>c.taskId===peer.spec.taskId&&c.type==='start'&&c.attempts>0)));
    if(peers.length&&!this.db.get('endpoint','epoch')){
      const page=await request(this.target,{type:'events',after:this.db.get<number>('cursor','host')??0,page:true},Math.max(1,deadline-Date.now()));
      if(!this.verifyHostPage(page))throw Error('Upgrade the Host to reconcile related execution outcomes before more work');
    }
    if(peers.length&&await this.reconcile(deadline,peers))throw Error('Operation outcome refresh incomplete; sync again before allowing more work in this task');
  }
  reviewOperationEffects(executionId:string,requestId:string,disposition:'no-effects'|'effects-addressed',evidence:string[]){
    const proof=VerificationEvidence.parse(evidence);
    z.guid().parse(requestId);z.enum(['no-effects','effects-addressed']).parse(disposition);
    return this.db.transaction(()=>{
      const t=this.task(executionId);
      // Unknown execution liveness must first be resolved on the Host. Knowledge
      // review and cancellation intent alone cannot establish stopped execution.
      if(this.needsFinalSnapshot(t)||!['canceled','failed'].includes(t.run?.state??'')||!['canceled','failed'].includes(t.status))throw Error('Confirm execution stopped and sync before reviewing operation effects');
      if(!t.run?.approvals?.some(a=>a.id===requestId&&a.state==='unknown'))throw Error('No unknown operation with this request ID in this execution');
      const prior=this.effectsReview(t,requestId);
      if(prior){
        if(prior.disposition!==disposition||canonical(prior.evidence)!==canonical(proof))throw Error('Conflicting operation effects review; original evidence is preserved');
        return this.taskSummary(t);
      }
      t.effectsReviews={...t.effectsReviews,[requestId]:{runId:t.spec.runId,by:this.owner,at:Date.now(),source:'main-reported',disposition,evidence:proof}};
      this.db.set('tasks',executionId,t);return this.taskSummary(t);
    });
  }
  private permissionCard(t:Task,a:ApprovalSummary,title=t.spec.goal){
    const review=this.effectsReview(t,a.id);
    return {executionId:t.spec.taskId,requestId:a.id,taskTitle:title.slice(0,160),host:this.target.kind==='ssh'?this.target.destination:'Local Host',state:a.state,
      operation:a.title??'Review a worker operation',preview:a.preview??'Read the full native request before deciding',truncated:a.truncated??false,
      decisionBy:a.state==='pending'?(a.decider??'user'):null,impact:a.impact??'Native request details required',reason:a.reason,expiresAt:a.expiresAt,
      effectsReview:review?{at:review.at,source:review.source,disposition:review.disposition,evidenceCount:review.evidence.length}:null};
  }
  taskSummary(t:Task,pending?:Map<string,Outbox[]>){return {
    executionId:t.spec.taskId,taskId:t.spec.taskId,runId:t.spec.runId,userTaskId:t.userTask?.id??null,taskRevision:t.userTask?.revision??null,taskKey:t.spec.taskKey??null,goal:t.spec.goal.slice(0,240),goalTruncated:t.spec.goal.length>240,
    status:t.status,cancelRequested:t.cancelRequested,operationEffects:this.unreviewedEffects(t).length?'unknown':t.run?.approvals?.some(a=>a.state==='unknown')?'reviewed':'no_unconfirmed_approval',learning:t.learning??null,workerSessionId:t.spec.worker?.sessionId??null,turn:t.spec.worker?.turn??null,continuedBy:t.continuedBy??null,
    questions:t.run?.report?.questions??[],approvalRequests:(t.run?.approvals??[]).map(a=>this.permissionCard(t,a)),permissions:t.run?.permissions??null,startRejection:t.startRejection?{...t.startRejection,reason:t.startRejection.reason.slice(0,320)}:null,
    error:(t.error??t.run?.error)?.slice(0,320),unresolved:t.run?.reportOmitted?null:t.run?.report?.unresolved.length??0,
    delivery:(pending?.get(t.spec.taskId)??(pending?[]:this.db.list<Outbox>('outbox').filter(c=>!c.done&&c.taskId===t.spec.taskId))).map(c=>({type:c.type,attempts:c.attempts,error:c.error?.slice(0,320)})),
  };}
  executionStatus(offset=0,limit=10,taskKey?:string){
    const overview=this.overview();
    const all=overview.tasks.filter(t=>!taskKey||t.spec.taskKey===taskKey).reverse();
    const page=all.slice(offset,offset+limit);
    return {mode:this.mode(),host:this.hostLabel(),sync:this.syncRecord(),workerStates:this.workerStates(all),
      executions:page.map(t=>({...this.taskSummary(t,overview.pending),taskTitle:t.userTask?overview.parentsById.get(t.userTask.id)?.title??null:null})),
      pagination:this.pagination(all.length,{offset,limit}),brief:this.brief(page,overview)};
  }
  status(raw:unknown={}){
    const q=StatusQuery.parse(raw);
    if(q.version&&(!q.id||q.view!=='tasks'))throw Error('version requires a user task id and tasks view');
    if(q.id){
      if(q.view==='knowledge')return {knowledge:this.knowledgeEntry(q.id)};
      if(q.view==='executions')return {execution:this.task(q.id)};
      if(q.view!=='tasks')throw Error('An id requires tasks, executions or knowledge view');
      let task=this.userTask(q.id);
      if(q.version){const old=this.db.get<UserTask>('user-task-history',`${q.id}:${q.version}`);if(!old)throw Error('User task version not found');task=old;}
      const overview=this.overview(),executions=(overview.byParent.get(q.id)??[]).toReversed(),history=this.db.list<UserTask>('user-task-history').filter(t=>t.id===task.id);
      return {task,history:history.slice(-25).map(t=>({version:t.version,revision:t.revision,status:t.status,reason:t.reason?.slice(0,240)})),historyTotal:history.length,executions:executions.slice(q.offset,q.offset+q.limit).map(e=>this.taskSummary(e,overview.pending)),pagination:this.pagination(executions.length,q)};
    }
    if(q.view==='executions')return this.executionStatus(q.offset,q.limit,q.taskKey);
    const overview=this.overview(),all=overview.tasks.filter(t=>!q.taskKey||t.spec.taskKey===q.taskKey).reverse();
    const knowledge=[...overview.knowledge.values()].filter(k=>k.active);
    if(q.view==='knowledge')return {knowledge:knowledge.slice(q.offset,q.offset+q.limit).map(k=>({id:k.id,version:k.version,preview:k.content.slice(0,240),truncated:k.content.length>240,verified:k.verified,workerClaimedVerified:k.workerClaimedVerified,verificationStatus:k.verification!.status})),pagination:this.pagination(knowledge.length,q)};
    const tasks=overview.parents.filter(t=>!q.taskKey||t.taskKey===q.taskKey).sort((a,b)=>b.updatedAt-a.updatedAt),summaries=tasks.map(t=>this.userTaskSummary(t,overview));
    const attention=[...summaries.filter(t=>t.actions.length).map(t=>({userTaskId:t.userTaskId,executionId:null as string|null,taskKey:t.taskKey,title:t.title,actions:t.actions,permissions:t.permissions})),
      ...this.brief(all.filter(e=>!e.userTask),overview).items.map(i=>({userTaskId:null as string|null,executionId:i.taskId,taskKey:this.task(i.taskId).spec.taskKey??null,title:this.task(i.taskId).spec.goal.slice(0,160),actions:i.actions,permissions:this.taskSummary(this.task(i.taskId),overview.pending).approvalRequests}))];
    const priority=(a:typeof attention[number])=>a.actions.some(s=>s.includes('inspect_execution')||s.includes('cancel_old'))?0:a.actions.some(s=>s.includes('context')||s.includes('decision')||s.includes('permission'))?1:a.actions.includes('collect_and_check_acceptance')?2:3;
    attention.sort((a,b)=>priority(a)-priority(b));
    if(q.view==='attention')return {items:attention.slice(q.offset,q.offset+q.limit),pagination:this.pagination(attention.length,q)};
    return {mode:this.mode(),memory:memoryPolicy(this.owner.harness),counts:{tasks:tasks.length,open:tasks.filter(t=>!['completed','canceled'].includes(t.status)).length,executions:all.length,unassignedExecutions:all.filter(e=>!e.userTask).length,unreviewed:all.filter(t=>t.learning==='pending').length,context:overview.context.entries.filter(n=>n.active).length,knowledge:knowledge.length},
      tasks:summaries.slice(q.offset,q.offset+q.limit),pagination:this.pagination(tasks.length,q),
      attention:{items:attention.slice(0,10),pagination:this.pagination(attention.length,{offset:0,limit:10})},
      context:overview.context.entries.filter(n=>n.active).slice(-5).map(n=>({id:n.id,version:n.version,preview:n.content.slice(0,240),appliesTo:n.appliesTo})),
      knowledge:knowledge.slice(-5).map(k=>({id:k.id,version:k.version,preview:k.content.slice(0,240)})),
      inboxErrors:this.db.pendingIncoming<Incoming>().filter(e=>e.error).slice(0,5).map(e=>({runId:e.run,seq:e.seq,error:e.error?.slice(0,240)})),
      sync:this.syncRecord(),wake:'unverified; synchronize on the next interaction'};
  }
  private pagination(total:number,q:{offset:number;limit:number}){return {offset:q.offset,limit:q.limit,total,nextOffset:q.offset+q.limit<total?q.offset+q.limit:null};}
  private workerHistory(spec:Spec,byRun?:Map<string,Task>){
    const specs=[spec];let current=spec;
    if((spec.worker?.turn??1)>1)byRun??=new Map(this.tasks().map(t=>[t.spec.runId,t]));
    while(current.worker&&current.worker.turn>1){
      const turn=current.worker,previous=turn.previousRunId?byRun?.get(turn.previousRunId)?.spec:undefined;
      if(!previous||previous.worker?.sessionId!==turn.sessionId||previous.worker.turn!==turn.turn-1||canonical(previous.owner)!==canonical(spec.owner)||previous.taskKey!==spec.taskKey||previous.baseCommit!==spec.baseCommit)return {specs,missing:true};
      specs.push(previous);current=previous;
    }
    return {specs,missing:false};
  }
  contextChanges(spec:Spec,overview?:Overview,execution?:Task){
    const snapshot=overview?.context??this.context.snapshot();
    const history=this.workerHistory(spec,overview?.byRun);
    // Newest explicit reference wins; omission does not erase what the native
    // session remembers. A corrected snapshot can supersede an older version.
    const effectiveContext=new Map<string,NonNullable<Spec['userContext']>[number]>();
    for(const turn of history.specs)for(const ref of turn.userContext??[])if(!effectiveContext.has(ref.id))effectiveContext.set(ref.id,ref);
    const knowledge=[...new Set(history.specs.flatMap(s=>s.knowledge).filter(ref=>{const k=overview?overview.knowledge.get(ref.id):this.db.get<Knowledge>('knowledge',ref.id);return !k||k.scope!==this.scope||!k.active||k.version!==ref.version;}).map(ref=>ref.id))];
    // Referenced IDs also catch short notes and notes whose text changed when
    // sharing was revoked. Omitting them from the next snapshot cannot erase
    // native conversation history. Normal requirement revisions remain allowed.
    const localOnly=[...new Set(history.specs.flatMap(s=>[...this.context.localOnlyMatches(s,snapshot),...(s.userContext??[]).filter(ref=>!snapshot.byId.get(ref.id)?.shareWithWorkers).map(ref=>ref.id)]))];
    const t=execution??this.db.get<Task>('tasks',spec.taskId);
    return {knowledge,userContext:this.context.changed([...effectiveContext.values()],snapshot),localOnly,historyMissing:history.missing,
      missingRequired:this.context.missingRequired(spec.userContext,spec.taskKey,snapshot),requiredSetChanged:(t?.requiredContextRevision??0)!==this.context.requiredRevision(spec.taskKey)};
  }
  private hasContextChanges(changes:ReturnType<Main['contextChanges']>){return !!(changes.knowledge.length||changes.userContext.length||changes.localOnly.length||changes.historyMissing||changes.missingRequired.length||changes.requiredSetChanged);}
  brief(tasks=this.tasks(),overview=this.overview()){
    return {mode:this.mode(),items:tasks.flatMap(t=>{
      const actions:string[]=[],changes=this.contextChanges(t.spec,overview,t);
      const parent=this.parentChanges(t,overview),changed=this.hasContextChanges(changes)||parent.stale;
      if(!['accepted','continued','canceled','failed'].includes(t.status)&&changed)actions.push('reconcile_context_before_further_work');
      if(overview.pending.has(t.spec.taskId))actions.push(!t.cancelRequested&&changed?'inspect_and_cancel_old_run_before_replacement':'sync_pending_commands');
      if(t.status==='ready')actions.push('collect_and_check_acceptance');
      if(t.status==='waiting_input')actions.push('answer_worker_questions_and_continue');
      if(t.status==='awaiting_approval')actions.push(t.run?.permissions?.mode==='delegate'&&t.run.approvals?.some(a=>a.state==='pending'&&a.decider==='main')?'review_native_permission_requests':'ask_user_about_native_permissions');
      if(t.status==='waiting_permission')actions.push('replace_legacy_permission_worker');
      if(t.status==='unknown')actions.push('inspect_execution_before_retry');
      if(['accepted','continued','canceled','failed'].includes(t.status)&&this.needsFinalSnapshot(t))actions.push('sync_execution_final_state');
      if(this.unreviewedEffects(t).length)actions.push('inspect_unknown_operation_effects_before_retry');
      if(t.run?.approvals?.some(a=>a.state==='unsupported')&&(!t.learning||t.learning==='pending'))actions.push('inspect_unsupported_permission_requests');
      if(t.cancelRequested&&t.status!=='canceled')actions.push('confirm_execution_stopped');
      if(t.status==='failed'&&!t.cancelRequested&&t.learning==='pending')actions.push('inspect_failed_execution');
      if(t.run?.report?.unresolved.length&&t.status!=='canceled'&&(t.status==='ready'||t.learning==='pending'))actions.push('resolve_report_questions');
      if(t.learning==='pending')actions.push('review_execution_outcome');
      return actions.length?[{taskId:t.spec.taskId,status:t.status,actions,contextChanges:changes}]:[];
    })};
  }
  dispatch(key:string,input:Pick<Spec,'goal'|'originalRequest'|'constraints'|'acceptance'|'baseCommit'>&{taskKey?:string;userTaskId?:string;expectedRevision?:number;contextIds?:string[];knowledgeIds?:string[];previousExecutionId?:string;message?:string;answers?:z.infer<typeof Answers>}) {
    if(!this.mode())throw Error('Enter Rein mode before dispatch');
    return this.db.transaction(()=>{
      const dedupKey=this.binding+':'+key,existing=this.db.get<{taskId:string;digest:string}>('requests',dedupKey),digest=hash(canonical(input));
      if(existing){if(existing.digest!==digest)throw Error('Request key content conflict');return this.task(existing.taskId);}
      const {contextIds=[],knowledgeIds=[],userTaskId,expectedRevision,previousExecutionId,message,answers,...taskInput}=input;
      const previous=previousExecutionId?this.task(previousExecutionId):undefined;
      if(!previous&&(message||answers))throw Error('Worker answers/message require a previous execution');
      if(previous){
        if(!previous.spec.worker||!previous.run?.nativeSessionId||previous.cancelRequested||previous.continuedBy||!['ready','waiting_input','waiting_permission','accepted'].includes(previous.status))throw Error('Worker session is not ready to continue; sync and inspect its latest turn');
        const changes=this.contextChanges(previous.spec);
        if(changes.historyMissing)throw Error('Native worker history is incomplete; use a fresh worker session');
        if(changes.localOnly.length)throw Error('Native worker history contains context now marked local-only; use a fresh worker session with a permitted snapshot');
        if(changes.knowledge.length)throw Error('Native worker history references knowledge changed or invalidated; use a fresh worker session and revalidate');
        if(previous.userTask?.id!==userTaskId||previous.spec.baseCommit!==taskInput.baseCommit)throw Error('Continuation must retain the same user task and base commit');
        z.string().trim().min(1).max(16000).parse(message);
        const questions=previous.run.report?.questions;
        if(!previous.run.report)throw Error('Collect the full report before continuing');
        const checkedAnswers=Answers.parse(answers??[]);
        if(questions?.some(q=>q.permission)&&!previous.run.permissions)throw Error('Permission policy missing; sync with a compatible Host before deciding');
        validatePermissionAnswers(previous.run.permissions??{mode:'ask',sandbox:'read-only'},questions,checkedAnswers);
      }
      let parent:UserTask|undefined;
      if(userTaskId){
        parent=this.userTask(userTaskId);
        if(parent.status!=='active'||parent.waitingFor.length)throw Error('User task must be active with its pending decisions resolved before dispatch');
        if(parent.revision!==expectedRevision)throw Error('User task revision changed; read current requirements before dispatch');
        if(input.taskKey&&input.taskKey!==parent.taskKey)throw Error('Dispatch taskKey does not match its user task');
        if(this.tasks().some(e=>e.userTask?.id===userTaskId&&this.executionActive(e)&&(e.userTask.revision!==parent!.revision||e.cancelRequested||e.status==='unknown')))throw Error('Inspect and confirm old or uncertain executions stopped before dispatching replacement work');
        taskInput.taskKey=parent.taskKey;
      }else{
        if(expectedRevision!==undefined)throw Error('expectedRevision requires userTaskId');
        if(input.taskKey&&this.userTasks().some(t=>t.taskKey===input.taskKey))throw Error('This taskKey has a user task; supply its userTaskId and expectedRevision');
      }
      this.assertEffectsSettled({userTaskId,taskKey:taskInput.taskKey,sessionId:previous?.spec.worker?.sessionId});
      const userContext=this.context.select(contextIds,taskInput.taskKey);
      const missingRequired=this.context.missingRequired(userContext,taskInput.taskKey);
      if(missingRequired.length)throw Error('Required task context must be shareable and explicitly selected before dispatch: '+missingRequired.join(', '));
      const knowledge=KnowledgeSelection.parse(knowledgeIds).map(knowledgeId=>{const k=this.knowledgeEntry(knowledgeId);if(!k.active)throw Error('Selected knowledge is inactive');const {id,version,content,source,verified}=k;return {id,version,content,source,verified};});
      if(previous&&previous.spec.taskKey!==taskInput.taskKey)throw Error('Continuation cannot change task scope');
      const worker=previous?{sessionId:previous.spec.worker!.sessionId,turn:previous.spec.worker!.turn+1,previousRunId:previous.spec.runId,message,answers:answers??[]}:{sessionId:id(),turn:1};
      const approvalMode=this.db.get<z.infer<typeof PermissionMode>>('approval-mode',this.binding);
      const spec=TaskSpec.parse({...taskInput,...(approvalMode?{approvalMode}:{}),...(userContext.length?{userContext}:{}),taskId:id(),runId:id(),revision:1,owner:this.owner,knowledge,worker});
      if(previous&&this.contextChanges(spec).userContext.length)throw Error('Native worker history contains changed or retired user context; explicitly select the current shareable versions, or use a fresh worker session');
      if(this.context.localOnlyMatches(spec).length)throw Error('Worker payload contains known local-only context. Rewrite originalRequest and other fields to include only the delegated task; do not copy the full conversation.');
      assertSize(spec,MAX_SPEC_BYTES,'Task snapshot');
      const t:Task={spec,key:id(),status:'queued',cancelRequested:false,requiredContextRevision:this.context.requiredRevision(spec.taskKey),...(parent?{userTask:{id:parent.id,revision:parent.revision}}:{})};
      this.db.set('tasks',spec.taskId,t);this.db.set('requests',dedupKey,{taskId:spec.taskId,digest});
      if(previous){previous.continuedBy=spec.taskId;this.db.set('tasks',previous.spec.taskId,previous);}
      const cmd:Outbox={id:id(),taskId:spec.taskId,type:'start',done:false,attempts:0};this.db.set('outbox',cmd.id,cmd);return t;
    });
  }
  async submit(key:string,input:Parameters<Main['dispatch']>[1]){
    const execution=this.dispatch(key,input);
    await this.sync();
    return {...this.taskSummary(this.task(execution.spec.taskId)),sync:this.db.get('sync-status',this.binding)};
  }
  async continueExecution(key:string,input:Omit<Parameters<Main['dispatch']>[1],'baseCommit'|'userTaskId'|'taskKey'>&{previousExecutionId:string;message:string}){
    const previous=this.task(input.previousExecutionId);
    return this.submit(key,{...input,baseCommit:previous.spec.baseCommit,userTaskId:previous.userTask?.id,taskKey:previous.spec.taskKey});
  }
  async permissionRequests(executionId:string):Promise<Approval[]>{
    const t=this.task(executionId);
    return request(this.target,{type:'approval-list',runId:t.spec.runId,owner:this.owner});
  }
  private assertPermissionActive(t:Task){
    const parent=this.parentChanges(t);
    if(t.cancelRequested||parent.paused||parent.stale||this.hasContextChanges(this.contextChanges(t.spec)))throw Error('Execution is canceled, paused or its context changed; approval remains pending');
  }
  private async permissionRequest(executionId:string,requestId:string){
    const t=this.task(executionId);this.assertPermissionActive(t);
    const a=(await this.permissionRequests(executionId)).find(a=>a.id===requestId);
    if(!a||a.runId!==t.spec.runId||canonical(a.owner)!==canonical(this.owner))throw Error('Permission request does not belong to this execution');
    return a;
  }
  async reviewPermission(executionId:string,requestId:string,prompt?:PermissionPrompt,signal?:AbortSignal){
    const pending=()=>({requestId,state:'pending',message:'No user decision was submitted'});
    if(signal?.aborted)return pending();
    const a=await this.permissionRequest(executionId,requestId);
    if(signal?.aborted)return pending();
    if(a.state!=='pending')return a;
    const saved=this.db.get<ApprovalOutbox>('approval-outbox',requestId);
    if(saved&&!(saved.done&&saved.error)){await this.sync();return {requestId,decision:saved.receipt.payload,delivery:this.db.get('approval-outbox',requestId)};}
    if(!prompt)throw Error('This harness cannot display a native approval form. The task remains pending; reopen this conversation in a client with approval UI. Terminal review is available for diagnostics.');
    const t=this.task(executionId);
    const allow=await awaitApproval(prompt,{...a,presentation:{taskTitle:t.userTask?this.userTask(t.userTask.id).title:t.spec.goal,executionGoal:t.spec.goal,host:this.target.kind==='ssh'?this.target.destination:'Local Host'}},signal);
    if(allow===null||signal?.aborted)return pending();
    const current=await this.permissionRequest(executionId,requestId);
    if(signal?.aborted)return pending();
    if(current.state!=='pending'||current.requestHash!==a.requestHash)throw Error('Approval changed while the user was reviewing it; inspect the latest request');
    return this.recordPermission(executionId,a,allow,'user','User selected this decision in the native approval interface');
  }
  async delegatePermission(executionId:string,requestId:string,allow:boolean,reason:string,signal?:AbortSignal){
    signal?.throwIfAborted();
    const a=await this.permissionRequest(executionId,requestId);
    signal?.throwIfAborted();
    if(a.policy.mode!=='delegate')throw Error('This request requires the user; the main agent cannot approve or deny it');
    if(allow&&a.review?.decider!=='main')return {requestId,state:'user_required',delivery:'not_submitted',message:a.policy.version===undefined?'This request retains a legacy delegation policy. Use user review; upgrading does not expand its authorization.':'This native request cannot be handled by the current adapter. Inspect its recorded details.',request:this.permissionCard(this.task(executionId),a.review??{id:a.id,state:a.state,method:a.method})};
    return this.recordPermission(executionId,a,allow,'main',reason);
  }
  async reviewTaskPermission(selection:{userTaskId?:string;executionId?:string;requestId?:string},prompt?:PermissionPrompt,signal?:AbortSignal){
    signal?.throwIfAborted();
    if(Number(!!selection.userTaskId)+Number(!!selection.executionId)!==1)throw Error('Select exactly one user task or execution');
    const parent=selection.userTaskId?this.userTask(selection.userTaskId):undefined;
    const executions=selection.executionId?[this.task(selection.executionId)]:this.tasks().filter(t=>t.userTask?.id===parent!.id);
    // The normal sync/attention flow supplies task cards. Explicit execution
    // review also works before the next sync, without scanning other tasks.
    const choices:ReturnType<Main['permissionCard']>[]=[];
    for(const t of executions){
      signal?.throwIfAborted();
      if(!selection.executionId&&!t.run?.approvals?.some(a=>a.state==='pending'&&(!selection.requestId||a.id===selection.requestId)))continue;
      for(const a of await this.permissionRequests(t.spec.taskId))if(a.state==='pending'&&(!selection.requestId||a.id===selection.requestId))choices.push(this.permissionCard(t,a.review??{id:a.id,state:a.state,method:a.method},parent?.title));
    }
    if(choices.length!==1)return {state:choices.length?'selection_required':'no_pending_request',message:choices.length?'Choose one operation in this task; approvals are never applied in bulk.':'No matching pending request in this task. Sync to refresh its state.',requests:choices};
    const selected=choices[0]!;
    return this.reviewPermission(selected.executionId,selected.requestId,prompt,signal);
  }
  private async recordPermission(executionId:string,a:Approval,allow:boolean,actor:'user'|'main',reason:string){
    z.string().trim().min(1).max(2000).parse(reason);
    if(allow)await this.refreshRelatedEffects(this.task(executionId),Date.now()+4000);
    const payload={requestId:a.id,requestHash:a.requestHash,runId:a.runId,owner:this.owner,allow,actor,reason};
    const receipt={payload,...signApproval(this.state,this.owner.instance,payload)};
    this.db.transaction(()=>{
      this.assertPermissionActive(this.task(executionId));
      if(allow)this.assertEffectsSettled(this.executionScope(this.task(executionId)),executionId);
      const previous=this.db.get<ApprovalOutbox>('approval-outbox',a.id);
      if(previous&&!(previous.done&&previous.error)&&canonical(previous.receipt.payload)!==canonical(payload))throw Error('Conflicting local permission decision');
      // A confirmed rejection did not authorize anything. Keep its audit record
      // while allowing the still-pending request to go through user review.
      if(previous?.done&&previous.error)this.db.set('approval-rejections',a.id+':'+hash(canonical(previous)),previous);
      if(!previous||(previous.done&&previous.error))this.db.set('approval-outbox',a.id,{executionId,receipt,done:false});
    });
    await this.sync();
    const result=this.db.get<ApprovalOutbox>('approval-outbox',a.id)!;
    return {requestId:a.id,decision:payload,delivery:result.done?(result.error?'rejected':'acknowledged'):'pending',error:result.error};
  }
  private cancelExecution(t:Task){
    if(t.status==='accepted'||t.status==='continued')throw Error('Accepted or continued task has no active execution; cancel its latest turn');
    if(t.status==='canceled'||t.cancelRequested)return t;
    t.cancelRequested=true;t.status='cancel_requested';this.db.set('tasks',t.spec.taskId,t);
    for(const command of this.db.list<Outbox>('outbox').filter(c=>c.taskId===t.spec.taskId&&c.type==='start'&&!c.done)){command.done=true;delete command.error;this.db.set('outbox',command.id,command);}
    const cmd:Outbox={id:'cancel:'+t.spec.runId,taskId:t.spec.taskId,type:'cancel',done:false,attempts:0};this.db.set('outbox',cmd.id,cmd);return t;
  }
  cancel(taskId:string){return this.db.transaction(()=>this.cancelExecution(this.task(taskId)));}
  async sync(budgetMs=4000){
    z.number().int().min(100).max(15000).parse(budgetMs);
    const generation=this.db.transaction(()=>{const next=(this.db.get<number>('sync-generation',this.binding)??0)+1;this.db.set('sync-generation',this.binding,next);return next;});
    const deadline=Date.now()+budgetMs;let deliveryError:string|undefined,remaining=false,unavailable:string|undefined;
    // Once paired, verify the Host database identity before delivering any more
    // intent. A replacement database must never silently replay old commands.
    if(this.db.get('endpoint','epoch')){
      try{
        const page=await request(this.target,{type:'events',after:this.db.get<number>('cursor','host')??0,page:true},Math.max(1,deadline-Date.now()));
        this.verifyHostPage(page);
      }catch(e){unavailable=(e as Error).message;}
    }
    // Every network await may overlap another Main process. Claim intent from
    // current state, then merge the acknowledgement back into current state.
    for(const candidate of this.db.list<Outbox>('outbox').filter(c=>!c.done).sort((a,b)=>Number(b.type==='cancel')-Number(a.type==='cancel'))){
      if(unavailable)break;
      if(Date.now()>=deadline){remaining=true;break;}
      if(candidate.type==='start'){
        const t=this.db.get<Task>('tasks',candidate.taskId)!;
        if(canonical(t.spec.owner)!==canonical(this.owner))continue;
        if(!t.cancelRequested&&this.mode())try{await this.refreshRelatedEffects(t,deadline);}
        catch(e){deliveryError=(e as Error).message;remaining=true;continue;}
      }
      const delivery=this.db.transaction(()=>{
        const cmd=this.db.get<Outbox>('outbox',candidate.id)!;
        if(cmd.done)return;
        const t=this.db.get<Task>('tasks',cmd.taskId)!;
        if(canonical(t.spec.owner)!==canonical(this.owner))return;
        if(cmd.type==='start'&&t.cancelRequested){cmd.done=true;delete cmd.error;this.db.set('outbox',cmd.id,cmd);return;}
        if(cmd.type==='start'&&!this.mode())return;
        if(cmd.type==='start'){
          try{this.assertEffectsSettled(this.executionScope(t),t.spec.taskId);}
          catch(e){cmd.error=(e as Error).message;this.db.set('outbox',cmd.id,cmd);return;}
          const parent=this.parentChanges(t);
          if(parent.paused)return;
          if(this.hasContextChanges(this.contextChanges(t.spec))||parent.stale){
            t.status='blocked_context';t.error='Snapshot context changed; further start delivery paused. A previous attempt may have reached the Host: inspect and confirm cancellation before replacement.';
            cmd.error=t.error;this.db.set('tasks',t.spec.taskId,t);this.db.set('outbox',cmd.id,cmd);return;
          }
        }
        return {cmd,t};
      });
      if(!delivery)continue;
      const {cmd,t}=delivery;let ack:any,error:string|undefined,rejected=false;
      try{ack=await request(this.target,cmd.type==='start'?{type:'start',key:t.key,spec:t.spec}:{type:'cancel',runId:t.spec.runId},Math.max(1,deadline-Date.now()));}
      catch(e){error=(e as Error).message;rejected=e instanceof RemoteRejection;}
      this.db.transaction(()=>{
        const current=this.db.get<Outbox>('outbox',cmd.id)!;
        current.attempts++;
        if(!current.done){
          if(error){current.error=error;deliveryError=error;
            if(rejected&&cmd.type==='start'){
              current.done=true;const latest=this.task(t.spec.taskId);
              latest.startRejection={source:'host',reason:error,recordedAt:Date.now()};
              if(!latest.cancelRequested){latest.status='failed';latest.error=error;latest.learning='pending';}
              this.db.set('tasks',latest.spec.taskId,latest);
              const previous=this.tasks().find(p=>p.spec.runId===t.spec.worker?.previousRunId);
              if(previous?.continuedBy===t.spec.taskId){delete previous.continuedBy;this.db.set('tasks',previous.spec.taskId,previous);}
            }
          }
          else{
            current.done=true;delete current.error;
            if(cmd.type==='start'){const previous=this.tasks().find(p=>p.spec.runId===t.spec.worker?.previousRunId);if(previous?.continuedBy===t.spec.taskId&&previous.status!=='accepted'){previous.status='continued';this.db.set('tasks',previous.spec.taskId,previous);}}
            if(cmd.type==='cancel'&&ack.confirmed){
              const latest=this.task(t.spec.taskId);latest.status='canceled';
              // A stop receipt alone carries no final approval/outcome snapshot.
              // The no-run tombstone is the only exception: there is no outcome.
              if(ack.state==='not-started'&&!latest.run)latest.cancelConfirmedNotStarted=true;
              this.db.set('tasks',t.spec.taskId,latest);
            }
          }
        }
        this.db.set('outbox',current.id,current);
      });
    }
    for(const queued of this.db.list<ApprovalOutbox>('approval-outbox').filter(c=>!c.done)){
      if(unavailable||Date.now()>=deadline)break;
      if(canonical(queued.receipt.payload.owner)!==canonical(this.owner))continue;
      const t=this.task(queued.executionId);
      if(t.cancelRequested){queued.done=true;queued.error='Execution canceled before decision delivery';this.db.set('approval-outbox',queued.receipt.payload.requestId,queued);continue;}
      const parent=this.parentChanges(t);
      if(parent.paused||parent.stale||this.hasContextChanges(this.contextChanges(t.spec)))continue;
      if(queued.receipt.payload.allow){
        try{await this.refreshRelatedEffects(t,deadline);const latest=this.task(queued.executionId);this.assertPermissionActive(latest);this.assertEffectsSettled(this.executionScope(latest),queued.executionId);}
        catch(e){queued.error=(e as Error).message;this.db.set('approval-outbox',queued.receipt.payload.requestId,queued);continue;}
      }
      try{await request(this.target,{type:'approval-decide',receipt:queued.receipt},Math.max(1,deadline-Date.now()));queued.done=true;delete queued.error;}
      catch(e){queued.error=(e as Error).message;if(e instanceof RemoteRejection)queued.done=true;else deliveryError=queued.error;}
      this.db.set('approval-outbox',queued.receipt.payload.requestId,queued);
    }
    let more=true;
    let modernHost=false;
    while(!unavailable&&more&&Date.now()<deadline){
      const cursor=this.db.get<number>('cursor','host')??0;
      try{
        let response:any;
        try{response=await request(this.target,{type:'events',after:cursor,page:true},Math.max(1,deadline-Date.now()));}
        catch(e){
          // Older preview Hosts reject this optional field. Keep their array
          // protocol readable; an upgraded Host is needed for byte-safe paging.
          const message=(e as Error).message;
          if(!message.includes('unrecognized_keys')||!message.includes('page')||Date.now()>=deadline)throw e;
          response=await request(this.target,{type:'events',after:cursor},Math.max(1,deadline-Date.now()));
        }
        modernHost=this.verifyHostPage(response)||modernHost;
        if(response?.epoch&&cursor>response.head)continue;
        const events:Incoming[]=Array.isArray(response)?response:response.events;
        if(!Array.isArray(events))throw Error('Invalid event page');
        let last=cursor;
        for(const e of events){if(!Number.isSafeInteger(e.seq)||e.seq<=last||typeof e.run!=='string')throw Error('Invalid event sequence');last=e.seq;}
        more=Array.isArray(response)?events.length===100:response.hasMore;
        if(typeof more!=='boolean'||(!Array.isArray(response)&&response.nextCursor!==last)||(more&&!events.length))throw Error('Invalid event page cursor');
        this.db.transaction(()=>{
          for(const e of events)if(!this.db.get('incoming',String(e.seq)))this.db.set('incoming',String(e.seq),{...e,handled:false});
          this.db.set('cursor','host',Math.max(this.db.get<number>('cursor','host')??0,last));
        });
        this.applyIncoming();
      }catch(e){unavailable=(e as Error).message;break;}
    }
    if(more&&!unavailable)remaining=true;
    this.applyIncoming();
    if(modernHost&&!unavailable&&Date.now()<deadline){
      try{remaining=await this.reconcile(deadline)||remaining;}catch(e){unavailable=(e as Error).message;}
    }
    if(this.db.pendingIncoming<Incoming>().some(e=>e.error))deliveryError??='Some Host events require reconciliation; see inboxErrors';
    remaining ||= this.db.list<Outbox>('outbox').some(c=>!c.done&&canonical(this.db.get<Task>('tasks',c.taskId)?.spec.owner)===canonical(this.owner));
    remaining ||= this.db.list<ApprovalOutbox>('approval-outbox').some(c=>!c.done&&canonical(c.receipt.payload.owner)===canonical(this.owner));
    this.db.transaction(()=>{
      if(this.db.get<number>('sync-generation',this.binding)!==generation)return;
      const at=Date.now(),state=unavailable?'unavailable':remaining||deliveryError?'partial':'synced';
      this.db.set('sync-status',this.binding,{state,at,lastSyncedAt:state==='synced'?at:this.syncRecord().lastSyncedAt,error:(unavailable??deliveryError)?.slice(0,320)});
    });
    return this.status();
  }
  private verifyHostPage(page:any){
    if(!page?.epoch)return false;
    z.guid().parse(page.epoch);z.number().int().nonnegative().parse(page.head);
    this.db.transaction(()=>{
      const epoch=this.db.get<string>('endpoint','epoch');
      if(epoch&&epoch!==page.epoch)throw Error('Host database identity changed. Delivery stopped; inspect the original Host before reconnecting this ledger.');
      this.db.set('endpoint','epoch',page.epoch);
      const cursor=this.db.get<number>('cursor','host')??0;
      if(cursor>page.head){
        if(this.db.list<Task>('tasks').some(t=>(t.lastEventSeq??0)>page.head))throw Error('Host event history rolled back; delivery stopped for operator review');
        this.db.set('cursor','host',page.head);
      }
    });
    return true;
  }
  private async reconcile(deadline:number,selected?:Task[]){
    const brokenRuns=new Set(this.db.pendingIncoming<Incoming>().filter(e=>e.error).map(e=>e.run));
    const tasks=selected??this.tasks().filter(t=>!['accepted','continued','canceled','failed'].includes(t.status)||this.needsFinalSnapshot(t)||brokenRuns.has(t.spec.runId));
    if(!tasks.length)return false;
    const offset=(this.db.get<number>('reconcile-offset',this.binding)??0)%tasks.length;
    const ordered=[...tasks.slice(offset),...tasks.slice(0,offset)];let count=0;
    while(count<ordered.length&&Date.now()<deadline){
      const batch=ordered.slice(count,count+8),response=await request(this.target,{type:'reconcile',runIds:batch.map(t=>t.spec.runId)},Math.max(1,deadline-Date.now()));
      if(response.epoch!==this.db.get('endpoint','epoch')||!Number.isSafeInteger(response.cursor)||!Array.isArray(response.runs)||response.runs.length!==batch.length)throw Error('Invalid reconciliation response');
      this.db.transaction(()=>{
        for(const original of batch){
          const row=response.runs.find((r:any)=>r.runId===original.spec.runId);
          if(!row)throw Error('Missing reconciliation result');
          const t=this.task(original.spec.taskId);
          if(!row.data){
            const attempted=this.db.list<Outbox>('outbox').some(c=>c.taskId===t.spec.taskId&&c.type==='start'&&(c.done||c.attempts>0));
            if(attempted&&!['accepted','continued','canceled'].includes(t.status)){t.status='unknown';t.error='Host has no record of this delivered execution; inspect before retry';this.db.set('tasks',t.spec.taskId,t);}
            continue;
          }
          this.applyRun(t,row.data,response.cursor);
          for(const event of this.db.pendingIncoming<Incoming>().filter(e=>e.run===t.spec.runId&&e.seq<=response.cursor))this.db.set('incoming',String(event.seq),{...event,handled:true,error:undefined,reconciledAt:Date.now()});
        }
      });
      count+=batch.length;
    }
    if(!selected)this.db.set('reconcile-offset',this.binding,(offset+count)%tasks.length);
    return count<tasks.length;
  }
  private applyRun(t:Task,data:any,seq:number){
    if((t.lastEventSeq??0)>seq)return;
    if(data.snapshot){if(data.snapshot.taskId!==t.spec.taskId||data.snapshot.digest!==hash(canonical(t.spec)))throw Error('Run snapshot mismatch');}
    else {const spec=TaskSpec.parse(data.spec);if(canonical(t.spec)!==canonical(spec))throw Error('Run snapshot mismatch');}
    if(!['prepared','starting','running','succeeded','waiting_input','waiting_permission','awaiting_approval','failed','canceled','unknown'].includes(data.state))throw Error('Invalid run state');
    const {snapshot,...state}=data;
    const run:Run={...state,spec:t.spec};
    if(run.permissions)run.permissions=PermissionPolicy.parse(run.permissions);
    if(run.reportOmitted&&t.run?.report&&run.artifacts?.['report.json']?.hash===t.run.artifacts?.['report.json']?.hash){run.report=t.run.report;delete run.reportOmitted;}
    t.run=run;t.lastEventSeq=seq;delete t.error;delete t.cancelConfirmedNotStarted;
    if(!['accepted','continued','canceled'].includes(t.status))t.status=t.cancelRequested?(['canceled','succeeded','waiting_input','waiting_permission','failed'].includes(run.state)?'canceled':'cancel_requested'):(run.state==='succeeded'?'ready':run.state);
    if(terminal(run.state)&&!t.learning)t.learning='pending';
    this.db.set('tasks',t.spec.taskId,t);
  }
  private applyIncoming(){
    const blockedRuns=new Set<string>();
    for(const candidate of this.db.pendingIncoming<Incoming>()){
      if(blockedRuns.has(candidate.run))continue;
      try{this.db.transaction(()=>{
        const e=this.db.get<Incoming>('incoming',String(candidate.seq))!;
        if(e.handled)return;
        const data=e.data;
        const taskId=data.snapshot?.taskId??data.spec?.taskId;
        const t=this.db.get<Task>('tasks',taskId??'');
        if(t&&(t.lastEventSeq??0)<e.seq){
          if(t.spec.runId!==e.run)throw Error('Run identity mismatch');
          this.applyRun(t,data,e.seq);
        }else if(!taskId)throw Error('Missing run snapshot identity');
        e.handled=true;delete e.error;this.db.set('incoming',String(e.seq),e);
      });}catch(err){
        blockedRuns.add(candidate.run);
        this.db.transaction(()=>{const e=this.db.get<Incoming>('incoming',String(candidate.seq))!;if(!e.handled){e.error=(err as Error).message;this.db.set('incoming',String(e.seq),e);}});
      }
    }
  }
  async collect(taskId:string){
    const t=this.task(taskId);if(!t.run?.artifacts)throw Error('No published artifacts');
    const dir=join(this.state,'artifacts',t.spec.runId);mkdirSync(dir,{recursive:true,mode:0o700});
    const verified:Record<string,string>={};
    for(const name of ['report.json','changes.patch'] as const){
      const meta=t.run.artifacts[name];if(!meta||meta.size>(name==='report.json'?MAX_REPORT_BYTES:MAX_ARTIFACT_BYTES))throw Error('Missing or oversized artifact');
      let offset=0;const chunks:Buffer[]=[];
      do{const part=await request(this.target,{type:'artifact',runId:t.spec.runId,name,offset});
        if(part.hash!==meta.hash||part.size!==meta.size||part.offset!==offset)throw Error('Artifact metadata changed');
        const b=Buffer.from(part.data,'base64');if(!b.length&&offset<meta.size)throw Error('Empty artifact chunk');
        offset+=b.length;if(offset>meta.size)throw Error('Artifact size mismatch');chunks.push(b);
      }while(offset<meta.size);
      const data=Buffer.concat(chunks);if(hash(data)!==meta.hash)throw Error('Artifact hash mismatch');
      writeFileSync(join(dir,name),data,{mode:0o600});verified[name]=meta.hash;
    }
    const report=Report.parse(JSON.parse(readFileSync(join(dir,'report.json'),'utf8')));
    assertSize(report,MAX_REPORT_BYTES,'Report');
    this.db.transaction(()=>{const latest=this.task(taskId);
      if(latest.run?.artifacts?.['report.json']?.hash!==verified['report.json']||latest.run?.artifacts?.['changes.patch']?.hash!==verified['changes.patch'])throw Error('Published artifacts changed during collection');
      latest.checked=verified;latest.run.report=report;delete latest.run.reportOmitted;this.db.set('tasks',taskId,latest);
    });
    return {directory:dir,hashes:verified};
  }
  accept(taskId:string,evidence:string[]){return this.db.transaction(()=>{
    const t=this.task(taskId);if(t.cancelRequested||t.status!=='ready'||t.run?.state!=='succeeded')throw Error('Task is not ready for acceptance');
    const parent=this.parentChanges(t);if(parent.stale||parent.paused)throw Error('User task revision changed or is not active; this execution cannot satisfy current requirements');
    if(!t.run.report)throw Error('Collect the full report before acceptance');
    if(t.run.report.unresolved.length||t.run.report.questions?.length)throw Error('Report has unresolved requirements');
    if(evidence.length!==t.spec.acceptance.length||evidence.some(x=>!x.trim()))throw Error('Provide evidence for each acceptance criterion');
    for(const name of ['report.json','changes.patch']){
      const expected=t.run.artifacts?.[name]?.hash;
      if(!expected||t.checked?.[name]!==expected||hash(readFileSync(join(this.state,'artifacts',t.spec.runId,name)))!==expected)throw Error('Artifacts must be retrieved and verified');
    }
    const changes=this.contextChanges(t.spec);
    if(changes.historyMissing)throw Error('Native worker history is incomplete; revalidation in a fresh worker session required');
    if(changes.knowledge.length)throw Error('Referenced knowledge changed in this snapshot or native worker history; fresh worker session and revalidation required');
    if(changes.localOnly.length)throw Error('Task snapshot or native worker history contains local-only context; inspect disclosure before acceptance');
    if(changes.userContext.length||changes.missingRequired.length||changes.requiredSetChanged)throw Error('Required or referenced user context changed; revalidation required');
    t.status='accepted';t.acceptance=evidence;this.db.set('tasks',taskId,t);return t;
  });}
  review(taskId:string,decision:'retain'|'discard',content?:string,discovery?:number,verificationEvidence?:string[]){return this.db.transaction(()=>{
    if(!['retain','discard'].includes(decision))throw Error('Unknown review decision');
    const proof=verificationEvidence===undefined?[]:VerificationEvidence.parse(verificationEvidence);
    if(decision==='discard'&&proof.length)throw Error('Verification evidence requires retaining a discovery');
    const t=this.task(taskId);
    if(!t.run){
      // Older clients wrote no rejection record. Only their specific settled
      // failed/canceled state plus a matching completed start receipt qualifies;
      // timeouts and other uncertain/pending deliveries must stay unresolved.
      t.startRejection??=this.confirmedStartRejection(t);
      if(!t.startRejection)throw Error('Review requires an execution outcome or a confirmed start rejection');
      if(decision!=='discard')throw Error('A rejected start has no worker discoveries to retain; review it with discard');
    }else if(!terminal(t.run.state))throw Error('Review requires an execution outcome');
    if(t.learning!=='pending')throw Error('This outcome has already been reviewed');
    if(decision==='retain'){
      if(!content?.trim()||content.length>16000||discovery===undefined)throw Error('Select a discovery and supply reviewed content (maximum 16000 characters)');
      const source=t.run!.report?.discoveries[discovery];if(!source)throw Error('Discovery is missing');
      const k:Knowledge={id:id(),version:1,content,source:`run:${t.spec.runId}/discovery:${discovery} (${source.source})`,verified:proof.length>0,workerClaimedVerified:source.verified,review:{by:this.owner,at:Date.now()},verification:{status:proof.length?'main-reported':'unverified',evidence:proof},scope:this.scope,active:true};
      this.db.set('knowledge',k.id,k);t.learning='retained:'+k.id;
    }else t.learning='discarded';
    this.db.set('tasks',taskId,t);return t;
  });}
  invalidate(knowledgeId:string,version:number){return this.db.transaction(()=>{
    const k=this.db.get<Knowledge>('knowledge',knowledgeId);if(!k||k.scope!==this.scope||k.version!==version)throw Error('Knowledge scope/version mismatch');
    k.active=false;k.version++;this.db.set('knowledge',k.id,k);
    const tasks=this.tasks(),byRun=new Map(tasks.map(t=>[t.spec.runId,t]));
    return {knowledge:knowledgeProvenance(k),affected:tasks.filter(t=>this.workerHistory(t.spec,byRun).specs.some(s=>s.knowledge.some(r=>r.id===k.id))).map(t=>t.spec.taskId)};
  });}
}
