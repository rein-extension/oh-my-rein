import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root=resolve('.'),temporary=mkdtempSync(join(tmpdir(),'rein-package-check-'));
const env={...process.env,PATH:dirname(process.execPath)+':'+(process.env.PATH??'')};
const run=(exe,args)=>execFileSync(exe,args,{cwd:root,env,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}).trim();
try{
  run('npm',['run','prepack']);
  const [packed]=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temporary]));
  const paths=new Set(packed.files.map(f=>f.path));
  for(const file of ['bin/rein.mjs','dist/runtime/cli.js','dist/runtime/setup.js','dist/runtime/host-installation.js','dist/runtime/permissions.js','dist/runtime/worker-config.js','dist/runtime/tool-native.js','dist/runtime/pi-worker-gate.js','dist/runtime/dependencies.lock.json','assets/hero.svg','assets/architecture.svg','docs/operations.md','docs/operations.zh-CN.md','plugins/shared/skills/rein/SKILL.md','plugins/codex/.codex-plugin/plugin.json','plugins/claude/.claude-plugin/plugin.json','plugins/pi/package.json'])assert.ok(paths.has(file),'Missing '+file);
  for(const file of paths)assert.match(file,/^(?:package\.json|README(?:\.zh-CN)?\.md|INSTALL(?:\.zh-CN)?\.md|CHANGELOG\.md|bin\/rein\.mjs|dist\/runtime\/[a-z][a-z0-9-]*\.(?:js|lock\.json)|assets\/[a-z][a-z0-9-]*\.svg|docs\/operations(?:\.zh-CN)?\.md|plugins\/(?:shared\/skills\/rein\/SKILL\.md|codex\/\.codex-plugin\/plugin\.json|claude\/\.claude-plugin\/plugin\.json|pi\/package\.json))$/,'Unexpected package file: '+file);
  for(const file of ['README.md','README.zh-CN.md','INSTALL.md','INSTALL.zh-CN.md','docs/operations.md','docs/operations.zh-CN.md']){
    const content=readFileSync(join(root,file),'utf8');
    // The installation guide uses "you" as a placeholder in example home paths.
    assert.doesNotMatch(content,/file\+|vscode-resource|\/(?:Users|home)\/(?!you\/)[\w.-]+\//,'Machine-specific link in '+file);
    const links=[...content.matchAll(/\]\(([^)]+)\)|\bsrc="([^"]+)"/g)].map(m=>m[1]??m[2]);
    for(const link of links){
      if(/^(https?:|#)/.test(link))continue;
      const path=join(dirname(file),link.split('#')[0]);
      assert.ok(paths.has(path),'Broken packaged link in '+file+': '+link);
    }
  }
  const prefix=join(temporary,'prefix');
  run('npm',['install','--global','--prefix',prefix,join(temporary,packed.filename),'--ignore-scripts','--no-audit','--no-fund']);
  const cli=join(prefix,'bin/rein');
  assert.equal(run(cli,['--version']),JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version);
  const setupHelp=run(cli,['setup','--help']);
  assert.match(setupHelp,/--update/);assert.match(setupHelp,/--permission-mode/);assert.match(setupHelp,/ask \(default\) or delegate/);
  assert.match(run(cli,['host','--help']),/confirm-stopped/);
  console.log(`Package verified: ${packed.filename} (${paths.size} files); clean prefix installation and CLI startup passed.`);
}finally{rmSync(temporary,{recursive:true,force:true});}
