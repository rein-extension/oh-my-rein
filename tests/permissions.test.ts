import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { HostConfig, canonical, hash, PermissionMode, WorkerReport, Report } from '../src/protocol.ts';
import { z } from 'zod';
import { permissionPolicy, nativeApprovals, hostConfigDigest, legacyHostConfigDigest, hostConfigMatches, validatePermissionAnswers, validateWorkerPermissions } from '../src/permissions.ts';
import { workerInvocation } from '../src/workers.ts';

test('Host init accepts native settings and rejects the removed Rein modes',()=>{
  const root=mkdtempSync('/tmp/rein-native-init-');
  try{
    for(const adapter of ['codex','claude','pi']){
      const flags=adapter==='codex'?['--sandbox','danger-full-access','--approval-policy','never']:adapter==='claude'?['--claude-permission-mode','dontAsk','--tools','Read,Glob']:['--tools','read,write'];
      const args=['src/cli.ts','host','init','--repository',root,'--executable',process.execPath,'--adapter',adapter,'--state',join(root,adapter),'--permission-mode','delegate',...flags];
      const config=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
      assert.equal(config.permissionMode,'delegate');assert.equal(config.workerPermissions.adapter,adapter);
      if(adapter==='codex')assert.equal(config.workerPermissions.sandbox,'danger-full-access');
      else assert.deepEqual(config.workerPermissions.tools,adapter==='claude'?['Read','Glob']:['read','write']);
      const rejected=spawnSync(process.execPath,[...args,'--state',join(root,adapter+'-bad'),'--permission-mode','full-access'],{encoding:'utf8'});
      assert.notEqual(rejected.status,0);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('ask/delegate only route approvals; explicit native access is independent for every adapter',()=>{
  assert.equal(PermissionMode.safeParse('read-only').success,false);
  assert.equal(PermissionMode.safeParse('full-access').success,false);
  const root=mkdtempSync('/tmp/rein-native-permissions-');
  try{
    const policies=[
      {adapter:'codex',sandbox:'workspace-write',approvalPolicy:'never'},
      {adapter:'claude',permissionMode:'dontAsk',tools:['Read','Glob','Grep']},
      {adapter:'pi',tools:['read','write','bash']},
    ];
    for(const policy of policies){
      const workerPermissions=validateWorkerPermissions(policy);
      const config=HostConfig.parse({repository:root,executable:policy.adapter,adapter:policy.adapter,workerPermissions});
      const ask=workerInvocation(config,join(root,policy.adapter));
      const delegate=workerInvocation({...config,permissionMode:'delegate'},join(root,policy.adapter));
      assert.deepEqual(ask.args,delegate.args);
      assert.deepEqual(permissionPolicy(config).worker,workerPermissions);
      if(policy.adapter==='pi')assert.equal(ask.args[ask.args.indexOf('--tools')+1],'read,write,bash');
    }
    assert.throws(()=>validateWorkerPermissions({adapter:'claude',permissionMode:'default',tools:['Read']}),/Use manual/);
    assert.throws(()=>validateWorkerPermissions({adapter:'pi',tools:['read','read']}),/Duplicate/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('model report schema requires every declared field and keeps permission decisions out of task questions',()=>{
  const schema=z.toJSONSchema(WorkerReport,{target:'draft-7'});
  assert.equal(schema.type,'object');
  assert.deepEqual([...schema.required!].sort(),['discoveries','evidence','questions','summary','unresolved']);
  const visit=(s:any)=>{
    if(!s||typeof s!=='object')return;
    if(s.type==='object'){assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort());assert.equal(s.additionalProperties,false);}
    for(const child of Object.values(s))if(Array.isArray(child))child.forEach(visit);else visit(child);
  };
  visit(schema);
  const report={summary:'Need a decision',evidence:[],discoveries:[],unresolved:[],questions:[{id:'format',text:'Which export format?'}]};
  assert.equal(WorkerReport.safeParse(report).success,true);
  assert.equal(Report.safeParse(report).success,true);
  assert.equal(WorkerReport.safeParse({...report,questions:[{...report.questions[0],permission:{}}]}).success,false);
  const {questions,...legacy}=report;
  assert.deepEqual(Report.parse(legacy),legacy);
  assert.equal(WorkerReport.safeParse(legacy).success,false);
});

test('Claude and Pi interactive channels are explicit; old Pi settings keep their behavior',()=>{
  const root=mkdtempSync('/tmp/rein-tool-policy-');try{
    for(const workerPermissions of [
      {adapter:'claude',permissionMode:'manual',tools:['Bash']},
      {adapter:'claude',permissionMode:'acceptEdits',tools:['Edit']},
      {adapter:'pi',toolApproval:'all',tools:['write']},
    ]){
      const config=HostConfig.parse({repository:root,executable:'cli',adapter:workerPermissions.adapter,workerPermissions});
      assert.equal(nativeApprovals(config),true);assert.throws(()=>workerInvocation(config,root),/interactive/);
      const {args}=workerInvocation(config,root,undefined,true);
      if(config.adapter==='claude'){assert.ok(args.includes('stream-json'));assert.ok(args.includes('--permission-prompt-tool'));assert.equal(args[args.indexOf('--permission-prompts')+1],'host');}
      else{assert.ok(args.includes('rpc'));assert.ok(args.includes('--no-extensions'));assert.match(args[args.indexOf('--extension')+1]!,/pi-worker-gate\.ts$/);assert.ok(!args.includes('--print'));}
    }
    for(const toolApproval of [undefined,'never']){
      const config=HostConfig.parse({repository:root,executable:'cli',adapter:'pi',workerPermissions:{adapter:'pi',tools:['write'],...(toolApproval?{toolApproval}:{})}});
      assert.equal(nativeApprovals(config),false);const {args}=workerInvocation(config,root);assert.ok(args.includes('--print'));assert.ok(!args.includes('--extension'));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('permission presets default to ask and accept old digests only under their known configuration',()=>{
  const config=HostConfig.parse({repository:'/repo',executable:'/codex'});
  assert.equal(config.permissionMode,'ask');assert.deepEqual(permissionPolicy(config),{version:2,mode:'ask',sandbox:'read-only'});
  const {permissionMode,...legacy}=config;
  const oldDigest=hash(canonical({...legacy,timeoutMs:1800000}));
  assert.equal(legacyHostConfigDigest(config),oldDigest);
  assert.equal(hostConfigMatches(oldDigest,config),true);
  assert.equal(hostConfigMatches(oldDigest,{...config,permissionMode:'delegate'}),false);
  assert.equal(hostConfigMatches(oldDigest,{...config,concurrency:3}),false,'Legacy limits need an explicit migration before changing');
  assert.equal(hostConfigDigest({...config,concurrency:3}),hostConfigDigest(config));
  assert.equal(hostConfigDigest({...config,timeoutMs:60000}),hostConfigDigest(config));
  assert.notEqual(hostConfigDigest({...config,permissionMode:'delegate'}),hostConfigDigest(config));
  assert.equal(PermissionMode.safeParse('unrestricted').success,false);
  assert.equal(HostConfig.safeParse({...config,permissionMode:'unknown'}).success,false);
});

test('all worker adapters apply read-only and explicit full-access presets independently of the legacy sandbox',()=>{
  const root=mkdtempSync('/tmp/rein-permissions-');
  try{
    for(const adapter of ['codex','claude','pi'] as const){
      for(const permissionMode of ['read-only','full-access'] as const){
        const config=HostConfig.parse({repository:root,executable:adapter,adapter,permissionMode,sandbox:permissionMode==='full-access'?'read-only':'workspace-write'});
        const invocation=workerInvocation(config,join(root,adapter,permissionMode));
        const policy=permissionPolicy(config),args=invocation.args;
        assert.equal(policy.sandbox,permissionMode==='full-access'?'danger-full-access':permissionMode==='read-only'?'read-only':'workspace-write');
        if(adapter==='codex'){
          assert.ok(args.includes(`sandbox_mode="${policy.sandbox}"`));assert.ok(args.includes('approval_policy="never"'));
        }else if(adapter==='claude'){
          assert.equal(args.includes('--restricted'),permissionMode!=='full-access');
          assert.equal(args[args.indexOf('--permission-mode')+1],permissionMode==='full-access'?'bypassPermissions':permissionMode==='read-only'?'dontAsk':'acceptEdits');
          assert.equal(args[args.indexOf('--tools')+1].includes('Bash'),permissionMode!=='read-only');
        }else{
          assert.equal(args[args.indexOf('--tools')+1].includes('bash'),permissionMode!=='read-only');
          assert.ok(args.includes('--no-approve'));assert.ok(args.includes('--no-extensions'));
        }
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('headless adapters never silently downgrade ask/delegate; report text cannot authorize operations',()=>{
  const root=mkdtempSync('/tmp/rein-policy-');
  try{
    for(const adapter of ['codex','claude','pi'] as const)for(const permissionMode of ['ask','delegate'] as const){
      assert.throws(()=>workerInvocation(HostConfig.parse({repository:root,executable:adapter,adapter,permissionMode}),root),/Native approval/);
    }
    const question={id:'write',text:'Write output?',permission:{operation:'write',target:'output.csv',reason:'Deliver output',scope:'workspace-write' as const}};
    const answer={questionId:'write',answer:'Approved',permissionDecision:{actor:'user' as const,allow:true,reason:'User approved',userQuote:'Yes'}};
    for(const mode of ['ask','delegate','read-only','full-access'] as const){
      assert.throws(()=>validatePermissionAnswers({mode,sandbox:'workspace-write'},[question],[answer]),/Report answers cannot authorize/);
      assert.throws(()=>validatePermissionAnswers({mode,sandbox:'workspace-write'},[{id:'write',text:'Which format?'}],[answer]),/Report answers cannot authorize/);
      assert.doesNotThrow(()=>validatePermissionAnswers({mode,sandbox:'read-only'},[{id:'format',text:'Which format?'}],[{questionId:'format',answer:'CSV'}]));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
