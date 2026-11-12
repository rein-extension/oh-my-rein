// Standalone bootstrap: builtins only, sent over SSH before Rein is installed.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HostSettings } from './protocol.ts';

type PayloadFile = { path: string; content: string };
export type RemoteSetupInput = {
  action: 'check' | 'install'; destination: string; repository: string; baseCommit: string; update?:boolean;
  profile?: string; codexHome?: string; codex?: string;
  adapter?: 'codex'|'claude'|'pi'; executable?:string; model?:string; provider?:string; settings?:string; piAgentDir?:string;
  approvalKey?:{keyId:string;publicKey:string;instance:string};
  permissionMode?: 'ask'|'delegate'|'read-only'|'full-access';
  workerPermissions?:HostSettings['workerPermissions'];
  sandbox: 'read-only' | 'workspace-write'; digest?: string; files?: PayloadFile[];
};
const env = () => ({ ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') });
const expand = (p: string) => p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
const normalizedConfig=(c:Record<string,unknown>)=>Object.entries({permissionMode:'ask',...c}).sort();
const sameConfig=(a:Record<string,unknown>,b:Record<string,unknown>)=>JSON.stringify(normalizedConfig(a))===JSON.stringify(normalizedConfig(b));
function executable(name: string): string {
  const found = isAbsolute(name) ? name : execFileSync('sh', ['-c', 'command -v "$1"', 'rein', name], { env: env(), encoding: 'utf8' }).trim();
  if (!isAbsolute(found) || !existsSync(found)) throw Error(`Required executable not found: ${name}`);
  return realpathSync(found);
}
function run(exe: string, args: string[], input?: string, timeout = 15000, cwd?: string): string {
  return execFileSync(exe, args, { env: env(), cwd, input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
export function payloadDigest(files: PayloadFile[]): string {
  const hash = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(f.path + '\0' + f.content + '\0');
  return hash.digest('hex');
}
function checkFiles(files: PayloadFile[], digest: string) {
  if (!Array.isArray(files) || files.length > 100 || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid runtime payload');
  const seen = new Set<string>();
  let size = 0;
  for (const f of files) {
    if (typeof f.path !== 'string' || typeof f.content !== 'string' || seen.has(f.path)) throw Error('Invalid or duplicate payload entry');
    if (!/^(package\.json|package-lock\.json|bin\/rein\.mjs|dist\/runtime\/[a-z][a-z0-9-]*\.js)$/.test(f.path)) throw Error('Unexpected runtime path');
    seen.add(f.path); size += Buffer.byteLength(f.content);
  }
  if (size > 8 * 1024 * 1024 || payloadDigest(files) !== digest) throw Error('Runtime payload integrity check failed');
  for (const f of ['package.json', 'package-lock.json', 'dist/runtime/cli.js', 'dist/runtime/host.js', 'dist/runtime/runner.js']) {
    if (!seen.has(f)) throw Error(`Missing runtime file: ${f}`);
  }
}
export function remoteSetup(input: RemoteSetupInput) {
  if (!['check', 'install'].includes(input.action)) throw Error('Unknown setup action');
  if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) !== 24) throw Error('Remote Host requires macOS/Linux and Node.js 24.x');
  if (!/^[a-f0-9]{40}$/.test(input.baseCommit)) throw Error('Invalid project commit');
  const permissionMode=input.permissionMode??'ask';
  if(input.approvalKey){
    const key=input.approvalKey;
    if(!/^[a-zA-Z0-9_-]+$/.test(key.instance)||createHash('sha256').update(key.publicKey).digest('hex')!==key.keyId||createPublicKey(key.publicKey).asymmetricKeyType!=='ed25519')throw Error('Invalid local approval public key');
  }
  if(!['ask','delegate','read-only','full-access'].includes(permissionMode))throw Error('Invalid permission mode');
  if (!['read-only', 'workspace-write'].includes(input.sandbox)) throw Error('Invalid worker permissions');
  if (input.profile && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.profile)) throw Error('Invalid profile name');
  if (!input.repository || !isAbsolute(expand(input.repository))) throw Error('Remote project must be an absolute path or start with ~/');
  const adapter=input.adapter??'codex';
  if(!['codex','claude','pi'].includes(adapter))throw Error('Invalid worker adapter');
  if(adapter!=='codex'&&(input.profile||input.codexHome))throw Error('Codex profile options require the codex adapter');
  if(adapter!=='claude'&&input.settings)throw Error('Settings file requires the claude adapter');
  if(adapter!=='pi'&&(input.provider||input.piAgentDir))throw Error('Provider/auth directory options require the pi adapter');
  const native=input.workerPermissions;
  if(native){
    if(native.adapter!==adapter)throw Error('Native permissions must match worker adapter');
    if(native.adapter==='codex'){
      if(!['read-only','workspace-write','danger-full-access'].includes(native.sandbox)||!['on-request','never'].includes(native.approvalPolicy))throw Error('Invalid Codex native permissions');
    }else{
      if(native.adapter==='claude'&&!['manual','acceptEdits','dontAsk','bypassPermissions'].includes(native.permissionMode))throw Error('Invalid Claude permission mode; use manual, acceptEdits, dontAsk or bypassPermissions');
      if(native.adapter==='pi'&&native.toolApproval!==undefined&&!['all','never'].includes(native.toolApproval))throw Error('Invalid Pi tool approval policy');
      const allowed=native.adapter==='claude'?['Read','Glob','Grep','Edit','Write','Bash']:['read','grep','find','ls','edit','write','bash'];
      if(!Array.isArray(native.tools)||!native.tools.length||native.tools.some(t=>!allowed.includes(t))||new Set(native.tools).size!==native.tools.length)throw Error('Invalid native tool list');
    }
  }
  if(!native&&['ask','delegate'].includes(permissionMode)&&adapter!=='codex')throw Error('Native approval forwarding requires an interactive adapter; configure explicit native permissions for Claude/Pi.');
  const git = executable('git'), npm = executable('npm'), worker = executable(input.executable ?? input.codex ?? adapter);
  const repository = realpathSync(run(git, ['-C', expand(input.repository), 'rev-parse', '--show-toplevel']));
  try { run(git, ['-C', repository, 'cat-file', '-e', input.baseCommit + '^{commit}']); }
  catch { throw Error('The remote project does not contain the local HEAD commit. Push/fetch it, then rerun setup.'); }
  const version = run(worker, ['--version']);
  const help = run(worker, adapter==='codex'?['exec','--help']:['--help']);
  const flags=adapter==='codex'?['--ephemeral','--output-schema','--output-last-message','--sandbox']:adapter==='claude'?['--bare','--restricted','--no-session-persistence','--permission-prompts']:['--no-session','--no-extensions','--no-mcp','--no-context-files','--no-approve'];
  if(adapter==='codex'&&(native?.adapter==='codex'?native.sandbox==='danger-full-access':permissionMode==='full-access'))flags.push('danger-full-access');
  if(adapter==='claude'&&(native?.adapter==='claude'?native.permissionMode==='bypassPermissions':permissionMode==='full-access'))flags.push('bypassPermissions');
  if(native?.adapter==='claude'&&['manual','acceptEdits'].includes(native.permissionMode))flags.push('--input-format','stream-json',native.permissionMode);
  if(native?.adapter==='pi'&&native.toolApproval==='all')flags.push('--extension','rpc');
  for(const flag of flags)if(!help.includes(flag))throw Error(`Remote ${adapter} does not support ${flag}; install a compatible CLI before setup.`);
  if (adapter==='codex'&&!input.profile && !help.includes('--ignore-user-config')) throw Error('Remote Codex does not support --ignore-user-config; configure an explicit profile or use a compatible CLI.');
  if(adapter==='codex'&&(native?.adapter==='codex'?native.approvalPolicy!=='never':['ask','delegate'].includes(permissionMode)))run(worker,['app-server','--help']);
  const settings=input.settings?realpathSync(expand(input.settings)):undefined;
  const piAgentDir=input.piAgentDir?realpathSync(expand(input.piAgentDir)):undefined;
  if(piAgentDir&&!input.provider)throw Error('Pi auth directory requires an explicit provider');
  let codexHome: string | undefined;
  if (input.profile) {
    const source = expand(input.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    if (!existsSync(join(source, input.profile + '.config.toml'))) throw Error(`Remote profile not found: ${input.profile}.config.toml. Configure it on the remote machine or specify --remote-codex-home.`);
    codexHome = realpathSync(source);
  }
  const root = join(homedir(), '.local/share/oh-my-rein');
  const hostId = createHash('sha256').update(adapter==='codex'?repository:repository+'\0'+adapter).digest('hex').slice(0, 16);
  const state = join(root, 'hosts', hostId);
  if (Buffer.byteLength(join(state, 'host.sock')) > 100) throw Error('Remote home path is too long for the Host Unix socket. Use an account with a shorter home path.');
  const config = {
    repository, adapter, executable: worker, concurrency: 2,
    sandbox: input.sandbox, ...(native?{workerPermissions:native}:{}), ...(permissionMode==='ask'?{}:{permissionMode}), ...(input.model?{model:input.model}:{}), ...(input.provider?{provider:input.provider}:{}), ...(settings?{settings}:{}), ...(piAgentDir?{piAgentDir}:{}), ...(input.profile ? { profile: input.profile, codexHome } : {}),
  };
  const receipt = join(state, 'installation.json'), configPath = join(state, 'host.json');
  const prior = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : undefined;
  if (existsSync(configPath) && (!prior || (!input.update&&!sameConfig(JSON.parse(readFileSync(configPath, 'utf8')),config)))) {
    throw Error('An existing Host has different configuration. Rerun with --update to drain and update a managed Host.');
  }
  if (prior && input.digest && prior.digest !== input.digest&&!input.update) throw Error('This Host uses a different runtime build. Rerun with --update; existing work has been left untouched.');
  const checked = { repository, node: process.execPath, adapter, workerVersion: version, state, reused: !!prior, modelAuthentication: 'not-tested' };
  if (input.action === 'check') return checked;
  if (!input.files || !input.digest) throw Error('Missing runtime payload');
  checkFiles(input.files, input.digest);
  const release = join(root, 'releases', input.digest);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Reject concurrent setups rather than racing installs or Host configuration writes.
  const lock = join(root, 'setup.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw Error(`Another setup is running, or an interrupted setup left ${lock}. Confirm it has stopped before removing that empty lock directory.`); }
  let staging: string | undefined;
  try {
    // Recheck under the setup lock in case another installer finished during preflight.
    if (existsSync(configPath) && !input.update&&!sameConfig(JSON.parse(readFileSync(configPath, 'utf8')),config)) throw Error('Existing Host configuration changed during setup');
    if (existsSync(receipt) && !input.update&&JSON.parse(readFileSync(receipt, 'utf8')).digest !== input.digest) throw Error('Existing Host runtime changed during setup');
    if(existsSync(receipt)&&JSON.stringify(JSON.parse(readFileSync(receipt,'utf8')))!==JSON.stringify(prior))throw Error('Installation changed since preflight; retry setup');
    if (!existsSync(join(release, '.ready'))) {
      if (existsSync(release)) throw Error('Incomplete runtime release found; setup will not overwrite it.');
      staging = join(root, 'releases', '.staging-' + randomUUID());
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const f of input.files) {
        const file = join(staging, f.path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, f.content, { mode: f.path.startsWith('bin/') ? 0o700 : 0o600, flag: 'wx' });
      }
      try { run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], undefined, 180000, staging); }
      catch (error) {
        const log = join(root, 'dependency-install.log');
        writeFileSync(log, String((error as { stderr?: string }).stderr ?? 'Dependency installation failed'), { mode: 0o600 });
        throw Error(`Remote dependency installation failed. Inspect ${log}, then rerun setup. No Host configuration was changed.`);
      }
      writeFileSync(join(staging, '.ready'), input.digest, { mode: 0o600 });
      renameSync(staging, release); staging = undefined;
    } else if (readFileSync(join(release, '.ready'), 'utf8') !== input.digest) throw Error('Runtime release marker mismatch');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const cli = join(release, 'dist/runtime/cli.js');
    // Keep the transport address stable so existing main ledgers retain ownership.
    const bridgeCli=prior?.bridgeCli??(prior?join(prior.release,'dist/runtime/cli.js'):cli);
    const bridgeNode=prior?.bridgeNode??process.execPath;
    if(prior&&input.update){
      let running=false;
      try{const response=JSON.parse(run(process.execPath,[cli,'bridge','--state',state],'{"type":"probe"}\n',3000));running=!!response.ok;}catch{}
      if(running){
        try{run(process.execPath,[cli,'host','stop','--state',state],undefined,12000);}
        catch{throw Error(`Host update paused. Existing tasks may still be running or unknown; inspect ${state}, settle them, then retry --update. The Host may be draining; use host resume to accept new work.`);}
      }
      const plan=join(state,'requested-installation.json');
      writeFileSync(plan,JSON.stringify({config,receipt:{digest:input.digest,release,bridgeCli,bridgeNode}}),{mode:0o600});
      try{run(process.execPath,[cli,'host','install-config','--state',state,'--file',plan]);}
      catch{throw Error(`Host configuration update did not complete. State was retained. Inspect ${state} and retry --update with the same package and options.`);}
      rmSync(plan,{force:true});
    }
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    if (!existsSync(receipt)) writeFileSync(receipt, JSON.stringify({ digest: input.digest, release, bridgeCli, bridgeNode }), { mode: 0o600, flag: 'wx' });
    if(input.approvalKey){
      const key=input.approvalKey;
      const keyFile=join(state,'approval-keys.json'),keys=existsSync(keyFile)?JSON.parse(readFileSync(keyFile,'utf8')):{};
      keys[key.keyId]={publicKey:key.publicKey,instance:key.instance};
      const temporary=keyFile+'.tmp-'+randomUUID();writeFileSync(temporary,JSON.stringify(keys),{mode:0o600});renameSync(temporary,keyFile);
    }
    let probe: any;
    try {
      const response = JSON.parse(run(process.execPath, [cli, 'bridge', '--state', state], '{"type":"probe"}\n', 3000));
      if (!response.ok) throw Error('Host probe failed');
      probe = response.value;
    } catch {
      try { probe = JSON.parse(run(process.execPath, [cli, 'host', 'start', '--state', state])); }
      catch {
        throw Error(`Host startup failed. On the remote machine, run ${process.execPath} ${cli} host serve --state ${state} to inspect diagnostics. Existing state was retained.`);
      }
    }
    if (probe.protocol !== 1 || probe.adapter !== adapter || probe.repository !== repository) throw Error('Running Host does not match the requested setup');
    if(input.update){
      const resumed=JSON.parse(run(process.execPath,[cli,'bridge','--state',state],'{"type":"maintenance","enabled":false}\n'));
      if(!resumed.ok)throw Error('Updated Host could not leave maintenance; inspect before dispatch');
      probe.maintenance=false;
    }
    return { ...checked, endpoint: { kind: 'ssh', destination: input.destination, node: bridgeNode, cli:bridgeCli, state }, probe };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv.includes('--rein-setup-remote')) {
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 12 * 1024 * 1024) throw Error('Setup request too large');
    }
    process.stdout.write(JSON.stringify({ ok: true, result: remoteSetup(JSON.parse(input)) }) + '\n');
  } catch (error) {
    // Do not echo the request or inherited provider credentials into setup output.
    const e = error as Error & { status?: number };
    const message = typeof e.status === 'number' ? 'A remote prerequisite command failed. Check Node 24, npm, Git, the selected worker CLI and project access.' : e.message;
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
    process.exitCode = 1;
  }
}
