import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { z } from 'zod';
import type { Binding, HostSettings, WorkerPermissions } from './protocol.ts';

export type WorkerSession={id:string;owner:Binding;taskKey?:string;baseCommit:string;adapter:HostSettings['adapter'];configDigest:string;latestRunId:string;turn:number;nativeId?:string;workerPermissions?:z.infer<typeof WorkerPermissions>};
export type NativeTurn={root:string;id?:string;resume:boolean};

function files(directory:string):string[]{
  if(!existsSync(directory))return [];
  return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):e.isFile()&&e.name.endsWith('.jsonl')?[join(directory,e.name)]:[]);
}
export function nativeSessionFile(adapter:HostSettings['adapter'],root:string,id:string){
  z.guid().parse(id);
  const directory=join(root,adapter==='codex'?'codex-home/sessions':adapter==='claude'?'claude-home/projects':'pi-sessions');
  const found=files(directory).filter(file=>basename(file).includes(id));
  if(found.length!==1)throw Error('Native worker session is missing or ambiguous; refusing to start a replacement session');
  if(adapter==='pi'){
    const header=JSON.parse(readFileSync(found[0]!,'utf8').split('\n')[0]!);
    if(header.type!=='session'||header.id!==id)throw Error('Pi session identity mismatch');
  }
  return found[0]!;
}
export function nativeSessionId(adapter:HostSettings['adapter'],output:string,expected?:string){
  let id:unknown;
  if(adapter==='claude')id=JSON.parse(output).session_id;
  else {
    const events=output.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
    id=adapter==='codex'?events.find(e=>e.type==='thread.started')?.thread_id:events.find(e=>e.type==='session')?.id;
  }
  const parsed=z.guid().parse(id);
  if(expected&&parsed!==expected)throw Error('Native worker resumed a different session');
  return parsed;
}
