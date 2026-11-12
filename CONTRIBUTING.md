# Contributing

Use Node.js 24.x, npm, and Git on macOS or Linux.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run check:package
```

The test suite uses isolated directories, mock harness installation, and a mock SSH transport. It does not call models or contact your SSH hosts. The package check installs the generated archive into a temporary prefix; npm may fetch dependencies.

Keep changes focused. Include the failure or user behavior being fixed, relevant tests, and any limitations. Changes to task ownership, delivery, cancellation, or recovery need regression coverage.

Plugin sources are organized by responsibility:

```text
plugins/shared/skills/rein/SKILL.md   Shared instructions for every harness
plugins/codex/                      Codex manifest template
plugins/claude/                     Claude Code manifest template
plugins/pi/                         Pi extension package template
src/plugin.ts                       Shared build, validation and install entry
src/plugin-{codex,claude,pi}.ts       Native formats and installation commands
src/plugin-common.ts                Shared configuration and generation helpers
```

Templates contain no machine paths or connection state. The root package supplies the version; setup fills in the connection and runtime paths. `rein setup`, `rein plugin` and `npm run build:plugin -- --harness codex|claude|pi ...` use the same builder. Codex and Claude receive the shared skill plus MCP wiring; Pi receives the same instructions through its native extension. The generated output, not the template directory, is installed in the harness. Keep native session binding and installation scopes covered when changing an adapter.

Real-model tests require explicit opt-in and provider credentials. They can incur charges; do not run them in pull-request CI or include credentials, native auth stores, transcripts, or local execution records in a contribution.

See [operations](docs/operations.md) for Host maintenance and [release validation](docs/releasing.md) for the remaining release gates.

License selection is deferred; this preview does not include a LICENSE file.
