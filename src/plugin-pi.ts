import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeManifest, validateManifest } from './plugin-common.ts';
import type { PluginAdapter } from './plugin-common.ts';

export const piPlugin: PluginAdapter = {
  build(context) {
    writeManifest(context, 'package.json');
    const runtime = pathToFileURL(join(context.root, 'dist/runtime/pi-extension.js')).href;
    writeFileSync(join(context.plugin, 'index.mjs'),
      `import { installPiExtension } from ${JSON.stringify(runtime)};\n` +
      `export default function(pi){installPiExtension(pi,${JSON.stringify(context.connection)},${JSON.stringify(context.instructions)});}\n`,
      { mode: 0o600 });
  },
  validate(context) {
    const manifest = validateManifest(context, 'package.json', 'oh-my-rein-pi');
    assert.equal(manifest.type, 'module');
    assert.deepEqual(manifest.pi.extensions, ['./index.mjs']);
    assert.ok(existsSync(join(context.plugin, 'index.mjs')), 'Missing generated Pi entry');
    assert.ok(existsSync(join(context.root, 'dist/runtime/pi-extension.js')), 'Missing Pi runtime; rebuild Rein');
  },
  installCommands({ directory }) {
    return [['install', '-l', join(directory, 'plugins/rein')]];
  },
};
