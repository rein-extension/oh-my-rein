import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately excludes SSH_AUTH_SOCK, cloud credentials, native session IDs,
// NODE_OPTIONS, preload hooks and the main harness's configuration directories.
export function workerEnvironment(root:string,provider:Record<string,string>={}){
  const home=join(root,'home'),tmp=join(root,'tmp');
  mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(tmp,{recursive:true,mode:0o700});
  const env:Record<string,string>={HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:join(home,'.config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  for(const name of ['PATH','GIT_EXEC_PATH','LANG','LC_ALL','LC_CTYPE','TZ','SYSTEMROOT','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']){
    if(process.env[name])env[name]=process.env[name]!;
  }
  return {...env,...provider};
}

export const providerValues=(names:string[])=>Object.fromEntries(names.flatMap(name=>process.env[name]?[ [name,process.env[name]!] ]:[]));
export const credentialValues=(env:Record<string,string>)=>Object.entries(env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(k)&&v.length>=4).map(([,v])=>v);

// Exact known credential values only: this is not semantic secret detection.
// Keep a suffix per stream so credentials split over stdout/stderr chunks do
// not reach persisted logs. The two streams must never share that suffix.
export class Redactor {
  secrets:string[];tail='';width:number;
  constructor(secrets:string[]){this.secrets=[...new Set(secrets)].sort((a,b)=>b.length-a.length);this.width=Math.max(1,...this.secrets.map(s=>s.length));}
  text(value:string){for(const secret of this.secrets)value=value.split(secret).join('[REDACTED]');return value;}
  push(value:string,final=false){
    const all=this.tail+value;let cut=final?all.length:Math.max(0,all.length-this.width+1);
    for(const secret of this.secrets){
      let at=all.indexOf(secret);
      while(at>=0&&at<cut){if(at+secret.length>cut)cut=at;at=all.indexOf(secret,at+1);}
    }
    this.tail=all.slice(cut);return this.text(all.slice(0,cut));
  }
  json<T>(value:T):T{
    if(typeof value==='string')return this.text(value) as T;
    if(Array.isArray(value))return value.map(v=>this.json(v)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.json(v)])) as T;
    return value;
  }
}
