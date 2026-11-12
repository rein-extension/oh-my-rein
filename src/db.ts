import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FRAME } from './protocol.ts';
import type { Binding } from './protocol.ts';

export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, {recursive:true, mode:0o700});
    this.db = new DatabaseSync(join(directory,'rein.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kv_owner ON kv(bucket, json_extract(value,'$.owner.harness'), json_extract(value,'$.owner.instance'), json_extract(value,'$.owner.session'));
      CREATE INDEX IF NOT EXISTS kv_execution_owner ON kv(bucket, json_extract(value,'$.spec.owner.harness'), json_extract(value,'$.spec.owner.instance'), json_extract(value,'$.spec.owner.session'));
      CREATE INDEX IF NOT EXISTS kv_scope ON kv(bucket, json_extract(value,'$.scope'));
      CREATE INDEX IF NOT EXISTS kv_incoming_pending ON kv(bucket, json_extract(value,'$.handled'), CAST(json_extract(value,'$.seq') AS INTEGER));
      CREATE INDEX IF NOT EXISTS kv_run_state ON kv(bucket, json_extract(value,'$.state'));
    `);
  }
  get<T>(bucket: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE bucket=? AND key=?').get(bucket,key);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  set(bucket: string, key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(bucket,key,JSON.stringify(value));
  }
  list<T>(bucket: string): T[] { return this.db.prepare('SELECT value FROM kv WHERE bucket=? ORDER BY rowid').all(bucket).map(r=>JSON.parse(r.value as string)); }
  runsIn<T>(states:string[]):T[]{return this.db.prepare(`SELECT value FROM kv WHERE bucket='runs' AND json_extract(value,'$.state') IN (${states.map(()=>'?').join(',')}) ORDER BY rowid`).all(...states).map(r=>JSON.parse(r.value as string));}
  openApprovalRunIds():string[]{return this.db.prepare("SELECT DISTINCT json_extract(value,'$.runId') AS runId FROM kv WHERE bucket='approvals' AND json_extract(value,'$.state') IN ('pending','approved','denied','responding')").all().map(r=>String(r.runId));}
  owned<T>(bucket:'tasks'|'user-tasks',owner:Binding):T[]{
    const path=bucket==='tasks'?'$.spec.owner':'$.owner';
    return this.db.prepare(`SELECT value FROM kv WHERE bucket=? AND json_extract(value,'${path}.harness')=? AND json_extract(value,'${path}.instance')=? AND json_extract(value,'${path}.session')=? ORDER BY rowid`).all(bucket,owner.harness,owner.instance,owner.session).map(r=>JSON.parse(r.value as string));
  }
  scoped<T>(bucket:string,scope:string):T[]{return this.db.prepare("SELECT value FROM kv WHERE bucket=? AND json_extract(value,'$.scope')=? ORDER BY rowid").all(bucket,scope).map(r=>JSON.parse(r.value as string));}
  pendingIncoming<T>():T[]{return this.db.prepare("SELECT value FROM kv WHERE bucket='incoming' AND json_extract(value,'$.handled')=0 ORDER BY CAST(json_extract(value,'$.seq') AS INTEGER)").all().map(r=>JSON.parse(r.value as string));}
  transaction<T>(fn:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(run: string, data: unknown) { return Number(this.db.prepare('INSERT INTO events(run,data) VALUES(?,?)').run(run,JSON.stringify(data)).lastInsertRowid); }
  eventCursor(){return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get()!.seq);}
  events(after:number) { return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 100').all(after).map(r=>({seq:Number(r.seq),run:r.run as string,data:JSON.parse(r.data as string)})); }
  eventPage(after:number,project:(data:any)=>unknown=(data)=>data){
    const rows=this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 101').all(after);
    const events:{seq:number;run:string;data:any}[]=[];
    // Reserve envelope/cursor bytes; measure UTF-8 JSON, not character count.
    let bytes=256;
    for(const row of rows.slice(0,100)){
      const event={seq:Number(row.seq),run:String(row.run),data:project(JSON.parse(String(row.data)))},size=Buffer.byteLength(JSON.stringify(event))+1;
      if(bytes+size>MAX_FRAME){if(!events.length)throw Error('Event exceeds frame limit; update the Main to use paged events');break;}
      events.push(event);bytes+=size;
    }
    return {events,nextCursor:events.at(-1)?.seq??after,hasMore:rows.length>events.length};
  }
  close() { this.db.close(); }
}
