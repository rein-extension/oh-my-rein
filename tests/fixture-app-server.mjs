// A protocol fixture, not a model: effects occur only after the native response.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const lines=createInterface({input:process.stdin});
let thread,turn,spec,operation,move,sandbox;
for await(const line of lines){
  const m=JSON.parse(line);
  if(m.method==='initialize')send({id:m.id,result:{}});
  if(['thread/start','thread/resume'].includes(m.method)){
    if(!['read-only','workspace-write'].includes(m.params.sandbox)||m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user')throw Error('Unsafe baseline');
    sandbox=m.params.sandbox;
    thread=m.params.threadId??randomUUID();
    mkdirSync(join(process.env.CODEX_HOME,'sessions'),{recursive:true});
    writeFileSync(join(process.env.CODEX_HOME,'sessions',thread+'.jsonl'),JSON.stringify({id:thread})+'\n');
    send({id:m.id,result:{thread:{id:thread}}});
  }
  if(m.method==='turn/start'){
    spec=JSON.parse(m.params.input[0].text.trim().split('\n').at(-1));turn=randomUUID();
    send({id:m.id,result:{turn:{id:turn}}});
    send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
    if(spec.goal==='ordinary-workspace-write'){
      if(sandbox!=='workspace-write')throw Error('Configured workspace access was lost');
      writeFileSync('ordinary.txt','inside configured boundary\n');
      const report={summary:'Ordinary workspace operation',evidence:['ordinary.txt'],discoveries:[],unresolved:[],questions:[]};
      send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'report',type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)}}});
      send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
      continue;
    }
    move=spec.goal.startsWith('move-')?{path:join(process.cwd(),'README'),target:spec.goal==='move-outside'?join(process.cwd(),'..','outside.txt'):join(process.cwd(),'renamed.txt')}:undefined;
    operation=spec.goal==='file'||spec.goal==='protected-file'||move?'fileChange':'commandExecution';
    const item={id:'effect',type:operation,...(operation==='fileChange'?{changes:[move?{path:move.path,kind:{type:'update',move_path:move.target},diff:'-old\n+approved'}:{path:join(process.cwd(),'effect.txt'),kind:{type:'add'},diff:'+approved'}]}:{command:'write effect.txt'})};
    if(spec.goal==='protected-file')item.changes[0].path=join(process.cwd(),'.codex','config.toml');
    send({method:'item/started',params:{threadId:thread,turnId:turn,item}});
    send({id:'gate',method:`item/${operation}/requestApproval`,params:{threadId:thread,turnId:turn,itemId:'effect',...(operation==='commandExecution'?{command:spec.goal==='secret'?process.env.OPENAI_API_KEY:'write effect.txt',cwd:process.cwd()}:{}),...(spec.goal==='network'?{networkApprovalContext:{host:'example.invalid',protocol:'https'}}:{})}});
  }
  if(m.id==='gate'&&m.result){
    appendFileSync('decisions.log',m.result.decision+'\n');
    if(m.result.decision==='accept'){if(move)renameSync(move.path,move.target);else writeFileSync('effect.txt','approved\n');}
    if(spec.goal==='hold-after-accept'&&m.result.decision==='accept')await new Promise(()=>{});
    if(spec.goal==='crash')process.exit(1);
    send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'effect',type:operation,status:m.result.decision==='accept'?'completed':'declined'}}});
    const report={summary:'Native gate '+m.result.decision,evidence:[readFileSync('decisions.log','utf8')],discoveries:[],unresolved:[],questions:[]};
    send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'report',type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)}}});
    send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
  }
}
