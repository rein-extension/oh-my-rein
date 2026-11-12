import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostConfig } from '../src/protocol.ts';
import { codexInvocation } from '../src/codex.ts';

test('named profile uses a fresh worker home without inheriting auth, memory, or user plugins',()=>{
  const root=mkdtempSync(join(tmpdir(),'rein-profile-')),source=join(root,'user'),run=join(root,'run');
  mkdirSync(source);mkdirSync(run);
  const profile='model = "test-model"\nmodel_provider = "test-provider"\n';
  writeFileSync(join(source,'test.config.toml'),profile);
  writeFileSync(join(source,'config.toml'),'model = "wrong-default"\n');
  writeFileSync(join(source,'auth.json'),'private-auth');
  writeFileSync(join(source,'AGENTS.md'),'private-instructions');
  mkdirSync(join(source,'memories'));mkdirSync(join(source,'plugins'));
  try{
    const config=HostConfig.parse({repository:root,executable:'/codex',profile:'test',codexHome:source});
    const invocation=codexInvocation(config,run),home=invocation.env.CODEX_HOME!;
    assert.equal(readFileSync(join(home,'config.toml'),'utf8'),profile);
    for(const file of ['auth.json','AGENTS.md','memories','plugins'])assert.equal(existsSync(join(home,file)),false);
    assert.equal(invocation.args.includes('--ignore-user-config'),false);
    assert.equal(invocation.args.includes('--profile'),false);
    assert.ok(invocation.args.includes('--ephemeral'));
    assert.ok(invocation.args.includes('features.memories=false'));
    assert.ok(invocation.args.includes('features.shell_snapshot=false'),'Provider environment must not be persisted in shell snapshots');
    assert.equal(readFileSync(join(source,'config.toml'),'utf8'),'model = "wrong-default"\n');
    assert.throws(()=>codexInvocation({...config,profile:'missing'},join(root,'missing-run')),/ENOENT/);
    assert.equal(HostConfig.safeParse({...config,profile:'../escape'}).success,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
