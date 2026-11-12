import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { Endpoint } from './protocol.ts';
import type { Connection } from './pi-extension.ts';
import { Harness, conversationCommands, readJSON, writeJSON, sharedInstructions } from './plugin-common.ts';
import type { HarnessName, PluginAdapter, PluginContext } from './plugin-common.ts';
import { codexPlugin } from './plugin-codex.ts';
import { claudePlugin } from './plugin-claude.ts';
import { piPlugin } from './plugin-pi.ts';

export type { HarnessName } from './plugin-common.ts';
const adapters: Record<HarnessName, PluginAdapter> = { codex: codexPlugin, claude: claudePlugin, pi: piPlugin };

export function buildLocalPlugin(root:string,directory:string,harness:HarnessName,connection:Connection){
  harness=Harness.parse(harness);
  const version=readJSON(join(root,'package.json')).version;
  Endpoint.parse(readJSON(connection.config));
  if(!existsSync(join(root,'dist/runtime/cli.js')))throw Error('Build the runtime first: npm run build');
  const plugin=join(directory,'plugins/rein');
  mkdirSync(plugin,{recursive:true,mode:0o700});
  const receipt=join(directory,'connection.json'),binding={harness,...connection};
  if(existsSync(receipt)&&JSON.stringify(readJSON(receipt))!==JSON.stringify(binding))throw Error('Plugin directory belongs to a different connection; use a new output directory');
  writeJSON(receipt,binding);
  const context: PluginContext = { root, directory, plugin, harness, connection, version,
    instructions: sharedInstructions(root), node: process.execPath, cli: join(root,'dist/runtime/cli.js') };
  adapters[harness].build(context);
  adapters[harness].validate(context);
  return {plugin,marketplace:directory,harness};
}
export function installLocalPlugin(harness:HarnessName,executable:string,directory:string,project:string,instance:string,update=false){
  const commands=adapters[Harness.parse(harness)].installCommands({directory,instance,update});
  for(const args of commands){
    const result=spawnSync(executable,args,{cwd:project,env:{...process.env,PATH:process.execPath.slice(0,process.execPath.lastIndexOf('/'))+':'+process.env.PATH},encoding:'utf8',timeout:60000});
    if(result.error||result.status!==0)throw Error(`Local ${harness} plugin installation failed: ${result.error?.message??result.stderr??result.stdout}`);
  }
}
export async function runPlugin(args:string[]){
  const {values:v}=parseArgs({args,options:{harness:{type:'string'},state:{type:'string'},config:{type:'string'},project:{type:'string'},instance:{type:'string'},output:{type:'string'},executable:{type:'string'},install:{type:'boolean'},help:{type:'boolean'}}});
  if(v.help){console.log('rein plugin --harness codex|claude|pi --config ENDPOINT.json --state MAIN_DIR --project PROJECT --instance ID --output PLUGIN_DIR [--install] [--executable PATH]\nBuild a project connection; --install registers it in the selected harness. Keep the runtime and output directory available.');return;}
  const harness=Harness.parse(v.harness);
  if(!v.state||!v.config||!v.project||!v.instance||!v.output)throw Error('Required: --state, --config, --project, --instance, --output');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v.instance))throw Error('Instance must be a stable alphanumeric label');
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const connection={state:resolve(v.state),config:realpathSync(v.config),project:realpathSync(v.project),instance:v.instance};
  const result=buildLocalPlugin(root,resolve(v.output),harness,connection);
  if(v.install)installLocalPlugin(harness,v.executable??harness,result.marketplace,connection.project,connection.instance);
  const commands=conversationCommands(harness);
  console.log(JSON.stringify({...result,installed:!!v.install,enable:commands.on,disable:commands.off,status:commands.status,sync:commands.sync},null,2));
}
