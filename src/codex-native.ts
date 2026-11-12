import { z } from 'zod';
import { Report, MAX_FRAME } from './protocol.ts';
import type { Store } from './db.ts';
import type { Run } from './host.ts';
import { updateRun } from './host.ts';
import { createApproval, saveApproval, runApprovals, delegateMayAllow } from './approval-store.ts';
import type { Approval } from './approval-store.ts';

// One app-server connection and one native turn. Native request IDs never leave
// this process as a replayable capability; durable approvals bind their contents.
export class CodexNative {
  buffer='';next=0;threadId?:string;turnId?:string;report?:unknown;done=false;
  pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  items=new Map<string,any>();gates=new Map<string,{rpcId:string|number;itemId:string}>();
  requests=new Set<string>();
  result:Promise<{threadId:string;report:ReturnType<typeof Report.parse>}>;
  private succeed!:(r:{threadId:string;report:ReturnType<typeof Report.parse>})=>void;
  private fail!:(e:Error)=>void;
  timer:ReturnType<typeof setInterval>;
  private db:Store;private runId:string;private workspace:string;private send:(m:unknown)=>void;
  private inspectRequest:(data:string)=>void;
  constructor(db:Store,runId:string,workspace:string,send:(m:unknown)=>void,inspectRequest:(data:string)=>void=()=>{}){
    this.db=db;this.runId=runId;this.workspace=workspace;this.send=send;
    this.inspectRequest=inspectRequest;
    this.result=new Promise((res,rej)=>{this.succeed=res;this.fail=rej;});
    this.timer=setInterval(()=>{try{this.deliver();}catch(e){this.abort(e as Error);}},100);
  }
  call(method:string,params:unknown):Promise<any>{
    const id=++this.next;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.send({id,method,params});});
  }
  async start(prompt:string,schema:unknown,previous?:string,model?:string){
    try{
      await this.call('initialize',{clientInfo:{name:'oh_my_rein',version:'0.1.0-beta.1'}});
      this.send({method:'initialized',params:{}});
      const policy=this.db.get<Run>('runs',this.runId)?.permissions;
      if(!policy||!['ask','delegate'].includes(policy.mode))throw Error('Native approval requires a frozen interactive permission policy');
      const config={cwd:this.workspace,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:policy.sandbox,...(model?{model}:{}),config:{'features.memories':false,'features.shell_snapshot':false,'sandbox_workspace_write.network_access':false,'sandbox_workspace_write.writable_roots':[]}};
      const response=await this.call(previous?'thread/resume':'thread/start',previous?{...config,threadId:previous}:config);
      this.threadId=z.guid().parse(response.thread?.id);
      if(previous&&previous!==this.threadId)throw Error('Native worker resumed another thread');
      this.db.transaction(()=>{const run=this.db.get<Run>('runs',this.runId)!;run.nativeSessionId=this.threadId;updateRun(this.db,run);});
      const started=await this.call('turn/start',{threadId:this.threadId,input:[{type:'text',text:prompt}],outputSchema:schema});
      if(this.turnId&&this.turnId!==started.turn?.id)throw Error('Native turn identity mismatch');
      this.turnId=z.string().min(1).parse(started.turn?.id);
    }catch(e){this.abort(e as Error);}
  }
  feed(text:string){
    if(this.done)return;
    this.buffer+=text;
    try{
      let index:number;
      while((index=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
        if(Buffer.byteLength(line)>MAX_FRAME)throw Error('Native protocol frame too large');
        if(line.trim())this.receive(JSON.parse(line));
      }
      if(Buffer.byteLength(this.buffer)>MAX_FRAME)throw Error('Native protocol frame too large');
    }catch(e){this.abort(e as Error);}
  }
  private receive(m:any){
    if(m.id!==undefined&&!m.method){
      const pending=this.pending.get(m.id);if(!pending)return;
      this.pending.delete(m.id);m.error?pending.reject(Error(m.error.message??'Native protocol error')):pending.resolve(m.result);return;
    }
    const p=m.params??{};
    if(m.id!==undefined){this.approval(m.id,m.method,p);return;}
    if(p.threadId!==this.threadId)return;
    if(m.method==='turn/started'){
      if(this.turnId&&this.turnId!==p.turn?.id)throw Error('Unexpected native turn');this.turnId=p.turn?.id;
    }
    if(p.turnId&&this.turnId&&p.turnId!==this.turnId)return;
    if(m.method==='item/started')this.items.set(p.item?.id,p.item);
    if(m.method==='item/completed'){
      const item=p.item;
      if(item?.type==='agentMessage'&&(item.phase==='final_answer'||!item.phase))this.report=item.text;
      this.db.transaction(()=>{
        for(const a of runApprovals(this.db,this.runId))if(a.params.itemId===item?.id&&a.state==='responding'){
          a.state='resolved';a.result=String(item.status??'completed');saveApproval(this.db,a);
        }
      });
    }
    if(m.method==='turn/completed'){
      if(this.turnId&&p.turn?.id!==this.turnId)return;
      if(p.turn?.status!=='completed')throw Error(p.turn?.error?.message??'Native turn did not complete');
      if(this.gates.size||runApprovals(this.db,this.runId).some(a=>['pending','approved','denied','responding'].includes(a.state)))throw Error('Native turn ended without resolving its approval operations; inspect effects');
      if(typeof this.report!=='string')throw Error('Native worker returned no final report');
      const report=Report.parse(JSON.parse(this.report));this.done=true;clearInterval(this.timer);this.succeed({threadId:this.threadId!,report});
    }
  }
  private approval(rpcId:string|number,method:string,p:Record<string,any>){
    const requestKey=JSON.stringify(rpcId);
    if(this.requests.has(requestKey))throw Error('Duplicate native approval request ID');
    this.requests.add(requestKey);
    if((p.threadId!==undefined&&p.threadId!==this.threadId)||(p.turnId!==undefined&&p.turnId!==this.turnId))throw Error('Native approval identity mismatch');
    const unsupported=(reason:string)=>{
      const item=this.items.get(p.itemId);
      this.inspectRequest(JSON.stringify({method,params:p,item}));
      createApproval(this.db,this.runId,method,p,this.workspace,item,reason);
    };
    if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
      // Broad/session permission grants and unknown request types are never approved.
      unsupported('Unsupported native request type: '+String(method).slice(0,160));
      this.send(method==='item/permissions/requestApproval'?{id:rpcId,result:{permissions:{},scope:'turn'}}:{id:rpcId,error:{code:-32601,message:'Rein does not support this native request; no authorization granted'}});return;
    }
    if(p.threadId!==this.threadId||!p.turnId||!this.turnId||p.turnId!==this.turnId||typeof p.itemId!=='string')throw Error('Native approval identity mismatch');
    const item=this.items.get(p.itemId);
    if(p.grantRoot||p.networkApprovalContext||(p.kind&&p.kind!=='command')||(method.includes('commandExecution')&&typeof p.command!=='string')||(method.includes('fileChange')&&(!item?.changes||!Array.isArray(item.changes)))){
      unsupported(p.grantRoot?'Session-wide file grants are not supported':p.networkApprovalContext?'Managed network approvals are not supported':p.kind&&p.kind!=='command'?'This native action kind is not supported':'Required native operation details are missing');
      this.send({id:rpcId,result:{decision:'decline'}});return;
    }
    this.inspectRequest(JSON.stringify({method,params:p,item}));
    const a=createApproval(this.db,this.runId,method,p,this.workspace,item);
    this.gates.set(a.id,{rpcId,itemId:p.itemId});
  }
  private deliver(){
    if(this.done)return;
    for(const [id,gate] of this.gates){
      let ready:Approval|undefined;
      this.db.transaction(()=>{
        const a=this.db.get<Approval>('approvals',id)!;
        const run=this.db.get<Run>('runs',this.runId)!;
        if(this.db.get('cancels',this.runId)||!['running','awaiting_approval'].includes(run.state)){a.state='canceled';saveApproval(this.db,a);ready=a;return;}
        if(a.state==='pending'&&Date.now()>a.expiresAt){a.state='expired';saveApproval(this.db,a);ready=a;return;}
        if(a.state==='approved'||a.state==='denied'){
          if(a.decision?.actor==='main'&&a.decision.allow&&!delegateMayAllow(a)){
            a.state='canceled';a.error='This request no longer supports a delegated decision';saveApproval(this.db,a);ready=a;return;
          }
          // Persist before sending: a crash now is uncertain, never automatically replayed.
          a.state='responding';saveApproval(this.db,a);ready=a;
        }
      });
      if(!ready)continue;
      this.send({id:gate.rpcId,result:{decision:ready.state==='responding'&&ready.decision?.allow?'accept':'decline'}});
      this.gates.delete(id);
    }
    if(!this.gates.size){
      this.db.transaction(()=>{const run=this.db.get<Run>('runs',this.runId)!;if(run.state==='awaiting_approval'){run.state='running';updateRun(this.db,run);}});
    }
  }
  abort(error:Error){
    if(this.done)return;this.done=true;clearInterval(this.timer);
    for(const p of this.pending.values())p.reject(error);this.pending.clear();this.fail(error);
  }
}
