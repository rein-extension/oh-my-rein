// Explicitly loaded into the isolated Pi worker. No local/user extensions are
// discovered. Every enabled tool is gated; no shell-text risk classifier.
type Context={mode?:string;hasUI:boolean;cwd:string;signal?:AbortSignal;sessionManager:{getSessionId():string};ui:{notify(message:string,type?:string):void;confirm(title:string,message:string,options?:{signal?:AbortSignal}):Promise<boolean>}};
type API={on(event:string,handler:(event:any,ctx:Context)=>unknown):void};
export default function installWorkerGate(pi:API){
  pi.on('session_start',(_event,ctx)=>{
    if(ctx.mode!=='rpc'||!ctx.hasUI)throw Error('Rein worker approvals require Pi RPC');
    ctx.ui.notify('rein-ready:'+JSON.stringify({version:1,sessionId:ctx.sessionManager.getSessionId()}),'info');
  });
  pi.on('tool_call',async(event,ctx)=>{
    if(ctx.mode!=='rpc'||!ctx.hasUI||ctx.signal?.aborted)return {block:true,reason:'Rein approval channel unavailable'};
    const operation=JSON.stringify({protocol:'rein-tool-v1',sessionId:ctx.sessionManager.getSessionId(),toolName:event.toolName,toolCallId:event.toolCallId,input:event.input,cwd:ctx.cwd});
    const allow=await ctx.ui.confirm('Rein tool approval',operation,{signal:ctx.signal});
    if(!allow||ctx.signal?.aborted)return {block:true,reason:'This operation was not approved. Do not retry it to bypass review.'};
  });
}
