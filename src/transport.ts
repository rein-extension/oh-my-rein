import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { MAX_FRAME, Endpoint } from './protocol.ts';
import type { Request, Target } from './protocol.ts';

export class RemoteRejection extends Error {}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
export function request(target:Target,command:Request,timeoutMs=15000):Promise<any> {
  target=Endpoint.parse(target);
  return new Promise((res,rej)=>{
    const proc=target.kind==='ssh'?spawn('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','--',target.destination,[target.node,target.cli,'bridge','--state',target.state].map(quote).join(' ')],{stdio:['pipe','pipe','pipe']}):undefined;
    const socket=target.kind==='local'?connect(join(target.state,'host.sock')):undefined;
    const input=proc?.stdin??socket!,output=proc?.stdout??socket!;
    let buffer='',settled=false,stderr='';
    const finish=(err?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket?.destroy();proc?.kill();err?rej(err):res(value);};
    const timer=setTimeout(()=>finish(Error('Transport timeout; execution state unknown')),timeoutMs);
    output.setEncoding('utf8');
    output.on('data',b=>{buffer+=b.toString();if(Buffer.byteLength(buffer)>MAX_FRAME){finish(Error('Response exceeds frame limit'));return;}
      if(buffer.includes('\n'))try{const r=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));r.ok?finish(undefined,r.value):finish(r.rejected?new RemoteRejection(r.error):Error(r.error));}catch(e){finish(e as Error);}});
    output.on('error',e=>finish(e));input.on('error',e=>finish(e));
    proc?.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-2000);});
    proc?.once('error',e=>finish(e));proc?.once('close',()=>finish(Error('SSH bridge closed: '+stderr)));
    socket?.once('close',()=>finish(Error('Host connection closed')));
    const send=()=>input.end(JSON.stringify(command)+'\n');socket?socket.once('connect',send):send();
  });
}
