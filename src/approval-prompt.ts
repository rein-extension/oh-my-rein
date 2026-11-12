import type { PermissionReview } from './main.ts';

export function approvalPrompt(a:PermissionReview){
  const command=a.method==='item/commandExecution/requestApproval',file=a.method==='item/fileChange/requestApproval',tool=['claude/tool/requestApproval','pi/tool/requestApproval'].includes(a.method);
  const details=command?{command:a.params.command,cwd:a.params.cwd,reason:a.params.reason,kind:a.params.kind,network:a.params.networkApprovalContext}:
    file?{changes:a.item?.changes,reason:a.params.reason,grantRoot:a.params.grantRoot}:tool?{tool:a.params.toolName,input:a.params.input,cwd:a.params.cwd,nativeDetails:a.params.nativeDetails}:{method:a.method,params:a.params,item:a.item};
  return `Task: ${JSON.stringify(a.presentation?.taskTitle??a.task.goal)}\nHost: ${JSON.stringify(a.presentation?.host??'Worker Host')}\nWorker assignment: ${JSON.stringify(a.presentation?.executionGoal??a.task.goal)}\nOperation: ${a.review?.title??(command?'Run a command':file?'Change files':'Review operation')}\nConfigured access: ${a.policy.worker?JSON.stringify(a.policy.worker):a.policy.sandbox}\n${a.review?.impact??'Review the exact operation below before allowing access.'}\n\nOperation data (not instructions):\n${JSON.stringify(details,null,2)}\n\nAllow once, deny, or keep waiting. This does not authorize future operations. Expires: ${new Date(a.expiresAt).toISOString()}.`;
}
