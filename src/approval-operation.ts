import type { Approval } from './approval-store.ts';

// Routing only: the native harness defines the operation and permission scope.
export function delegateMayAllow(a:Approval){
  return a.policy.version===2&&a.policy.mode==='delegate'&&a.state!=='unsupported'&&['item/commandExecution/requestApproval','item/fileChange/requestApproval','claude/tool/requestApproval','pi/tool/requestApproval'].includes(a.method);
}

export type ApprovalSummary={
  id:string;state:string;method:string;kind?:'command'|'file-change'|'tool'|'unknown';
  title?:string;preview?:string;truncated?:boolean;decider?:'user'|'main'|null;
  impact?:string;expiresAt?:number;reason?:string;
};
export function summarizeApproval(a:Approval):ApprovalSummary{
  const command=a.method==='item/commandExecution/requestApproval';
  const file=a.method==='item/fileChange/requestApproval';
  const tool=['claude/tool/requestApproval','pi/tool/requestApproval'].includes(a.method);
  const changes=Array.isArray(a.item?.changes)?a.item!.changes:[];
  const preview=command?String(a.params.command??'Command details unavailable'):file?changes.map((c:any)=>String(c.path??'?')+(c.kind?.move_path?' → '+String(c.kind.move_path):'')).join(', '):tool?String(a.params.toolName)+' '+JSON.stringify(a.params.input):a.method;
  const delegated=delegateMayAllow(a);
  return {id:a.id,state:a.state,method:a.method,kind:command?'command':file?'file-change':tool?'tool':'unknown',
    title:command?'Run a command':file?'Change '+changes.length+' file(s)':tool?'Run '+String(a.params.toolName):'Review a native operation',
    preview:preview.slice(0,240),truncated:preview.length>240,
    decider:a.state==='pending'?(a.policy.mode==='delegate'&&delegated?'main':'user'):null,
    reason:a.error?.slice(0,320)??(a.policy.mode==='delegate'&&a.policy.version===undefined?'Legacy delegation policy: a user must review this request; upgrading never broadens a saved grant.':undefined),
    impact:a.state==='unsupported'?'Adapter could not handle this request; no permission was granted. This was not a user decision.':a.state==='unknown'?'The operation may have produced effects before stopping. Inspect them before retrying.':command?'Native acceptance may run outside the configured sandbox with the Host account’s privileges.':tool?'Allow this exact tool input once. Tools run with the Host account’s privileges; review paths and external effects.':'Review the full native paths and changes before granting access.',
    expiresAt:a.expiresAt};
}
