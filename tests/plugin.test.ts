import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLocalPlugin, installLocalPlugin } from '../src/plugin.ts';
import type { HarnessName } from '../src/plugin.ts';

const harnesses: HarnessName[] = ['codex', 'claude', 'pi'];
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function fixture() {
  const directory = mkdtempSync('/tmp/rein-plugin-');
  const root = join(directory, "package with ' spaces");
  const project = join(directory, "project ' $literal");
  mkdirSync(join(root, 'dist/runtime'), { recursive: true });
  mkdirSync(project);
  cpSync(resolve('plugins'), join(root, 'plugins'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'oh-my-rein', version: '9.8.7-test', type: 'module' }));
  writeFileSync(join(root, 'dist/runtime/cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  writeFileSync(join(root, 'dist/runtime/pi-extension.js'), 'export function installPiExtension(pi,connection,instructions){pi.capture({connection,instructions});}');
  const config = join(directory, 'endpoint.json');
  writeFileSync(config, JSON.stringify({ kind: 'local', state: join(directory, 'host') }));
  const connection = { state: join(directory, 'main'), config, project, instance: 'plugin-test' };
  const instructions = readFileSync(join(root, 'plugins/shared/skills/rein/SKILL.md'), 'utf8');
  return { directory, root, project, connection, instructions, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('each native plugin receives the shared instructions, package version and exact connection', async () => {
  const f = fixture();
  try {
    for (const harness of harnesses) {
      const output = join(f.directory, harness);
      const { plugin } = buildLocalPlugin(f.root, output, harness, f.connection);
      assert.deepEqual(json(join(output, 'connection.json')), { harness, ...f.connection });
      if (harness === 'pi') {
        const manifest = json(join(plugin, 'package.json'));
        assert.equal(manifest.version, '9.8.7-test');
        assert.equal(existsSync(join(plugin, '.mcp.json')), false, 'Pi uses its native extension boundary');
        let captured: unknown;
        const extension = await import(pathToFileURL(join(plugin, manifest.pi.extensions[0])).href);
        extension.default({ capture: (value: unknown) => { captured = value; } });
        assert.deepEqual(captured, { connection: f.connection, instructions: f.instructions });
      } else {
        const manifest = json(join(plugin, harness === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json'));
        assert.equal(manifest.version, '9.8.7-test');
        assert.equal(readFileSync(join(plugin, 'skills/rein/SKILL.md'), 'utf8'), f.instructions);
        if (harness === 'codex') assert.match(f.instructions, /\$rein:rein sync.*`rein_sync` once/);
        const mcp = json(join(plugin, '.mcp.json')).mcpServers.rein;
        const actual = JSON.parse(execFileSync(mcp.command, mcp.args, { encoding: 'utf8' }));
        assert.deepEqual(actual, ['mcp', '--harness', harness, '--state', f.connection.state,
          '--config', f.connection.config, '--project', f.project, '--instance', f.connection.instance]);
        const marketplace = json(join(output, harness === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'));
        assert.equal(marketplace.name, f.connection.instance);
        const source = harness === 'codex' ? marketplace.plugins[0].source.path : marketplace.plugins[0].source;
        assert.equal(resolve(output, source), plugin);
        if (harness === 'claude') {
          for (const [command,tool] of [['on','rein_mode'],['off','rein_mode'],['status','rein_status'],['sync','rein_sync']]) {
            const skill = readFileSync(join(plugin, 'skills', command, 'SKILL.md'), 'utf8');
            assert.match(skill, /^disable-model-invocation: true$/m);
            assert.ok(skill.includes(tool));
          }
          const binding = json(join(plugin, 'hooks/hooks.json')).hooks.PreToolUse[0];
          assert.equal(binding.matcher, 'mcp__plugin_rein_rein__rein_.*');
          const hook = binding.hooks[0];
          assert.equal(hook.onFailure, 'block');
          const actualHook = JSON.parse(execFileSync(hook.command, hook.args, { encoding: 'utf8' }));
          assert.deepEqual(actualHook, ['claude-hook', '--state', f.connection.state, '--project', f.project]);
        }
      }
    }
  } finally { f.close(); }
});

test('rebuild updates shared instructions and version but rejects rebinding an existing plugin', () => {
  const f = fixture();
  try {
    for (const harness of harnesses) buildLocalPlugin(f.root, join(f.directory, harness), harness, f.connection);
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'oh-my-rein', version: '9.8.8-test', type: 'module' }));
    writeFileSync(join(f.root, 'plugins/shared/skills/rein/SKILL.md'), f.instructions + '\nUpdated shared instructions.\n');
    for (const harness of harnesses) {
      const output = join(f.directory, harness);
      buildLocalPlugin(f.root, output, harness, f.connection);
      const manifest = join(output, 'plugins/rein', harness === 'pi' ? 'package.json' : `.${harness === 'codex' ? 'codex' : 'claude'}-plugin/plugin.json`);
      assert.equal(json(manifest).version, '9.8.8-test');
      const receipt = readFileSync(join(output, 'connection.json'), 'utf8');
      assert.throws(() => buildLocalPlugin(f.root, output, harness, { ...f.connection, project: f.directory }), /different connection/);
      assert.equal(readFileSync(join(output, 'connection.json'), 'utf8'), receipt);
      const content = readFileSync(join(output, 'plugins/rein', harness === 'pi' ? 'index.mjs' : 'skills/rein/SKILL.md'), 'utf8');
      assert.match(content, /Updated shared instructions/);
    }
  } finally { f.close(); }
});

test('adapter installation preserves native scopes and Claude update behavior', () => {
  const f = fixture();
  try {
    const log = join(f.directory, 'commands.jsonl');
    const executable = join(f.directory, 'harness');
    writeFileSync(executable, '#!' + process.execPath + '\n' +
      'require("node:fs").appendFileSync(' + JSON.stringify(log) + ',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+"\\n");', { mode: 0o700 });
    for (const harness of harnesses) installLocalPlugin(harness, executable, join(f.directory, harness), f.project, f.connection.instance, true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.every(call => realpathSync(call.cwd) === realpathSync(f.project)));
    assert.deepEqual(calls.map(call => call.args), [
      ['plugin', 'marketplace', 'add', join(f.directory, 'codex')],
      ['plugin', 'add', 'rein@plugin-test'],
      ['plugin', 'validate', join(f.directory, 'claude/plugins/rein')],
      ['plugin', 'marketplace', 'add', join(f.directory, 'claude')],
      ['plugin', 'install', 'rein@plugin-test', '--scope', 'local'],
      ['plugin', 'update', 'rein@plugin-test', '--scope', 'local'],
      ['install', '-l', join(f.directory, 'pi/plugins/rein')],
    ]);
  } finally { f.close(); }
});
