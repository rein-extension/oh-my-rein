import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, hash } from './protocol.ts';
import { reinTools } from './tools.ts';
import { assertProject } from './project-scope.ts';

// A native PreToolUse hook supplies a single-use receipt, not a model-chosen
// session argument. No dependence on the MCP process's stale startup session.
export function issueBinding(directory:string,project:string,event:Record<string,any>){
  if(event.hook_event_name!=='PreToolUse')throw Error('Expected native PreToolUse event');
  assertProject(event.cwd,project);
  if(event.agent_id)throw Error('Rein main-agent tools cannot be delegated to native subagents');
  const session=z.guid().parse(event.session_id);
  const name=String(event.tool_name).match(/^mcp__plugin_rein_rein__(rein_[a-z_]+)$/)?.[1];
  const tool=reinTools(()=>{throw Error('Hook cannot execute tools');}).find(t=>t.name===name);
  if(!tool)throw Error('Not a configured Rein tool');
  const {_reinBinding:ignored,...input}=event.tool_input??{};
  const args=tool.schema.parse(input);
  mkdirSync(directory,{recursive:true,mode:0o700});
  // Expired receipts from denied/interrupted calls are not conversation history.
  for(const file of readdirSync(directory))if(/^[a-f0-9-]{36}\.json$/.test(file)){
    const path=join(directory,file);try{if(Date.now()-statSync(path).mtimeMs>300000)unlinkSync(path);}catch{}
  }
  const token=randomUUID();
  writeFileSync(join(directory,token+'.json'),JSON.stringify({session,project:realpathSync(project),name,digest:hash(canonical(args)),created:Date.now()}),{mode:0o600,flag:'wx'});
  // Leave permission decisions to Claude Code and the user.
  return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{...args,_reinBinding:token}}};
}
export function consumeBinding(directory:string,project:string,name:string,args:unknown,token:unknown){
  if(!z.guid().safeParse(token).success)throw Error('Missing native Claude session receipt. Enable the Rein PreToolUse hook; --bare is not supported for the main plugin.');
  const path=join(directory,String(token)+'.json');
  let receipt;
  try{receipt=JSON.parse(readFileSync(path,'utf8'));unlinkSync(path);}catch{throw Error('Unknown or already consumed native session receipt');}
  if(receipt.name!==name||receipt.project!==realpathSync(project)||receipt.digest!==hash(canonical(args))||Date.now()-receipt.created>300000||receipt.created>Date.now()+1000)throw Error('Native session receipt does not match this call');
  return z.guid().parse(receipt.session);
}
