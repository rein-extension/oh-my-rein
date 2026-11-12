import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { buildLocalPlugin } from '../src/plugin.ts';
import { Harness } from '../src/plugin-common.ts';

const { values: v } = parseArgs({ options: {
  harness: { type: 'string', default: 'codex' }, endpoint: { type: 'string' },
  state: { type: 'string' }, project: { type: 'string' }, instance: { type: 'string' }, output: { type: 'string' },
} });
if (!v.endpoint || !v.state || !v.project || !v.instance) throw Error('Required: --endpoint FILE --state DIR --project DIR --instance STABLE_ID');
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v.instance)) throw Error('Instance must be a stable alphanumeric label');
const harness = Harness.parse(v.harness);
const result = buildLocalPlugin(fileURLToPath(new URL('../', import.meta.url)),
  resolve(v.output ?? `dist/${harness}-marketplace`), harness, {
    state: resolve(v.state), config: realpathSync(v.endpoint), project: realpathSync(v.project), instance: v.instance,
  });
console.log(JSON.stringify({ ...result, note: 'Development output uses the shared plugin builder and compiled runtime. Keep the runtime and resolved Node executable available. No harness was installed.' }, null, 2));
