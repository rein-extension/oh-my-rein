import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, readSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { Command, HostConfig, canonical, hash, MAX_FRAME, terminal, assertSize, MAX_SPEC_BYTES, id } from './protocol.ts';
import type { Spec, HostSettings, Result } from './protocol.ts';
import { permissionPolicy, permissionPolicyMatches, validatePermissionAnswers, hostConfigDigest, hostConfigMatches, workerPermissions, validateWorkerPermissions, nativeApprovals } from './permissions.ts';
import { runApprovals, decideApproval, finishApprovals } from './approval-store.ts';
import { summarizeApproval } from './approval-operation.ts';
import type { ApprovalSummary } from './approval-operation.ts';
import type { WorkerSession } from './worker-session.ts';

export type Run = {spec:Spec; state:string; workerPermissions?:ReturnType<typeof workerPermissions>; approvals?:ApprovalSummary[]; permissions?:ReturnType<typeof permissionPolicy>; eventSeq?:number; nativeSessionId?:string; pid?:number; workerPid?:number; recovery?:{at:number;reason:string;previousError?:string}; report?:Result; reportOmitted?:boolean; error?:string; created:number; finished?:number; artifacts?:Record<string,{hash:string;size:number}>};
export function alive(pid:number) {try {process.kill(pid,0);return true;} catch(e) {return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
export function readConfig(state:string):HostSettings {return HostConfig.parse(JSON.parse(readFileSync(join(state,'host.json'),'utf8')));}
export class HostPaused extends Error {}
export function updateRun(db:Store, run:Run) {run.eventSeq=db.event(run.spec.runId,run);db.set('runs',run.spec.runId,run);}
// Caller holds a transaction. Publish only the final snapshot, never a terminal
// execution with approvals that still appear to be awaiting native delivery.
export function finalizeRun(db:Store,run:Run){
  db.set('runs',run.spec.runId,run);
  if(!finishApprovals(db,run.spec.runId))updateRun(db,run);
  return db.get<Run>('runs',run.spec.runId)!;
}
// The immutable spec already lives in the Main ledger. Reference its digest
// instead of repeating up to 256 KiB at every transition. Large reports remain
// in their hash-checked artifact and are hydrated by collect(). Also projects old
// persisted events, so upgrading a Host unblocks an existing oversized backlog.
export function eventSummary(run:Run){
  if(!run.spec)return {invalid:'Missing run snapshot'};
  const reportOmitted=!!run.report&&Buffer.byteLength(JSON.stringify(run.report))>128*1024;
  return {snapshot:{taskId:run.spec.taskId,digest:hash(canonical(run.spec))},state:run.state,created:run.created,finished:run.finished,
    permissions:run.permissions,approvals:run.approvals,eventSeq:run.eventSeq,nativeSessionId:run.nativeSessionId,pid:run.pid,workerPid:run.workerPid,artifacts:run.artifacts,error:run.error?.slice(0,4000),
    recovery:run.recovery?{...run.recovery,previousError:run.recovery.previousError?.slice(0,4000)}:undefined,
    ...(reportOmitted?{reportOmitted:true}:{report:run.report})};
}
function inspectSummary(run:Run|undefined){return run?{...eventSummary(run),...(Buffer.byteLength(JSON.stringify(run.spec))<=MAX_SPEC_BYTES?{spec:run.spec}:{specOmitted:true})}:null;}

export class Host {
  shutdownRequested=false;
  db:Store; state:string; config:HostSettings;
  constructor(state:string) {this.state=resolve(state);this.config=readConfig(state);this.db=new Store(state);this.db.transaction(()=>{if(!this.db.get('host','epoch'))this.db.set('host','epoch',id());});this.recoverTerminalApprovals();}
  private defaults(){const saved=this.db.get<{revision:number;permissions:ReturnType<typeof workerPermissions>}>('host','worker-defaults');return {revision:saved?.revision??0,permissions:saved?.permissions??workerPermissions(this.config)};}
  private executionConfig(){const saved=this.db.get<{permissions:ReturnType<typeof workerPermissions>}>('host','worker-defaults');return saved?{...this.config,workerPermissions:saved.permissions}:this.config;}
  handle(raw:unknown):unknown {
    const c=Command.parse(raw);
    if(this.shutdownRequested&&c.type!=='probe')throw new HostPaused('Host is stopping');
    switch(c.type) {
      case 'probe': return {protocol:1, epoch:this.db.get('host','epoch'),adapter:this.config.adapter, permissions:permissionPolicy(this.executionConfig()), approvalRequired:nativeApprovals(this.executionConfig()), concurrency:this.config.concurrency, maintenance:this.db.get<boolean>('host','maintenance')??false, unsettled:this.unsettled().map(r=>({runId:r.spec.runId,state:r.state})), capabilities:{workerPermissions:true,maintenance:true,recovery:true,reconcile:true,wake:false,steer:false,resume:true,questions:true,permissionRequests:true,nativePermissionForwarding:['codex','claude','pi'].includes(this.config.adapter),durable:true,userContext:true,memoryIsolation:this.config.adapter==='fixture'?'fixture-only':'unverified'},repository:this.config.repository};
      case 'worker-permissions': {
        if(c.adapter&&c.adapter!==this.config.adapter)throw Error('Worker adapter does not match this Host connection');
        return {...this.defaults(),adapter:this.config.adapter,epoch:this.db.get('host','epoch'),repository:this.config.repository,updateProtocol:1,appliesTo:'new-worker-sessions',approvalForwarding:['codex','claude','pi'].includes(this.config.adapter)};
      }
      case 'worker-permissions-set': return this.db.transaction(()=>{
        if(c.change){
          if(c.change.expectedEpoch!==this.db.get('host','epoch'))throw Error('Host identity changed; read worker permissions again');
          const previous=this.db.get<{digest:string;receipt:unknown}>('worker-permission-changes',c.change.id);
          if(previous){if(previous.digest!==hash(canonical(c)))throw Error('Conflicting worker permission change');return previous.receipt;}
        }
        const permissions=validateWorkerPermissions(c.permissions),current=this.defaults();
        if(permissions.adapter!==this.config.adapter)throw Error('Worker adapter does not match this Host connection');
        if(c.expectedRevision!==current.revision)throw Error('Worker permissions changed; read them again before updating');
        const previous=this.executionConfig(),frozen={...this.config,workerPermissions:current.permissions};
        for(const session of this.db.list<WorkerSession>('worker-sessions'))if(!session.workerPermissions&&hostConfigMatches(session.configDigest,previous))this.db.set('worker-sessions',session.id,{...session,workerPermissions:current.permissions,configDigest:hostConfigDigest(frozen)});
        for(const run of this.unsettled())if(!run.workerPermissions){
          const expected={...permissionPolicy(previous),...(run.spec.approvalMode?{mode:run.spec.approvalMode}:{})};
          // Do not legitimize an old queued run whose original access no longer
          // matches the Host file. Its runner must still reject that mismatch.
          if(!permissionPolicyMatches(run.permissions,expected))continue;
          run.workerPermissions=current.permissions;this.db.set('runs',run.spec.runId,run);
        }
        this.db.set('host','worker-defaults',{revision:current.revision+1,permissions});
        if(c.change){
          // This records the runtime-bound main's request, not a human UI signature.
          const receipt={id:c.change.id,owner:c.change.owner,reason:c.change.reason,source:'main-request',at:Date.now(),epoch:c.change.expectedEpoch,adapter:this.config.adapter,repository:this.config.repository,
            before:current.permissions,after:permissions,beforeRevision:current.revision,revision:current.revision+1,appliesTo:'new-worker-sessions',existingSessions:'unchanged'};
          this.db.set('worker-permission-changes',c.change.id,{digest:hash(canonical(c)),receipt});return receipt;
        }
        return {...this.defaults(),adapter:this.config.adapter,appliesTo:'new-worker-sessions',existingSessions:'unchanged'};
      });
      case 'approval-list': {const run=this.db.get<Run>('runs',c.runId);if(!run||canonical(run.spec.owner)!==canonical(c.owner))throw Error('Approval execution ownership mismatch');return runApprovals(this.db,c.runId).map(a=>({...a,review:summarizeApproval(a)}));}
      case 'approval-decide': return decideApproval(this.db,this.state,c.receipt);
      case 'maintenance': return this.db.transaction(()=>{this.db.set('host','maintenance',c.enabled);return {maintenance:c.enabled,unsettled:this.unsettled().map(r=>({runId:r.spec.runId,state:r.state}))};});
      case 'shutdown': return this.db.transaction(()=>{
        if(!this.db.get<boolean>('host','maintenance'))throw Error('Drain the Host before stopping it');
        if(this.unsettled().length)throw Error('Host still has queued, active or unknown executions. Wait, cancel, or resolve them before stopping.');
        this.shutdownRequested=true;return {stopping:true};
      });
      case 'resolve': return this.db.transaction(()=>{
        const run=this.db.get<Run>('runs',c.runId);
        if(!run)throw Error('Unknown execution');
        if(run.recovery&&run.state==='canceled')return inspectSummary(run);
        if(run.state!=='unknown')throw Error('Only an unknown execution can be resolved');
        if(run.pid&&alive(run.pid))throw Error('Runner process is still alive; inspect and stop it first');
        if(run.workerPid&&(alive(run.workerPid)||alive(-run.workerPid)))throw Error('Worker process group is still alive; inspect and stop it first');
        run.recovery={at:Date.now(),reason:c.reason,previousError:run.error};
        run.state='canceled';run.finished=Date.now();run.error='Manually resolved as stopped; external effects require review. '+c.reason;
        this.db.set('cancels',c.runId,{at:Date.now(),reason:c.reason});
        return inspectSummary(finalizeRun(this.db,run));
      });
      case 'start': return this.db.transaction(()=>{
        assertSize(c.spec,MAX_SPEC_BYTES,'Task snapshot');
        const digest=hash(canonical(c.spec));
        const prior=this.db.get<{digest:string;runId:string}>('dedup',c.key);
        if(prior){if(prior.digest!==digest)throw Error('Idempotency key content conflict');return inspectSummary(this.db.get<Run>('runs',prior.runId));}
        if(this.db.get<boolean>('host','maintenance'))throw new HostPaused('Host is draining; new executions are paused');
        if(this.db.get('cancels',c.spec.runId))throw Error('Run has a cancellation tombstone');
        if(this.db.get('runs',c.spec.runId))throw Error('Run ID already exists with another key');
        let executionConfig=this.executionConfig();
        if(c.spec.worker){
          const turn=c.spec.worker,session=this.db.get<WorkerSession>('worker-sessions',turn.sessionId);
          if(session?.workerPermissions)executionConfig={...this.config,workerPermissions:session.workerPermissions};
          const configDigest=hostConfigDigest(executionConfig);
          if(turn.turn===1){
            if(session||turn.previousRunId||turn.message||turn.answers?.length)throw Error('Invalid initial worker session');
            this.db.set('worker-sessions',turn.sessionId,{id:turn.sessionId,owner:c.spec.owner,taskKey:c.spec.taskKey,baseCommit:c.spec.baseCommit,adapter:this.config.adapter,configDigest,latestRunId:c.spec.runId,turn:1,...(executionConfig.workerPermissions?{workerPermissions:executionConfig.workerPermissions}:{})} satisfies WorkerSession);
          }else{
            if(!session||session.latestRunId!==turn.previousRunId||session.turn+1!==turn.turn)throw Error('Worker session turn conflict; reload its latest execution');
            if(canonical(session.owner)!==canonical(c.spec.owner)||session.taskKey!==c.spec.taskKey||session.baseCommit!==c.spec.baseCommit||!hostConfigMatches(session.configDigest,executionConfig))throw Error('Worker session scope or Host configuration changed');
            const previous=this.db.get<Run>('runs',session.latestRunId);
            if(!previous||!['succeeded','waiting_input','waiting_permission'].includes(previous.state)||!session.nativeId||this.db.get('cancels',session.latestRunId))throw Error('Previous worker turn must be safely completed before resume');
            const questions=previous.report?.questions??[],answers=turn.answers??[];
            if(answers.length!==questions.length||new Set(answers.map(a=>a.questionId)).size!==answers.length||questions.some(q=>!answers.some(a=>a.questionId===q.id)))throw Error('Answer every pending question exactly once');
            validatePermissionAnswers(previous.permissions??permissionPolicy(this.config),questions,answers);
            session.configDigest=configDigest;session.latestRunId=c.spec.runId;session.turn=turn.turn;this.db.set('worker-sessions',session.id,session);
          }
        }
        const permissions=permissionPolicy(executionConfig);
        if(c.spec.approvalMode)permissions.mode=c.spec.approvalMode;
        const run:Run={spec:c.spec,state:'prepared',permissions,...(executionConfig.workerPermissions?{workerPermissions:executionConfig.workerPermissions}:{}),created:Date.now()};
        updateRun(this.db,run);this.db.set('dedup',c.key,{digest,runId:c.spec.runId});return inspectSummary(run);
      });
      case 'cancel': return this.db.transaction(()=>{
        this.db.set('cancels',c.runId,{at:Date.now()});
        const run=this.db.get<Run>('runs',c.runId);
        if(run?.state==='prepared'){run.state='canceled';run.finished=Date.now();updateRun(this.db,run);}
        return {cancelRequested:true, confirmed:!run||['canceled','succeeded','waiting_input','waiting_permission','failed'].includes(run.state),state:run?.state??'not-started',alreadyFinished:!!run&&['succeeded','waiting_input','waiting_permission','failed'].includes(run.state)};
      });
      case 'inspect': return inspectSummary(this.db.get<Run>('runs',c.runId));
      case 'reconcile': return this.db.transaction(()=>({epoch:this.db.get('host','epoch'),cursor:this.db.eventCursor(),runs:c.runIds.map(runId=>{const run=this.db.get<Run>('runs',runId);return {runId,data:run?eventSummary(run):null};})}));
      case 'events': return c.page?{...this.db.eventPage(c.after,eventSummary),epoch:this.db.get('host','epoch'),head:this.db.eventCursor()}:this.db.eventPage(c.after).events;
      case 'artifact': {
        const run=this.db.get<Run>('runs',c.runId), meta=run?.artifacts?.[c.name];
        if(!meta)throw Error('Artifact not published');
        const file=join(this.state,'runs',c.runId,c.name), fd=openSync(file,'r');
        try {const total=statSync(file).size;if(c.offset>total)throw Error('Invalid offset');
          const b=Buffer.alloc(Math.min(64*1024,total-c.offset));const count=readSync(fd,b,0,b.length,c.offset);
          return {...meta,offset:c.offset,data:b.subarray(0,count).toString('base64'),done:c.offset+count===total};
        }finally{closeSync(fd);}
      }
    }
  }
  unsettled(){return this.db.runsIn<Run>(['prepared','starting','running','awaiting_approval','unknown']);}
  private recoverTerminalApprovals(){
    for(const runId of this.db.openApprovalRunIds())this.db.transaction(()=>{
      const run=this.db.get<Run>('runs',runId);
      if(!run||!terminal(run.state)||(run.pid&&alive(run.pid)))return;
      // Older runners could commit their terminal state before approval cleanup.
      // Do not claim stopped execution if a surviving worker group is observed.
      if(run.workerPid&&(alive(run.workerPid)||alive(-run.workerPid))){run.state='unknown';run.error='Worker survived terminal execution; inspect and stop it before recovery';}
      finalizeRun(this.db,run);
    });
  }
  tick() {
    this.recoverTerminalApprovals();
    const runs=this.unsettled();
    for(const run of runs) if(['starting','running','awaiting_approval'].includes(run.state) && run.pid && !alive(run.pid)) {
      this.db.transaction(()=>{const latest=this.db.get<Run>('runs',run.spec.runId)!;
        if(!terminal(latest.state)){latest.state='unknown';latest.error='Runner exited without confirmed result; inspect workspace and external effects before retry';finalizeRun(this.db,latest);}});
    }
    let active=runs.filter(r=>['starting','running','awaiting_approval','unknown'].includes(r.state)).length;
    for(const queued of runs.filter(r=>r.state==='prepared')) {
      if(active>=this.config.concurrency)break;
      this.db.transaction(()=>{
        const run=this.db.get<Run>('runs',queued.spec.runId)!;
        if(run.state!=='prepared')return;
        if(this.db.get('cancels',run.spec.runId)){run.state='canceled';updateRun(this.db,run);return;}
        run.state='starting';updateRun(this.db,run);
        const root=join(this.state,'runs',run.spec.runId);mkdirSync(root,{recursive:true,mode:0o700});
        const log=openSync(join(root,'runner.log'),'a',0o600);
        try {
          const child=spawn(process.execPath,[fileURLToPath(new URL('./runner.ts',import.meta.url)),this.state,run.spec.runId],{detached:true,stdio:['ignore',log,log]});
          run.pid=child.pid;this.db.set('runs',run.spec.runId,run);
          child.on('error',e=>{this.db.transaction(()=>{const r=this.db.get<Run>('runs',run.spec.runId)!;r.state='unknown';r.error=e.message;updateRun(this.db,r);});});child.unref();active++;
        }finally{closeSync(log);}
      });
    }
  }
}

export async function serve(state:string) {
  state=resolve(state);mkdirSync(state,{recursive:true,mode:0o700});
  const lock=join(state,'host.pid'),socket=join(state,'host.sock');
  const host=new Host(state);
  // Claim in the same local SQLite transaction used by other supervisors: stale-file
  // unlink followed by exclusive create is not safe when two restarts race.
  host.db.transaction(()=>{
    if(existsSync(join(state,'pending-installation.json')))throw Error('Interrupted Host update: rerun setup --update before starting');
    host.config=readConfig(state);
    const owner=host.db.get<{pid:number}>('supervisor','owner');
    if(owner&&owner.pid>0&&alive(owner.pid))throw Error('Host lock is active; refusing another supervisor');
    host.db.set('supervisor','owner',{pid:process.pid});
  });
  writeFileSync(lock,String(process.pid),{mode:0o600});
  try {unlinkSync(socket);} catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  // A crash between persistence and spawn cannot safely be interpreted as no execution.
  host.db.transaction(()=>{for(const r of host.db.list<Run>('runs')) if(r.state==='starting'&&!r.pid){r.state='unknown';r.error='Uncertain launch after restart';updateRun(host.db,r);}});
  const server=createServer(s=>{
    let buf='',handled=false;s.setTimeout(15000,()=>s.destroy());
    s.on('error',()=>{});
    s.setEncoding('utf8');
    s.on('data',data=>{if(handled)return;buf+=data.toString();if(Buffer.byteLength(buf)>MAX_FRAME){s.destroy();return;}
      if(!buf.includes('\n'))return;
      handled=true;
      try{s.end(JSON.stringify({ok:true,value:host.handle(JSON.parse(buf.slice(0,buf.indexOf('\n'))))})+'\n');}
      catch(e){s.end(JSON.stringify({ok:false,rejected:!(e instanceof HostPaused)&&!(e as NodeJS.ErrnoException).code?.includes('SQLITE'),error:(e as Error).message})+'\n');}
    });
  });
  await new Promise<void>((res,rej)=>{server.once('error',rej);server.listen(socket,res);});chmodSync(socket,0o600);
  let stopping=false;
  const timer=setInterval(()=>{try{if(host.shutdownRequested){stop();return;}host.tick();}catch(e){console.error(e);}},100);host.tick();
  const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);server.close(()=>{
    host.db.transaction(()=>{if(host.db.get<{pid:number}>('supervisor','owner')?.pid===process.pid)host.db.set('supervisor','owner',{pid:0});});
    host.db.close();try{unlinkSync(lock);}catch{} process.exit(0);
  });};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return {host,server,timer};
}
