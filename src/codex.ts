import { mkdirSync, realpathSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostSettings } from './protocol.ts';
import type { NativeTurn } from './worker-session.ts';
import { permissionPolicy, workerPermissions } from './permissions.ts';
import { nativeSessionFile } from './worker-session.ts';
import { providerValues } from './worker-environment.ts';

// Named profiles in the supported CLI live in <name>.config.toml. Loading a
// profile together with --ignore-user-config silently ignores it in some builds.
// Give each profiled worker a fresh home whose only config is that profile.
// Authentication must come from the provider environment; never copy auth.json.
export function codexInvocation(config:HostSettings,root:string,session?:NativeTurn,native=false){
  const permissions=workerPermissions(config);if(permissions.adapter!=='codex')throw Error('Codex worker permissions required');
  const workerHome=join(session?.root??root,'codex-home');
  mkdirSync(workerHome,{recursive:true,mode:0o700});
  const env:Record<string,string>={...providerValues(['OPENAI_API_KEY']),CODEX_HOME:workerHome};
  let configArgs=['--ignore-user-config'];
  if(config.profile){
    const sourceHome=config.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex');
    const profile=realpathSync(join(sourceHome,`${config.profile}.config.toml`));
    const target=join(workerHome,'config.toml');
    if(!existsSync(target))copyFileSync(profile,target);
    // Only environment keys explicitly named by the chosen provider profile.
    // The profile itself is a trusted Host configuration, frozen per session.
    const text=readFileSync(target,'utf8');
    for(const match of text.matchAll(/^\s*env_key\s*=\s*["']([A-Z][A-Z0-9_]*)["']/gm))Object.assign(env,providerValues([match[1]!]));
    configArgs=[];
  }
  // Native shell snapshots can persist inherited provider credentials.
  if(session?.resume)nativeSessionFile('codex',session.root,session.id!);
  if(native)return {env,args:['app-server','--listen','stdio://','-c','features.memories=false','-c','features.shell_snapshot=false','-c',`approval_policy="${permissions.approvalPolicy}"`,'-c',`sandbox_mode="${permissions.sandbox}"`]};
  return {env,args:['exec',...(session?.resume?['resume']:[]),...(!session?['--ephemeral']:[]),...(config.model?['--model',config.model]:[]),...configArgs,'-c','features.memories=false','-c','features.shell_snapshot=false','-c','approval_policy="never"','-c',`sandbox_mode="${permissionPolicy(config).sandbox}"`,'--json','--output-schema',join(root,'report-schema.json'),'--output-last-message',join(root,'report.json'),...(session?.resume?[session.id!]:[]),'-']};
}
