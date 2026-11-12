import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON, writeJSON, writeManifest, writeMcp, writeSkill, validateManifest, validateMcp } from './plugin-common.ts';
import type { PluginAdapter } from './plugin-common.ts';

export const claudePlugin: PluginAdapter = {
  build(context) {
    writeManifest(context, '.claude-plugin/plugin.json');
    writeSkill(context);
    const commands = {
      on: 'Enable Rein in this conversation. Call rein_mode with enabled=true. If enabled, call rein_sync once. Report the actual Host, connectivity, capacity and any approval UI issue. Do not dispatch sample work.',
      off: 'Call rein_mode with enabled=false. Report the cached workerStates counts for any ongoing or uncertain executions. Leave workers and pending approvals alone.',
      status: 'Call rein_status with view="executions". Report the mode and Host. Group executions by task title and show each goal and cached state, last complete sync time and any later failed or partial attempt. Follow pagination if needed. Do not enable Rein or call rein_sync.',
      sync: 'Call rein_sync once for the current conversation, preserving its mode. Report the returned sync state and task updates or items needing attention by task name. If partial or unavailable, identify what remains pending or cached. Return after this pass.',
    };
    for (const [name, instruction] of Object.entries(commands)) {
      const directory = join(context.plugin, 'skills', name);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const body = name === 'on' ? '\n\n' + context.instructions.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim() : '';
      writeFileSync(join(directory, 'SKILL.md'),
        `---\ndescription: Rein session control — ${name}\ndisable-model-invocation: true\n---\n\n${instruction}${body}\n`, { mode: 0o600 });
    }
    writeMcp(context);
    writeJSON(join(context.plugin, 'hooks/hooks.json'), { hooks: { PreToolUse: [{
      matcher: 'mcp__plugin_rein_rein__rein_.*', hooks: [{
        type: 'command', command: context.node,
        args: [context.cli, 'claude-hook', '--state', context.connection.state, '--project', context.connection.project],
        timeout: 10, onFailure: 'block',
      }],
    }] } });
    writeJSON(join(context.directory, '.claude-plugin/marketplace.json'), {
      name: context.connection.instance, owner: { name: 'Rein' },
      plugins: [{ name: 'rein', source: './plugins/rein', description: 'Personal main agent and durable worker execution' }],
    });
  },
  validate(context) {
    validateManifest(context, '.claude-plugin/plugin.json', 'rein');
    validateMcp(context);
    const hook = readJSON(join(context.plugin, 'hooks/hooks.json')).hooks.PreToolUse[0].hooks[0];
    assert.equal(hook.command, context.node);
    assert.equal(hook.onFailure, 'block');
    assert.deepEqual(hook.args, [context.cli, 'claude-hook', '--state', context.connection.state, '--project', context.connection.project]);
    assert.equal(readJSON(join(context.directory, '.claude-plugin/marketplace.json')).name, context.connection.instance);
  },
  installCommands({ directory, instance, update }) {
    const commands = [
      ['plugin', 'validate', join(directory, 'plugins/rein')],
      ['plugin', 'marketplace', 'add', directory],
      ['plugin', 'install', 'rein@' + instance, '--scope', 'local'],
    ];
    if (update) commands.push(['plugin', 'update', 'rein@' + instance, '--scope', 'local']);
    return commands;
  },
};
