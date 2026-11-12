import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Endpoint, PermissionMode } from './protocol.ts';
import { ensureApprovalKey } from './approval-authority.ts';
import { buildLocalPlugin, installLocalPlugin } from './plugin.ts';
import { conversationCommands } from './plugin-common.ts';
import { z } from 'zod';
import { payloadDigest } from './setup-remote.ts';
import type { RemoteSetupInput } from './setup-remote.ts';
import { validateWorkerPermissions } from './permissions.ts';

export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const expand = (p: string) => p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
const childEnv = () => ({ ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') });
function run(exe: string, args: string[], input?: string, timeout = 15000, structuredRemoteError = false): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(exe, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', settled = false;
    const finish = (e?: Error) => { if (settled) return; settled = true; clearTimeout(timer); e ? rej(e) : res(output.trim()); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(Error(`${basename(exe)} timed out. Remote setup may still be running; inspect it before retrying.`)); }, timeout);
    child.stdout.on('data', b => { output += b; if (Buffer.byteLength(output) > 16 * 1024 * 1024) { child.kill(); finish(Error('Command output too large')); } });
    child.stderr.on('data', b => { error = (error + b).slice(-4000); });
    child.on('error', e => finish(Error(`Cannot run ${exe}: ${e.message}`)));
    child.on('close', code => {
      // Remote helper returns structured errors even when its exit code is nonzero.
      if (structuredRemoteError && output.trimStart().startsWith('{')) return finish();
      finish(code === 0 ? undefined : Error(`${basename(exe)} failed (${code}): ${error.trim()}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
function executable(name: string): string {
  const found = execFileSync('sh', ['-c', 'command -v "$1"', 'rein', name], { env: childEnv(), encoding: 'utf8' }).trim();
  return realpathSync(found);
}
export function runtimePayload(root: string) {
  const files = ['package.json', 'bin/rein.mjs', ...readdirSync(join(root, 'dist/runtime')).filter(f => f.endsWith('.js')).map(f => 'dist/runtime/' + f)]
    .map(path => ({ path, content: readFileSync(join(root, path), 'utf8') }));
  files.push({ path: 'package-lock.json', content: readFileSync(join(root, 'dist/runtime/dependencies.lock.json'), 'utf8') });
  return { files, digest: payloadDigest(files) };
}
function saveJSON(path: string, value: unknown) {
  const temporary = path + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export async function runSetup(args: string[]) {
  const { values: v } = parseArgs({ args, options: {
    host: { type: 'string' }, project: { type: 'string' }, 'remote-project': { type: 'string' },
    profile: { type: 'string' }, 'remote-codex-home': { type: 'string' },
    'remote-node': { type: 'string' }, 'remote-codex': { type: 'string' }, codex: { type: 'string' },
    harness:{type:'string'},worker:{type:'string'},'local-executable':{type:'string'},'remote-executable':{type:'string'},model:{type:'string'},provider:{type:'string'},'remote-settings':{type:'string'},'remote-pi-agent-dir':{type:'string'},
    sandbox: { type: 'string' }, 'permission-mode': {type:'string'}, yes: { type: 'boolean' }, help: { type: 'boolean' }, update:{type:'boolean'},
    'approval-policy':{type:'string'},'claude-permission-mode':{type:'string'},'pi-tool-approval':{type:'string'},tools:{type:'string'},
  } });
  if (v.help) {
    console.log(`Usage: rein setup [options]

Interactive: rein setup
Scripted:    rein setup --host worker-host --project ./my-app --remote-project '~/projects/my-app' --yes

  --harness NAME            Local main agent: codex (default), claude, pi
  --worker NAME             Remote execution adapter: codex (default), claude, pi
  --local-executable PATH   Local harness CLI override
  --remote-executable PATH  Remote worker CLI override
  --model NAME              Remote worker model
  --provider NAME           Pi provider
  --remote-settings FILE    Claude provider settings (env keys only)
  --remote-pi-agent-dir DIR  Pi API-key source; no sessions/memory imported
  --host ALIAS              Existing SSH alias or user@host
  --project PATH            Local project (default: current directory)
  --remote-project PATH     Existing remote project; absolute path or quoted ~/path
  --profile NAME            Remote NAME.config.toml profile (optional)
  --remote-codex-home PATH  Directory containing that remote profile
  --permission-mode MODE    Approval routing: ask (default) or delegate
  --sandbox MODE            Codex: workspace-write (default), read-only, danger-full-access
  --approval-policy MODE    Codex: on-request (default) or never
  --claude-permission-mode MODE  Claude: manual (default), acceptEdits, dontAsk, bypassPermissions
  --tools LIST              Claude/Pi native tool names, comma separated; defaults to read tools
  --pi-tool-approval MODE    Pi: all (default, approve each enabled tool) or never
  --remote-node PATH        Node 24 executable if absent from remote login PATH
  --remote-codex PATH       Remote Codex executable if absent from PATH
  --codex PATH              Local Codex executable (default: codex)
  --yes                     Apply the displayed plan without a confirmation prompt
  --update                  Drain an existing Host and update its runtime/configuration

Setup checks tools and the shared Git commit, deploys the runtime, starts a Host,
and installs the selected local harness plugin. It never copies credentials or calls a model.
Remote Node 24, npm, Git, the selected worker CLI and model access must already be configured.
Rerunning the same setup reuses its state. Updates require --update and no unsettled tasks.
Repeat all desired provider and permission options; omitted options use defaults.`);
    return;
  }
  if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) !== 24) throw Error('Setup requires macOS/Linux and Node.js 24.x');
  const interactive = !!process.stdin.isTTY;
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (label: string, fallback = '') => {
    if (!prompt) throw Error(`Missing ${label}. Use --help for noninteractive options.`);
    const answer = (await prompt.question(`${label}${fallback ? ' [' + fallback + ']' : ''}: `)).trim();
    return answer || fallback;
  };
  try {
    console.log('\nOh My Rein — connect your remote workspace\n');
    const destination = v.host ?? await ask('SSH host');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(destination)) throw Error('Use an SSH alias or user@host; set ports and keys in your SSH config.');
    const localInput = v.project ?? (interactive ? await ask('Local project', process.cwd()) : process.cwd());
    const project = realpathSync((await run('git', ['-C', expand(localInput), 'rev-parse', '--show-toplevel'])).trim());
    const baseCommit = await run('git', ['-C', project, 'rev-parse', 'HEAD']);
    const repository = v['remote-project'] ?? await ask('Remote project', '~/projects/' + basename(project));
    const harness=z.enum(['codex','claude','pi']).parse(v.harness??'codex');
    const worker=z.enum(['codex','claude','pi']).parse(v.worker??'codex');
    const profile = v.profile ?? (interactive&&worker==='codex' ? await ask('Remote provider profile (blank for default Codex)') : '');
    const permissionMode = PermissionMode.parse(v['permission-mode'] ?? (interactive ? await ask('Who answers worker approvals: ask / delegate', 'ask') : 'ask'));
    if(worker!=='codex'&&(v.sandbox||v['approval-policy']))throw Error('--sandbox/--approval-policy require Codex');
    if(worker!=='pi'&&v['pi-tool-approval'])throw Error('--pi-tool-approval requires Pi');
    if(worker!=='claude'&&v['claude-permission-mode'])throw Error('--claude-permission-mode requires Claude');
    if(worker==='codex'&&v.tools)throw Error('--tools is supported for Claude/Pi');
    const sandbox=v.sandbox??'workspace-write';
    const workerPermissions=validateWorkerPermissions(worker==='codex'?{adapter:worker,sandbox,approvalPolicy:v['approval-policy']??'on-request'}:worker==='claude'?{adapter:worker,permissionMode:v['claude-permission-mode']??'manual',tools:(v.tools??'Read,Glob,Grep').split(',').map(s=>s.trim())}:{adapter:worker,tools:(v.tools??'read,grep,find,ls').split(',').map(s=>s.trim()),toolApproval:v['pi-tool-approval']??'all'});
    if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw Error('Invalid provider profile name');
    if (v['remote-codex-home'] && !profile) throw Error('--remote-codex-home requires --profile');
    const localExecutable = executable(v['local-executable'] ?? v.codex ?? harness);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const payload = runtimePayload(root);
    const helper = readFileSync(join(root, 'dist/runtime/setup-remote.js'), 'utf8');
    const remoteNode = v['remote-node'] ?? 'node';
    if (/[\0\r\n]/.test(remoteNode)) throw Error('Invalid remote Node executable');
    const command = 'sh -lc ' + shellQuote(shellQuote(remoteNode) + ' --input-type=module -e ' + shellQuote(helper) + ' -- --rein-setup-remote');
    const request: RemoteSetupInput = { action: 'check', destination, repository, baseCommit, update:v.update, permissionMode,workerPermissions, sandbox: sandbox==='read-only'?'read-only':'workspace-write', digest: payload.digest, adapter:worker, executable:v['remote-executable'],model:v.model,provider:v.provider,settings:v['remote-settings'],piAgentDir:v['remote-pi-agent-dir'],
      ...(profile ? { profile } : {}), ...(v['remote-codex-home'] ? { codexHome: v['remote-codex-home'] } : {}), ...(v['remote-codex'] ? { codex: v['remote-codex'] } : {}) };
    const remote = async (data: RemoteSetupInput) => {
      const result = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', destination, command], JSON.stringify(data), 210000, true);
      let response;
      try { response = JSON.parse(result); } catch { throw Error('Remote setup returned unexpected output. Check the remote Node path and login-shell output.'); }
      if (!response.ok) throw Error(response.error ?? 'Remote setup failed');
      return response.result;
    };
    console.log('Checking local harness, SSH, remote tools and shared project commit…');
    await run(localExecutable,['--version']);
    if(harness==='codex'){await run(localExecutable, ['plugin', 'marketplace', 'add', '--help']);await run(localExecutable, ['plugin', 'add', '--help']);}
    const checked = await remote(request);
    const setupId = createHash('sha256').update(JSON.stringify(harness==='codex'&&worker==='codex'?[destination,checked.repository,project]:[destination,checked.repository,project,harness,worker])).digest('hex').slice(0, 16);
    const directory = join(homedir(), '.local/share/oh-my-rein/connections', setupId);
    const settings = { destination, project, repository: checked.repository, digest: payload.digest, profile, sandbox,workerPermissions, ...(permissionMode==='ask'?{}:{permissionMode}), ...(harness!=='codex'||worker!=='codex'?{harness,worker}:{}), ...(v.model?{model:v.model}:{}), ...(v.provider?{provider:v.provider}:{}) };
    const receipt = join(directory, 'setup.json');
    if (existsSync(receipt) && !v.update&&JSON.stringify(JSON.parse(readFileSync(receipt, 'utf8'))) !== JSON.stringify(settings)) throw Error('This local connection has different setup options. Use --update; existing state has not been changed.');
    if(v.update)console.log('Update requested: the Host will drain and stop before changing configuration. Unsettled tasks block the update.');
    console.log(`\nLocal project:  ${project}\nRemote project: ${destination}:${checked.repository}\nWorkers:        2 concurrent\nApproval route: ${permissionMode}\nNative permissions: ${JSON.stringify(workerPermissions)}\nProvider:       ${worker} ${v.model||profile||'(default model)'}\n\nWill deploy a pinned runtime and start a remote Host, then install a local ${harness} plugin.\nModel authentication is not tested by setup; remote credentials must already be available.\n`);
    if (!v.yes && (await ask('Apply this setup? yes / no', 'no')).toLowerCase() !== 'yes') { console.log('Setup canceled. No installation changes were made.'); return; }
    console.log('Deploying remote runtime and starting Host…');
    const instance = 'rein-' + setupId;
    const approvalKey=ensureApprovalKey(join(directory,'main'),instance);
    const installed = await remote({ ...request, approvalKey, action: 'install', ...payload });
    const endpoint = Endpoint.parse(installed.endpoint);
    if (endpoint.kind !== 'ssh' || endpoint.destination !== destination || installed.probe?.repository !== checked.repository) throw Error('Remote installation receipt does not match the requested connection');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    saveJSON(receipt, settings);
    const endpointFile = join(directory, 'endpoint.json'); saveJSON(endpointFile, endpoint);
    const packaged=buildLocalPlugin(root,join(directory,'marketplace'),harness,{state:join(directory,'main'),config:endpointFile,project,instance});
    console.log(`Installing local ${harness} plugin…`);
    // Retain the remote receipt if local installation fails so a retry is safe.
    installLocalPlugin(harness,localExecutable,packaged.marketplace,project,instance,v.update);
    const commands=conversationCommands(harness);
    console.log(`\nInstalled: remote Host connected; local ${harness} plugin installed.\n\nStart here\n  1. Reload ${harness} and open: ${project}\n  2. In that conversation, enter: ${commands.on}\n  3. Try: Send a remote worker to inspect this project's README without changing files.\n\nSession controls: ${commands.status} (cached workers), ${commands.off} (turn Rein off).\nActivation reports the current Host connection and concurrency limit.\nModel access is verified by the first real task, which may use provider credits.\nKeep chatting while workers run. Enter ${commands.sync} for one sync pass, or ask “Sync my Rein tasks”.\nNew conversations start with Rein off. Turning it off does not cancel running tasks.\n\nSetup record: ${receipt}\nThe Host runs as a detached process, not a boot service. Rerun the same setup after a remote reboot.\n`);
  } finally { prompt?.close(); }
}
