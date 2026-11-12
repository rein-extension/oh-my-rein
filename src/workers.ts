import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionPolicy, nativeApprovals, validateWorkerPermissions } from './permissions.ts';
import { Report } from './protocol.ts';
import type { HostSettings } from './protocol.ts';
import { codexInvocation } from './codex.ts';
import { providerValues } from './worker-environment.ts';
import { nativeSessionFile } from './worker-session.ts';
import type { NativeTurn } from './worker-session.ts';

export function workerInvocation(config:HostSettings,root:string,session?:NativeTurn,interactive=false){
  if(nativeApprovals(config)&&!interactive)throw Error('Native approval execution requires an interactive worker adapter');
  if(config.workerPermissions)validateWorkerPermissions(config.workerPermissions);
  if(config.adapter==='codex')return codexInvocation(config,root,session);
  const env:Record<string,string>={},policy=permissionPolicy(config);
  const native=config.workerPermissions;
  const readOnly=policy.sandbox==='read-only',fullAccess=policy.mode==='full-access'||(native?.adapter==='claude'&&native.permissionMode==='bypassPermissions');
  if(config.adapter==='claude'){
    const home=join(session?.root??root,'claude-home');mkdirSync(home,{recursive:true,mode:0o700});
    Object.assign(env,providerValues(['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN']));
    env.CLAUDE_CONFIG_DIR=home;
    // Import provider settings only. Never load user hooks, permissions, plugins,
    // memory or conversation state into a disposable worker.
    if(config.settings){
      const settings=JSON.parse(readFileSync(config.settings,'utf8'));
      for(const [key,value] of Object.entries(settings.env??{})){
        if(/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_(HAIKU|SONNET|OPUS)_MODEL)|CLAUDE_CODE_OAUTH_TOKEN)$/.test(key)&&typeof value==='string')env[key]=value;
      }
    }
    const tools=native?.adapter==='claude'?native.tools.join(','):readOnly?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write,Bash';
    if(session?.resume)nativeSessionFile('claude',session.root,session.id!);
    return {env,args:['--print','--bare',...(fullAccess?[]:['--restricted']),...(session?[session.resume?'--resume':'--session-id',session.id!]:['--no-session-persistence']),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--permission-mode',native?.adapter==='claude'?native.permissionMode:fullAccess?'bypassPermissions':readOnly?'dontAsk':'acceptEdits','--permission-prompts',interactive?'host':'none','--tools',tools,'--output-format',interactive?'stream-json':'json',...(interactive?['--input-format','stream-json','--permission-prompt-tool','stdio','--verbose']:[]),...(config.model?['--model',config.model]:[])]};
  }
  if(config.adapter==='pi'){
    const home=join(session?.root??root,'pi-home');mkdirSync(home,{recursive:true,mode:0o700});env.PI_CODING_AGENT_DIR=home;
    const keyName=({deepseek:'DEEPSEEK_API_KEY',anthropic:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',google:'GEMINI_API_KEY'} as Record<string,string>)[config.provider??''];
    if(keyName)Object.assign(env,providerValues([keyName]));
    if(config.piAgentDir){
      if(!config.provider)throw Error('Pi auth directory requires an explicit provider');
      const auth=JSON.parse(readFileSync(join(config.piAgentDir,'auth.json'),'utf8'))[config.provider];
      if(!keyName||auth?.type!=='api_key'||typeof auth.key!=='string'||!auth.key||auth.key.startsWith('!'))throw Error('Pi auth adapter supports literal API keys for deepseek/anthropic/openai/google; otherwise configure provider credentials in the Host environment');
      env[keyName]=auth.key;
    }
    const sessionArgs=!session?['--no-session']:session.resume?['--session',nativeSessionFile('pi',session.root,session.id!)]:['--session-id',session.id!,'--session-dir',join(session.root,'pi-sessions')];
    return {env,args:[...(interactive?[]:['--print']),'--mode',interactive?'rpc':'json',...sessionArgs,'--no-extensions',...(interactive?['--extension',fileURLToPath(new URL('./pi-worker-gate.ts',import.meta.url))]:[]),'--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--offline','--tools',native?.adapter==='pi'?native.tools.join(','):readOnly?'read,grep,find,ls':'read,grep,find,ls,edit,write,bash',...(config.provider?['--provider',config.provider]:[]),...(config.model?['--model',config.model]:[])]};
  }
  throw Error('Unsupported worker adapter');
}

function jsonReport(text:string){
  const clean=text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  return Report.parse(JSON.parse(clean));
}
export function saveWorkerReport(adapter:HostSettings['adapter'],root:string,output:string){
  if(adapter==='codex'||adapter==='fixture')return;
  let report;
  if(adapter==='claude'){
    const result=JSON.parse(output);
    if(result.type!=='result'||result.is_error||result.subtype!=='success')throw Error('Claude Code did not finish successfully');
    report=result.structured_output?Report.parse(result.structured_output):jsonReport(result.result);
  }else{
    const events=output.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
    const settled=events.findLast(e=>e.type==='agent_settled');
    const message=events.findLast(e=>e.type==='message_end'&&e.message?.role==='assistant')?.message;
    if(!settled||settled.aborted||!message||!['stop','length'].includes(message.stopReason))throw Error('Pi did not finish with a successful assistant response');
    if(message.stopReason==='length')throw Error('Pi response was truncated');
    report=jsonReport(message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'));
  }
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
}
