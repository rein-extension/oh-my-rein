import {createInterface} from 'node:readline';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2),claude=args.includes('--input-format');
const value=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
const resumed=args.includes('--resume')||args.includes('--session');
const session=claude?(resumed?value('--resume'):value('--session-id'))??randomUUID():resumed?JSON.parse(readFileSync(value('--session'),'utf8').split('\n')[0]).id:value('--session-id')??randomUUID();
const history=claude?join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture',session+'.jsonl'):resumed?value('--session'):join(args.includes('--session-dir')?value('--session-dir'):process.env.PI_CODING_AGENT_DIR,session+'.jsonl');
mkdirSync(dirname(history),{recursive:true});if(!resumed)writeFileSync(history,JSON.stringify({type:'session',id:session})+'\n');
const send=m=>console.log(JSON.stringify(m));
let spec,tool='write',input;
const finish=()=>{
  const report={summary:resumed?'continued':'first turn',evidence:['fixture outcome'],discoveries:[],unresolved:[],questions:[]};
  if(claude)send({type:'result',subtype:'success',is_error:false,session_id:session,result:JSON.stringify(report)});
  else{send({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(report)}]}});send({type:'agent_settled',aborted:false});}
};
const request=()=>{
  if(claude)send({type:'control_request',request_id:'approve',request:{subtype:'can_use_tool',tool_name:tool,input,tool_use_id:'op',permission_suggestions:[{type:'addRules',behavior:'allow'}]}});
  else send({type:'extension_ui_request',id:'approve',method:'confirm',title:'Rein tool approval',message:JSON.stringify({protocol:'rein-tool-v1',sessionId:session,toolName:tool,toolCallId:'op',input,cwd:process.cwd()})});
};
const begin=prompt=>{
  spec=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));appendFileSync(history,JSON.stringify({type:'user',goal:spec.goal})+'\n');
  if(claude)send({type:'system',subtype:'init',session_id:session});
  tool=claude?'Write':'write';if(spec.goal==='unsupported')tool='unconfigured';
  input=claude?{file_path:join(process.cwd(),'effect.txt'),content:'approved\n'}:{path:'effect.txt',content:'approved\n'};
  if(spec.goal==='secret')input.content=process.env.ANTHROPIC_API_KEY??process.env.DEEPSEEK_API_KEY;
  request();if(spec.goal==='duplicate')request();
  if(spec.goal==='withdraw'&&claude){send({type:'control_cancel_request',request_id:'approve'});setTimeout(finish,200);}
};
const decide=m=>{
  const response=claude?m.response.response:m,allowed=claude?response.behavior==='allow':response.confirmed===true;
  appendFileSync('decisions.log',JSON.stringify(response)+'\n');
  if(allowed){writeFileSync('effect.txt','approved\n');if(claude&&JSON.stringify(response.updatedInput)!==JSON.stringify(input))process.exit(3);}
  if(spec.goal==='crash')process.exit(2);
  if(claude)send({type:'control_request',request_id:'post',request:{subtype:'hook_callback',callback_id:allowed?'rein:post':'rein:failure',tool_use_id:'op',input:{tool_name:tool,tool_input:input,tool_use_id:'op'}}});
  else{send({type:'tool_execution_end',toolCallId:'op',isError:!allowed});finish();}
};
if(!claude)send({type:'extension_ui_request',id:'ready',method:'notify',message:'rein-ready:'+JSON.stringify({version:1,sessionId:session})});
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(claude){
    if(m.type==='control_request'&&m.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{hooks_applied:true}}});
    if(m.type==='user')begin(m.message.content);
    if(m.type==='control_response'&&m.response.request_id==='approve')decide(m);
    if(m.type==='control_response'&&m.response.request_id==='post')finish();
  }else{
    if(m.type==='get_state')send({type:'response',id:m.id,success:true,data:{sessionId:session}});
    if(m.type==='prompt'){send({type:'response',id:m.id,success:true,data:{disposition:'started'}});begin(m.message);}
    if(m.type==='extension_ui_response'&&m.id==='approve')decide(m);
  }
});
