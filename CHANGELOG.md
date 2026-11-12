# Changelog

## 0.1.0-beta.1

- Upgrade Zod to 4.6.7 to address GHSA-mrhx-c7xc-m3w5. Keep the worker report contract and support for existing project ledgers and native session IDs.
- Turn Rein on or off and check worker status from the main conversation. Activation reports the Host and its concurrency limit. Status groups cached executions by task and shows when the last complete sync occurred.
- Follow parallel work and project context across conversations in the English and Chinese guides, with diagrams for desktop and mobile.
- Unknown operation effects block same-task retries, queued starts and further allows until evidence is reviewed; unrelated tasks, denial and cancellation remain available. Refresh related execution outcomes before delivery and after user review.
- Version approval policies without rewriting old request hashes. Unversioned delegated allows require user review; queued runs retain their original semantics.
- Repair the opt-in native harness smoke test with explicit noninteractive fixture settings and a no-model preflight; approval UI is tested separately. Accept an installed runtime path for archive-based checks.

- Main-conversation worker permission query/update tools for all three local harnesses, with bound targets, partial updates, revision conflicts, durable receipts and exact retries that preserve newer settings. No shell tool required; existing sessions retain their permissions.

- Separate ask/delegate approval routing from native worker access; add worker permission inspection and configuration with persistent defaults and existing-session preservation.
- Canceled approval interactions cannot authorize late UI responses; stopped executions retain unknown-operation inspection reminders.

- Guided installation of a remote Host and local harness plugin.
- Session-owned tasks, parallel executions, selected context, and reviewed reports and patches.
- Host drain, resume, idle shutdown, and explicit recovery of uncertain executions.
- Opt-in runtime/configuration updates with retained history, stable transport addresses, backups, and interrupted-update recovery.
- Connection discovery and activation connectivity checks.
- Package-content checks, clean installation verification, and macOS/Linux CI configuration.
- Persistent Codex/Claude Code/Pi worker sessions, structured questions and idempotent `rein_continue` turns with separate reports and cumulative patches.
- Execution-time approval forwarding for Codex command/file requests, Claude native tool permission requests (`manual`/`acceptEdits`) and Pi tool calls (`toolApproval: all`). Shared `ask`/`delegate` routing, trusted UI review, signed durable decisions and separate operation outcomes; no permanent native rules or replay into replacement processes. New setups use Claude `manual` and Pi `all`; existing configurations and pinned sessions retain their settings.
- Task-scoped permission cards and single-request user review, activation checks for native approval UI, and optional user review in delegate mode.
- Codex ask/delegate respects the configured native sandbox with on-request approval; setup defaults to workspace-write without changing existing Host configurations.
- New worker report schemas omit legacy permission questions and require every declared field, fixing strict provider validation while preserving old report reads.
- Legacy report text no longer authorizes execution. Lost decision receipts retry idempotently; interrupted operations remain uncertain. Rejected continuations release their previous-turn reservation.
- Minimal worker environments, known-credential redaction, bounded reports, Host snapshot reconciliation and Host database identity checks.
- Pause now holds new delivery while retaining running work/results; cancellation remains separate. Host scheduling no longer parses finished runs on every tick.
- Continuations now recheck historical sharing and knowledge dependencies before delivery, acceptance and task completion; revoked sharing and invalidated facts require a fresh worker session.
- Workers can run beyond 30 minutes and remain cancellable. Upgrading an older Host preserves native sessions, including sessions created with the former execution timeout.
- Retained knowledge separates worker claims, main review and optional main-reported verification evidence; legacy worker-only flags no longer imply validation.
- Native file requests retain move destinations and operation details for review, reject ambiguous metadata, and recheck delegated policy compatibility before delivery.
- Continued sessions inherit omitted user-context dependencies; explicit current versions can supersede earlier references, while stale or retired context blocks delivery and acceptance.
- Confirmed Host start rejections can be reviewed without a worker run, including narrowly recognized legacy records, so failed attempts no longer permanently block task completion. Uncertain delivery remains unresolved.

This is a development preview. The November 12 archive passed the Claude Code terminal to SSH Codex human approval check. The current candidate includes subsequent plugin and session-control changes. Fresh OS setup, other remote combinations and broader failure recovery still need validation. See the per-archive results in the [validation record](https://github.com/rein-extension/oh-my-rein/blob/main/docs/validation.md).
