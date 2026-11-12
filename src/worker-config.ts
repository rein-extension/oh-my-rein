import {z} from 'zod';
import {WorkerPermissions,WorkerPermissionsUpdate,canonical,hash,id} from './protocol.ts';
import type {Binding,Target,Request} from './protocol.ts';
import type {Store} from './db.ts';
import {mergeWorkerPermissions} from './permissions.ts';
import {request,RemoteRejection} from './transport.ts';

const Snapshot=z.object({revision:z.number().int().nonnegative(),permissions:WorkerPermissions,adapter:z.enum(['codex','claude','pi']),epoch:z.guid(),repository:z.string().min(1),updateProtocol:z.literal(1)});
type Update=z.infer<typeof WorkerPermissionsUpdate>;
type ChangeCommand=Extract<Request,{type:'worker-permissions-set'}>;
type Pending={digest:string;command:ChangeCommand;targetId:string;receipt?:unknown;rejection?:string};

export async function readWorkerPermissions(target:Target,project:string){
  const raw=await request(target,{type:'worker-permissions'});
  const parsed=Snapshot.safeParse(raw);
  if(!parsed.success)throw Error('Host does not support conversation-based worker configuration. Update the Host runtime, then query again.');
  const value=parsed.data;
  if(value.permissions.adapter!==value.adapter)throw Error('Host worker configuration identity mismatch');
  return {targetId:hash(canonical({target,epoch:value.epoch,repository:value.repository,adapter:value.adapter})),
    host:target.kind==='ssh'?target.destination:'Local Host',project,repository:value.repository,adapter:value.adapter,epoch:value.epoch,
    revision:value.revision,permissions:value.permissions,scope:'host-project-worker-defaults',appliesTo:'new-worker-sessions',existingSessions:'unchanged',sharedAcrossConversations:true};
}

// Explicit tool retries only. Configuration changes are never added to the
// task outbox or applied later by an unrelated sync/dispatch.
export async function setWorkerPermissions(db:Store,target:Target,project:string,owner:Binding,raw:Update,signal?:AbortSignal){
  signal?.throwIfAborted();
  const input=WorkerPermissionsUpdate.parse(raw),key=hash(canonical({owner,requestKey:input.requestKey})),digest=hash(canonical(input));
  const saved=()=>{
    const record=db.get<Pending>('worker-permission-outbox',key);
    if(record&&record.digest!==digest)throw Error('Worker permission request key content conflict; use the original request or a new key');
    if(record?.rejection&&!record.receipt)throw Error(record.rejection+'; read current permissions and use a new request key if the user still wants a change');
    return record;
  };
  let pending=saved();
  const current=await readWorkerPermissions(target,project);
  signal?.throwIfAborted();
  if(current.targetId!==input.targetId)throw Error('Worker configuration target changed or belongs to another connection; read the intended connection first');
  // An identical invocation may have committed while the Host read was in flight.
  pending=saved();
  if(!pending){
    if(current.revision!==input.expectedRevision)throw Error('Worker permissions changed; read them again before updating');
    const permissions=mergeWorkerPermissions(current.permissions,input.changes);
    const prepared:Pending={digest,targetId:current.targetId,command:{type:'worker-permissions-set',permissions,expectedRevision:input.expectedRevision,change:{id:id(),owner,reason:input.reason,expectedEpoch:current.epoch}}};
    pending=db.transaction(()=>{
      const raced=db.get<Pending>('worker-permission-outbox',key);
      if(raced){if(raced.digest!==digest)throw Error('Worker permission request key content conflict');return raced;}
      db.set('worker-permission-outbox',key,prepared);return prepared;
    });
  }
  if(!pending.receipt){
    signal?.throwIfAborted();
    try{
      const receipt=await request(target,pending.command);
      if(receipt?.id!==pending.command.change!.id||receipt.epoch!==current.epoch||receipt.beforeRevision!==pending.command.expectedRevision||receipt.revision!==pending.command.expectedRevision+1||canonical(receipt.owner)!==canonical(owner)||canonical(receipt.after)!==canonical(pending.command.permissions))throw Error('Host returned an invalid worker configuration receipt');
      db.transaction(()=>{const latest=db.get<Pending>('worker-permission-outbox',key)!;db.set('worker-permission-outbox',key,{...latest,receipt});});
      pending=db.get<Pending>('worker-permission-outbox',key)!;
    }catch(error){
      // Another identical tool call may already have saved the valid receipt.
      pending=db.transaction(()=>{const latest=db.get<Pending>('worker-permission-outbox',key)!;
        if(!latest.receipt&&error instanceof RemoteRejection){latest.rejection=error.message;db.set('worker-permission-outbox',key,latest);}return latest;});
      if(!pending.receipt){
        if(error instanceof RemoteRejection)throw error;
        return {status:'unknown',lastObserved:current,current:null,message:'Delivery was not confirmed. Query current permissions or retry this exact request/key to recover its receipt. Do not infer failure or overwrite newer settings.',error:error instanceof Error?error.message:String(error)};
      }
    }
  }
  try{return {status:'applied',change:pending.receipt,current:await readWorkerPermissions(target,project),approvalRouting:'unchanged'};}
  catch(error){return {status:'applied',change:pending.receipt,current:null,approvalRouting:'unchanged',message:'Host confirmed this change; current settings could not be refreshed. Query again.',error:error instanceof Error?error.message:String(error)};}
}
