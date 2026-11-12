import { z } from 'zod';
import { Store } from './db.ts';
import { ContextInput, ContextUpdate, ContextSelection, PageQuery, canonical, hash, id } from './protocol.ts';
import type { Binding, Spec } from './protocol.ts';
import type { UserTask } from './main.ts';

export type ContextEntry=z.infer<typeof ContextInput>&{
  id:string;version:number;scope:string;active:boolean;createdAt:number;updatedAt:number;
  origin:'user_statement';recordedBy:Binding;retiredReason?:string;
};
const normalizeText=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const strings=(x:unknown):string[]=>typeof x==='string'?[x]:Array.isArray(x)?x.flatMap(strings):x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
export type ContextSnapshot={entries:ContextEntry[];byId:Map<string,ContextEntry>;localOnly:{id:string;texts:string[]}[];required:Map<string,ContextEntry[]>};

// Project-scoped user statements live separately from worker discoveries.
// The main agent supplies a relevant quote; this is provenance, not independent
// verification that a statement occurred in the native conversation.
export class ContextStore {
  readonly db:Store;readonly scope:string;readonly owner:Binding;
  constructor(db:Store,scope:string,owner:Binding){this.db=db;this.scope=scope;this.owner=owner;}
  private normalize(n:ContextEntry):ContextEntry{
    const appliesTo=n.appliesTo??{type:'project'};
    return {...n,appliesTo,requiredForTask:n.requiredForTask??(appliesTo.type==='task'&&n.kind!=='preference')};
  }
  private visible(n:ContextEntry){return n.scope===this.scope&&(n.appliesTo.type==='project'||canonical(n.recordedBy)===canonical(this.owner));}
  list(includeInactive=false){return this.db.scoped<ContextEntry>('user-context',this.scope).map(n=>this.normalize(n)).filter(n=>this.visible(n)&&(includeInactive||n.active));}
  snapshot():ContextSnapshot{
    const entries=this.list(true),required=new Map<string,ContextEntry[]>();
    for(const n of entries)if(n.active&&n.requiredForTask&&n.appliesTo.type==='task'){
      const group=required.get(n.appliesTo.taskKey)??[];group.push(n);required.set(n.appliesTo.taskKey,group);
    }
    return {entries,byId:new Map(entries.map(n=>[n.id,n])),required,localOnly:entries.filter(n=>!n.shareWithWorkers).map(n=>({id:n.id,texts:[n.content,n.quote].map(normalizeText).filter(s=>s.length>=12)})).filter(n=>n.texts.length)};
  }
  required(taskKey?:string,snapshot=this.snapshot()){return taskKey?snapshot.required.get(taskKey)??[]:[];}
  private revisionKey(taskKey:string){return hash(canonical({scope:this.scope,owner:this.owner,taskKey}));}
  requiredRevision(taskKey?:string){return taskKey?this.db.get<number>('required-context-revisions',this.revisionKey(taskKey))??0:0;}
  missingRequired(refs:Spec['userContext'],taskKey?:string,snapshot=this.snapshot()){
    const selected=new Map((refs??[]).map(n=>[n.id,n.version]));
    return this.required(taskKey,snapshot).filter(n=>!n.shareWithWorkers||selected.get(n.id)!==n.version).map(n=>n.id);
  }
  page(query:{includeInactive?:boolean;taskKey?:string;offset?:number;limit?:number}={}){
    const {offset,limit}=PageQuery.parse(query);
    const all=this.list(query.includeInactive).filter(n=>!query.taskKey||n.appliesTo.type==='project'||n.appliesTo.taskKey===query.taskKey);
    return {entries:all.slice(offset,offset+limit).map(n=>({id:n.id,version:n.version,kind:n.kind,appliesTo:n.appliesTo,active:n.active,shareWithWorkers:n.shareWithWorkers,requiredForTask:n.requiredForTask,preview:n.content.slice(0,240),truncated:n.content.length>240})),total:all.length,nextOffset:offset+limit<all.length?offset+limit:null};
  }
  get(contextId:string){
    const raw=this.db.get<ContextEntry>('user-context',contextId),note=raw?this.normalize(raw):undefined;
    if(!note||!this.visible(note))throw Error('User context scope mismatch or missing entry');
    return note;
  }
  history(contextId:string){this.get(contextId);return this.db.list<ContextEntry>('user-context-history').filter(n=>n.scope===this.scope&&n.id===contextId).map(n=>this.normalize(n)).sort((a,b)=>a.version-b.version);}
  private save(note:ContextEntry){
    note=this.normalize(note);
    if(note.requiredForTask&&note.appliesTo.type!=='task')throw Error('requiredForTask is only supported for task-scoped context');
    const raw=this.db.get<ContextEntry>('user-context',note.id),prior=raw?this.normalize(raw):undefined;
    const requirement=(n:ContextEntry)=>({required:n.requiredForTask,active:n.active,content:n.content,shareWithWorkers:n.shareWithWorkers});
    if(note.appliesTo.type==='task'&&(note.requiredForTask||prior?.requiredForTask)&&(!prior||canonical(requirement(prior))!==canonical(requirement(note)))){
      const taskKey=note.appliesTo.taskKey;
      this.db.set('required-context-revisions',this.revisionKey(taskKey),this.requiredRevision(taskKey)+1);
      // This runs inside the same transaction as the context mutation: acceptance
      // can never observe the new requirement with an old parent revision.
      const parent=this.db.owned<UserTask>('user-tasks',this.owner).find(t=>t.taskKey===taskKey);
      if(parent){
        parent.version++;parent.revision++;parent.updatedAt=Date.now();parent.reason=`Required context changed: ${note.id}@${note.version}`;
        delete parent.completion;if(parent.status==='completed')parent.status='active';
        this.db.set('user-tasks',parent.id,parent);this.db.set('user-task-history',`${parent.id}:${parent.version}`,parent);
      }
    }
    this.db.set('user-context',note.id,note);this.db.set('user-context-history',`${note.id}:${note.version}`,note);return note;
  }
  record(requestKey:string,raw:unknown){
    const input=ContextInput.parse(raw);z.string().min(1).max(200).parse(requestKey);
    return this.db.transaction(()=>{
      const key=hash(canonical({scope:this.scope,owner:this.owner,requestKey})),digest=hash(canonical(input));
      const old=this.db.get<{id:string;digest:string}>('context-requests',key);
      if(old){if(old.digest!==digest)throw Error('Context request key content conflict');return this.get(old.id);}
      const now=Date.now(),note=this.save({...input,id:id(),version:1,scope:this.scope,active:true,createdAt:now,updatedAt:now,origin:'user_statement',recordedBy:this.owner});
      this.db.set('context-requests',key,{id:note.id,digest});return note;
    });
  }
  update(contextId:string,expectedVersion:number,raw:unknown){
    const input=ContextUpdate.parse(raw);
    return this.db.transaction(()=>{
      const prior=this.get(contextId);
      if(!prior.active||prior.version!==expectedVersion)throw Error('User context is inactive or its version changed; reload before editing');
      return this.save({...prior,...input,version:prior.version+1,updatedAt:Date.now(),recordedBy:this.owner});
    });
  }
  retire(contextId:string,expectedVersion:number,reason:string){
    z.string().trim().min(1).max(2000).parse(reason);
    return this.db.transaction(()=>{
      const prior=this.get(contextId);
      if(!prior.active||prior.version!==expectedVersion)throw Error('User context is inactive or its version changed; reload before retiring');
      return this.save({...prior,active:false,version:prior.version+1,updatedAt:Date.now(),recordedBy:this.owner,retiredReason:reason});
    });
  }
  select(raw:unknown,taskKey?:string):NonNullable<Spec['userContext']>{
    return ContextSelection.parse(raw).map(contextId=>{
      const n=this.get(contextId);
      if(!n.active||!n.shareWithWorkers)throw Error('Selected user context is inactive or local-only');
      if(n.appliesTo.type==='task'&&n.appliesTo.taskKey!==taskKey)throw Error('Selected context belongs to a different taskKey');
      return {id:n.id,version:n.version,kind:n.kind,content:n.content,origin:n.origin,source:`conversation:${hash(canonical(n.recordedBy))}/context:${n.id}@${n.version}`};
    });
  }
  changed(refs:Spec['userContext'],snapshot=this.snapshot()){
    return (refs??[]).filter(ref=>{
      const n=snapshot.byId.get(ref.id);
      return !n||n.scope!==this.scope||!n.active||!n.shareWithWorkers||n.version!==ref.version;
    }).map(ref=>ref.id);
  }
  localOnlyMatches(payload:unknown,snapshot=this.snapshot()){
    if(!snapshot.localOnly.length)return [];
    const text=strings(payload).map(normalizeText).join('\n');
    // A deterministic guard against known verbatim leaks, not semantic DLP.
    // Short generic phrases are left to the main agent to avoid false matches.
    return snapshot.localOnly.filter(n=>n.texts.some(s=>text.includes(s))).map(n=>n.id);
  }
}
