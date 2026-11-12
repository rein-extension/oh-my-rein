import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash } from './protocol.ts';

export function ensureApprovalKey(state:string,instance:string){
  mkdirSync(state,{recursive:true,mode:0o700});
  const file=join(state,'approval-key.json');
  if(!existsSync(file)){
    const pair=generateKeyPairSync('ed25519');
    try{writeFileSync(file,JSON.stringify({instance,privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'})}),{mode:0o600,flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  const key=JSON.parse(readFileSync(file,'utf8'));
  if(key.instance!==instance)throw Error('Approval key belongs to another installation');
  const publicKey=String(createPublicKey(key.privateKey).export({type:'spki',format:'pem'}));
  return {keyId:hash(publicKey),publicKey,instance};
}

export function signApproval(state:string,instance:string,payload:unknown){
  const key=JSON.parse(readFileSync(join(state,'approval-key.json'),'utf8'));
  if(key.instance!==instance)throw Error('Approval key belongs to another installation');
  const publicKey=String(createPublicKey(key.privateKey).export({type:'spki',format:'pem'}));
  return {keyId:hash(publicKey),signature:sign(null,Buffer.from(canonical(payload)),key.privateKey).toString('base64')};
}
