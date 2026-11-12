# Install Oh My Rein

[← Overview](README.md) · **English** · [简体中文](INSTALL.zh-CN.md)

## 1. Prepare both machines

Install Node.js 24.x, npm, Git and the harness CLI you plan to run on each machine. Check that SSH connects without a prompt, both project checkouts contain the task's base commit, and the remote worker already has model access. The remote Host inherits the SSH login shell's environment.

## 2. Install the preview locally

Install the beta from npm.

```sh
npm install -g oh-my-rein@beta
```

If you downloaded the release archive, run this from its directory.

```sh
npm install -g ./oh-my-rein-0.1.0-beta.1.tgz
```

### Build from source

To install from a source checkout, run these commands in the Rein repository.

```sh
npm ci --ignore-scripts
mkdir -p dist/packages
npm pack --pack-destination dist/packages
npm install -g ./dist/packages/oh-my-rein-0.1.0-beta.1.tgz
```

## 3. Choose a harness and connect

**Run one command** for the main agent you use. Each Host configuration runs one type of worker and can run several tasks concurrently.

| Local main → remote worker | Run in your local terminal |
| --- | --- |
| Claude Code → Codex (tested end to end over SSH) | `rein setup --harness claude --worker codex` |
| Claude Code → Claude Code (preview) | `rein setup --harness claude --worker claude` |
| Codex → Codex (default) | `rein setup --harness codex --worker codex` or `rein setup` |
| Pi → Codex | `rein setup --harness pi --worker codex` |

Enter the connection details when prompted:

| Prompt | Example |
| --- | --- |
| SSH host | `worker-host` or `user@server` |
| Local project | `/Users/you/projects/my-app` |
| Remote project | `~/projects/my-app` |
| Remote provider profile | Blank for default Codex, or your configured profile name |
| Approval route | `ask` (default) or `delegate` |

Review the plan, then confirm. Setup checks both machines, deploys the remote runtime, starts the Host, creates the connection configuration, and installs the selected local plugin or extension.

## 4. Use Rein in your conversation

Reload your local harness and open the configured project. Use the row for the harness you are chatting in. For example, Claude Code uses `/rein:on` with both Codex and Claude workers.

| Your local conversation | Turn on | Turn off | Check workers | Sync once |
| --- | --- | --- | --- | --- |
| Claude Code | `/rein:on` | `/rein:off` | `/rein:status` | `/rein:sync` |
| Codex CLI | `$rein:rein on` | `$rein:rein off` | `$rein:rein status` | `$rein:rein sync` |
| Pi | `/rein on` | `/rein off` | `/rein status` | `/rein sync` |

In Codex CLI, type `$`, select the `rein:rein` skill, then add the action. You can also ask your agent to enable Rein in plain language. Claude Code still accepts the original `/rein:rein` to turn it on.

**Check workers** reads the current conversation's local records. It shows each execution under its task and the time of the last complete sync, including when SSH is down or Rein is off. In Pi, use `/rein status 2` for the next page when prompted. **Sync once** contacts the Host for updates and attempts to deliver pending commands and recorded approval decisions. It returns after one pass, even if workers are still running or the Host is offline. You can also say **“Sync my Rein tasks.”**

Tested native versions: Claude Code **2.1.322**, Pi **1.5.2**, with DeepSeek. These integrations are development previews. Claude Code requires the installed Rein hook; do not launch the main plugin with `--bare`. Pi reads the current native session directly. New/forked conversations do not inherit task control; resuming the original conversation restores it.

Once the Host shows as connected, try two read-only assignments:

> “Send one worker to locate the CSV export code and another to investigate our slowest test. Just report findings for now.”
>
> “Narrow the export task to the CLI entry point. Remember CSV as the project default for future exports.”
>
> “Sync both tasks. What did each worker find?”

Check that each report answers its own request. Running real workers calls the model and may use provider credits.

New conversations start with Rein off. Turning it off does not cancel running tasks. Rein imposes no wall-clock limit on a worker execution. To stop a long task, ask your main agent to cancel it. No separate worker chat is needed; automatic completion notifications are not enabled.

## Approvals and worker permissions

Rein has two approval routes. Worker access is configured separately in the worker's native terms.

| Route | Who answers a native approval? |
| --- | --- |
| **`ask` (default)** | You, in the main conversation. Dismissing the prompt leaves it pending. |
| `delegate` | The main agent, using your task and context. It can still ask you when uncertain. |

Say **“Use Rein ask mode”** or **“Use Rein delegate mode”** in your main conversation. Pi also supports `/rein ask` and `/rein delegate`. Changing the route affects subsequent executions; existing requests keep their recorded route. It does not change worker access or force a prompt for operations already permitted by the worker.

You can configure workers in the main conversation: **“Show this connection's worker permissions”**, then **“Set this Codex worker's sandbox to read-only for future workers; keep its approval policy.”** The main uses `rein_worker_permissions` and `rein_worker_permissions_set` directly; no terminal tool is required. It checks the bound Host/project/adapter and reports before/after settings and scope. Unspecified fields are preserved; a supplied tool list replaces the old list. These are shared Host/project/adapter defaults across conversations, not a per-task override. Existing and resumed workers retain their permissions. Changing who answers approvals still uses `rein_mode`.

Conflicting changes require a fresh read. An unconfirmed transport result is reported as unknown; an exact retry recovers the original receipt without reapplying it over newer settings. Both local plugin and Host runtime must be updated to expose these tools. The CLI below remains available for administration.

```sh
# Inspect this project's installed worker connection
rein worker permissions --host worker-host --worker codex

# Configure native defaults for new worker sessions
rein worker permissions set --host worker-host --worker codex \
  --sandbox workspace-write --approval-policy on-request

rein worker permissions set --host worker-host --worker claude \
  --claude-permission-mode manual --tools Read,Edit,Bash

rein worker permissions set --host worker-host --worker pi \
  --pi-tool-approval all --tools read,grep,find,ls,edit,write,bash
```

Changes affect new worker sessions; queued, running and resumed sessions retain their configuration. See the [operations guide](docs/operations.md#permission-requests) for options.

**Worker approval adapters:**

| Worker | Forward execution-time approvals | Without forwarding |
| --- | --- | --- |
| Codex | `--approval-policy on-request`: native command/file requests | `never` follows the configured sandbox |
| Claude Code | `--claude-permission-mode manual` or `acceptEdits`: native `can_use_tool` requests | `dontAsk` or `bypassPermissions` follows native semantics |
| Pi | `--pi-tool-approval all`: Rein's isolated extension pauses **every enabled tool**, including reads | `never` runs enabled tools without this gate |

New installations use Claude `manual` and Pi `all`, with read/search tools enabled initially. Add editing or shell tools explicitly when your tasks need them. Claude only forwards requests its native permission checks produce; `acceptEdits` can allow edits without asking. Available tools depend on the installed CLI. Pi's `--no-approve` controls project trust, **not** tool execution approval. Rein waits for the Pi gate's readiness handshake before sending any task.

Loading an existing configuration does not migrate its permissions; an older Pi configuration without `toolApproval` keeps its previous behavior. When using `setup --update`, repeat your desired permission and provider options: omitted flags use the new defaults. Then use `worker permissions set` to change defaults for new sessions. A native permission response resumes the pending operation; it does not create a new worker turn or grant permanent rules. Model-generated task questions continue to use `rein_continue`. Claude Code 2.1.322 and Pi 1.5.2 have passed local native-model allow/deny and same-session continuation tests using scripted UI decisions. In a separate test of the beta.1 archive, a user denied a write in the Claude Code terminal and allowed it once on the next turn of the same SSH Codex worker session. The denied turn left no file. The allowed patch reproduced the expected contents in a clean checkout. Remote Claude/Pi worker approvals and desktop UI still need validation.

<details>
<summary><strong>Custom providers and paths</strong></summary>

A named remote profile must exist as `NAME.config.toml` in the remote Codex configuration directory and authenticate through environment variables. Workers use an isolated Codex home; without a profile they do not inherit interactive provider configuration. Headless execution with `--approval-policy never` also uses `--ignore-user-config`.

```sh
rein setup --host worker-host --project ./my-app \
  --remote-project '~/projects/my-app' --profile deepseek \
  --remote-codex-home /home/you/.codex
```

Claude Code workers can read provider environment settings from a file already on the remote machine:

```sh
rein setup --harness claude --worker claude --host worker-host \
  --project ./my-app --remote-project '~/projects/my-app' \
  --tools Read,Glob,Grep \
  --remote-settings '~/.claude/settings.json' --model 'deepseek-flash[1m]'
```

Pi workers accept provider credentials from the Host environment, or a remote API-key source:

```sh
rein setup --harness pi --worker pi --host worker-host \
  --project ./my-app --remote-project '~/projects/my-app' \
  --tools read,grep,find,ls \
  --provider deepseek --model deepseek-flash --remote-pi-agent-dir '~/.pi/agent'
```

The Pi auth-directory adapter supports literal API keys for DeepSeek, Anthropic, OpenAI and Google. Other providers must use their supported environment credentials. OAuth/native-login reuse and custom Pi model registries are not implemented. Claude imports only selected provider environment keys from its settings file. Workers receive fresh native state directories; personal conversations, plugins and memory are not imported.

Codex sandbox/approval policy, Claude permission mode, and Pi tools are configured independently. Claude/Pi tool filtering is not an OS sandbox.

Use `--local-executable` / `--remote-executable` for a custom harness binary. If remote Node or Codex is absent from the login-shell PATH, use `--remote-node /absolute/node` or `--remote-codex /absolute/codex`. `rein setup --help` lists all options. `--yes` applies the displayed plan without a confirmation prompt.

</details>

<details>
<summary><strong>Retrying and troubleshooting</strong></summary>

- Rerun the same setup to reuse its runtime, Host, and task state. If local plugin installation fails, the remote installation is retained for retry.
- The Host is a detached process, not a boot service. Rerun the same setup after a remote reboot.
- To change the model or update the runtime, repeat the full setup command with `--update`. The Host drains first; queued, running and unknown executions block the update. History and endpoint addresses are retained.
- An interrupted deployment may leave a setup lock. Inspect the remote process before removing the empty lock directory reported by setup.
- A connected Host does not prove model authentication. Verify one bounded task before sending real work.
- `rein doctor` is an optional diagnostic command, not an installation step.

See [Host maintenance and recovery](docs/operations.md) for unknown executions, updates, stopping and uninstalling.

Setup records live under `~/.local/share/oh-my-rein/` on each machine. The installed local package and Node executable must remain available to the plugin. Uninstalling the npm package does not remove remote state or unregister the harness plugin.

</details>

<details>
<summary><strong>Attach a different local harness to an existing endpoint</strong></summary>

```sh
rein plugin --harness claude --config /absolute/endpoint.json \
  --state /absolute/claude-main --project /absolute/my-app \
  --instance rein-my-app --output /absolute/claude-plugin --install
# For Pi, choose --harness pi and its own state/output directories.
```

Omit `--install` to generate a reviewable plugin directory. Claude can load the generated `plugins/rein` directory with `--plugin-dir`; Pi can load `plugins/rein/index.mjs` with `-e`. Keep the installed Rein runtime and generated directory available. Main-agent state stays scoped to its native harness and original session.

</details>

**Validation:** package execution under `node_modules`, setup/retry, configuration conflicts, and compiled worker execution are covered by isolated tests. Automated setup tests substitute SSH and harness installation, while exercising real compiled runtimes for all three adapters. Separately, native Claude/Pi installation and real DeepSeek runs cover two concurrent tasks, context selection, report/patch collection, original-session resume, acceptance/review/completion, and new-session isolation. A separate packed-install test validates a native Claude main with real SSH Codex workers, scoped correction, result review, runtime/configuration update and teardown. Other remote combinations, fresh OS setup, desktop UI and in-process session switching remain unverified. See the [validation record](https://github.com/rein-extension/oh-my-rein/blob/main/docs/validation.md).
