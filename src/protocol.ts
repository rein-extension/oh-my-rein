import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const Owner = z.object({ harness: z.string().min(1), instance: z.string().min(1), session: z.string().min(1) }).strict();
export const MAX_SPEC_BYTES = 256 * 1024;
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export function assertSize(value:unknown,limit:number,label:string){
  if(Buffer.byteLength(JSON.stringify(value))>limit)throw Error(`${label} exceeds ${limit} bytes`);
}
export const KnowledgeRef = z.object({ id: z.string().max(200), version: z.number().int().positive(), content: z.string().max(16000), source: z.string().max(4000), verified: z.boolean() }).strict();
export const ContextKind = z.enum(['goal','constraint','preference','decision']);
export const TaskKey = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).describe('Stable label for one user task within this conversation, such as payment-fix. Reuse for follow-up executions of that task; use a different label for independent work.');
// Model-facing alternatives use disjoint literals and serialize as JSON Schema anyOf.
export const ContextAudience = z.union([
  z.object({type:z.literal('project')}).strict(),
  z.object({type:z.literal('task'),taskKey:TaskKey}).strict(),
]);
export const ContextInput = z.object({
  kind: ContextKind, content:z.string().trim().min(1).max(8000),
  quote:z.string().trim().min(1).max(8000), shareWithWorkers:z.boolean().default(false),
  requiredForTask:z.boolean().optional().describe('Defaults to true for task goals, constraints and decisions, false for preferences/project notes. Required task entries must be explicitly selected and shareable before dispatch. Set false only for optional background notes.'),
  appliesTo:ContextAudience.describe('Choose task for a task-specific requirement; project only for an explicit reusable project agreement. Global personal memory belongs to the harness.'),
}).strict();
export const ContextUpdate = ContextInput.omit({kind:true,appliesTo:true});
export const ContextSelection = z.array(z.guid()).max(30).refine(ids=>new Set(ids).size===ids.length,'Duplicate context selection');
export const KnowledgeSelection = z.array(z.guid()).max(50).refine(ids=>new Set(ids).size===ids.length,'Duplicate knowledge selection');
export const PageQuery = z.object({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(25).default(10)});
export const StatusQuery = PageQuery.extend({view:z.enum(['tasks','executions','attention','knowledge']).default('tasks'),id:z.guid().optional(),version:z.number().int().positive().optional(),taskKey:TaskKey.optional()});
export const UserTaskInput = z.object({
  taskKey:TaskKey, title:z.string().trim().min(1).max(160),
  goal:z.string().trim().min(1).max(16000),
  acceptance:z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
}).strict();
export const UserTaskUpdate = z.object({
  title:UserTaskInput.shape.title.optional(),goal:UserTaskInput.shape.goal.optional(),
  acceptance:UserTaskInput.shape.acceptance.optional(),
  waitingFor:z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  status:z.enum(['active','paused','canceled']).optional(),
  reason:z.string().trim().min(1).max(2000),
}).strict();
export const UserContextRef = z.object({
  id:z.guid(),version:z.number().int().positive(),kind:ContextKind,
  content:z.string().min(1).max(8000),source:z.string().min(1).max(4000),origin:z.literal('user_statement'),
}).strict();
export const PermissionMode = z.enum(['ask','delegate']);
// Read old ledgers/configuration without reinterpreting their permissions.
export const LegacyPermissionMode = z.enum(['ask','delegate','read-only','full-access']);
export const WorkerPermissions = z.discriminatedUnion('adapter',[
  z.object({adapter:z.literal('codex'),sandbox:z.enum(['read-only','workspace-write','danger-full-access']),approvalPolicy:z.enum(['on-request','never'])}).strict(),
  z.object({adapter:z.literal('claude'),permissionMode:z.enum(['default','manual','acceptEdits','dontAsk','bypassPermissions']),tools:z.array(z.enum(['Read','Glob','Grep','Edit','Write','Bash'])).min(1).max(6)}).strict(),
  z.object({adapter:z.literal('pi'),tools:z.array(z.enum(['read','grep','find','ls','edit','write','bash'])).min(1).max(7),toolApproval:z.enum(['all','never']).optional()}).strict(),
]);
export const WorkerPermissionChanges=z.union([
  z.object({adapter:z.literal('codex'),sandbox:z.enum(['read-only','workspace-write','danger-full-access']).optional(),approvalPolicy:z.enum(['on-request','never']).optional()}).strict(),
  z.object({adapter:z.literal('claude'),permissionMode:z.enum(['manual','acceptEdits','dontAsk','bypassPermissions']).optional(),tools:z.array(z.enum(['Read','Glob','Grep','Edit','Write','Bash'])).min(1).max(6).optional()}).strict(),
  z.object({adapter:z.literal('pi'),tools:z.array(z.enum(['read','grep','find','ls','edit','write','bash'])).min(1).max(7).optional(),toolApproval:z.enum(['all','never']).optional()}).strict(),
]).refine(value=>Object.keys(value).some(key=>key!=='adapter'),'Specify at least one native permission change');
export const WorkerPermissionsUpdate=z.object({
  requestKey:z.string().trim().min(1).max(200),targetId:z.string().length(64),expectedRevision:z.number().int().nonnegative(),
  changes:WorkerPermissionChanges,reason:z.string().trim().min(1).max(2000),
}).strict();
export const PermissionPolicy = z.object({
  // Missing on old records. Never default this while parsing a hashed request.
  version:z.literal(2).optional(),
  mode:LegacyPermissionMode,
  sandbox:z.enum(['read-only','workspace-write','danger-full-access']),
  worker:WorkerPermissions.optional(),
}).strict();
export const PermissionRequest = z.object({
  operation:z.string().trim().min(1).max(2000),target:z.string().trim().min(1).max(2000),
  reason:z.string().trim().min(1).max(2000),scope:z.enum(['workspace-write','external']),
}).strict();
export const PermissionDecision = z.object({
  actor:z.enum(['user','main','policy']),allow:z.boolean(),reason:z.string().trim().min(1).max(2000),
  userQuote:z.string().trim().min(1).max(8000).optional(),
}).strict();
export const Answers = z.array(z.object({questionId:z.string().min(1).max(120),answer:z.string().trim().min(1).max(8000),permissionDecision:PermissionDecision.optional()}).strict()).max(10);
export const WorkerTurn = z.object({
  sessionId:z.guid(),turn:z.number().int().positive(),previousRunId:z.guid().optional(),
  message:z.string().trim().min(1).max(16000).optional(),answers:Answers.optional(),
}).strict();
export const TaskSpec = z.object({
  taskId: z.guid(), runId: z.guid(), revision: z.number().int().positive(),
  owner: Owner, goal: z.string().min(1).max(16000), originalRequest: z.string().min(1).max(32000).describe('Only the task-relevant excerpt of the user request that may be sent to this worker. Exclude local-only notes and unrelated conversation; never copy the full message by default.'),
  constraints: z.array(z.string().max(8000)).max(50), acceptance: z.array(z.string().min(1).max(2000)).min(1).max(30),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), knowledge: z.array(KnowledgeRef).max(50),
  userContext:z.array(UserContextRef).max(30).optional(),
  taskKey:TaskKey.optional(),
  worker:WorkerTurn.optional(),
  approvalMode:PermissionMode.optional(),
}).strict();
export type Spec = z.infer<typeof TaskSpec>;
export type Binding = z.infer<typeof Owner>;
export const Report = z.object({
  summary: z.string().min(1).max(32000),
  evidence: z.array(z.string().max(16000)).max(100),
  discoveries: z.array(z.object({ content: z.string().max(16000), source: z.string().max(4000), verified: z.boolean() }).strict()).max(50),
  unresolved: z.array(z.string().max(8000)).max(50),
  questions:z.array(z.object({id:z.string().min(1).max(120),text:z.string().min(1).max(2000),permission:PermissionRequest.optional()}).strict()).max(10).optional(),
}).strict();
export type Result = z.infer<typeof Report>;
// New workers ask only task questions. Legacy report permission fields remain
// readable through Report, but never appear in the strict model output schema.
export const WorkerReport=Report.extend({questions:Report.shape.questions.unwrap().element.omit({permission:true}).array().max(10)});
export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('probe') }).strict(),
  z.object({type:z.literal('worker-permissions'),adapter:z.enum(['codex','claude','pi']).optional()}).strict(),
  z.object({type:z.literal('worker-permissions-set'),permissions:WorkerPermissions,expectedRevision:z.number().int().nonnegative(),change:z.object({id:z.guid(),owner:Owner,reason:z.string().trim().min(1).max(2000),expectedEpoch:z.guid()}).strict().optional()}).strict(),
  z.object({ type:z.literal('approval-list'),runId:z.guid(),owner:Owner }).strict(),
  z.object({ type:z.literal('approval-decide'),receipt:z.unknown() }).strict(),
  z.object({ type: z.literal('maintenance'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('shutdown') }).strict(),
  z.object({ type: z.literal('resolve'), runId: z.guid(), confirmStopped: z.literal(true), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('start'), key: z.string().min(1).max(200), spec: TaskSpec }).strict(),
  z.object({ type: z.literal('cancel'), runId: z.guid() }).strict(),
  z.object({ type: z.literal('inspect'), runId: z.guid() }).strict(),
  z.object({ type: z.literal('reconcile'), runIds:z.array(z.guid()).min(1).max(8) }).strict(),
  z.object({ type: z.literal('events'), after: z.number().int().nonnegative(), page:z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('artifact'), runId: z.guid(), name: z.enum(['report.json','changes.patch']), offset: z.number().int().nonnegative() }).strict(),
]);
export type Request = z.infer<typeof Command>;
export const HostConfig = z.object({
  repository: z.string().min(1), concurrency: z.number().int().min(1).max(16).default(2),
  // Older Hosts persisted this field. It is used only to recognize old session digests.
  timeoutMs: z.number().int().min(100).max(86400000).optional(),
  adapter: z.enum(['codex','claude','pi','fixture']).default('codex'),
  executable: z.string().min(1), sandbox: z.enum(['read-only','workspace-write']).default('read-only'),
  permissionMode: LegacyPermissionMode.default('ask'),
  workerPermissions:WorkerPermissions.optional(),
  profile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  codexHome: z.string().startsWith('/').optional(),
  model: z.string().min(1).optional(), provider:z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
  settings:z.string().startsWith('/').optional(), piAgentDir:z.string().startsWith('/').optional(),
}).strict().superRefine((config,ctx)=>{
  if(config.adapter!=='codex'&&(config.profile||config.codexHome))ctx.addIssue({code:'custom',message:'profile/codexHome require codex'});
  if(config.adapter!=='claude'&&config.settings)ctx.addIssue({code:'custom',message:'settings requires claude'});
  if(config.adapter!=='pi'&&(config.provider||config.piAgentDir))ctx.addIssue({code:'custom',message:'provider/piAgentDir require pi'});
  if(config.piAgentDir&&!config.provider)ctx.addIssue({code:'custom',message:'piAgentDir requires provider'});
  if(config.workerPermissions&&config.workerPermissions.adapter!==config.adapter)ctx.addIssue({code:'custom',message:'Worker permissions must match the Host adapter'});
});
export type HostSettings = z.infer<typeof HostConfig>;
export const Endpoint = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('local'), state:z.string().min(1)}).strict(),
  z.object({kind:z.literal('ssh'), destination:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/), node:z.string().startsWith('/'), cli:z.string().startsWith('/'), state:z.string().startsWith('/')}).strict(),
]);
export type Target = z.infer<typeof Endpoint>;
export const MAX_FRAME = 2 * 1024 * 1024;
export const terminal = (s: string) => ['succeeded','waiting_input','waiting_permission','failed','canceled','unknown'].includes(s);
