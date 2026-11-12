# 安装 Oh My Rein

[← 项目介绍](README.zh-CN.md) · [English](INSTALL.md) · **简体中文**

## 1. 准备两台机器

在本机和 SSH 主机上分别安装 Node.js 24.x、npm、Git 及该机器要运行的 harness CLI。确认 SSH 能非交互连接，两个项目仓库都含有任务的基线提交，远程 worker 已配置好模型访问。远程 Host 使用 SSH 登录 shell 的环境变量。

## 2. 在本地安装预览包

从 npm 安装 beta 版。

```sh
npm install -g oh-my-rein@beta
```

如果已下载安装包，在它所在的目录执行以下命令。

```sh
npm install -g ./oh-my-rein-0.1.0-beta.1.tgz
```

### 从源码打包

要从源码安装，在 Rein 源码目录运行以下命令。

```sh
npm ci --ignore-scripts
mkdir -p dist/packages
npm pack --pack-destination dist/packages
npm install -g ./dist/packages/oh-my-rein-0.1.0-beta.1.tgz
```

## 3. 选择一种组合并连接

根据你使用的主 agent，**只运行表中的一条命令**。一个 Host 配置使用一种 worker，可并发执行多个任务。

| 本地主 agent → 远程 worker | 在本地终端运行 |
| --- | --- |
| Claude Code → Codex（已做 SSH 端到端验证） | `rein setup --harness claude --worker codex` |
| Claude Code → Claude Code（预览） | `rein setup --harness claude --worker claude` |
| Codex → Codex（默认） | `rein setup --harness codex --worker codex` 或 `rein setup` |
| Pi → Codex | `rein setup --harness pi --worker codex` |

按提示填写连接信息：

| 提示 | 示例 |
| --- | --- |
| SSH 主机 | `worker-host` 或 `user@server` |
| 本地项目 | `/Users/you/projects/my-app` |
| 远程项目 | `~/projects/my-app` |
| 远程提供商 profile | 默认 Codex 可留空，或填入已配置的 profile 名称 |
| 审批路由 | `ask`（默认）或 `delegate` |

查看安装计划并确认。安装器会检查两端环境、部署远程运行时、启动 Host、生成连接配置，再安装所选本地插件或扩展。

## 4. 在主会话中使用 Rein

重新加载本地 harness，打开配置好的项目，按你聊天用的工具选择一行。例如本地用 Claude Code，远端运行 Codex 或 Claude worker，都用 `/rein:on` 开启。

| 本地主会话 | 开启 | 关闭 | 查看 worker | 同步一次 |
| --- | --- | --- | --- | --- |
| Claude Code | `/rein:on` | `/rein:off` | `/rein:status` | `/rein:sync` |
| Codex CLI | `$rein:rein on` | `$rein:rein off` | `$rein:rein status` | `$rein:rein sync` |
| Pi | `/rein on` | `/rein off` | `/rein status` | `/rein sync` |

在 Codex CLI 中输入 `$`，选中 `rein:rein` 技能，再补上动作。也可以直接对主 agent 说“开启 Rein”。Claude Code 仍支持用旧命令 `/rein:rein` 开启。

**查看 worker** 会读取当前会话的本地记录，按任务列出每次执行和上次完整同步的时间。即使 SSH 断线或 Rein 已关闭也能查看。在 Pi 中，看到翻页提示时输入 `/rein status 2`。**同步一次** 会联系 Host 收取进展，并尝试送达排队的命令和已记录的审批决定。即使 worker 还在运行或 Host 离线，本次同步也会返回。也可以直接对主 agent 说 **“同步一下 Rein 任务”**。

已用 DeepSeek 验证 Claude Code **2.1.322**、Pi **1.5.2**。两者均为开发预览。Claude Code 主插件需要原生 Rein hook，不能使用 `--bare` 启动；Pi 直接读取当前原生会话。新对话不会继承任务控制权，恢复原对话后才能继续原任务。

看到 Host 已连接后，可以派发两项只读任务：

> “派两个 worker，一个找出 CSV 导出的入口，另一个调查最慢的测试。先只报告发现。”
>
> “导出任务只看命令行入口。把 CSV 记为这个项目以后导出的默认格式。”
>
> “同步两个任务，分别告诉我导出入口和慢测试的调查结果。”

查看两份报告是否分别回应了各自的要求。运行真实 worker 会调用模型，可能消耗额度。

新会话默认关闭 Rein，需重新开启。关闭 mode 不会取消运行中的任务。Rein 不限制单次 worker 执行的时长，需要中止时可以直接让主 agent 取消。无需另开 worker 会话，目前尚无完成后的自动通知。

## 审批与 worker 权限

Rein 只保留两种审批路由。worker 的执行权限单独使用各自原生配置。

| 路由 | 谁回答原生审批？ |
| --- | --- |
| **`ask`（默认）** | 你，在主对话中决定。关闭提示后保持等待。 |
| `delegate` | 主 agent，结合你的任务与上下文判断；不确定时仍可问你。 |

在主对话中说 **“使用 Rein ask 模式”** 或 **“使用 Rein delegate 模式”**。Pi 也支持 `/rein ask` 和 `/rein delegate`。切换路由影响后续执行，已有请求保留原来的路由；不会改变 worker 权限，也不会让原生已允许的操作额外请求审批。

直接在主对话中说：**“查看这个连接的 worker 权限”**，然后说 **“把这个 Codex worker 的沙箱改成只读，保留审批策略，应用到以后新建的 worker。”** 主 agent 通过 `rein_worker_permissions` 和 `rein_worker_permissions_set` 直接操作，不需要终端工具。它会核对绑定的 Host、项目和 worker 类型，回显修改前后配置及生效范围。未指定的字段保留；指定工具列表会替换旧列表。这是该 Host／项目／worker 类型跨对话共享的默认配置，不是单个任务的临时权限；已有 worker 和续跑会话保留原权限。审批交给谁仍通过 `rein_mode` 修改。

并发修改发生冲突时需要重新读取。断线导致回执不明时返回 `unknown`，用相同参数重试可找回原回执，不会把后来的配置改回去。需要升级本地插件及 Host 运行时后使用新工具。下面的 CLI 仍可用于管理。

```sh
# 查看当前项目已安装的 worker 连接
rein worker permissions --host worker-host --worker codex

# 为新 worker 会话配置原生默认权限
rein worker permissions set --host worker-host --worker codex \
  --sandbox workspace-write --approval-policy on-request

rein worker permissions set --host worker-host --worker claude \
  --claude-permission-mode manual --tools Read,Edit,Bash

rein worker permissions set --host worker-host --worker pi \
  --pi-tool-approval all --tools read,grep,find,ls,edit,write,bash
```

修改仅影响新建 worker 会话，排队、运行及续接的会话保留原配置。完整参数见[运行指南](docs/operations.zh-CN.md#权限请求)。

**worker 审批适配：**

| Worker | 转发执行时审批 | 不转发时 |
| --- | --- | --- |
| Codex | `--approval-policy on-request`：原生命令／文件请求 | `never` 仍遵循配置的沙箱 |
| Claude Code | `--claude-permission-mode manual` 或 `acceptEdits`：原生 `can_use_tool` 请求 | `dontAsk` 或 `bypassPermissions` 遵循原生语义 |
| Pi | `--pi-tool-approval all`：Rein 独立扩展在**每个已启用工具**执行前暂停，包括读取 | `never` 不经过这个审批层 |

新安装默认使用 Claude `manual`、Pi `all`，初始仍只启用读／搜索工具；需要编辑或命令执行时显式添加工具。Claude 只转发原生权限检查实际产生的请求，`acceptEdits` 可直接允许编辑。可用工具取决于安装的 CLI 版本。Pi 的 `--no-approve` 控制项目文件信任，**不是**工具执行审批；Rein 收到 Pi 审批扩展就绪信号后才发送任务。

读取已有配置时不自动迁移权限，旧 Pi 配置未设置 `toolApproval` 时不新增审批。使用 `setup --update` 时需要重新指定期望的权限和 provider 选项，省略参数会使用新版默认值；随后可用 `worker permissions set` 修改新会话默认值。审批回复恢复原来的待执行操作，不新建 worker 轮次，也不授予永久规则；普通需求问答仍使用 `rein_continue`。Claude Code 2.1.322、Pi 1.5.2 已通过本地真实模型的允许、拒绝和原会话续跑测试，决策由测试脚本提供。另外，在已验收的 beta.1 安装包上，用户在 Claude Code 终端拒绝了 SSH Codex worker 的首次写入，随后在同一 worker 会话的下一轮允许一次。拒绝后文件不存在；允许后的补丁能在干净仓库中还原预期内容。Claude/Pi 作为远程 worker 的审批和桌面 UI 仍待验证。

<details>
<summary><strong>自定义提供商与路径</strong></summary>

远程 profile 对应 Codex 配置目录中的 `NAME.config.toml`，使用环境变量认证。Worker 使用独立 Codex home，不指定 profile 时不会继承交互式提供商配置；`--approval-policy never` 的无交互执行还会使用 `--ignore-user-config`。

```sh
rein setup --host worker-host --project ./my-app \
  --remote-project '~/projects/my-app' --profile deepseek \
  --remote-codex-home /home/you/.codex
```

远程 Node 或 Codex 不在登录 shell 的 PATH 中时，可指定 `--remote-node /absolute/node` 或 `--remote-codex /absolute/codex`。完整选项见 `rein setup --help`；`--yes` 表示直接执行展示的计划，跳过确认提示。

Claude Code worker 可读取远程机器已有的 provider 配置：

```sh
rein setup --harness claude --worker claude --host worker-host \
  --project ./my-app --remote-project '~/projects/my-app' \
  --tools Read,Glob,Grep \
  --remote-settings '~/.claude/settings.json' --model 'deepseek-flash[1m]'
```

Pi worker 可使用 Host 环境变量认证，或读取远程 API key：

```sh
rein setup --harness pi --worker pi --host worker-host \
  --project ./my-app --remote-project '~/projects/my-app' \
  --tools read,grep,find,ls \
  --provider deepseek --model deepseek-flash --remote-pi-agent-dir '~/.pi/agent'
```

Pi auth 目录目前支持 DeepSeek、Anthropic、OpenAI、Google 的直接 API key；其他 provider 使用自身支持的环境变量。尚未实现 OAuth 登录复用和自定义 Pi model registry。Claude 仅导入 settings 中选定的 provider 环境变量。Worker 使用独立的原生状态目录，不导入个人会话、插件和记忆。

Codex 的沙箱和审批策略、Claude 的 permission mode、Pi 的工具清单独立配置。Claude/Pi 工具过滤不等于操作系统沙箱。

自定义 CLI 路径可用 `--local-executable` / `--remote-executable`。

</details>

<details>
<summary><strong>重试与排错</strong></summary>

- 重复相同安装会复用运行时、Host 和任务状态。本地插件安装失败时，已部署的远程部分会保留，便于重试。
- Host 是独立后台进程，不是开机服务。远程机器重启后，重新执行相同安装即可启动。
- 修改模型或运行版本时，用完整原参数重跑 setup 并加 `--update`。Host 会先停止接收新任务；排队、运行中和 unknown 执行会阻止更新。历史和连接地址保留。
- 部署中断可能留下安装锁。确认远程安装进程已停止后，再移除错误提示中的空锁目录。
- Host 连通不等于模型认证有效。请先验证一个小任务。
- `rein doctor` 仅用于可选排错，不是安装步骤。

unknown 恢复、更新、停止和卸载步骤见[Host 管理指南](docs/operations.zh-CN.md)。

两端安装记录分别保存在 `~/.local/share/oh-my-rein/`。本地安装包和 Node 可执行文件必须保持可用。卸载 npm 包不会删除远程状态，也不会注销 harness 中的插件。

</details>

**验证范围：**隔离测试覆盖包在 `node_modules` 中运行、安装与重试、配置冲突、编译后的 worker 执行。自动化安装测试替代 SSH 和 harness 安装命令，实际运行三种 adapter 的编译后运行时。另已验证 Claude/Pi 原生安装，以及真实 DeepSeek 的双任务并行、上下文选择、报告/补丁回收、原会话恢复、验收/审查/完成和新会话隔离。另已用安装包验证原生 Claude 主 agent → 真实 SSH Codex worker，覆盖任务要求纠正、结果审查、运行版本/配置更新和卸载。其他远程组合、全新系统安装、桌面 UI 和进程内会话切换仍待验证。详见[验证记录](https://github.com/rein-extension/oh-my-rein/blob/main/docs/validation.md)。
