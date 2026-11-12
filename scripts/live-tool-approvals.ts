// Opt-in, billable native worker test. Decisions are scripted test UI inputs,
// not evidence that a human clicked an approval form in a desktop harness.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,openSync,closeSync,realpathSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
const {values:v}=parseArgs({options:{adapter:{type:'string'},executable:{type:'string'},model:{type:'string'},settings:{type:'string'},provider:{type:'string'},tools:{type:'string'},'pi-agent-dir':{type:'string'},'allow-model-calls':{type:'boolean'},'runtime-dir':{type:'string'}}});
if(!v['allow-model-calls']||!['claude','pi'].includes(v.adapter!)||!v.executable)throw Error('Requires --allow-model-calls --adapter claude|pi --executable PATH and provider/model settings');
const runtime=resolve(v['runtime-dir']??'src'),extension=existsSync(join(runtime,'main.js'))?'js':'ts';
const load=(name:string)=>import(pathToFileURL(join(runtime,name+'.'+extension)).href);
const [{Main},{id},{ensureApprovalKey},{request}]=await Promise.all(['main','protocol','approval-authority','transport'].map(load));
const root=mkdtempSync('/tmp/rein-live-tool-'),repo=join(root,'repo'),state=join(root,'host');for(const dir of [repo,state])mkdirSync(dir,{mode:0o700});
console.log('Retained native approval test: '+root);
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init','-q');writeFileSync(join(repo,'README'),'Isolated approval test.\n');git('add','.');git('-c','user.name=Rein Test','-c','user.email=test@example.invalid','commit','-qm','base');
const adapter=v.adapter!,workerPermissions=adapter==='claude'?{adapter,permissionMode:'manual',tools:(v.tools??'Bash').split(',')}:{adapter,tools:(v.tools??'write').split(','),toolApproval:'all'};
writeFileSync(join(state,'host.json'),JSON.stringify({repository:repo,adapter,executable:resolve(v.executable!),workerPermissions,permissionMode:'ask',model:v.model,settings:v.settings,provider:v.provider,piAgentDir:v['pi-agent-dir']}),{mode:0o600});
const target={kind:'local' as const,state},owner={harness:'codex',instance:'live-tool-test',session:id()},main=new Main(join(root,'main'),owner,target,repo);main.mode(true);
const key=ensureApprovalKey(main.state,owner.instance);writeFileSync(join(state,'approval-keys.json'),JSON.stringify({[key.keyId]:key}));
const log=openSync(join(root,'host.log'),'a',0o600),host=spawn(process.execPath,[join(runtime,'cli.'+extension),'host','serve','--state',state],{stdio:['ignore',log,log]});closeSync(log);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const checks:unknown[]=[];
try{
  for(let i=0;i<100;i++){try{await request(target,{type:'probe'},300);break;}catch{if(i===99)throw Error('Host did not start');await sleep(100);}}
  let previousExecutionId:string|undefined,nativeId:string|undefined;
  for(const allow of [false,true]){
    const input={taskKey:'native-approval',goal:`${adapter==='claude'?"Use the Bash tool exactly once with command: printf 'rein-native-permission-test\\n' > result.txt":'Use the write tool exactly once to create result.txt with content rein-native-permission-test followed by one newline.'} Work only in this checkout. Do not use any other tool. If permission is denied, stop attempting the operation and report the denial as unresolved, with questions: []. Then output the required JSON report.`,originalRequest:'Isolated native approval test',constraints:['Only the result.txt write described here is authorized; do not access credentials, network, or other projects.'],acceptance:['Report the actual write or denial'],baseCommit:git('rev-parse','HEAD'),...(previousExecutionId?{previousExecutionId,message:'For this new test turn, the same write is authorized to be requested again. Request it once; the test UI will now allow it.',answers:[]}:{})};
    const t=main.dispatch(id(),input);await main.sync();const workspace=join(state,'sessions',t.spec.worker!.sessionId,'workspace');let decisions=0;
    const end=Date.now()+200000;
    while(Date.now()<end){
      await main.sync();const current=main.task(t.spec.taskId);
      if(current.status==='awaiting_approval'){
        for(const pending of current.run!.approvals!.filter((a:any)=>a.state==='pending')){
          const approvals=await request(target,{type:'approval-list',runId:t.spec.runId,owner}) as any[];
          const a=approvals.find(a=>a.id===pending.id);assert.equal(a.params.toolName,adapter==='claude'?'Bash':'write');
          if(adapter==='claude')assert.equal(a.params.input.command,"printf 'rein-native-permission-test\\n' > result.txt");
          else {const path=a.params.input.path;assert.ok(resolve(workspace,path)===join(workspace,'result.txt')||resolve(workspace,path)===join(realpathSync(workspace),'result.txt'));assert.equal(a.params.input.content,'rein-native-permission-test\n');}
          assert.equal(existsSync(join(workspace,'result.txt')),false,'Operation ran before a decision');assert.equal(decisions,0,'Worker retried the denied operation');
          await main.reviewPermission(t.spec.taskId,a.id,async()=>allow);decisions++;
        }
      }
      if(['ready','failed','unknown','canceled'].includes(current.status))break;
      await sleep(200);
    }
    const result=main.task(t.spec.taskId);assert.equal(result.status,'ready',result.run?.error);assert.equal(decisions,1,'Native permission request was not forwarded');
    assert.equal(existsSync(join(workspace,'result.txt')),allow);if(allow)assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'rein-native-permission-test\n');
    if(nativeId)assert.equal(result.run!.nativeSessionId,nativeId);nativeId=result.run!.nativeSessionId;previousExecutionId=t.spec.taskId;
    await main.collect(t.spec.taskId);
    const approvals=await request(target,{type:'approval-list',runId:t.spec.runId,owner}) as any[];
    assert.equal(approvals[0].state,'resolved');assert.equal(approvals[0].result,allow?'completed':'not-granted');
    checks.push({allow,runId:t.spec.runId,nativeSessionId:nativeId,decisions,outcome:approvals[0].result,status:result.status});console.log(adapter+' '+(allow?'allow':'deny')+' passed');
  }
  writeFileSync(join(root,'summary.json'),JSON.stringify({adapter,status:'passed',checks,limits:['Scripted UI decisions, not human desktop acceptance','Local Host transport; no SSH network partition']},null,2));
}finally{
  try{for(const t of main.tasks())if(!['ready','failed','accepted','continued','canceled'].includes(t.status))main.cancel(t.spec.taskId);await main.sync().catch(()=>{});}finally{main.db.close();host.kill('SIGTERM');}
}
