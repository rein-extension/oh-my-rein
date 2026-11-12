import { z } from 'zod';
import { MAX_FRAME, Report } from './protocol.ts';
import type { Store } from './db.ts';
import type { Run } from './host.ts';
import { updateRun } from './host.ts';
import { createApproval, saveApproval, runApprovals, delegateMayAllow } from './approval-store.ts';
import type { Approval } from './approval-store.ts';

const ToolRequest=z.object({toolName:z.string().min(1),toolCallId:z.string().min(1),input:z.record(z.string(),z.unknown()),cwd:z.string().min(1)});
type Gate={nativeId:string;toolId:string;respond:(allow:boolean)=>void};

// One invocation owns its native callbacks. Only the signed, durable Rein
// decision crosses the transport; a callback is never replayed into a new process.
export class ToolNative {
  result:Promise<{threadId:string;report:ReturnType<typeof Report.parse>}>;
  private succeed!:(value:{threadId:string;report:ReturnType<typeof Report.parse>})=>void;
  private fail!:(error:Error)=>void;
  private buffer='';private done=false;private initialized=false;private started=false;
  private sessionId?:string;private expected?:string;private readySession?:string;private prompt='';private report?:unknown;
  private timer:ReturnType<typeof setInterval>;private deadline=Date.now()+30000;
  private gates=new Map<string,Gate>();private seen=new Set<string>();
  private db:Store;private runId:string;private workspace:string;private adapter:'claude'|'pi';
  private send:(message:unknown)=>void;private inspect:(data:string)=>void;
  constructor(db:Store,runId:string,workspace:string,adapter:'claude'|'pi',send:(message:unknown)=>void,inspect:(data:string)=>void=()=>{}){
    this.db=db;this.runId=runId;this.workspace=workspace;this.adapter=adapter;this.send=send;this.inspect=inspect;
    this.result=new Promise((resolve,reject)=>{this.succeed=resolve;this.fail=reject;});
    this.timer=setInterval(()=>{try{if(!this.started&&Date.now()>this.deadline)throw Error('Native permission bridge initialization timed out');this.deliver();}catch(e){this.abort(e as Error);}},100);
  }
  async start(prompt:string,_schema:unknown,expected?:string){
    try{
      this.prompt=prompt;this.expected=expected;
      const policy=this.db.get<Run>('runs',this.runId)?.permissions;
      if(!policy||!['ask','delegate'].includes(policy.mode)||policy.worker?.adapter!==this.adapter)throw Error('Interactive worker requires explicit frozen native permissions');
      if(this.adapter==='claude')this.send({type:'control_request',request_id:'rein:init',request:{subtype:'initialize',hooks:{
        PostToolUse:[{matcher:'',hookCallbackIds:['rein:post'],timeout:10}],
        PostToolUseFailure:[{matcher:'',hookCallbackIds:['rein:failure'],timeout:10}],
      }}});
      else this.send({id:'rein:state',type:'get_state'});
    }catch(e){this.abort(e as Error);}
  }
  feed(text:string){
    if(this.done)return;this.buffer+=text;
    try{
      let end:number;
      while(!this.done&&(end=this.buffer.indexOf('\n'))>=0){
        const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
        if(Buffer.byteLength(line)>MAX_FRAME)throw Error('Native protocol frame too large');
        if(line.trim()){const value=JSON.parse(line);this.adapter==='claude'?this.claude(value):this.pi(value);}
      }
      if(Buffer.byteLength(this.buffer)>MAX_FRAME)throw Error('Native protocol frame too large');
    }catch(e){this.abort(e as Error);}
  }
  private session(value:unknown){
    const sessionId=z.guid().parse(value);
    if((this.expected&&sessionId!==this.expected)||(this.sessionId&&this.sessionId!==sessionId))throw Error('Native worker session identity mismatch');
    this.sessionId=sessionId;
    this.db.transaction(()=>{const run=this.db.get<Run>('runs',this.runId)!;run.nativeSessionId=sessionId;updateRun(this.db,run);});
  }
  private answer(id:string,response:unknown){this.send({type:'control_response',response:{subtype:'success',request_id:id,response}});}
  private request(nativeId:unknown,raw:unknown,respond:(allow:boolean)=>void,details?:unknown){
    const key=z.string().min(1).parse(nativeId);
    if(this.seen.has(key))throw Error('Duplicate native approval request ID');this.seen.add(key);
    if(!this.sessionId||!this.started)throw Error('Approval arrived before native session initialization');
    const data=ToolRequest.parse(raw),policy=this.db.get<Run>('runs',this.runId)!.permissions!;
    const worker=policy.worker;
    this.inspect(JSON.stringify({data,details}));
    const supported=worker&&worker.adapter===this.adapter&&worker.tools.includes(data.toolName as never);
    const a=createApproval(this.db,this.runId,this.adapter+'/tool/requestApproval',{...data,...(details?{nativeDetails:details}:{})},this.workspace,undefined,supported?undefined:'Tool is outside the frozen worker tool list');
    if(!supported){respond(false);return;}
    this.gates.set(a.id,{nativeId:key,toolId:data.toolCallId,respond});
  }
  private completeTool(toolId:unknown,failed:boolean){
    if(typeof toolId!=='string')return;
    this.db.transaction(()=>{
      for(const a of runApprovals(this.db,this.runId))if(a.params.toolCallId===toolId&&a.state==='responding'){
        a.state='resolved';a.result=a.decision?.allow===false?'not-granted':failed?'failed':'completed';saveApproval(this.db,a);
      }
    });
  }
  private withdraw(nativeId:unknown){
    for(const [id,gate] of this.gates)if(gate.nativeId===nativeId){
      this.db.transaction(()=>{const a=this.db.get<Approval>('approvals',id)!;a.state='canceled';a.error='Native invocation withdrew its request';saveApproval(this.db,a);});
      this.gates.delete(id);
    }
  }
  private claude(m:any){
    if(m.type==='control_response'&&m.response?.request_id==='rein:init'){
      if(this.initialized||m.response.subtype!=='success')throw Error('Claude permission bridge initialization failed');
      this.initialized=true;this.started=true;
      this.send({type:'user',session_id:this.expected??'',message:{role:'user',content:this.prompt},parent_tool_use_id:null});return;
    }
    if(m.type==='system'&&m.subtype==='init'){this.session(m.session_id);return;}
    if(m.session_id&&this.sessionId&&m.session_id!==this.sessionId)throw Error('Claude message session identity mismatch');
    if(m.type==='control_cancel_request'){this.withdraw(m.request_id);return;}
    if(m.type==='control_request'){
      const id=z.string().min(1).parse(m.request_id),p=m.request;
      if(p?.subtype==='can_use_tool'){
        const input=z.record(z.string(),z.unknown()).parse(p.input);
        this.request(id,{toolName:p.tool_name,toolCallId:p.tool_use_id,input,cwd:this.workspace},allow=>this.answer(id,allow?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'This operation was not approved. Do not retry it to bypass review.'}),p);
      }else if(p?.subtype==='hook_callback'&&['rein:post','rein:failure'].includes(p.callback_id)){
        this.completeTool(p.tool_use_id??p.input?.tool_use_id,p.callback_id==='rein:failure');this.answer(id,{});
      }else{
        this.inspect(JSON.stringify(m));
        createApproval(this.db,this.runId,'claude/control/unsupported',p??{},this.workspace,undefined,'Unsupported Claude control request');
        this.send({type:'control_response',response:{subtype:'error',request_id:id,error:'Unsupported Rein control request; no permission granted'}});
      }return;
    }
    if(m.type==='user')for(const part of Array.isArray(m.message?.content)?m.message.content:[])if(part.type==='tool_result')this.completeTool(part.tool_use_id,part.is_error===true);
    if(m.type==='result'){
      this.session(m.session_id);
      if(m.subtype!=='success'||m.is_error)throw Error('Claude native turn failed: '+String(m.errors?.join('; ')??m.result??m.subtype).slice(0,2000));
      this.finish(m.structured_output??m.result);
    }
  }
  private beginPi(){
    if(this.sessionId&&this.readySession&&this.readySession!==this.sessionId)throw Error('Pi permission extension session identity mismatch');
    if(!this.started&&this.initialized&&this.sessionId&&this.readySession===this.sessionId){this.started=true;this.send({id:'rein:prompt',type:'prompt',message:this.prompt});}
  }
  private pi(m:any){
    if(m.type==='response'){
      if(m.success!==true)throw Error('Pi RPC request failed: '+String(m.error).slice(0,2000));
      if(m.id==='rein:state'){if(this.initialized)throw Error('Duplicate Pi initialization');this.session(m.data?.sessionId);this.initialized=true;this.beginPi();}
      if(m.id==='rein:prompt'&&m.data?.disposition&&m.data.disposition!=='started')throw Error('Pi did not start the requested native turn');
      return;
    }
    if(m.type==='extension_error')throw Error('Pi worker permission extension failed: '+String(m.error).slice(0,2000));
    if(m.type==='extension_ui_request'){
      if(m.method==='notify'&&m.message?.startsWith('rein-ready:')){
        const ready=JSON.parse(m.message.slice('rein-ready:'.length));
        if(this.readySession||ready.version!==1)throw Error('Pi permission extension identity mismatch');
        this.readySession=z.guid().parse(ready.sessionId);this.beginPi();return;
      }
      if(m.method==='confirm'&&m.title==='Rein tool approval'){
        const data=JSON.parse(m.message);
        if(data.protocol!=='rein-tool-v1'||data.sessionId!==this.sessionId)throw Error('Pi approval session identity mismatch');
        this.request(m.id,data,allow=>this.send({type:'extension_ui_response',id:m.id,confirmed:allow}));return;
      }
      this.inspect(JSON.stringify(m));
      createApproval(this.db,this.runId,'pi/ui/unsupported',m,this.workspace,undefined,'Unsupported Pi extension interaction');
      this.send({type:'extension_ui_response',id:m.id,cancelled:true});return;
    }
    if(m.type==='tool_execution_end')this.completeTool(m.toolCallId,m.isError===true);
    if(m.type==='message_end'&&m.message?.role==='assistant'){
      if(m.message.stopReason==='stop')this.report=m.message.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n');
      else this.report=undefined;
    }
    if(m.type==='agent_settled'){
      if(m.aborted||!this.started||!this.report)throw Error('Pi did not finish with a complete report');
      this.finish(this.report);
    }
  }
  private finish(raw:unknown){
    if(!this.sessionId||!this.initialized||!this.started)throw Error('Native session initialization missing');
    if(this.gates.size||runApprovals(this.db,this.runId).some(a=>['pending','approved','denied','responding','unknown'].includes(a.state)))throw Error('Native turn ended with unconfirmed operations; inspect effects');
    const report=Report.parse(typeof raw==='string'?JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1')):raw);
    this.done=true;clearInterval(this.timer);this.succeed({threadId:this.sessionId,report});
  }
  private deliver(){
    if(this.done)return;
    for(const [id,gate] of this.gates){
      let decision:boolean|undefined;
      this.db.transaction(()=>{
        const a=this.db.get<Approval>('approvals',id)!,run=this.db.get<Run>('runs',this.runId)!;
        if(this.db.get('cancels',this.runId)||!['running','awaiting_approval'].includes(run.state)){a.state='canceled';decision=false;}
        else if(a.state==='pending'&&Date.now()>a.expiresAt){a.state='expired';decision=false;}
        else if(a.state==='approved'||a.state==='denied'){
          if(a.decision?.actor==='main'&&a.decision.allow&&!delegateMayAllow(a)){a.state='canceled';decision=false;}
          else{a.state='responding';decision=a.decision!.allow;}
        }
        if(decision!==undefined)saveApproval(this.db,a);
      });
      if(decision===undefined)continue;
      gate.respond(decision);this.gates.delete(id);
    }
    if(!this.gates.size)this.db.transaction(()=>{const run=this.db.get<Run>('runs',this.runId)!;if(run.state==='awaiting_approval'){run.state='running';updateRun(this.db,run);}});
  }
  abort(error:Error){if(this.done)return;this.done=true;clearInterval(this.timer);this.fail(error);}
}
