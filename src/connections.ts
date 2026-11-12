import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function listConnections(){
  const root=join(homedir(),'.local/share/oh-my-rein/connections');
  const connections=[];
  for(const id of existsSync(root)?readdirSync(root):[]){
    try{
      const directory=join(root,id),setup=JSON.parse(readFileSync(join(directory,'setup.json'),'utf8'));
      connections.push({id,host:setup.destination,project:setup.project,remoteProject:setup.repository,harness:setup.harness??'codex',worker:setup.worker??'codex',endpoint:join(directory,'endpoint.json'),plugin:join(directory,'marketplace'),instance:'rein-'+id});
    }catch{connections.push({id,error:'Incomplete connection record; inspect the setup directory'});}
  }
  return connections;
}
