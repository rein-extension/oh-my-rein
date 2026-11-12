import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Main } from './main.ts';
import { reinTools, toolErrorMessage } from './tools.ts';
import { consumeBinding } from './claude-binding.ts';
import { approvalPrompt } from './approval-prompt.ts';

export function runtimeSession(meta:Record<string,unknown>|undefined,boundSession?:string){
  if(meta?.threadId!==undefined){
    const thread=z.guid().parse(meta.threadId);
    if(boundSession&&boundSession!==thread)throw Error('Runtime thread metadata conflicts with the bound session');
    return thread;
  }
  if(boundSession)return boundSession;
  throw Error('No runtime-bound session identity; requires MCP request _meta.threadId or CODEX_THREAD_ID. Tool arguments cannot supply identity.');
}

export async function startMcp(source:(meta:Record<string,unknown>|undefined)=>Main,claude?:{directory:string;project:string}){
  const server=new McpServer({name:'rein',version:'0.1.0'});
  const prompt:import('./main.ts').PermissionPrompt=async (approval,signal)=>{
    if(!server.server.getClientCapabilities()?.elicitation?.form)throw Error('This client cannot show the task approval form. The operation is still waiting; reopen this conversation in a client with form elicitation. Terminal review is available for diagnostics.');
    const result=await server.server.elicitInput({mode:'form',message:approvalPrompt(approval),requestedSchema:{type:'object',properties:{decision:{type:'string',title:'Decision for this operation',enum:['pending','allow','deny'],enumNames:['Keep waiting','Allow once','Deny'],default:'pending'}},required:['decision']}},{timeout:120000,signal});
    if(result.action==='cancel')return null;
    if(result.action==='decline')return false;
    return result.content?.decision==='allow'?true:result.content?.decision==='deny'?false:null;
  };
  for(const tool of reinTools(source,prompt,()=>!!server.server.getClientCapabilities()?.elicitation?.form)){
    const inputSchema=claude
      ?tool.schema.extend({_reinBinding:z.string().optional().describe('Reserved for the native Rein hook. Omit this field.')})
      :tool.schema;
    server.registerTool(tool.name,{description:tool.description,inputSchema,annotations:tool.annotations},async(input:Record<string,unknown>,extra:{_meta?:Record<string,unknown>;signal:AbortSignal})=>{
      try{
        const {_reinBinding,...args}=input;
        const meta=claude?{nativeSession:consumeBinding(claude.directory,claude.project,tool.name,tool.schema.parse(args),_reinBinding)}:extra._meta;
        return await tool.execute(args,meta,extra.signal);
      }catch(e){return {isError:true,content:[{type:'text' as const,text:toolErrorMessage(e)}]};}
    });
  }
  await server.connect(new StdioServerTransport());return server;
}
