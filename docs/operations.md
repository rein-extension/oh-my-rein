# Maintain a Rein connection

[Install](../INSTALL.md) · [简体中文](operations.zh-CN.md)

## Find your connection

```sh
rein connections
rein host status --config /path/from/connection/endpoint.json
```

The status shows whether the Host is draining and lists unsettled executions. These commands do not call a model. Use the `endpoint` path printed for your project; do not recreate the connection or delete its ledger to troubleshoot it.

## Permission requests

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

Commands select an installed connection by current project, SSH Host and worker. Disambiguate with `--harness` or `--config /connection/endpoint.json`; use `--project /path/to/project` for another project. Defaults persist on the Host without a restart. Existing sessions, including queued and resumed work, retain their native configuration. Conflicting updates require a fresh read.

Codex supports `--sandbox read-only|workspace-write|danger-full-access` and `--approval-policy on-request|never`; Claude supports `--claude-permission-mode manual|acceptEdits|dontAsk|bypassPermissions` and `--tools`; Pi uses native `--tools` with Rein’s `--pi-tool-approval all|never` gate. The harness defines these settings: `never`, `dontAsk`, and tool availability do not mean the same thing.

New executions record approval-policy version 2. Saved unversioned requests keep their original policy and operation hash; a delegated allow now requires user review for those requests. Queued legacy runs keep the old policy, and already signed main-agent allowances are checked again before native delivery. Updating both the local plugin and Host is required; do not rely on a partial upgrade for these guards.

Rein adds no command/path classifier to delegate mode. The main must inspect the full native request and judge task authorization. Accepting a command may run it outside the sandbox with the remote account's privileges. Only single-operation command/file/tool decisions are supported; unknown requests and network/session grants are recorded as `unsupported`, without a grant or a fabricated user denial.

**Worker approval adapters:**

| Worker | Forward execution-time approvals | Without forwarding |
| --- | --- | --- |
| Codex | `--approval-policy on-request`: native command/file requests | `never` follows the configured sandbox |
| Claude Code | `--claude-permission-mode manual` or `acceptEdits`: native `can_use_tool` requests | `dontAsk` or `bypassPermissions` follows native semantics |
| Pi | `--pi-tool-approval all`: Rein's isolated extension pauses **every enabled tool**, including reads | `never` runs enabled tools without this gate |

New installations use Claude `manual` and Pi `all`, with read/search tools enabled initially. Add editing or shell tools explicitly when your tasks need them. Claude only forwards requests its native permission checks produce; `acceptEdits` can allow edits without asking. Available tools depend on the installed CLI. Pi's `--no-approve` controls project trust, **not** tool execution approval. Rein waits for the Pi gate's readiness handshake before sending any task.

Loading an existing configuration does not migrate its permissions; an older Pi configuration without `toolApproval` keeps its previous behavior. When using `setup --update`, repeat your desired permission and provider options: omitted flags use the new defaults. Then use `worker permissions set` to change defaults for new sessions. A native permission response resumes the pending operation; it does not create a new worker turn or grant permanent rules. Model-generated task questions continue to use `rein_continue`. Claude Code 2.1.322 and Pi 1.5.2 have passed local native-model allow/deny and same-session continuation tests using scripted UI decisions. Human desktop clicks and real SSH approval acceptance remain unverified.

**In the main conversation:** sync to see permission requests under their tasks. Each shows the task, Host, operation and impact. The main calls `rein_permission_review` with the task reference (`userTaskId`); one pending request opens directly, while several return choices for a single-operation review. Execution-level selection remains available for older unassigned work. Users do not need to copy request IDs. MCP clients need form elicitation; Pi uses its native selection UI. Choose allow once, deny, or keep waiting. The model cannot provide that choice as a tool argument. Activation checks the connected Host and local UI; an unavailable approval interface prevents enabling the mode. Offline activation is unverified, not evidence that approvals will work. No answer means pending, not rejection or approval. Canceling the approval tool call also leaves the request pending; a late UI response cannot sign a decision. Clients that cannot close an existing dialog may leave it visible, but its response is ignored.

**Diagnostic terminal fallback:** normal use stays in the task conversation. If troubleshooting requires it, run this yourself in an interactive terminal, using your connection's paths and the originating session/execution/request IDs:

```sh
rein main permission-review --state /connection/main \
  --config /connection/endpoint.json --project /path/to/project \
  --harness codex --instance INSTALLATION_ID --session SESSION_ID \
  --task EXECUTION_ID --value REQUEST_ID
```

The prompt shows the exact request before accepting `allow` or `deny`; Enter leaves it pending. Do not ask the agent to type this confirmation for you.

Setup pairs a local signing key with the remote Host. Decisions bind the owner, run, request and exact operation digest, persist independently of task snapshots, and retry idempotently after transport loss. Approval delivery and the native operation result have separate records. If an invocation disappears after an allowance is sent, effects may be unknown: inspect before retrying. Never replay a decision into a replacement process. An interrupted decline records no grant without claiming confirmed delivery. Canceling execution does not undo an approved operation: the task retains `unknown` operation effects and an inspection reminder even after execution stops or its knowledge review is discarded.

After confirming execution stopped and syncing, the main agent uses `rein_effects_review` for each unknown request, with actual inspection evidence and `no-effects` or `effects-addressed`. Keep unresolved effects open. This records the main agent's assessment in the local ledger, preserves the original Host approval, and closes that request's reminder. Evidence remains available in the full execution view. Unknown effects block new dispatch, queued start delivery, further allow decisions in the same user task, and task completion until reviewed. The delivery path refreshes related Host snapshots, so an unsynced final outcome cannot be overtaken by queued work. Unrelated tasks, denials and cancellation remain available; already running operations are not retroactively stopped. Legacy work is grouped by its task key or native session when available, not by guessing from goal text; knowledge review and Host process recovery are separate steps. If execution itself is still `unknown`, recover it first as described below.

A cancellation receipt may arrive before the final execution and approval snapshot. If `sync_execution_final_state` appears, sync again before reviewing effects or completing the task. Host startup and periodic checks recover approval cleanup interrupted by older runners; a surviving worker keeps execution `unknown` until inspected and stopped. A confirmed never-started execution needs no worker outcome review.

Pending native requests keep the worker process and a Host slot alive. Each approval request expires after 30 minutes. Workers can run for hours under the same execution, and you can cancel a running execution from its task. Disconnecting does not auto-approve or auto-deny; sync after reconnecting. Automatic main-chat wake remains unverified.

The local harness/UI, installation account and remote Host are trusted. Signatures prevent forged tool arguments or unpaired decision messages; they do not isolate against code with access to the local private key or administrative control of the Host. Claude/Pi tool filtering is not a general OS sandbox. Legacy report `permissionDecision`/`userQuote` fields no longer grant permissions; start a new native worker for those blocked sessions. Ordinary requirement questions still use `rein_continue`.

## Change model or runtime

Stop dispatching new work in your main conversation. Repeat your original setup options, add `--update`, and change only the settings you intend to change:

```sh
rein setup --host worker-host --project ./my-app \
  --remote-project '~/projects/my-app' --sandbox workspace-write --update
```

Include your original `--harness`, `--worker`, profile/provider, authentication-source and model options. Omitted options use defaults. To update the software, first install the new preview package, then run the same setup with `--update` and reload the harness.

The installer stages the runtime, drains the Host, and refuses to stop while queued, running or unknown executions remain. Existing queued work continues while draining. Sync in the original conversation and wait or explicitly cancel the remaining work; then retry the same command. To abandon the update and accept new work again:

```sh
rein host resume --config /path/from/connection/endpoint.json
```

Once idle, the installer stops the supervisor, backs up its configuration, updates it, restarts, and resumes acceptance. Task history, artifacts and the endpoint address are retained. Configuration backups are under the remote Host state's `backups/`; they are not database backups. Releases still referenced by an endpoint must remain installed. This is a same-protocol preview update flow, not a general database migration service.

If interrupted during configuration replacement, retry **the same package and options** with `--update`. A pending update blocks Host startup until completed. If a setup lock remains, first confirm the previous setup process has stopped before removing that empty lock directory. A failed local plugin installation retains remote state for retry.

Changing only concurrency or timeout preserves worker-session compatibility. The runner uses the current timeout when starting the next turn. The managed update migrates legacy session hashes using the previous configuration, including on interrupted-update retry. For a legacy session whose configuration was edited directly, Rein may be unable to prove compatibility; restore the known previous configuration and use the update flow, or start a fresh session. Unknown hashes are never assumed compatible.

## Recover an unknown execution

```sh
rein host inspect --config /path/from/connection/endpoint.json --task RUN_ID
```

On the worker machine, inspect the reported runner/worker processes, logs and artifacts under `HOST_STATE/runs/RUN_ID/`, and any external effects. New workers keep their checkout and native history under `HOST_STATE/sessions/WORKER_SESSION_ID/`; legacy runs keep their workspace under the run directory. Stop surviving processes only after verifying their identity. A PID can be reused; do not blindly kill a PID from an old record.

After confirming that the execution and its descendants have stopped:

```sh
rein host resolve --config /path/from/connection/endpoint.json \
  --task RUN_ID --confirm-stopped \
  --reason 'Verified processes stopped and inspected workspace and external effects'
```

Rein rejects recovery while a recorded runner or worker process group is alive. Your confirmation covers untracked descendants and external effects. It records the execution as **canceled**, preserves its files and recovery note, and releases its slot. It does not mark the work successful or undo external changes. Sync the original conversation before deciding whether to dispatch a new execution. Never restart the same execution as if nothing happened.

## Stop or uninstall

```sh
rein host drain --config /path/from/connection/endpoint.json
# Sync, finish or explicitly cancel outstanding work in its original conversation.
rein host stop --config /path/from/connection/endpoint.json
```

Stop refuses unsettled work. Its receipt acknowledges shutdown and transport closure; a lost SSH connection alone is not proof the remote process exited. A configuration update independently checks the supervisor is stopped before changing files.

Disable/unregister Rein through your harness's native plugin/extension manager, then uninstall the local command:

```sh
npm uninstall -g oh-my-rein
```

Task data and the remote runtime remain under `~/.local/share/oh-my-rein/`. Uninstall does not delete them. Do not remove state or older runtime paths while a connection still uses them. To restart after an ordinary shutdown or reboot, rerun setup with the same options; if you deliberately drained the Host, use `host resume` after reviewing its status.

## Use the result

Ask the original main agent to sync, collect and review the report and patch. Collection verifies artifact integrity; it does not apply changes. If you want the change in your project, explicitly ask the agent to inspect and apply the selected patch, then run relevant checks. Acceptance records a review; it is not a merge receipt.

Large event backlogs are synchronized in pages bounded by encoded response size. Large reports stay in their artifacts until collection; `reportOmitted: true` means the main agent must collect the full report before checking requirements or retaining discoveries. A bounded sync may leave more pages for the next interaction. Update both the local plugin and Host to get this behavior; a new plugin can read the older array protocol, but an old Host cannot repair an oversized backlog without an update.

Task-scoped goals, constraints and decisions are required by default. Adding, editing or retiring one also advances the task's requirement revision and blocks acceptance of older work. The main agent must reload the task version and explicitly select every active required entry before dispatch. Optional background can use `requiredForTask: false`; project notes and preferences are optional by default. Required entries that remain local-only block remote dispatch rather than being silently omitted or shared.

## Continue a worker conversation

After a worker asks a structured question, its turn becomes `waiting_input` and releases its Host slot. Answer through the original main conversation. The main agent uses `rein_continue` with the latest execution, question IDs, answers and current task snapshot. The native session and checkout are retained; a new run stores the next turn's input, report and artifacts. Only one turn can run in a worker session at a time. Other sessions remain concurrent. Completed turns can also receive follow-up work. Lost native history, uncertain or canceled runs never silently fall back to a fresh session.

Every patch is cumulative against the session's original base commit. Apply the latest intended patch to that base; do not stack earlier turn patches. Earlier reports remain reviewable. A continued intermediate turn needs outcome review but does not itself satisfy final acceptance. Legacy runs created without a worker-session identity cannot resume. Update both ends and reload the plugin for the new tool.

Knowledge selected in any earlier turn remains a dependency of that native session. Invalidating it blocks continuation, undelivered starts, result acceptance and task completion, even if the next turn omits its ID. Revalidate in a fresh worker session with a corrected snapshot. Changing a previously selected context entry to local-only also blocks that session, including continuations already queued. Revocation does not erase remote history or retract an already in-flight start. Inspect delivered work and cancel when needed. Missing or mismatched local ancestry blocks reuse and acceptance rather than silently dropping dependencies.

Ordinary user-context updates can continue in the same native session when the next turn explicitly selects the current version. The newest selected version supersedes that entry's older reference; old snapshots remain immutable. Omitting an entry inherits its most recently selected version, so it cannot bypass a correction. These checks cover enqueue, delivery, acceptance and task completion, including optional task context and project context. Retiring a previously selected entry requires a fresh worker session.

Retained discoveries distinguish the worker's `workerClaimedVerified`, the main agent's review identity/time, and validation evidence. `rein_review` accepts optional `verificationEvidence` describing checks actually performed and their results. Without it, retained knowledge is unverified, even if the worker claims success. With it, verification is explicitly `main-reported`; the compatibility field `verified` means that the main supplied evidence, not that Rein independently ran or authenticated those checks. Older worker-only flags are read as unverified. Read the full knowledge entry to inspect the evidence before relying on it.

Pause holds new dispatch and undelivered commands; workers already delivered to the Host may finish and their results remain available. Cancel is separate and its confirmation remains visible. No live steering or automatic main-chat wake is provided. Native approvals appear within their task as described above.

## Result and recovery boundaries

Task snapshots are capped at 256 KiB, reports at 4 MiB and individual artifacts at 16 MiB, with per-field limits as well. Oversized results fail publication instead of becoming uncollectable successes. Inspection and duplicate-start replies omit large report bodies.

Worker subprocesses receive a basic environment and explicitly selected provider credentials, with separate HOME and native state directories. Rein redacts known provider credential values from its logs and published reports, including values split across log chunks, and rejects patches containing those values. This is not general secret detection or an OS sandbox; native session files, unrecognized secrets and model tool access still need the harness's controls. Workers share the Host's OS user.

Sync reconciles tracked runs against Host snapshots as well as replaying events. Reconciled malformed events retain their audit receipt. A changed Host database identity blocks further delivery; inspect the original Host and pending work before deliberately configuring a replacement connection. Do not delete the local ledger to hide uncertainty. There is still no automatic retention, database backup/export or boot service.

A confirmed Host start rejection is recorded separately from a worker run. Inspect the rejection, then use `rein_review` with `decision: "discard"` to settle its review; it has no artifacts or discoveries to retain. This lets the parent task complete after a replacement execution succeeds and all other requirements are met. Older ledgers are recognized only from matching settled rejection evidence. Missing runs, lost acknowledgements and uncertain delivery still require synchronization and reconciliation; they cannot be discarded as confirmed start rejections.
