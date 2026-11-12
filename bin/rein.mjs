#!/usr/bin/env node
import { readFileSync } from 'node:fs';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Rein requires Node.js 24.x. Install Node 24, then run this command again.');
  process.exit(1);
}
const command = process.argv[2];
if (command === '--version') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else if (!command || command === '--help' || command === '-h') {
  console.log(`Oh My Rein — one conversation, parallel remote work.

  rein setup              Connect a remote Host and install your local harness plugin
  rein setup --help       Setup options for scripts and custom environments
  rein plugin --help      Connect Codex, Claude Code or Pi to an existing Host
  rein doctor             Diagnose the local runtime
  rein connections        List configured projects and endpoint file paths
  rein mode ask|delegate  Select who answers approvals in the bound conversation
  rein worker permissions [set]  View/configure native worker permissions
  rein host --help        Host maintenance and recovery commands

Setup requires Node 24, npm, Git and the selected harness CLI on each machine, plus noninteractive SSH.
It installs the Rein runtime; it does not install harness CLIs or copy model credentials.
Advanced Host/task commands: rein host --help`);
} else if (command === 'connections') {
  const { listConnections } = await import('../dist/runtime/connections.js');
  console.log(JSON.stringify(listConnections(), null, 2));
} else if (command === 'plugin') {
  const { runPlugin } = await import('../dist/runtime/plugin.js');
  await runPlugin(process.argv.slice(3)).catch(error => {console.error(error.message);process.exitCode=1;});
} else if (command === 'setup') {
  const { runSetup } = await import('../dist/runtime/setup.js');
  await runSetup(process.argv.slice(3)).catch(error => {
    console.error(`Setup stopped: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  await import('../dist/runtime/cli.js');
}
