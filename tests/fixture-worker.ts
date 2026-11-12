import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root=process.argv[2]!;
const spec=JSON.parse(readFileSync(join(root,'context.json'),'utf8'));
// Opt-in conversational tests hold workers until the driver releases each run.
// This is only loaded by the explicitly enabled fixture adapter.
if(process.env.REIN_FIXTURE_RELEASE_DIR)while(!existsSync(join(process.env.REIN_FIXTURE_RELEASE_DIR,spec.runId)))await new Promise(r=>setTimeout(r,100));
await new Promise(r=>setTimeout(r,spec.goal.includes('slow')?2500:100));
writeFileSync('result.txt',spec.goal+'\n');
writeFileSync(join(root,'report.json'),JSON.stringify({summary:'Fixture completed: '+spec.goal,evidence:['Created result.txt in isolated checkout'],discoveries:[{content:'Fixture project uses result.txt',source:'result.txt',verified:true}],unresolved:[]}));
