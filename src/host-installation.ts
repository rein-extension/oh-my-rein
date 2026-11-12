import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './db.ts';
import { alive } from './host.ts';
import type { Run } from './host.ts';
import { HostConfig, canonical } from './protocol.ts';
import { hostConfigDigest, legacyHostConfigDigest } from './permissions.ts';
import type { WorkerSession } from './worker-session.ts';

const Receipt=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),release:z.string().startsWith('/'),bridgeCli:z.string().startsWith('/'),bridgeNode:z.string().startsWith('/')}).strict();
const Plan=z.object({config:HostConfig,receipt:Receipt}).strict();
const Pending=Plan.extend({previousConfig:HostConfig.optional()});
function atomicJSON(file:string,value:unknown){
  const temporary=file+'.tmp-'+randomUUID();
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temporary,file);
}

// Runs on the Host machine only after its supervisor has stopped. A journal blocks
// startup between the two file replacements; retry completes exactly the same plan.
export function installHostConfiguration(state:string,raw:unknown){
  const plan=Plan.parse(raw),db=new Store(state);
  try{const result=db.transaction(()=>{
    const owner=db.get<{pid:number}>('supervisor','owner');
    if(owner&&owner.pid>0&&alive(owner.pid))throw Error('Stop the Host before updating its configuration');
    const runs=db.list<Run>('runs');
    if(runs.some(r=>!['succeeded','waiting_input','waiting_permission','failed','canceled'].includes(r.state)))throw Error('Settle queued, active and unknown executions before updating');
    const configFile=join(state,'host.json'),receiptFile=join(state,'installation.json'),pendingFile=join(state,'pending-installation.json');
    const current=HostConfig.parse(JSON.parse(readFileSync(configFile,'utf8')));
    if(current.repository!==plan.config.repository||current.adapter!==plan.config.adapter)throw Error('An update cannot change the repository or worker adapter');
    let previous=current;
    if(existsSync(pendingFile)){
      const {previousConfig,...pending}=Pending.parse(JSON.parse(readFileSync(pendingFile,'utf8')));
      if(canonical(pending)!==canonical(plan))throw Error('An interrupted update must be retried with the same package and options');
      previous=previousConfig??current;
    }else{
      const backup=join(state,'backups',Date.now()+'-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});
      atomicJSON(join(backup,'host.json'),current);
      if(existsSync(receiptFile))atomicJSON(join(backup,'installation.json'),JSON.parse(readFileSync(receiptFile,'utf8')));
      // Keep the old configuration available if file replacement succeeds but
      // the database transaction rolls back. Retrying can still migrate hashes.
      atomicJSON(pendingFile,{...plan,previousConfig:current});
    }
    const legacy=legacyHostConfigDigest(previous),compatible=hostConfigDigest(previous);
    for(const session of db.list<WorkerSession>('worker-sessions'))if(session.configDigest===legacy)db.set('worker-sessions',session.id,{...session,configDigest:compatible});
    db.set('host','maintenance',true);
    if(plan.config.workerPermissions){
      const prior=db.get<{revision:number}>('host','worker-defaults');
      db.set('host','worker-defaults',{revision:(prior?.revision??0)+1,permissions:plan.config.workerPermissions});
    }
    atomicJSON(configFile,plan.config);
    atomicJSON(receiptFile,plan.receipt);
    return {updated:true,maintenance:true};
  });
    // Clear the retry journal only after the legacy-session migration commits.
    unlinkSync(join(state,'pending-installation.json'));
    return result;
  }finally{db.close();}
}
