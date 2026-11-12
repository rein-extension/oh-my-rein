import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {resolve} from 'node:path';

for(const harness of ['claude','pi'])test(`${harness} live smoke preflight uses explicit headless permissions without invoking a model`,()=>{
  const output=execFileSync(process.execPath,['scripts/live-harness-smoke.mjs','--preflight-only','--harness',harness,'--executable','/usr/bin/false','--runtime-dir',resolve('src')],{encoding:'utf8',timeout:15000});
  const lines=output.trim().split('\n'),root=lines[0]!.replace('Retained isolated test state: ','');
  try{
    const result=JSON.parse(lines.at(-1)!);assert.equal(result.status,'passed');assert.equal(result.modelCalls,false);
    assert.equal(result.workerPermissions.adapter,harness);
    if(harness==='claude')assert.equal(result.workerPermissions.permissionMode,'bypassPermissions');
    else assert.equal(result.workerPermissions.toolApproval,'never');
  }finally{if(/^\/tmp\/rein-live-harness-[\w-]+$/.test(root))rmSync(root,{recursive:true,force:true});}
});
