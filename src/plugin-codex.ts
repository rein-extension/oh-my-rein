import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJSON, writeJSON, writeManifest, writeMcp, writeSkill, validateManifest, validateMcp } from './plugin-common.ts';
import type { PluginAdapter } from './plugin-common.ts';

export const codexPlugin: PluginAdapter = {
  build(context) {
    writeManifest(context, '.codex-plugin/plugin.json');
    writeSkill(context);
    writeMcp(context);
    writeJSON(join(context.directory, '.agents/plugins/marketplace.json'), {
      name: context.connection.instance,
      interface: { displayName: 'Rein' },
      plugins: [{ name: 'rein', source: { source: 'local', path: './plugins/rein' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    });
  },
  validate(context) {
    const manifest = validateManifest(context, '.codex-plugin/plugin.json', 'rein');
    assert.equal(manifest.skills, './skills/');
    assert.equal(manifest.mcpServers, './.mcp.json');
    validateMcp(context);
    assert.equal(readJSON(join(context.directory, '.agents/plugins/marketplace.json')).name, context.connection.instance);
  },
  installCommands({ directory, instance }) {
    return [['plugin', 'marketplace', 'add', directory], ['plugin', 'add', 'rein@' + instance]];
  },
};
