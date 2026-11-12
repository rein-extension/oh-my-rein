import { verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, hash, id, Owner, PermissionPolicy } from './protocol.ts';
import type { Store } from './db.ts';
import type { Run } from './host.ts';
import { updateRun } from './host.ts';
import { delegateMayAllow, summarizeApproval } from './approval-operation.ts';
import type { ApprovalSummary } from './approval-operation.ts';
export { delegateMayAllow } from './approval-operation.ts';

export const ApprovalDecision=z.object({
  requestId:z.guid(),requestHash:z.string().length(64),runId:z.guid(),owner:Owner,
  allow:z.boolean(),actor:z.enum(['user','main']),reason:z.string().trim().min(1).max(2000),
}).strict();
export const SignedApproval=z.object({payload:ApprovalDecision,keyId:z.string().length(64),signature:z.string().max(200)}).strict();
export type Approval={id:string;runId:string;owner:z.infer<typeof Owner>;requestHash:string;policy:z.infer<typeof PermissionPolicy>;
  review?:ApprovalSummary;
  task:{id:string;goal:string;taskKey?:string};
  method:string;params:Record<string,any>;item?:Record<string,any>;workspace:string;created:number;expiresAt:number;
  state:'pending'|'approved'|'denied'|'responding'|'resolved'|'canceled'|'expired'|'unknown'|'unsupported';
  decision?:z.infer<typeof ApprovalDecision>;decisionKey?:string;result?:string;error?:string};
export const openApproval=(a:Approval)=>['pending','approved','denied','responding'].includes(a.state);
export function runApprovals(db:Store,runId:string){return db.list<Approval>('approvals').filter(a=>a.runId===runId);}
export function saveApproval(db:Store,a:Approval){
  db.set('approvals',a.id,a);
  const run=db.get<Run>('runs',a.runId)!;
  run.approvals=runApprovals(db,a.runId).filter(x=>openApproval(x)||x.state==='unknown'||x.state==='unsupported').map(summarizeApproval);
  updateRun(db,run);
}
export function createApproval(db:Store,runId:string,method:string,params:Record<string,any>,workspace:string,item?:Record<string,any>,unsupportedReason?:string){
  if(Buffer.byteLength(JSON.stringify({params,item}))>96*1024)throw Error('Native approval too large to display safely');
  return db.transaction(()=>{
    const run=db.get<Run>('runs',runId)!;
    if(!run.permissions||!['running','awaiting_approval'].includes(run.state)||db.get('cancels',runId))throw Error('Execution cannot request approval');
    const previous=runApprovals(db,runId);
    if(previous.length>=100||Buffer.byteLength(JSON.stringify(previous))+Buffer.byteLength(JSON.stringify({params,item}))+8000*(previous.length+1)>1024*1024)throw Error('Execution approval limit reached');
    const requestId=id(),created=Date.now();
    const binding={id:requestId,runId,owner:run.spec.owner,task:{id:run.spec.taskId,goal:run.spec.goal,taskKey:run.spec.taskKey},policy:run.permissions,method,params,item,workspace};
    const a:Approval={...binding,requestHash:hash(canonical(binding)),created,expiresAt:created+30*60*1000,state:unsupportedReason?'unsupported':'pending',...(unsupportedReason?{error:unsupportedReason,result:'not-granted'}:{})};
    if(!unsupportedReason)run.state='awaiting_approval';
    db.set('runs',runId,run);saveApproval(db,a);return a;
  });
}
export function decideApproval(db:Store,state:string,raw:unknown){
  const signed=SignedApproval.parse(raw),p=signed.payload;
  return db.transaction(()=>{
    const a=db.get<Approval>('approvals',p.requestId);
    if(!a||a.runId!==p.runId||a.requestHash!==p.requestHash||canonical(a.owner)!==canonical(p.owner))throw Error('Approval does not match the exact request');
    const keys=JSON.parse(readFileSync(join(state,'approval-keys.json'),'utf8')) as Record<string,{publicKey:string;instance:string}>;
    const key=keys[signed.keyId];
    if(!key||key.instance!==a.owner.instance||!verify(null,Buffer.from(canonical(p)),key.publicKey,Buffer.from(signed.signature,'base64')))throw Error('Invalid approval authority');
    if(a.decision){if(canonical(a.decision)!==canonical(p))throw Error('Conflicting approval decision');return a;}
    const run=db.get<Run>('runs',a.runId)!;
    if(a.state!=='pending'||Date.now()>a.expiresAt||db.get('cancels',a.runId)||!['running','awaiting_approval'].includes(run.state))throw Error('Approval request is no longer actionable');
    if(a.policy.mode==='ask'&&p.actor!=='user')throw Error('This request requires a real user interaction');
    if(p.actor==='main'&&(a.policy.mode!=='delegate'||(p.allow&&!delegateMayAllow(a))))throw Error('This request does not support a main-agent decision');
    if(p.allow&&a.policy.mode==='read-only')throw Error('Read-only executions cannot be granted additional access');
    a.decision=p;a.decisionKey=signed.keyId;a.state=p.allow?'approved':'denied';saveApproval(db,a);return a;
  });
}
export function finishApprovals(db:Store,runId:string){
  const approvals=runApprovals(db,runId),open=approvals.filter(openApproval);
  for(const a of open){
    if(a.state==='responding'&&a.decision?.allow===false){
      a.state='resolved';a.result='not-granted';a.error='Decline delivery was not confirmed; no authorization was granted';
    }else{
      a.state=a.state==='responding'?'unknown':'canceled';a.error='Native invocation ended; never replay this approval into another invocation';
    }
    db.set('approvals',a.id,a);
  }
  if(open.length){
    const run=db.get<Run>('runs',runId)!;
    run.approvals=approvals.filter(a=>a.state==='unknown'||a.state==='unsupported').map(summarizeApproval);
    updateRun(db,run);
  }
  return open.length>0;
}
