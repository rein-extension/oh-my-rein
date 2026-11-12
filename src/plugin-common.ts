import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Connection } from './pi-extension.ts';

export const Harness = z.enum(['codex', 'claude', 'pi']);
export type HarnessName = z.infer<typeof Harness>;
export function conversationCommands(harness: HarnessName) {
  const prefix = { claude: '/rein:', codex: '$rein:rein ', pi: '/rein ' }[harness];
  return { on: prefix + 'on', off: prefix + 'off', status: prefix + 'status', sync: prefix + 'sync' };
}
export type PluginContext = {
  root: string;
  directory: string;
  plugin: string;
  harness: HarnessName;
  connection: Connection;
  version: string;
  instructions: string;
  node: string;
  cli: string;
};
export type InstallContext = { directory: string; instance: string; update: boolean };
export type PluginAdapter = {
  build(context: PluginContext): void;
  validate(context: PluginContext): void;
  installCommands(context: InstallContext): string[][];
};

export const readJSON = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
export function writeJSON(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function sharedInstructions(root: string) {
  return readFileSync(join(root, 'plugins/shared/skills/rein/SKILL.md'), 'utf8');
}
export function writeManifest(context: PluginContext, path: string) {
  const template = readJSON(join(context.root, 'plugins', context.harness, path));
  writeJSON(join(context.plugin, path), { ...template, version: context.version });
}
export function writeSkill(context: PluginContext) {
  const directory = join(context.plugin, 'skills/rein');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'SKILL.md'), context.instructions, { mode: 0o600 });
}
function mcpConfiguration(context: PluginContext) {
  const { connection, node, cli, harness } = context;
  return { mcpServers: { rein: { command: node, args: [cli, 'mcp', '--harness', harness,
    '--state', connection.state, '--config', connection.config,
    '--project', connection.project, '--instance', connection.instance] } } };
}
export function writeMcp(context: PluginContext) {
  writeJSON(join(context.plugin, '.mcp.json'), mcpConfiguration(context));
}
export function validateManifest(context: PluginContext, path: string, name: string) {
  const manifest = readJSON(join(context.plugin, path));
  assert.equal(manifest.name, name, 'Generated plugin name mismatch');
  assert.equal(manifest.version, context.version, 'Generated plugin version mismatch');
  return manifest;
}
export function validateMcp(context: PluginContext) {
  assert.deepEqual(readJSON(join(context.plugin, '.mcp.json')), mcpConfiguration(context), 'Generated MCP connection mismatch');
  assert.equal(readFileSync(join(context.plugin, 'skills/rein/SKILL.md'), 'utf8'), context.instructions, 'Generated skill differs from shared instructions');
}
