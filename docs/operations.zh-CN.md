# 管理 Rein 连接

[安装指南](../INSTALL.zh-CN.md) · [English](operations.md)

## 找到连接

```sh
rein connections
rein host status --config /连接记录中的路径/endpoint.json
```

使用对应项目打印出的 `endpoint` 路径。状态会显示 Host 是否停止接收新任务，以及哪些执行尚未结束。这些命令不调用模型；排查问题时不要删除账本或重建连接。

## 权限请求

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

命令按当前项目、SSH Host 和 worker 类型选择已安装连接；存在多个连接时增加 `--harness` 或直接使用 `--config /connection/endpoint.json`，其他项目用 `--project /path/to/project`。新默认值持久保存在 Host；修改无需重启，已有会话（含排队和续接）保留原权限。并发修改冲突会要求重新读取。

Codex 支持 `--sandbox read-only|workspace-write|danger-full-access`、`--approval-policy on-request|never`；Claude 支持 `--claude-permission-mode manual|acceptEdits|dontAsk|bypassPermissions` 与 `--tools`；Pi 使用原生 `--tools`，并可配置 Rein 的 `--pi-tool-approval all|never` 审批层。`never`、`dontAsk` 与工具列表的语义由各自 harness 决定，不等于统一的完全放开。

Rein 不再对 delegate 的命令或路径另设分类规则。主 agent 应读取完整原生请求，再按用户授权决定；批准命令可能允许它以远程账号权限在沙箱外执行。当前只支持单次命令／文件／工具决策；未知请求或网络／会话级授权标记为 `unsupported`，不授予权限，也不伪装成用户拒绝。

**worker 审批适配：**

| Worker | 转发执行时审批 | 不转发时 |
| --- | --- | --- |
| Codex | `--approval-policy on-request`：原生命令／文件请求 | `never` 仍遵循配置的沙箱 |
| Claude Code | `--claude-permission-mode manual` 或 `acceptEdits`：原生 `can_use_tool` 请求 | `dontAsk` 或 `bypassPermissions` 遵循原生语义 |
| Pi | `--pi-tool-approval all`：Rein 独立扩展在**每个已启用工具**执行前暂停，包括读取 | `never` 不经过这个审批层 |

新安装默认使用 Claude `manual`、Pi `all`，初始仍只启用读／搜索工具；需要编辑或命令执行时显式添加工具。Claude 只转发原生权限检查实际产生的请求，`acceptEdits` 可直接允许编辑。可用工具取决于安装的 CLI 版本。Pi 的 `--no-approve` 控制项目文件信任，**不是**工具执行审批；Rein 收到 Pi 审批扩展就绪信号后才发送任务。

读取已有配置时不自动迁移权限，旧 Pi 配置未设置 `toolApproval` 时不新增审批。使用 `setup --update` 时需要重新指定期望的权限和 provider 选项，省略参数会使用新版默认值；随后可用 `worker permissions set` 修改新会话默认值。审批回复恢复原来的待执行操作，不新建 worker 轮次，也不授予永久规则；普通需求问答仍使用 `rein_continue`。Claude Code 2.1.322、Pi 1.5.2 已通过本地真实模型的允许、拒绝和原会话续跑测试，决策由测试脚本提供。桌面真实用户点击与真实 SSH 审批验收仍待完成。

**在主对话中：**同步后，权限请求显示在所属任务下，包含任务、Host、操作与影响。主 agent 用任务引用（`userTaskId`）调用 `rein_permission_review`：单个请求直接打开，多个请求先选择其中一个；旧的未归属执行仍可按执行选择。用户无需复制请求 ID。MCP 客户端需要支持表单 elicitation；Pi 使用原生选择界面。用户选择允许一次、拒绝或保持等待，模型不能通过工具参数填入决策。开启模式时检查已连接 Host 和本地界面；不支持审批界面时不开启。离线开启仅表示能力未验证。没有回答时保持等待，不默认批准，也不默认拒绝。取消审批工具调用也会保持等待，迟到的界面响应不能再签发决策；客户端若不能关闭现有弹窗，弹窗可能仍在，但回答不会生效。

**诊断用终端入口：**日常操作留在任务对话中；确需排障时，由用户本人在交互终端中运行，填写连接路径和原会话、执行、请求 ID：

```sh
rein main permission-review --state /connection/main \
  --config /connection/endpoint.json --project /path/to/project \
  --harness codex --instance INSTALLATION_ID --session SESSION_ID \
  --task EXECUTION_ID --value REQUEST_ID
```

终端先显示完整请求，再接受 `allow` 或 `deny`；直接回车保持等待。不要让 agent 代替用户输入确认。

新执行记录审批策略版本 2。没有版本号的旧请求保留原策略和操作摘要，其委托允许决策改为要求用户审核；排队中的旧执行不会自动升级策略，已签名的主 agent 允许决策在原生送达前还会重新检查。本地插件与 Host 需要同时更新，不能把部分升级当成这些保护已经生效。

安装时将本地签名公钥配对到远程 Host。决策绑定所属用户会话、执行、请求和操作摘要，独立于任务快照持久化；断线后可幂等补发。批准送达与原生操作结果分别记录。允许决策发出后若进程失联，可能已产生效果：先检查，再决定是否重试，不向替代进程重放旧审批。拒绝送达时中断会记录未授予权限，不声称送达已确认。取消执行不会撤销已经批准的操作：即使执行已停止或知识审查已丢弃，任务仍保留 `unknown` 操作效果和检查提醒。

确认执行停止并同步后，主 agent 对每个未知请求调用 `rein_effects_review`，提供实际检查证据，选择 `no-effects`（确认没有效果）或 `effects-addressed`（效果已检查并处理）。尚未处理的问题应保持打开。核查记录保存在本地账本，代表主 agent 的判断；原始 Host 审批记录保留，完整证据可在执行详情查看。核查后关闭对应提醒。未核查的未知效果会阻止同一用户任务的新派发、排队启动、后续允许决策及任务完成；发送前刷新相关 Host 快照，避免排队工作越过尚未同步的最终结果。无关任务、拒绝和取消仍可操作，已经运行的操作不会被追溯停止。旧执行有 task key 或原生 session 时按这些标识关联，不根据目标文本猜测关联。知识审阅和 Host 进程恢复是独立步骤；执行本身仍为 `unknown` 时，先按下文恢复。

取消回执可能先于最终执行与审批快照到达。出现 `sync_execution_final_state` 时，应继续同步，再核查影响或完成任务。Host 启动和巡检会恢复旧版 runner 中断的审批收尾；如果仍有 worker 存活，执行保持 `unknown`，需要先检查并停止。Host 明确确认从未启动的执行，无需审阅不存在的 worker 结果。

等待原生审批会保留 worker 进程并占用 Host 并发名额。每个审批请求在 30 分钟后过期。worker 的同一次执行可以持续数小时，你也可以在对应任务中取消执行。网络断开不会自动批准或拒绝，重连后同步即可；尚未验证主对话自动唤醒。

信任边界包括本地 harness／交互界面、安装账号和远程 Host。签名阻止工具参数冒充用户或未配对的决策消息，不能防御能读取本地私钥或控制 Host 的代码。Claude/Pi 工具过滤不等于通用操作系统沙箱。旧报告中的 `permissionDecision`／`userQuote` 不再授予权限，这类阻塞会话需新建原生 worker；普通需求问答仍使用 `rein_continue`。

## 修改模型或运行版本

先让主 agent 停止派发新工作。重新使用原有安装参数，增加 `--update`，只修改你想改变的设置：

```sh
rein setup --host worker-host --project ./my-app \
  --remote-project '~/projects/my-app' --sandbox workspace-write --update
```

请保留原来的 `--harness`、`--worker`、profile/provider、认证来源和模型参数；省略的参数使用默认值。升级软件时，先安装新的预览包，再运行带 `--update` 的安装命令，最后重新加载 harness。

安装器先准备运行文件，再让 Host 停止接收新任务。已排队的工作仍会继续执行；只要存在排队、运行中或 `unknown` 执行，更新就会停止。回到原会话同步，等待或明确取消剩余执行，再重试。如果暂时放弃更新、希望继续接收新任务：

```sh
rein host resume --config /连接记录中的路径/endpoint.json
```

确认空闲后，安装器才停止 supervisor、备份配置、更新并重启 Host。任务历史、产物和连接地址保留。配置备份位于远程 Host 状态目录的 `backups/`，不包含数据库备份。仍被连接引用的旧运行目录必须保留；当前流程支持同一预览协议内的更新，不是通用数据库迁移。

配置更新中断后，用**相同安装包和参数**重试 `--update`；待完成的更新会阻止 Host 启动。如果遗留 setup 锁，先确认上次安装进程已停止，再移除提示中的空锁目录。本地插件安装失败时，远程状态会保留供重试。

只调整并发数或超时不会阻止旧 worker 会话续接；下一轮启动时使用当前超时。安装器会利用更新前的配置迁移旧版会话摘要，中断后重试也保留这个依据。若旧版配置被直接编辑，Rein 可能无法证明兼容性：应恢复已知旧配置后通过更新流程操作，或开启新会话，不能猜测未知摘要兼容。

## 恢复 unknown 执行

```sh
rein host inspect --config /连接记录中的路径/endpoint.json --task RUN_ID
```

在远程机器检查记录中的 runner/worker 进程、`HOST_STATE/runs/RUN_ID/` 下的日志和产物，以及可能的外部影响。新版 worker 的工作目录及原生历史位于 `HOST_STATE/sessions/WORKER_SESSION_ID/`；旧执行的工作目录仍在 run 目录下。核实身份后再停止存活进程；旧 PID 可能已经被复用，不能直接照着记录杀进程。

确认执行及其后代进程均已停止后：

```sh
rein host resolve --config /连接记录中的路径/endpoint.json \
  --task RUN_ID --confirm-stopped \
  --reason '已核查进程停止，并检查工作目录与外部影响'
```

如果记录中的 runner 或 worker 进程组仍存活，Rein 会拒绝恢复；你的确认涵盖未被跟踪的后代进程和外部影响。恢复将执行标记为**已取消**，保存文件与处理记录，释放并发名额，不会标记成功或撤销外部修改。回到原会话同步后，再决定是否派发新执行。

## 停用与卸载

```sh
rein host drain --config /连接记录中的路径/endpoint.json
# 回到原会话同步，完成或明确取消尚未结束的工作。
rein host stop --config /连接记录中的路径/endpoint.json
```

存在未结束的执行时，停止请求会被拒绝。命令回执表示 Host 接受了退出请求、连接随后关闭或不可达；SSH 断开本身不能证明远程进程已经退出。配置更新会另外核查 supervisor 已停止，才修改文件。

通过 harness 自带的插件/扩展管理器停用并移除 Rein，再卸载本地命令：

```sh
npm uninstall -g oh-my-rein
```

任务数据与远程运行文件仍保留在两端的 `~/.local/share/oh-my-rein/`，卸载不会删除它们。连接仍在使用时，不要删除状态或旧运行目录。普通停止或重启机器后，可以用相同参数重跑 setup；如果此前主动执行了 drain，检查状态后用 `host resume` 恢复接收任务。

## 使用任务产物

让原会话中的主 agent 同步、收取并审查报告和补丁。收取会校验文件完整性，但不会修改本地项目。需要使用修改时，明确让主 agent 检查并应用所选补丁，再运行相应检查。验收是审查记录，不代表补丁已经合并。

积累的事件会按编码后的响应大小分页同步。大报告在收取前保留于产物中；`reportOmitted: true` 表示主 agent 需要先收取完整报告，再检查要求或保留发现。一次有时间预算的同步可能留下后续页面，下一次交互继续处理。本地插件和 Host 都需更新才能获得完整支持；新插件可以读取旧版数组协议，但旧 Host 的超大事件积压需要更新 Host 才能恢复。

任务范围内的目标、约束和决定默认属于必需条件。新增、修改或退役这些记录会同步推进任务的需求版本，阻止接受旧结果。主 agent 需要重新读取版本，并显式选中所有有效必需条件后才能派遣。可选背景备注可设为 `requiredForTask: false`；项目记录和偏好默认可选。必须留在本地的必需条件会阻止远程派遣，不会被静默遗漏或发送。

## 继续同一个 worker 会话

worker 返回结构化问题后，本轮进入 `waiting_input`，释放 Host 并发名额。用户在原来的主对话中回答；主 agent 使用 `rein_continue`，指定上一轮执行、问题 ID、答案和当前任务快照。新一轮保留原生 session 与工作目录，另存输入、报告和产物。同一 worker session 串行，不同 session 仍可并行。正常完成的轮次也能接收后续要求。原生历史丢失、运行状态不明或已取消时，不会静默新建会话代替恢复。

每轮 patch 都相对于该 session 最初的 base commit，包含累计修改。把选定的最新 patch 应用于该基线，不要在旧轮次 patch 上叠加。前一轮仍需审查，但标记为 `continued` 的中间轮次不能独立完成最终验收。没有 worker session 标识的旧执行不支持续接；两端更新并重新加载插件后才能使用新工具。

任意前置轮次选用的知识，仍是该原生会话的依赖。将其失效后，续跑、待投递命令、结果验收和用户任务完成都会被拦截，即使新快照不再选择该知识 ID。应使用修正后的快照创建新的 worker 会话，再验证结果。曾选用的上下文改为 local-only 后，同样会拦截该会话，包括已经入队的续跑。撤销共享不会删除远程历史，也无法收回已在传输中的启动请求；需要检查已投递的工作，并按需取消。缺失或身份不符的本地历史会阻止复用和验收，不会静默丢弃依赖。

普通用户上下文修订可以沿用原生会话，但下一轮必须显式选入该条目的当前版本。最近一次选入的版本替代该条目的旧引用，旧轮次快照保持不变。省略条目会继承最近选用的版本，不能绕过修订检查。检查覆盖入队、投递、验收和用户任务完成，也包括可选任务上下文与项目上下文。已选用条目被停用后，需要新建 worker 会话。

保留的知识分别记录 worker 的 `workerClaimedVerified`、主 agent 的审查身份／时间，以及验证证据。`rein_review` 可传入 `verificationEvidence`，描述实际执行的检查及结果；没有证据时，即使 worker 自报成功，知识也仍为未验证。有证据时明确标为 `main-reported`；兼容字段 `verified` 表示主 agent 提交了证据，不代表 Rein 独立运行或认证了检查。旧版仅来自 worker 的标记也按未验证读取。使用知识前，应读取完整条目核查证据。

暂停只阻止新派遣与尚未投递的命令；已经交给 Host 的 worker 可以完成，报告保留。取消是独立操作，需确认停止。当前未实现运行中插话或主对话自动唤醒；原生权限请求显示在所属任务中，见上文。

## 结果与恢复边界

任务快照上限 256 KiB、报告 4 MiB、单个产物 16 MiB，各字段也有长度限制。超限结果在发布前失败，不再显示为成功却无法收取。检查执行和重复启动回执会省略大报告正文。

worker 子进程只收到基础环境及显式选定的 provider 凭据，使用独立 HOME 和原生状态目录。Rein 日志及发布报告会遮蔽已知 provider 凭据原文，包括跨日志数据块的值；包含这些值的 patch 会被拒绝。这不是通用秘密检测或 OS 沙箱：原生 session 文件、未识别的秘密和模型工具访问仍受各 harness 自身能力约束；worker 与 Host 使用同一 OS 用户。

同步除重放事件外，也会与 Host 当前快照对账；被修复的异常事件保留审计记录。Host 数据库身份发生变化时会停止投递，需先检查原 Host 与未确认工作，再明确配置替代连接。不要删除本地账本来掩盖不确定状态。自动保留期清理、账本备份/导出和开机服务仍待实现。

Host 明确拒绝启动时，会单独保存拒绝记录。检查原因后，用 `rein_review` 的 `decision: "discard"` 完成这次失败尝试的审查；它没有 worker 运行结果、产物或可保留的发现。替代执行成功且其他条件满足后，用户任务即可正常完成。旧账本只在已结算的拒绝证据相互匹配时兼容识别。缺少运行记录、回执丢失或投递结果不明，仍需同步和对账，不能按“确认拒绝启动”直接收尾。
