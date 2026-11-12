import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, linkSync, copyFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { shellQuote } from '../src/setup.ts';

const root = resolve('.');
const environment = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') };
const command = (exe: string, args: string[], env = environment, input?: string) => execFileSync(exe, args, { env, input, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

test('setup shell quoting preserves literal characters', () => {
  const value = "a path ' with $() `commands` ; & spaces";
  assert.equal(command('sh', ['-c', 'printf %s ' + shellQuote(value)]), value);
});

test('packed install: guided setup, idempotent Host reuse, compiled runner and safe failure paths', { timeout: 120000 }, async () => {
  // Keep the real Unix socket below macOS's 104-byte sockaddr limit.
  const temp = mkdtempSync('/tmp/rein-setup-');
  const localHome = join(temp, 'local'), remoteHome = join(temp, 'remote');
  const fakebin = join(temp, 'bin'), log = join(temp, 'commands.jsonl'), requests = join(temp, 'ssh.jsonl');
  const project = join(temp, 'local project'), remoteProject = join(temp, "remote project ' $literal");
  const packageRoot = join(temp, 'installed/node_modules/oh-my-rein');
  let hostState: string | undefined;
  try {
    for (const dir of [localHome, remoteHome, fakebin, project, packageRoot]) mkdirSync(dir, { recursive: true });
    // A separate executable path lets remote Node resolve the isolated npm stub beside it.
    try { linkSync(process.execPath, join(fakebin, 'node')); } catch { copyFileSync(process.execPath, join(fakebin, 'node')); }
    command(process.execPath, ['scripts/build-release.mjs']);
    const devEndpoint=join(temp,'development-endpoint.json');
    writeFileSync(devEndpoint,JSON.stringify({kind:'local',state:join(temp,'unused-host')}));
    for(const harness of ['codex','claude','pi']){
      const output=join(temp,'development-'+harness);
      const generated=JSON.parse(command(process.execPath,['scripts/package-plugin.ts','--harness',harness,'--endpoint',devEndpoint,'--state',join(temp,'development-main'),'--project',project,'--instance','dev-test','--output',output]));
      assert.equal(generated.harness,harness);
      assert.equal(JSON.parse(readFileSync(join(output,'connection.json'),'utf8')).instance,'dev-test');
      if(harness==='pi')assert.ok(existsSync(join(generated.plugin,'index.mjs')));
      else{
        assert.equal(readFileSync(join(generated.plugin,'skills/rein/SKILL.md'),'utf8'),readFileSync(join(root,'plugins/shared/skills/rein/SKILL.md'),'utf8'));
        const invocation=JSON.parse(readFileSync(join(generated.plugin,'.mcp.json'),'utf8')).mcpServers.rein;
        assert.equal(invocation.args[0],join(root,'dist/runtime/cli.js'));
      }
    }
    const npm = join(dirname(process.execPath), 'npm');
    const packed = JSON.parse(command(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp]));
    const paths = packed[0].files.map((f: { path: string }) => f.path) as string[];
    assert.ok(paths.includes('bin/rein.mjs') && paths.includes('dist/runtime/runner.js'));
    assert.ok(paths.includes('dist/runtime/dependencies.lock.json'));
    assert.ok(paths.every(p => !/^(src|tests|work|scripts)\//.test(p) && (!p.startsWith('docs/') || /^docs\/operations(?:\.zh-CN)?\.md$/.test(p))), 'Package must not expose source-only or private records');
    assert.ok(paths.every(p => !p.endsWith('.ts')), 'Installed runtime must not rely on TS stripping under node_modules');
    command('tar', ['-xf', join(temp, packed[0].filename), '-C', packageRoot, '--strip-components', '1']);
    symlinkSync(join(root, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
    const bin = join(packageRoot, 'bin/rein.mjs');
    assert.match(command(process.execPath, [bin, '--help']), /rein setup/);
    assert.equal(command(process.execPath, [bin, '--version']), JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version);
    command('git', ['init', '-q', project]);
    writeFileSync(join(project, 'README.md'), 'installation fixture\n');
    command('git', ['-C', project, 'add', '.']);
    command('git', ['-C', project, '-c', 'user.name=Setup Test', '-c', 'user.email=setup@example.invalid', 'commit', '-qm', 'base']);
    command('git', ['clone', '-q', '--', project, remoteProject]);
    const shebang = '#!' + process.execPath + '\n';
    writeFileSync(join(fakebin, 'codex'), shebang + `
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === '--version') console.log('codex-cli setup-test');
else if (a.includes('--help')) console.log('--ephemeral --output-schema --output-last-message --sandbox --ignore-user-config');
else if (a[0] === 'plugin') {
  if (process.env.SETUP_TEST_PLUGIN_FAIL === '1') { console.log(JSON.stringify({error:'test plugin failure'})); process.exit(1); }
  console.log('installed');
}
else if (a[0] === 'app-server') {
  const lines=require('node:readline').createInterface({input:process.stdin});
  const thread=require('node:crypto').randomUUID(),turn='turn-1';
  const send=m=>console.log(JSON.stringify(m));
  lines.on('line',line=>{const m=JSON.parse(line);
    if(m.method==='initialize')send({id:m.id,result:{}});
    if(m.method==='thread/start')send({id:m.id,result:{thread:{id:thread}}});
    if(m.method==='turn/start'){
      send({id:m.id,result:{turn:{id:turn}}});
      send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
      send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'write',command:'write result.txt',cwd:process.cwd()}});
    }
    if(m.id==='approval'&&m.result){
      if(m.result.decision==='accept')fs.writeFileSync('result.txt','compiled worker succeeded\\n');
      send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'write',type:'commandExecution',status:m.result.decision==='accept'?'completed':'declined'}}});
      send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'report',type:'agentMessage',text:JSON.stringify({summary:'setup test',evidence:['result.txt written'],discoveries:[],unresolved:[]})}}});
      send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
    }
  });
}
else if (a[0] === 'exec') {
  fs.readFileSync(0, 'utf8');
  fs.writeFileSync('result.txt', 'compiled worker succeeded\\n');
  fs.writeFileSync(a[a.indexOf('--output-last-message') + 1], JSON.stringify({summary:'setup test',evidence:['result.txt written'],discoveries:[],unresolved:[]}));
} else process.exit(2);
`, { mode: 0o700 });
    // Dependency download is substituted in this integration test. Runtime and Host are real.
    writeFileSync(join(fakebin, 'npm'), shebang + `
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['npm',...a])+'\\n');
if (a[0] !== 'ci' || !a.includes('--ignore-scripts') || !a.includes('--omit=dev')) process.exit(2);
fs.symlinkSync(${JSON.stringify(join(root, 'node_modules'))},path.join(process.cwd(),'node_modules'),'dir');
`, { mode: 0o700 });
    // An isolated local process substitutes for the SSH server. No real host is contacted.
    writeFileSync(join(fakebin, 'ssh'), shebang + `
const fs=require('node:fs'),cp=require('node:child_process');
const input=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(requests)},input+'\\n');
const env={...process.env,HOME:${JSON.stringify(remoteHome)}};delete env.LOCAL_ONLY_CREDENTIAL;
const cmd=process.argv.at(-1).replace(/^sh -lc /,'sh -c ');
const r=cp.spawnSync('sh',['-c',cmd],{input,env,encoding:'utf8',maxBuffer:32*1024*1024});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status ?? 1);
`, { mode: 0o700 });
    const env = { ...environment, HOME: localHome, PATH: fakebin + ':' + environment.PATH, LOCAL_ONLY_CREDENTIAL: 'do-not-copy-this-local-credential' };
    const args = [bin, 'setup', '--host', 'test-host', '--project', project, '--remote-project', remoteProject, '--remote-node', join(fakebin,'node'), '--sandbox', 'workspace-write'];
    const failed = spawnSync(process.execPath, [...args, '--profile', 'missing', '--yes'], { env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /profile not found/);
    assert.equal(existsSync(join(remoteHome, '.local/share/oh-my-rein')), false, 'Failed preflight must not deploy');
    const unconfirmed = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(unconfirmed.status, 0); assert.match(unconfirmed.stderr, /Apply this setup/);
    assert.equal(existsSync(join(remoteHome, '.local/share/oh-my-rein')), false);
    const first = command(process.execPath, [...args, '--yes'], env);
    assert.match(first, /Installed: remote Host connected; local codex plugin installed/);
    for(const action of ['on','off','status','sync'])assert.ok(first.includes('$rein:rein '+action));
    assert.match(first, /Approval route: ask/);
    const connections = join(localHome, '.local/share/oh-my-rein/connections');
    const connection = join(connections, readdirSync(connections)[0]!);
    const endpoint = JSON.parse(readFileSync(join(connection, 'endpoint.json'), 'utf8'));
    hostState = endpoint.state;
    const pid = readFileSync(join(hostState!, 'host.pid'), 'utf8');
    const plugin = JSON.parse(readFileSync(join(connection, 'marketplace/plugins/rein/.mcp.json'), 'utf8'));
    assert.ok(plugin.mcpServers.rein.args[0].endsWith('/dist/runtime/cli.js'));
    assert.ok(plugin.mcpServers.rein.args.includes(realpathSync(project)));
    assert.ok(endpoint.cli.endsWith('/dist/runtime/cli.js'));
    assert.equal(endpoint.destination, 'test-host');
    const hostSettings=JSON.parse(readFileSync(join(hostState!, 'host.json'), 'utf8'));
    assert.equal(hostSettings.repository,realpathSync(remoteProject));
    assert.equal('timeoutMs' in hostSettings,false);
    assert.equal(readFileSync(requests, 'utf8').includes(env.LOCAL_ONLY_CREDENTIAL), false);
    const bridge = (data: unknown) => JSON.parse(command(process.execPath, [endpoint.cli, 'bridge', '--state', hostState!], env, JSON.stringify(data) + '\n'));
    assert.deepEqual(bridge({type:'probe'}).value.permissions,{version:2,mode:'ask',sandbox:'workspace-write',worker:{adapter:'codex',sandbox:'workspace-write',approvalPolicy:'on-request'}});
    assert.equal(bridge({type:'probe'}).value.capabilities.nativePermissionForwarding,true);
    assert.equal(JSON.parse(command(process.execPath,[args[0]!,'worker','permissions','--host','test-host','--worker','codex','--project',project],env)).permissions.sandbox,'workspace-write');
    const nativeArgs=[args[0]!,'worker','permissions','--config',join(connection,'endpoint.json')];
    assert.equal(JSON.parse(command(process.execPath,nativeArgs,env)).permissions.sandbox,'workspace-write');
    assert.equal(JSON.parse(command(process.execPath,[...nativeArgs,'set','--sandbox','read-only'],env)).permissions.sandbox,'read-only');
    assert.equal(bridge({type:'probe'}).value.permissions.mode,'ask');
    const invalidNative=spawnSync(process.execPath,[...nativeArgs,'set','--tools','Read'],{env,encoding:'utf8'});
    assert.notEqual(invalidNative.status,0);
    assert.equal(JSON.parse(command(process.execPath,[...nativeArgs,'set','--sandbox','workspace-write'],env)).permissions.sandbox,'workspace-write');
    const modeConflict=spawnSync(process.execPath,[...args,'--permission-mode','full-access','--yes'],{env,encoding:'utf8',timeout:15000});
    assert.notEqual(modeConflict.status,0);
    assert.equal(bridge({type:'probe'}).value.permissions.mode,'ask','Setup must not silently elevate an existing Host');
    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();
    const paired=JSON.parse(readFileSync(join(connection,'main/approval-key.json'),'utf8'));
    const spec = {taskId:randomUUID(),runId,revision:1,owner:{harness:'test',instance:paired.instance,session:randomUUID()},goal:'Check compiled execution',originalRequest:'Write a test result',constraints:[],acceptance:['result.txt exists'],knowledge:[],baseCommit:command('git',['-C',project,'rev-parse','HEAD'])};
    assert.equal(bridge({type:'start',key:'compiled-run',spec}).ok, true);
    let outcome: any;
    for (let i=0;i<100;i++) {
      outcome=bridge({type:'inspect',runId}).value;
      if(outcome.state==='awaiting_approval'){
        assert.equal(existsSync(join(hostState!,'runs',runId,'workspace/result.txt')),false);
        const approval=bridge({type:'approval-list',runId,owner:spec.owner}).value[0];
        const payload={requestId:approval.id,requestHash:approval.requestHash,runId,owner:spec.owner,allow:true,actor:'user',reason:'Trusted test UI decision'};
        const {signApproval}=await import('../src/approval-authority.ts');
        assert.equal(bridge({type:'approval-decide',receipt:{payload,...signApproval(join(connection,'main'),paired.instance,payload)}}).ok,true);
      }
      if (['succeeded','failed','unknown'].includes(outcome.state)) break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(outcome.state,'succeeded',outcome.error);
    assert.match(readFileSync(join(hostState!, 'runs', runId, 'changes.patch'),'utf8'),/compiled worker succeeded/);
    const again = command(process.execPath, [...args, '--yes'], env);
    assert.match(again,/Installed:/);
    assert.equal(readFileSync(join(hostState!, 'host.pid'),'utf8'),pid,'Repeat setup should reuse the active Host');
    assert.equal(bridge({type:'inspect',runId}).value.state,'succeeded','Existing work must survive repeat setup');
    const calls=readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(calls.filter(c=>c[0]==='npm').length,1,'Dependencies should install once for the same release');
    assert.ok(calls.some(c=>c[0]==='plugin' && c[1]==='add' && !c.includes('--help')));
    const pluginFailure=spawnSync(process.execPath,[...args,'--yes'],{env:{...env,SETUP_TEST_PLUGIN_FAIL:'1'},encoding:'utf8',timeout:15000});
    assert.notEqual(pluginFailure.status,0,'JSON output must not turn a failed plugin install into success');
    assert.doesNotMatch(pluginFailure.stdout,/Installed:/);
    assert.equal(readFileSync(join(hostState!,'host.pid'),'utf8'),pid,'Partial local failure must preserve remote work');
    const conflict = spawnSync(process.execPath, [...args.slice(0,-2),'--sandbox','read-only','--yes'],{env,encoding:'utf8',timeout:15000});
    assert.notEqual(conflict.status,0); assert.match(conflict.stderr,/different configuration/);
    assert.equal(readFileSync(join(hostState!, 'host.pid'),'utf8'),pid);
    // Exercise the same packed setup path for both new local/remote adapters.
    for(const harness of ['claude','pi']){
      const fixtureSource='data:text/javascript;base64,'+Buffer.from(readFileSync(resolve('tests/fixture-tool-worker.mjs'),'utf8')).toString('base64');
      writeFileSync(join(fakebin,harness),shebang+`
const fs=require('node:fs'),a=process.argv.slice(2);
if(a.includes('--version'))console.log('test CLI');
else if(a.includes('--help'))console.log('--bare --restricted --no-session-persistence --permission-prompts --input-format stream-json manual acceptEdits --no-session --no-extensions --extension rpc --no-mcp --no-context-files --no-approve');
else if(a[0]==='plugin'||a[0]==='install'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['${harness}',...a])+'\\n');console.log('installed');}
else import(${JSON.stringify(fixtureSource)});
`,{mode:0o700});
      const nativeSetup=[...args.slice(0,-2),'--harness',harness,'--worker',harness,'--tools',harness==='claude'?'Write':'write'];
      assert.match(command(process.execPath,[...nativeSetup,'--yes'],env),/Installed:/);
      const connectionDir=readdirSync(connections).map(d=>join(connections,d)).find(d=>JSON.parse(readFileSync(join(d,'setup.json'),'utf8')).harness===harness)!;
      const endpoint=JSON.parse(readFileSync(join(connectionDir,'endpoint.json'),'utf8'));
      assert.equal(JSON.parse(readFileSync(join(endpoint.state,'host.json'),'utf8')).adapter,harness);
      const bridge=(data:unknown)=>JSON.parse(command(process.execPath,[endpoint.cli,'bridge','--state',endpoint.state],env,JSON.stringify(data)+'\n'));
      const paired=JSON.parse(readFileSync(join(connectionDir,'main/approval-key.json'),'utf8'));
      const runId=randomUUID(),owner={...spec.owner,instance:paired.instance};
      assert.equal(bridge({type:'start',key:runId,spec:{...spec,owner,taskId:randomUUID(),runId}}).ok,true);
      let result:any;for(let i=0;i<80;i++){
        result=bridge({type:'inspect',runId}).value;
        if(result.state==='awaiting_approval'){
          assert.equal(existsSync(join(endpoint.state,'runs',runId,'workspace/effect.txt')),false);
          const approval=bridge({type:'approval-list',runId,owner}).value[0];
          const payload={requestId:approval.id,requestHash:approval.requestHash,runId,owner,allow:true,actor:'user',reason:'Trusted test UI'};
          const {signApproval}=await import('../src/approval-authority.ts');
          assert.equal(bridge({type:'approval-decide',receipt:{payload,...signApproval(join(connectionDir,'main'),paired.instance,payload)}}).ok,true);
        }
        if(['succeeded','failed','unknown'].includes(result.state))break;await new Promise(r=>setTimeout(r,100));
      }
      assert.equal(result.state,'succeeded',result.error);
      assert.match(readFileSync(join(endpoint.state,'runs',runId,'changes.patch'),'utf8'),/approved/);
      const plugin=join(connectionDir,'marketplace/plugins/rein');
      if(harness==='claude')assert.ok(JSON.parse(readFileSync(join(plugin,'hooks/hooks.json'),'utf8')).hooks.PreToolUse[0].hooks[0].onFailure==='block');
      else assert.match(readFileSync(join(plugin,'index.mjs'),'utf8'),/installPiExtension/);
      assert.match(command(process.execPath,[...nativeSetup,'--permission-mode','ask','--update','--yes'],env),/Installed:/);
      if(harness==='claude'){const calls=readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.ok(calls.some(c=>c[0]==='claude'&&c[1]==='plugin'&&c[2]==='update'),'Runtime update must refresh the native Claude plugin');}
    }
    // An update refuses unknown work, then preserves both history and the transport
    // address after explicit recovery. No deletion or new main ledger is needed.
    const {Main}=await import('../src/main.ts');
    const owner={harness:'codex',instance:'persistent-setup-test',session:randomUUID()};
    const ledger=join(connection,'main'),originalMain=new Main(ledger,owner,endpoint,realpathSync(project));
    const userTask=originalMain.createUserTask('persistent-task',{taskKey:'persistent',title:'Survive update',goal:'Preserve this task across runtime updates',acceptance:['History retained']});
    originalMain.mode(true);originalMain.db.close();
    const {Store}=await import('../src/db.ts');
    const unknownId=randomUUID(),db=new Store(hostState!);
    db.set('runs',unknownId,{spec:{...spec,runId:unknownId,taskId:randomUUID()},state:'unknown',created:Date.now()});db.close();
    const updateArgs=[...args.slice(0,-2),'--sandbox','read-only','--permission-mode','delegate','--update','--yes'];
    const blockedUpdate=spawnSync(process.execPath,updateArgs,{env,encoding:'utf8',timeout:20000});
    assert.notEqual(blockedUpdate.status,0);assert.match(blockedUpdate.stderr,/update paused/);
    assert.equal(bridge({type:'probe'}).value.maintenance,true);
    assert.equal(bridge({type:'resolve',runId:unknownId,confirmStopped:true,reason:'Inspected test processes; no external effects'}).ok,true);
    assert.match(command(process.execPath,updateArgs,env),/Installed:/);
    assert.deepEqual(JSON.parse(readFileSync(join(connection,'endpoint.json'),'utf8')),endpoint);
    assert.equal(JSON.parse(readFileSync(join(hostState!,'host.json'),'utf8')).sandbox,'read-only');
    assert.equal(JSON.parse(readFileSync(join(hostState!,'host.json'),'utf8')).permissionMode,'delegate');
    assert.deepEqual(bridge({type:'probe'}).value.permissions,{version:2,mode:'delegate',sandbox:'read-only',worker:{adapter:'codex',sandbox:'read-only',approvalPolicy:'on-request'}});
    assert.equal(bridge({type:'probe'}).value.maintenance,false);
    assert.equal(bridge({type:'inspect',runId}).value.state,'succeeded');
    // A different payload exercises a real runtime upgrade, not just configuration.
    const runtimeFile=join(packageRoot,'dist/runtime/activation.js');
    writeFileSync(runtimeFile,readFileSync(runtimeFile,'utf8')+'\n// isolated upgrade fixture\n');
    assert.match(command(process.execPath,updateArgs,env),/Installed:/);
    assert.deepEqual(JSON.parse(readFileSync(join(connection,'endpoint.json'),'utf8')),endpoint);
    assert.equal(bridge({type:'inspect',runId:unknownId}).value.state,'canceled');
    const resumedMain=new Main(ledger,owner,JSON.parse(readFileSync(join(connection,'endpoint.json'),'utf8')),realpathSync(project));
    try{assert.equal(resumedMain.mode(),true);assert.equal(resumedMain.userTask(userTask.id).title,'Survive update');}finally{resumedMain.db.close();}
    const helper=readFileSync(join(packageRoot,'dist/runtime/setup-remote.js'),'utf8');
    const captured=readFileSync(requests,'utf8').trim().split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
    const install=captured.find(r=>r.action==='install');
    install.files.push({path:'../../escape',content:'must not write'});
    const {payloadDigest}=await import('../src/setup-remote.ts');install.digest=payloadDigest(install.files);
    const freshHome=join(temp,'other');mkdirSync(freshHome);
    const tampered=spawnSync(process.execPath,['--input-type=module','-e',helper,'--','--rein-setup-remote'],{env:{...env,HOME:freshHome},input:JSON.stringify(install),encoding:'utf8'});
    assert.notEqual(tampered.status,0);assert.match(tampered.stdout,/Unexpected runtime path/);
    assert.equal(existsSync(join(freshHome,'.local')),false,'Unsafe archive paths must fail before deployment');
    assert.equal(existsSync(join(temp,'escape')),false);
  } catch (error) {
    const installLog = join(remoteHome, '.local/share/oh-my-rein/dependency-install.log');
    if (existsSync(installLog)) console.error('Isolated test dependency error:', readFileSync(installLog, 'utf8').slice(0, 1800));
    throw error;
  } finally {
    const hosts = join(remoteHome, '.local/share/oh-my-rein/hosts');
    for (const state of existsSync(hosts) ? readdirSync(hosts).map(d => join(hosts, d)) : []) {
      if (!existsSync(join(state, 'host.pid'))) continue;
      try { process.kill(Number(readFileSync(join(state,'host.pid'),'utf8')),'SIGTERM'); } catch {}
      for(let i=0;i<50&&existsSync(join(state,'host.pid'));i++) await new Promise(r=>setTimeout(r,50));
    }
    rmSync(temp,{recursive:true,force:true});
  }
});
