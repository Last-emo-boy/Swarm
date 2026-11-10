# Swarm 指南

[English](GUIDE.md) · 简体中文

这里按命令逐条介绍 Swarm 的全部功能。想了解 Swarm 是什么并完成第一次会话，请先阅读 [README](../README.zh-CN.md)。

## 目录

- [安装和配置](#安装和配置)
- [产品状态](#产品状态)
- [主流程](#主流程)
- [CLI](#cli)
- [TUI](#tui)：[主要命令](#主要命令)、[结果卡片](#结果卡片)、[布局](#布局)、[按键](#按键)、[输入](#输入)
- [能力和扩展](#能力和扩展)
- [安全和权限](#安全和权限)
- [本地 Gateway](#本地-gateway)
- [Symphony](#symphony)
- [工单](#工单)：[角色和机器人命令](#角色和机器人命令)、[harness worker](#harness-worker)、[harness 子代理](#harness-子代理)
- [网格](#网格)：[让节点保持运行和最新](#让节点保持运行和最新)
- [用量、价格和预算](#用量价格和预算)
- [架构](#架构)
- [记忆和恢复](#记忆和恢复)
- [调试](#调试)
- [配置](#配置)
- [开发](#开发)
- [基准测试 CLI](#基准测试-cli) 和 [基准测试包装器](#基准测试包装器)

## 安装和配置

Swarm 需要 Node.js 24 或更新版本。

```bash
git clone https://github.com/Last-emo-boy/Swarm.git
cd Swarm
npm install
npm run build
npm install -g .
swarm onboard   # 选择服务商和模型，并输入它的 API key
swarm           # 在当前目录打开 TUI
```

之后运行 `swarm update` 会拉取该克隆所跟踪的分支（仅快进），运行 `npm install` 和 `npm run build`，并在节点服务运行时重启它；`swarm update --check` 只报告是否有更新在等待。它会拒绝三种克隆：有未提交改动的、所在分支没有跟踪任何远程的、有自己独有提交的；对于其他安装方式（复制的软件包、容器镜像），它会说明应当如何更新。

也可以手动配置：

```bash
swarm auth set-key openai sk-...
swarm models set \
  --planner kimi-coding/kimi-for-coding \
  --worker kimi-coding/kimi-for-coding \
  --aggregator kimi-coding/kimi-for-coding
```

不打开 TUI，运行单个目标：

```bash
swarm run "read this repo and summarize the main runtime"
```

## 产品状态

发布就绪状态以离线发布门禁（`npm run release:gate`）为唯一依据，它必须在不付费调用服务商的情况下通过。一项已实现的声明，只有同时具备源码锚点和针对性的测试锚点，才算有据可依。

当前已验证的能力范围：

- 以 CLI/TUI 为先的本地编程产品，包括结果卡片、恢复/记忆检查、斜杠命令操作界面、提示词缓存状态、限定范围写入/只读策略、本地 LSP 语义辅助，以及本地 Work Kernel 查看。
- 有证据支撑的本地 Swarm v2 协作（Evidence-backed local Swarm v2 collaboration）：执行者身份、邮箱投递、所有权租约、交接转移、黑板的认领/提案/决策流程、Gateway/Symphony/LSP 能力参与方、协议调试时间线、`/swarm` 工作台投影、真实 swarm 离线评测，以及旧版直连路径迁移审计，均已实现，并由针对性的本地测试/评测覆盖。
- 本地 Gateway 自动化，覆盖运行、事件流、实时审批、会话、worker、交接、能力、有界的检查点路由，以及 Symphony 路由冒烟测试。
- Symphony 在本地后台接收仓库自带工作来源里的工作，包括本地/模拟来源解析、调度器恢复、守护进程生命周期、runner 终态记录、工作流加载失败处理、工作区边界检查、CLI/Gateway/TUI 共用的状态格式化，以及清理。
- 本地 ASP 协议行为：信封幂等性、进程内路由分发、黑板的写入/读取/更新/锁定/查询处理、任务/产物/竞标/共识处理、回复关联，以及保守的执行路由回退策略。
- 有界的子进程 ASP 传输行为：子运行时的信封进入路由器，指定了收件方的回复返回给子代理，任务进度变成循环活动，本地能力/幂等重放的边界情况都有测试。

仍然有意保持有限范围：

- 一条有界的 Gateway 检查点路由（bounded Gateway checkpoint route）现在可以通过现有的运行时辅助函数，为当前服务器工作区列出、创建和回退检查点。更广泛的检查点编排（broader checkpoint orchestration）仍然推迟：会话/运行范围的检查点 API、分布式检查点传输、检查点存储重新设计、检查点事件流扩展，都不是已完成的产品声明。
- 更广泛的分布式 ASP 传输仍在计划中（Broader distributed ASP transport is still planned）：网络/跨主机路由、新的分布式 worker 模型、换用其他 worker 重试的健康策略，以及分布式追踪，都不是已完成的产品声明。
- 单次运行的跨主机分布式网络（cross-host distributed network）执行（[网格](#网格)是把整个工单 worker 放到已配对的设备上，而不是把一个计划的各个 worker 分散到多台主机上）、超出本地协议测试用例的复杂共识（complex consensus），以及接入外部服务商的实地试用（external provider dogfood），仍然推迟或属于可选项；默认发布门禁不需要付费调用服务商。
- Hook 竞态下的审批仲裁和丰富的 WorkSource 写入仍然推迟（Hook-race approval arbitration and rich WorkSource writes remain deferred）。

## 主流程

1. 在项目目录中运行 `swarm`。
2. 输入一个自然语言目标。
3. Swarm 询问时，审批有风险的工具。
4. 观察输入框上方的活动行：当前在运行什么、已运行多久、有多少个 worker。
5. 阅读回答。回答下面的一行说明改了什么、哪些检查通过了；Ctrl+O 打开完整的结果卡片，其中包含评审和记忆新鲜度。
6. 之后用 `/continue`、`/resume` 或 `/memory` 继续。

默认情况下，Swarm 不是报告生成器。对于编程和项目工作，最终产物是工作区中真实的改动。长日志、worker 草稿、追踪快照和大段工具输出会存放在本地 Swarm 状态下，而不会刷满聊天。

## CLI

```text
swarm [--debug] [--debug-trace] [--yolo]

Commands:
  chat       Open the interactive Swarm TUI (default)
  run        Run one objective non-interactively
  work       Run one objective through the local coding_loop main path
  watch      Follow the live Gateway event stream for the current workspace
  runs       Inspect active and recent Gateway runs
  checkpoints
             List, create, and revert local workspace checkpoints
  sessions   List, inspect, resume, execute, and fork persisted WorkSessions
  workers    Inspect, watch, stop, and continue persisted worker contracts
  handoffs   Inspect, watch, and take back persisted handoff contracts
  approvals  Inspect approval records and answer live Gateway approval requests
  ps         Alias for `swarm sessions`
  doctor     Diagnose local model setup, stores, extensions, logs, and Symphony preflight
  logs       List recent debug logs or tail the latest matching log file
  capabilities
             List, inspect, refresh, toggle, and invoke capability-plane surfaces
  plugins    List, inspect, validate, and manage plugin roots and plugin enablement
  skills     List, inspect, and activate discovered Agent Skills
  mcp        List, inspect, refresh, and read configured MCP servers, resources, and prompts
  lsp        Inspect local Language Server Protocol providers and logs
  yolo       Open chat with temporary yolo permissions for this process
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  serve      Start the local Swarm Gateway HTTP/event-stream server
  symphony   Run local work-source automation commands
  superagent Run the ticket host and manage tickets from GitHub, Feishu and this terminal
  harness    List the agent harness profiles here: installed, signed in, keys set
  mesh       Pair this device with other Swarm devices and see them
  node       Run this device's node: the ticket host and the mesh server peers call; install it as a service
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List or add model providers
  models     Show or update selected models
  version    Print the installed Swarm version
  update     Pull, install and build a clone install, and restart its node service; --check only looks
  usage      What model calls and harness turns used and cost, by model, provider, harness, device, ticket or day

Run modes:
  auto         Default. Structured route decision; usually starts with coding_loop.
  coding_loop  Main Swarm read/edit/command/test loop.
  chat         Answer without inspecting or modifying the workspace.
  full_swarm   Experimental ASP planner/worker/reviewer/aggregator path.
```

目前预设的服务商包括 OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、xAI、Groq、Cerebras、Together AI、Fireworks、Moonshot、Kimi Coding Plan、Mistral、SiliconFlow、DashScope、Requesty、Helicone、Ollama、LM Studio、vLLM、LocalAI，以及自定义的 OpenAI 兼容或 Claude 兼容端点。

无头运行可以输出机器可读的产物：

```bash
swarm run --mode auto --json --report report.json "fix the failing tests"
swarm work "fix the failing tests"
swarm run --stream-json "fix the failing tests"
swarm run --permission-mode full-auto "apply the mechanical rename"
swarm run --approval-mode wait "run the gated command and wait for approval"
swarm run --read-only --stream-json "audit the auth flow"
swarm run --add-dir ../shared --read-only "audit this repo and shared types"
swarm run --max-turns 3 --max-tool-calls 12 "make the smallest safe fix"
swarm run --allowed-tools Read,Glob,Grep "audit this repo without edits"
swarm run --append-system-prompt "Answer in release-note format." "summarize the diff"
swarm run --system-prompt-file ./agent-prompt.md "run this custom agent prompt"
swarm run --skill repo-auditor --skills testing,release-notes "inspect this change"
swarm run --mcp-config ./mcp.servers.json --strict-mcp-config "use only these MCP tools"
swarm run --resume sess_123 "continue with the failing test output"
swarm run --continue "finish the verification"
swarm resume sess_123 "continue with the failing test output"
swarm continue "finish the verification"
swarm watch --gateway-url http://127.0.0.1:38171
swarm watch --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm live --gateway-url http://127.0.0.1:38171
swarm attach --gateway-url http://127.0.0.1:38171
swarm sessions
swarm sessions show latest
swarm sessions watch latest --gateway-url http://127.0.0.1:38171
swarm sessions attach latest --gateway-url http://127.0.0.1:38171
swarm sessions watch sess_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm sessions resume sess_123 "continue with the failing test output"
swarm sessions continue "finish the verification"
swarm reply "focus on the failing tests" --gateway-url http://127.0.0.1:38171
swarm interrupt "stop after the current safe boundary" --gateway-url http://127.0.0.1:38171
swarm reply "focus on the failing tests" --request-id retry-safe-001 --gateway-url http://127.0.0.1:38171
swarm sessions execute sess_plan_123 --gateway-url http://127.0.0.1:38171
swarm sessions fork sess_plan_123 "try the alternative fix path" --gateway-url http://127.0.0.1:38171
swarm sessions stop sess_123 "stop after the current safe boundary" --gateway-url http://127.0.0.1:38171
swarm runs --gateway-url http://127.0.0.1:38171
swarm runs show latest --gateway-url http://127.0.0.1:38171
swarm runs watch latest --gateway-url http://127.0.0.1:38171
swarm runs watch run_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm checkpoints
swarm checkpoints create "before risky refactor"
swarm checkpoints revert last
swarm workers --session sess_123
swarm workers watch worker_123 --gateway-url http://127.0.0.1:38171
swarm workers continue worker_123 "rerun the verification" --gateway-url http://127.0.0.1:38171
swarm handoffs --session sess_123
swarm handoffs watch handoff_123 --gateway-url http://127.0.0.1:38171 --protocol runtime --jsonl
swarm handoffs take-back handoff_123 --gateway-url http://127.0.0.1:38171
swarm ps --limit 5
swarm run --telemetry telemetry.json --trajectory trajectory.json "inspect this repo"
swarm doctor
swarm doctor ./WORKFLOW.md --workspace ../other-repo
swarm logs
swarm logs latest --tail 80
swarm capabilities
swarm capabilities --all local_tool
swarm capabilities show local_tool.Read
swarm capabilities invoke local_tool.Read path=README.md
swarm capabilities hide local_tool.Read
swarm capabilities unhide local_tool.Read
swarm plugins
swarm plugins show workspace-demo
swarm plugins install ../shared-plugins
swarm plugins disable workspace-demo
swarm plugins validate
swarm skills
swarm skills show repo-auditor
swarm skills activate repo-auditor --session sess_123 --reason "use the repo audit checklist"
swarm mcp
swarm mcp show demo
swarm mcp refresh demo
swarm mcp resources demo
swarm mcp read demo memory://greeting
swarm mcp prompts demo
swarm mcp prompt demo greeting name=Swarm
swarm approvals
swarm approvals pending --gateway-url http://127.0.0.1:38171
swarm approvals show approval_123
swarm approvals approve approval_123
swarm approvals approve approval_123 --gateway-url http://127.0.0.1:38171
```

`swarm work ...` 是本地 `coding_loop` 主路径的简写命令。它接受与 `swarm run` 相同的运行参数，并在执行前设置 `--mode coding_loop`。

`swarm doctor` 为当前工作区打印一份本地就绪报告：模型和 API key、权限模式、核心存储路径、最近的 Kernel 状态、发现的命令/技能/插件/MCP 服务器、最新的调试日志路径，以及 Symphony 工作来源/预检状态。报告中包含 `FAIL` 行时，它以非零状态退出。

`swarm logs` 把 `~/.swarm/logs` 变成一个产品界面，而不是隐藏的实现细节。不带参数时，它列出最近的调试日志；带上 `latest` 或匹配的文件名时，它打印该日志的末尾部分。

`swarm watch` 通过 Gateway 提供一条覆盖整个工作区的实时操作流。默认视图跟随稳定的工作协议，因此队列、活动、任务、权限、worker 和交接事件都会出现在同一个终端里，没有 TUI 的界面装饰；`--protocol runtime --jsonl` 切换到原始的运行时流，供自动化使用。如果只想看某个特定范围而不是整个工作区，请使用范围更窄的 `sessions`、`runs`、`workers` 或 `handoffs` watch 命令。`swarm attach` 是附加到最新会话流的简写形式。

`swarm capabilities` 把共享的能力平面变成一等 CLI 界面。`list` 汇总已加载的目录，`--all` 把它展开成完整的提供方和能力视图，`show` 查看单个能力，`refresh` 重建单个提供方或整个目录，`enable` / `disable` 和 `hide` / `unhide` 持久保存能力设置，`invoke` 则经由 TUI 和 Gateway 所用的同一个 broker 进行路由。

`swarm runs` 把 Gateway 的内存运行表变成一等 CLI 界面。`list` 显示当前 Gateway 进程中活跃的和最近的运行，`show` 查看单个运行，包括关联的会话 id，以及执行结束后的最终结果，`watch` 实时跟踪关联会话的事件流。默认的 `watch` 视图跟随稳定的工作协议流，输出便于操作者阅读的队列/活动/任务行，而 `--protocol runtime` 切换到原始的运行时事件流，`--jsonl` 输出结构化的 watch 记录，供自动化使用。

`swarm checkpoints` 暴露的是 TUI 结果卡片和 `/checkpoint` 命令所用的同一个本地工作区检查点来源。`list` 打印当前工作区最近的检查点记录，`create <name>` 为已跟踪的工作区状态创建快照，`revert [checkpoint_id|last]` 恢复最近的或指定的检查点。传入 `--workspace <path>` 可以操作另一个检出目录，传入 `--json` 可以得到便于自动化处理的输出。本地 Gateway 也为脚本暴露了一组有界的、限于工作区范围的检查点路由：`GET /v1/checkpoints`、`POST /v1/checkpoints` 和 `POST /v1/checkpoints/:id/revert` 委托给相同的运行时辅助函数，并且创建/回退需要 Gateway 的变更授权。超出这组路由的更广泛检查点编排仍然推迟。

`swarm sessions` 把持久化的 Work Kernel 会话变成一等 CLI 界面。不带子命令时，它列出当前工作区最近的会话；`show` 打印存储的快照和恢复健康状况；`resume` 和 `continue` 复用同一条无头 coding-loop 续跑路径，你不必每次都写出 `swarm run --resume`。`execute` 可以通过本地 Gateway 启动一个已存储的计划，而 `fork` 从现有会话分支出一个新的已存储计划，可以附带一条新指令。无头会话恢复现在与 TUI 共用同样的预检摘要和已存储计划防护规则。`watch` 直接跟随单个会话的 Gateway 事件流，这样你可以让一个终端保持附加在实时的队列/活动/任务更新上，同时在另一个终端使用 `reply` 或 `interrupt`；`attach` 是同一个命令，用于常见的“加入实时会话”工作流。`stop` 和 `kill` 是 `interrupt` 的别名，让会话生命周期控制使用操作者自然会想到的词。默认视图跟随稳定的工作协议流，而 `--protocol runtime` 和 `--jsonl` 暴露原始事件，供自动化使用。

`swarm workers` 把持久化的 worker 契约变成一等 CLI 界面。本地的 `list` 和 `show` 命令查看工作区或会话族的 worker 状态，`watch` 通过 Gateway 跟踪父会话和附加的 worker 会话，让你跟进实时的委派进度，`stop` / `continue` 通过本地 Gateway 桥接，无需打开 TUI 即可控制 worker。

`swarm handoffs` 对持久化的交接契约做同样的事。`list` 和 `show` 查看会话族的交接状态，`watch` 跟随活跃的交接及附加的 worker 会话，`take-back` 通过本地 Gateway 收回一个活跃的交接，同时停止被委派的 worker。

`swarm approvals` 把审批历史和实时审批决定变成一等 CLI 界面。本地的列表命令和 `show` 命令查看当前工作区或某个会话族的持久化审批记录，而 `pending`、`approve` 和 `deny` 可以通过本地 Gateway 桥接，无需打开 TUI 即可答复可操作的审批。

`swarm plugins` 把插件发现和插件启用变成一等 CLI 界面。`list` 和 `show` 展示发现的清单目录，`install` 和 `remove-root` 管理显式的插件根目录，`enable` 和 `disable` 持久保存插件信任状态，`validate` 报告清单或贡献项的诊断信息，无需打开 TUI 或 Gateway。

`swarm skills` 把技能发现和按会话激活变成一等 CLI 界面。`list` 和 `show` 展示发现的受信任技能目录，而 `activate` 把一个指定的技能附加到现有会话上，无需打开 TUI，也无需直接调用 Gateway。

`swarm mcp` 把已配置的 MCP 服务器变成一等 CLI 界面。`list` 和 `show` 展示服务器目录，`refresh` 按需重新连接服务器，`resources` / `read` / `prompts` / `prompt` 让短生命周期的 CLI 进程也能查看或调用 MCP 内容，而不依赖一个已在运行的 TUI。

`--stream-json` 把 JSONL 记录（`run_start`、`runtime_event` 和 `run_end`）写到 stdout，供 SDK 包装器和自动化使用。`run_start` 包含生效的权限模式和沙箱模式，让自动化可以审计审批提示是被启用、减少还是绕过，以及该运行是否被允许写入。无头运行还会处理 SIGINT/SIGTERM：要求正在进行的工作在下一个安全边界停止，并在已有会话时打印 TUI 恢复提示。

`--sandbox read-only`（或 `--read-only`）在工具执行时阻止工作区写入、本地命令执行、软件包安装、分支切换、委派以及持久上下文的变更。它仍然允许只读的文件、git、进程查看、黑板读取/搜索/列出，以及有界的网页搜索/抓取工具。`--add-dir` 为该次无头运行把一个现有目录加入读取根目录，但不会扩大写入、shell 工作目录或分支变更的边界。

`--resume <session_id>` 和 `--continue` 复用与 TUI 相同的 Work Kernel 恢复提示词：Swarm 先注入之前的快照、压缩后的记忆、重放内容和工作区新鲜度契约，再重新运行本地 coding loop。已存储的计划会话与 `/resume` 有同样的防护规则：新指令会被拒绝，应改用 fork 来处理。`swarm resume ...` 和 `swarm continue ...` 是同一会话生命周期路径的短别名。`--max-turns` 和 `--max-tool-calls` 为无头运行限制本地 coding-loop 的预算，并记录在无头产物中。

`--allowed-tools` 和 `--disallowed-tools` 在本地 coding loop 中应用按运行生效的工具策略，动态工具也包括在内，选定的策略会记录在流、报告、遥测和轨迹产物中。

`--system-prompt` 替换该次运行的默认行为提示词，而 `--append-system-prompt` 在默认或替换后的提示词之后追加指令。`--system-prompt-file` 和 `--append-system-prompt-file` 从磁盘读取这些值。Swarm 仍会注入 coding-loop 工具协议，因此自定义提示词可以改变行为，而不会破坏本地工具桥接；产物只记录提示词的来源和字节数，不记录提示词内容。

`--skill NAME` 和 `--skills A,B` 只为该次运行或恢复的会话激活受信任的 Agent Skills。激活的技能说明会在 coding loop 第一轮之前加入；chat 模式的运行会在系统提示词中收到相同的技能内容。技能激活不会持久保存，运行产物只记录规范化后的技能名称。

`--mcp-config` 从 JSON 字符串或文件为该次运行加载 MCP 服务器，使用常见的 `{ "mcpServers": { ... } }` 结构。重复使用它可以加载多份配置，后面的条目覆盖前面的。不带 `--strict-mcp-config` 时，运行时 MCP 条目覆盖用户设置，而项目和插件的 MCP 来源仍照常加载。带 `--strict-mcp-config` 时，Swarm 只使用提供的运行时 MCP 配置，跳过项目、插件和持久化的 MCP 来源。运行产物记录来源类型、路径、字节数和服务器 id，不记录环境变量的值。

`--trajectory` 为基准测试 harness 写入 ATIF-v1.7 风格的轨迹。`--telemetry` 写入 Swarm 运行时遥测。

## TUI

CLI TUI 是唯一的产品界面。无头 CLI、Gateway 和 Symphony 路径是执行或自动化的入口。

### 主要命令

| 命令 | 用途 |
| --- | --- |
| `/help` | 打开分组的斜杠命令目录。 |
| `/help main` | 显示简洁的主路径摘要。 |
| `/help work`、`/help debug`、`/help ext`、`/help symphony` | 直接跳到某一个命令组。 |
| `/help all` | 保持完整目录可见，并包含所有高级命令。 |
| `/doctor [workflow_path]` | 诊断模型设置、权限、Kernel 存储和 Symphony 预检。 |
| `/mode [auto\|fast\|swarm\|chat]` | 显示或更改路由模式。 |
| `/permissions` | 查看权限模式、沙箱、规则、读取根目录和最近的审批。 |
| `/permission-mode [ask\|auto-edit\|full-auto\|yolo]` | 显示或更改审批策略。 |
| `/sandbox [workspace-write\|read-only]` | 查看或更改 TUI 的沙箱模式、范围和写入闸门。 |
| `/why` | 解释最近的路由、委派、评审和验证决定。 |
| `/session [session_id]` | 查看一个持久化的 Work Kernel 会话快照。 |
| `/memory [session_id]` | 显示记住的会话上下文，以及恢复前使用的新鲜度检查。 |
| `/resume [session_id] [message]` | 带预检摘要恢复之前的会话。 |
| `/continue [message]` | 带预检摘要继续最近的本地 coding-loop 会话。 |
| `/reply <message>` | 向活跃的运行发送一条实时回复。 |
| `/add-dir <directory>` | 为工具权限添加一个持久的只读目录。 |
| `/remove-dir <directory>` | 移除一个持久的额外读取目录。 |
| `/kernel [workflow_path]` | 显示 Swarm、Work Kernel 和 Symphony 的统一状态视图。 |
| `/status` | 当前 Kernel 状态视图的别名。 |
| `/attempts [session_id]` | 查看 Work Kernel 的运行尝试、失败、工作区和恢复提示。 |
| `/leases [session_id\|lease_id]` | 查看 Work Kernel 的工作区租约和写入边界。 |
| `/work-items [workflow_path]` | 查看本地 Symphony 活跃的和已终结的工作项。 |
| `/symphony [workflow_path]` | 查看本地 Symphony 调度器/会话状态。 |
| `/symphony-run-once [workflow_path] [--max-turns N]` | 在 TUI 中分派并执行一次 Symphony tick。 |

默认情况下，`/help` 在详情视图中打开分组的斜杠命令目录，而 `/help main` 保留较短的摘要。在你多输入几个字符之前，斜杠补全仍然偏向主路径。能力和扩展界面也从摘要开始；使用 `/capabilities all`、`/commands all`、`/skills all`、`/plugins all` 或 `/mcp all` 查看完整的高级目录。

对于已存储的计划会话，`/resume <session_id> <message>` 不再悄悄丢弃新消息。当你想把一条新指令分支到已存储的计划上时，Swarm 现在会要求你使用 `/fork <session_id> <message>`。

当没有活跃的运行可以接收时，实时回复和显式中断现在会直接失败（fail closed）。在没有兼容的运行时，`/reply`、`/interrupt`、`swarm reply`、`swarm interrupt`、`swarm sessions reply`、`swarm sessions interrupt`、Gateway 的 `POST /v1/live/messages`、`POST /v1/live/interrupt`、`POST /v1/sessions/:id/messages`、`POST /v1/sessions/:id/interrupt`，以及 MCP 的 `swarm.send_message` / `swarm.interrupt`，都不再声称工作已入队。`swarm sessions execute` 和 `swarm sessions fork` 现在桥接的是 Gateway 早已暴露的同一组已存储计划控制路由。显式中断现在会让活跃的本地 `coding_loop` 运行在下一个安全的循环边界立即停止，而活跃的 `full_swarm` 运行则会变成安全边界停止请求，在 Swarm 返回已停止的结果之前收回活跃的交接。

审批查看现在也遵循同样的规则：Gateway 审批路由和 MCP 审批工具会区分持久化的审批历史和实时可操作的请求。`pending_requests` 和 `actionable_approval_ids` 只针对当前 Gateway 进程；`approvals` 是持久化的 Work Kernel 历史。MCP 的 `swarm.session_status` 和 `swarm://sessions/<id>` 现在复用与 Gateway 相同的会话快照，包括 `work_snapshot`、`task_contracts` 和 `work_contracts`。`swarm://sessions/<id>/approvals` 以只读资源的形式暴露持久化的审批历史。Gateway 的 `GET /v1/sessions` 和不带 `session_id` 的 MCP `swarm.session_status` 现在也共用一份工作区概览契约：最近的会话、审批摘要、工作区工作契约、MCP 服务器目录和活跃的实时目标状态，会以相同的结构返回给本地自动化和 MCP 客户端。

常用的高级控制命令包括 `/self-review`、`/improve-self`、`/evals`、`/read`、`/grep`、`/glob`、`/shell`、`/web`、`/diff`、`/output`、`/workers`、`/handoffs`、`/approvals`、`/audit`、`/usage`、`/symphony-tick`、`/symphony-daemon`、`/symphony-start`、`/symphony-stop`、`/symphony-cleanup`、`/capability-enable`、`/capability-disable`、`/commands`、`/plugin-install`、`/plugin-enable`、`/plugin-disable`、`/skill`、`/mcp-refresh`、`/mcp-resources`、`/mcp-read`、`/mcp-prompts` 和 `/mcp-prompt`。

`~/.swarm/commands`、`.swarm/commands` 或配置的 `settings.extensions.commands.roots` 下的 Markdown 文件会成为自定义提示词斜杠命令。名为 `review.md` 的文件会创建 `/review`；frontmatter 可以设置 `name`、`description` 和 `argument-hint`。受信任插件的斜杠命令会出现在同一个 `/commands` 目录和斜杠补全界面中。提示词正文通过正常的 Swarm 运行循环发送，其中的 `$ARGUMENTS` 会被替换为斜杠命令的参数。项目命令与其他项目扩展一样，遵循受信任工作区的策略。

当权限模式和沙箱模式不是默认值时，TUI 标题栏会显示它们。`/sandbox` 现在会报告当前仅限 TUI 的沙箱范围、读取根目录，以及沙箱与权限之间的相互作用。`/sandbox read-only` 让运行经过本地 coding loop 沙箱，从而在执行时拒绝类似写入的工具操作；`/sandbox workspace-write` 恢复正常的工作区写入，但仍受权限策略约束。

### 结果卡片

正常的运行现在会以一张结果卡片结束。在对话中，它是回答下面的一行，例如 `2 files changed · 1 check passed · /revert last undoes it` 或 `✗ Failed · command exited 1`；Ctrl+O 打开这张卡片，其中显示：

- 会话 id 和完成状态；
- 改动的文件；
- 检查和验证信号；
- 评审摘要；
- 记忆新鲜度说明；
- 长输出被持久保存时的产物路径。

`/session <session_id>` 在展示更深入的 Kernel 记录之前，先显示同样的结果卡片。`/memory [session_id]` 显示记住的上下文，以及 Swarm 在恢复前注入的同一份新鲜度契约，让过时的会话记忆变得可见，而不是被悄悄信任。

### 布局

主屏幕就是对话，从上到下依次是：

- 一行标题栏：`swarm`、模型和工作区；右侧只显示不是默认值的模式，例如用 `/mode` 设置的运行模式、`yolo` 权限模式或 `read-only` 沙箱；
- 对话记录：你的发言以 `›` 开头，回答是普通的 markdown。每次工具调用占一行，包含一个动词（Read、Edit、Bash、Search、Fetch、Agent…）、它的目标和执行情况（`✓`、带原因的 `✗`、`approved`、`denied`、秒数），运行期间原地更新；该轮结束后，它的调用会折叠成一行，例如 `▸ Read 2 files, ran 1 command · 1 failed`，按 Enter 可以展开。空会话会显示两行不显眼的文字；
- 工作运行时，输入框上方有一行活动行：当前在运行什么、已运行多久、有多少个 worker，以及 Ctrl+C 可以中断。Ctrl+R 会在它上方列出正在运行的 worker；
- 输入框，`›`；
- 状态栏：只显示需要关注或说明当前进展的内容（已达到的预算、其他会话在等待的审批、需要你处理的工单、本设备今天的花费），右侧是 `? keys`。点击某一项会打开它的视图。

审批会以一张简短的卡片取代输入框的位置：调用要做什么、对什么做、触发询问的规则，以及 `y yes · a always · n no · ? details`。编辑会显示其 diff 的前几行，高风险调用会显示红色的 `!` 及原因；`?` 会在卡片内打开请求携带的全部内容（风险等级、评审重点、为何是现在、权限、治理、影响、回滚）。等待运行的计划也使用同样的卡片。

使用 `/view` 打开聚焦的 Kernel 面板，例如 Trace、Overview、Output、Sessions、Attempts、Activity 和 Blackboard；`/tickets` 打开工单。每个都是全屏视图，带有标题、正文以及在那里可用的按键；Esc 或 `q` 返回对话，`/` 返回对话并开始输入一条命令。期间到达的审批会显示在视图底部。Overview 显示正在运行的任务及其写入策略，以及 auto 模式最近实际选择的路由，例如 `coding_loop` 或 `full_swarm`，并附带置信度和路由器给出的理由；Activity 面板汇总 worker、审批和后台工作，而不把 agent 的内部细节作为默认视图。模型、权限、gateway、缓存、LSP、MCP 和 Symphony 的健康状况在 `/status` 中查看。

TUI 会为当前的聊天状态创建一个本地 Work Kernel 会话。斜杠工具的审批和工具结果都记录在该会话下，因此 `/session`、`/attempts`、`/approvals`、`/audit` 和 `/usage` 可以查看 TUI 本地的工作，而不是显示孤立的工具事件。

### 按键

按键只作用于两处之一：输入框或对话记录。输入框用于打字；在空输入框上，`?` 列出所有按键，Esc 移到对话记录并选中其最后一行。在对话记录中，↑↓（或 `j`/`k`）选择一行，Enter 或 `x` 折叠和展开它，`o` 或 Ctrl+O 打开它的详情，`/` 搜索，Esc 或直接打字回到输入框。Ctrl+F（或 `/search [text]`）可以在任何地方搜索对话记录，Ctrl+O 打开最新的详情，Ctrl+T 打开任务详情，Ctrl+C 在运行时中断运行，在空闲时退出。

### 输入

输入框支持用 Up/Down 浏览命令历史，同时保留当前尚未发送的草稿。它支持用 Left/Right 移动光标，用 Ctrl+A/Ctrl+E 跳到行首和行尾，用 Ctrl+U 删除光标之前的草稿，用 Ctrl+K 删除到行尾，用 Ctrl+W 删除前一个单词，用 Ctrl+Y 粘回上一次删除的文本，并在常见的终端编码下稳健地处理 Backspace/Delete。

Enter 提交草稿。Ctrl+J 或 Alt+Enter 插入换行。粘贴的多行文本会留在草稿中，而不会提交不完整的提示。输入 `/` 会显示斜杠命令候选项；Up/Down 移动高亮的候选项，Tab 接受它，Esc 关闭候选列表。

斜杠命令的结果在 TUI 中渲染为预览。对于长输出，Ctrl+O 打开完整的详情视图，最近的斜杠工具输出可以在 Output 面板中查看。较大的斜杠工具输出保存在本地会话输出存储中，并显示为一段预览加一个完整输出的路径。

模态视图独占自己的键盘输入。审批视图和详情视图会在全局快捷键之前处理 Escape/Ctrl+C/Ctrl+O，因此关闭浮层不会中断正在进行的工作，也不会改变下层的面板。

输入框由 TUI 自己的渲染器根据本地输入状态渲染，而不是靠手动的 stdout 重绘循环。这让删除和光标移动的行为可以预期，也避免每输入一个字节就重绘一次主面板。

## 能力和扩展

Swarm 的扩展能力平面把内置工具、MCP 服务器、Agent Skills、斜杠命令、agent 规格以及未来的插件，统一到同一套 Gateway、TUI、权限、审计和 Work Kernel 记录之后。参见 [EXTENSION_CAPABILITY_PLANE.md](EXTENSION_CAPABILITY_PLANE.md)。

能力和扩展界面同样从摘要开始。Gateway 的目录端点会返回原始记录，并为能力、技能、插件和 MCP 服务器附带一个共享的 `summary` 对象，让集成方可以展示与 TUI 相同的摘要优先界面。

### 内置工具族

| 工具族 | 示例 |
| --- | --- |
| 文件 | `file.read`、`file.list`、`file.glob`、`file.grep`、`file.stat`、`file.resolve`、`file.write`、`file.edit`、`file.patch`、`file.mkdir`、`file.move`、`file.copy`、`file.delete` |
| JSON 和笔记本 | `json.read`、`json.edit`、`notebook.edit` |
| 任务和记忆 | `todo.write`、`blackboard.write`、`blackboard.search`、`blackboard.read`、`blackboard.list` |
| Shell 和进程 | `shell.exec`、`exec`、`process.start`、`process.status`、`process.list`、`process.tail`、`process.grep`、`process.stop` |
| 网页 | `web.search`、`web.fetch` |
| 代码 | `code.test`、`code.lint`、`code.build` |
| Git | `git.status`、`git.diff`、`git.log`、`git.branch`、`git.show` |
| 软件包和项目 | `package.install`、`package.info`、`project.detect` |
| Agent | `agent.delegate` |

对模型可见的工具使用通用的编程名称，而兼容别名和高级能力仍然可以通过能力目录发现。

`agent.delegate` 仍由主 Swarm 协调。同一轮模型回复中的多个 Agent 调用，只有在显式请求 `preferred_mode: "parallel"`，并且目标是只读的 agent 规格（例如 `researcher`、`reviewer`、`critic` 或 `architect`），或者目标是带有具体 `file_scope`、且与同一批次中其他委派不重叠的 `scoped_write` agent 规格时，才会并发运行。`workspace_write` agent、交接、重叠的写入范围、glob 风格的范围以及普通的委派调用仍然串行执行，以避免工作区冲突。并发批次的上限由 `runtime.maxParallelTasks` 决定。达到上限时，额外委派的 worker 会被持久保存为 `pending`，显示在工作契约快照中，并在有 worker 槽位空出时自动启动，而不是立即失败。

对于 `scoped_write` agent，`file_scope` 会在写入工具执行之前强制检查：文件写入、编辑、补丁、移动、删除、JSON 编辑和笔记本编辑都必须指向委派范围内的路径。软件包安装和分支切换处在 scoped-write 沙箱之外。

## 安全和权限

工具审批由 `~/.swarm/settings.json` 中的权限规则驱动。shell、软件包安装、委派、写入/编辑、网页抓取和分支变更等高风险操作会被挂起，直到用户在 TUI 中确认，除非当前的权限模式允许它们。破坏性的 `r4` shell 命令仍然需要确认，除非有显式的权限规则允许这个具体操作。

审批视图会显示为什么需要这个工具、预计的影响、回滚指引、目标详情，以及在 Swarm 能于执行前推导出来时，针对拟议的写入、编辑和 JSON 改动的 diff 风格预览。对于 `.env`、机密、令牌、凭据和密钥等敏感目标，预览在审批记录中会被脱敏。按 `y` 允许一次，按 `a`（或 `s`）在本次 TUI 会话的剩余时间里允许相同的操作和目标，按 `n`、`d` 或 Esc 拒绝；`?` 显示完整的请求。

权限模式：

| 模式 | 行为 |
| --- | --- |
| `ask` | 在有风险的操作之前询问。 |
| `auto-edit` | 允许较低风险的编辑，但有风险的操作仍需审批。 |
| `full-auto` | 减少提示，同时保留拒绝规则。 |
| `yolo` | 需要临时主动启用的模式，跳过审批提示，同时保留工作区和拒绝列表的边界。 |

拒绝规则优先于一切。显式的允许规则优先于模式的默认值。自定义的询问规则即使在 `full-auto` 或 `yolo` 下也仍然需要审批；基线询问目录本身不会抵消这些绕过模式。

无头运行可以用 `swarm run --permission-mode ask|auto-edit|full-auto|yolo ...` 为单个进程覆盖模式。默认情况下，需要审批时无头模式会直接失败。使用 `swarm run --approval-mode wait ...` 可以把待处理的审批持久保存在本地，并等待另一个终端用 `swarm approvals approve <id>` 或 `swarm approvals deny <id>` 答复。使用 `--approval-timeout-ms <ms>` 可以修改默认 10 分钟的等待时间。无头运行还可以用 `swarm run --sandbox read-only ...` 或 `swarm run --read-only ...` 强制使用只读工具沙箱，并用 `swarm run --add-dir <dir> ...` 添加临时的只读根目录。在 TUI 中，`/permissions` 会报告生效的模式、沙箱、规则数量、读取根目录和最近的审批。`/add-dir <dir>` 和 `/remove-dir <dir>` 会更新持久的 `permissions.additionalDirectories`，供之后的运行使用。

## 本地 Gateway

`swarm serve` 启动一个本地 HTTP/事件流 API，用于脚本、编辑器集成和调试。它的默认地址是 `http://127.0.0.1:38171`。

```bash
swarm serve
swarm serve --port 0
```

Gateway 默认绑定到回环地址。改变状态的请求需要满足其一：来自回环客户端、并带有本地 CLI 的 `X-Swarm-Local-Control` 请求头；或者带有 `SWARM_GATEWAY_TOKEN` bearer 令牌。除非同时设置了 `SWARM_GATEWAY_ALLOW_REMOTE=1` 和 `SWARM_GATEWAY_TOKEN`，否则拒绝远程绑定。CORS 仅限于回环来源，除非 `SWARM_GATEWAY_ALLOWED_ORIGINS` 列出了以逗号分隔的来源。

`/` 路由返回一个 JSON API 索引。它不是产品界面；面向用户的工作流都在 CLI/TUI 中。

`/health` 返回正在运行的 Gateway 当前的公开路由列表。重要的端点组：

| 组 | 路由 |
| --- | --- |
| 运行和会话 | `POST /v1/sessions`、`GET /v1/runs`、`GET /v1/events`、`GET /v1/work-events`、`GET /v1/sessions/:id/events`、`GET /v1/sessions/:id/work-events` |
| 实时控制 | `GET /v1/live`、`POST /v1/live/messages`、`POST /v1/live/interrupt`、`POST /v1/sessions/:id/messages`、`POST /v1/sessions/:id/interrupt`、`POST /v1/sessions/:id/execute`、`POST /v1/sessions/:id/fork` |
| Kernel 查看 | `GET /v1/sessions/:id/graph`、`/tasks/:task_id`、`/trace`、`/blackboard`、`/approvals`、`/audit`、`/usage` |
| 协作 | `GET /v1/workers`、`GET /v1/workers/:id`、`POST /v1/workers/:id/stop`、`POST /v1/workers/:id/continue`、`GET /v1/handoffs`、`GET /v1/handoffs/:id`、`POST /v1/handoffs/:id/take-back` |
| 能力 | `GET /v1/capabilities`、`POST /v1/capabilities/:id/invoke`、启用/禁用/查看/隐藏、刷新 |
| 扩展 | `GET /v1/skills`、`POST /v1/skills/:name/activate`、`GET /v1/plugins`、插件安装/更新/移除/启用/禁用 |
| MCP | `GET /v1/mcp/servers`、服务器刷新、资源列出/读取、提示词列出/获取 |
| Symphony | `GET /v1/symphony/status`、预览、tick、run-once、清理、守护进程启动/停止 |

`/v1/events` 为现有客户端保留运行时事件流，并在每条记录上带有 `work` 字段。`/v1/work-events` 直接流式输出稳定的 `swarm.work.v1` 记录，供想要使用共享的运行/会话/任务/权限协议、而不需要 TUI 特定事件结构的自动化使用。这条流现在带有一等的 `queue` 记录（表示 worker 槽位准入）和 `activity` 记录（表示结构化的 worker 进度），客户端不必再从运行时字符串中逆向推断。`GET /v1/live` 返回一份直接的实时状态契约，包含 `status`、`active_target`、`controls`，以及当前有可控的 Gateway 运行时的活跃会话快照；`swarm live` CLI 命令打印的是同样的内容。当活跃的循环能够对消息进行分类时，实时回复和中断路由会返回所应用的 `control` 决定；已存储的计划执行在运行期间会以 `full_swarm` 实时目标的形式暴露。`POST /v1/live/messages`、`POST /v1/live/interrupt`、`POST /v1/sessions/:id/messages` 和 `POST /v1/sessions/:id/interrupt` 还接受可选的 `request_id` 幂等键；使用相同键的重试会返回原始结果并带上 `duplicate: true`，而不会注入或中断两次。`GET /v1/sessions/:id` 还会返回 `work_snapshot.work_contracts` 和顶层的 `work_contracts` 摘要，让 Gateway 的使用方无需重放完整的事件流，就能恢复活跃的/可恢复的 worker 契约及其委派的写入范围。`GET /v1/workers` 和 `GET /v1/handoffs` 现在也会返回 `worker_contracts` / `handoff_contracts`，`parent_session_id=<session>` 可以把这些协作视图过滤到单个会话委派出去的工作。会话快照还会暴露 `task_contracts`，而 `/v1/sessions/:id/graph` 和 `/v1/sessions/:id/tasks/:task_id` 直接携带任务策略和文件范围元数据。

审批路由现在既暴露持久化的历史，也暴露实时可操作的队列状态。`GET /v1/approvals?session_id=<session>` 和 `GET /v1/sessions/:id/approvals` 会在持久化的 `approvals` 之外，返回 `pending_requests`、`actionable_approval_ids` 和一份摘要。`GET /v1/approvals/:id` 会标明该审批在当前 Gateway 进程中是否仍可操作，MCP 通过 `swarm.approvals` 暴露同样的视图。当审批已不再可操作时，`swarm.approval_decision` 现在会直接失败，而不是返回含糊的 `found=false`。

## Symphony

Symphony 是后台的工作接收和调度器。它读取本地工作项，为每个工作项创建工作区，并运行 TUI 所用的同一个 Work Kernel runner。

```bash
swarm symphony preview --workflow WORKFLOW.md
swarm symphony tick --workflow WORKFLOW.md
swarm symphony run-once --workflow WORKFLOW.md --max-turns 12
swarm symphony status --workflow WORKFLOW.md
swarm symphony daemon --workflow WORKFLOW.md --execute --max-ticks 3
swarm symphony cleanup --workflow WORKFLOW.md --execute
```

Symphony 把会话、尝试、工作区租约、黑板记录、审计、用量和最终结果写入同一组本地 Work Kernel 存储。它没有自己独立的规划器、黑板、评审系统或产品 UI。

当存在 `WORKFLOW.md` 时，运行时还拥有一个轻量的内部系统循环，可以在启动时以及发生相关运行时事件时自动唤醒 Symphony，例如黑板工作来源更新、任务/产物信封和已完成的会话。在工作流的 front matter 中配置它：

```yaml
system_loop:
  enabled: true
  execute: false
  startup_tick: true
  tick_on_events: true
  debounce_ms: 250
```

`execute: false` 只分派 Work Kernel 会话。当工作流应当通过同一个 coding-loop runner 运行本地工作项、而不需要单独的 `symphony run-once` 或守护进程命令时，设置 `execute: true`。

## 工单

`swarm superagent` 是面向单个仓库的主动式团队 agent，改编自 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)。被允许提出工作请求的人可以在 GitHub 上提及这个 agent、给它的飞书机器人发消息，或者在 TUI 中输入 `/ticket <request>`。在任何模型看到请求之前，一道确定性的闸门会先检查发送者是谁；随后由一个模型把请求路由到新工单、已有工单、停止，或者不做处理。每个工单都有一个 worker 进程，在它自己的目录中（通常是由准备命令创建的 git 工作树）运行 Swarm 的 coding loop，或者 Claude Code 等其他 agent harness；worker 会在提出请求的那个对话中答复。该对话中之后的消息会直接发给这个工单的 worker。

```bash
swarm superagent config init      # 写入 ~/.swarm/superagent/settings.json
swarm superagent run              # 运行宿主：来源、路由、worker、回复
swarm superagent request "fix the typo in README"
swarm superagent tickets          # 等待人处理的工单排在最前
swarm superagent say <id> "use build.sh"
swarm superagent stop <id>
swarm superagent retry <id>
```

在 TUI 中，`/ticket <request>` 提交工作，`/ticket <id>` 显示一个工单，`/ticket say|stop|retry <id>` 对某个工单执行操作，`/tickets` 打开工单面板（方向键选择，Enter 打开，`s` 停止，`r` 重试，Esc 返回）。没有宿主在运行时，TUI 会启动一个，并在 TUI 退出时停止它。

主动式的工作（例如一条没有指名的评论恰好匹配某条团队规则）从 `observe` 模式开始：评估结果会被记录为“would accept”，在 `eval.mode` 设为 `auto` 之前什么都不会运行。在配置好 agent 账号和机器人之前，GitHub 和飞书保持关闭。worker 以你的操作系统用户身份、在 `full-auto` 权限模式下运行；`gh`/`lark-cli` 包装器和被阻止的命令只是默认设置，并不是安全边界，而且工单讨论串上的消息会作为上下文传给它的 worker，所以在有陌生人评论的仓库中，请使用专用的操作系统账号。评估时还不会读取飞书图片。参见 [SUPERAGENT.md](SUPERAGENT.md)。

### 角色和机器人命令

在 superagent 设置里加上 `access` 一块后，每个提需求的人都有一个角色，角色决定他们还能做什么、能提多少需求。没有这一块时，来源 `allowed` 列表里的人什么都能做。

| 角色 | 谁有这个角色 | 他们的需求 | 未结工单 | 每小时请求 |
| --- | --- | --- | --- | --- |
| `owner` | 在 `roles` 里指定 | 用自己绑定的账号写到 GitHub；owner 还能用下面的设置命令 | 8 | 不限 |
| `maintainer` | 在 `roles` 里指定，或在 `allowed` 列表里 | 用自己绑定的账号写到 GitHub；maintainer 还能操控别人的工单 | 4 | 60 |
| `everyone` | 被列入的群放进来的其他人 | 用自己绑定的账号写到 GitHub | 1 | 10 |

- **写到 GitHub** 用的是提需求的人自己的身份，不管什么角色。他们先用 `/link` 绑定一次 GitHub 账号，worker 的 `gh` 和 git 就用这个账号操作他们的仓库。没有可用的绑定，或者是没人要求的工作（推断出来的，或机器人发的），工单只在本地做：worker 在自己的目录里提交，没有 `gh` 和 `lark-cli` 账号，结果里附上这些提交的补丁。之后可以用 `/takeover` 把补丁变成拉取请求。
- **绑定之前要拉取请求。** 还没绑定账号就要拉取请求的人，工作会先作为本地工单来做，同时私聊收到绑定用的验证码。绑定好、工单也完成后，agent 会接手它，以这个人的身份开拉取请求。
- **群的上限**（`read-only`、`local` 或 `github`）会压低在那个群里提出的所有工作。没人列入的群是 `local`。
- **谁能操控工单。** 提需求的人和 maintainer。其他人在工单对话里发的消息只作为上下文交给 worker，既不会让工单继续，也不能停下它。
- **限额。** 超出发送者限额的消息会被搁下，并回复一次说明原因。`access.limits` 可以改这些数字。
- **选择 harness。** owner 和 maintainer 可以指定自己的工作运行在哪个 agent harness 上（见 [harness worker](#harness-worker)）；它的轮次用的是 owner 的 harness 账号。`everyone` 的工作运行在默认的 harness 上。

在飞书里 @ 机器人或私聊它，可以用这些命令：

| 命令 | 谁能用 | 作用 |
| --- | --- | --- |
| `/help` | 任何人 | 列出这些命令。 |
| `/me` | 任何人 | 显示你的角色、未结工单、最近一小时的请求、这个群的上限和你的 GitHub 账号。 |
| `/link` | 任何人 | 绑定你的 GitHub 账号。在 GitHub 上输入的验证码总是私聊发给你，在群里问也一样：谁输入这个码，就是把谁的账号绑到你身上。 |
| `/repo [owner/name]` | 任何人，私聊 | 列出或设置你的默认仓库。 |
| `/unlink` | 任何人 | 解除 GitHub 绑定。 |
| `/takeover [工单]` | 提需求的人或 maintainer | 把本地工单的补丁做成拉取请求，作为你的一张新工单。它会等到你绑定好账号、工单也有了补丁；一张工单只会被接手一次。 |
| `/devices` | 任何人；maintainer 和 owner 能看到节点名 | 显示 agent 现在能用什么干活：本机和配对节点（是否在线、有哪些 harness），以及还有几个空闲的工单 worker。 |
| `/role @某人 owner\|maintainer\|everyone\|none` | owner | 设置被 @ 的人的角色。 |
| `/listen all\|mentions\|off` | owner，在群里 | 把这个群列入，或移出列表。 |
| `/ceiling read-only\|local\|github` | owner | 设置在这个群里提出的工作最多能写到哪一步。 |
| `/chatter [on\|off]` | owner，在用 `/listen all` 列入的群里；任何人都能查询 | agent 是否在这里主动加入对话。 |

也可以直接用自己的话说：agent 会替你执行 `/help`、`/me`、`/link`、`/repo`、`/takeover` 和 `/devices`，就像你自己输入了一样。`/role`、`/listen`、`/ceiling`、`/chatter` 和 `/unlink` 会改设置或解除绑定，必须自己输入。

不需要干活的消息，比如道谢，或者 agent 当场就能回答的问题，会得到一句简短的回复，不开工单。打开 `/chatter on` 后，群里安静下来、agent 又有话可说时，它也会主动发言：每小时最多几次，安静时段不说话。

第一个 owner、`/link` 背后的 GitHub App，以及 agent 在群里的人设、发言频率和安静时段，都写在设置文件里，见 [SUPERAGENT.md](SUPERAGENT.md#access)（英文）。

### Harness worker

工单的 worker 可以不用 Swarm 自己的 coding loop，而是运行在本机安装的其他 agent harness 上：Claude Code（`claude`）、Codex（`codex`）、Kimi Code（`kimi`）或 OpenCode（`opencode`），或者运行在 GLM 或 DeepSeek 上的 Claude Code（`claude-glm`、`claude-deepseek`，见下文）。superagent 设置中的 `executor.harness` 指定新工单运行在哪个 harness 上（默认值 `null` 保留 Swarm 的循环）；`swarm superagent request --harness claude "..."` 或 `/ticket --harness codex <request>` 为单个请求选择一个 harness。这个选择会和工单的执行记录一起保存，因此它的后续消息也在同一个 harness 上运行，`swarm superagent tickets`/`ticket` 和 TUI 会把它显示为 `via claude`。

给机器人发消息的人也可以用自己的话指定一个，例如“用 codex 做”或 “run this on Claude Code”。开启访问模型时，owner 和 maintainer 可以这样做（见[角色](#角色和机器人命令)）；没有开启时，任何能提需求的人都可以。确认回复会说明由哪个 harness 来做、工作在哪里运行：本节点，或已登录该 harness 的已配对节点（见[网格](#网格)）。如果没有任何节点有它，或者本机没有叫这个名字的配置档，机器人会直接说明，不创建工单。以提需求者身份写到 GitHub 的工作只在接受它的节点上运行，因为那里保存着他们的 token，所以它只能使用在那里登录的 harness。

每一轮都是在工单目录中进行的一次无头运行：Swarm 的工单工具（`swarm superagent mcp`，对放在已配对节点上的 worker 还会加上 `--remote`）作为名为 `ticket` 的 MCP 服务器提供，Swarm 的 worker 说明会附加在 harness 自己的说明之后：

| Harness | 轮次 | 工单工具 | 说明 | 恢复 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json` | `--mcp-config`，并且只用这些（`--strict-mcp-config`） | `--append-system-prompt` | `--resume <id>` |
| Codex | `codex exec --json` | `-c mcp_servers.ticket.*` | `developer_instructions` | `codex exec resume <id>` |
| Kimi Code | `kimi --prompt <prompt> --output-format stream-json` | 在该轮期间加入目录的 `.kimi-code/mcp.json`，轮次结束后复原，并设置 `KIMI_CODE_TRUST_WORKSPACE=1` | 一个 agent 文件（`--agent-file`），Kimi 自己的提示词在前 | `--session <id>` |
| OpenCode | `opencode run --format json --agent swarm` | `OPENCODE_CONFIG_CONTENT`，OpenCode 会在该进程中把它合并到你的配置之上 | 在该配置中指定的一个说明文件 | `--session <id>` |

Kimi Code 没有用于指定 MCP 服务器或额外说明的参数，所以工单的一轮会在工单目录中写入项目级的 `.kimi-code/mcp.json`（保留其中已有的其他内容），并在该轮结束时恢复这个文件；信任变量让无头运行能够读取它，同时也会启用仓库自身在那里或在 `.mcp.json` 中声明的 MCP 服务器。一个 Kimi 会话会一直使用它启动时 agent 文件中的说明。Swarm 为一轮写入的文件，例如 Kimi 的 agent 文件、OpenCode 的说明和 Claude Code 的设置文件，都放在一个私有的临时目录中，该轮结束时这个目录会被删除。之后的轮次会带着等待该工单的消息恢复 harness 的会话；会话 id 保存在 `~/.swarm/state/harness-sessions/` 中。报告、一轮没有报告时的提醒、失败轮次的重试、每轮的预算（60 条模型消息和 200 次工具调用，根据 harness 的事件计数）以及停止工作，都与 Swarm 自己的循环一样，只是在 harness 一轮进行期间到达的消息要等到下一轮。每一轮的 token 都会连同 harness 及其模型记入 Swarm 的用量记录：Codex 的模型取自它的会话文件，Kimi Code 的 token 和模型取自它的会话的 wire 文件（它的事件两者都不包含），OpenCode 的模型取自 `opencode export`。Claude Code 的费用是它自己按标价做的估算，OpenCode 的费用是它为每次模型调用报告的费用之和。Claude Code 按 Claude 的价格给所有模型定价，所以在 `claude-glm` 和 `claude-deepseek` 上它的费用是错的（一次实际的 DeepSeek 轮次，它估为 $0.127，按 DeepSeek 的价格实际约为 $0.003）；用量记录中的 token 数是正确的。

在第一轮之前，worker 会检查 harness 是否已安装并已登录（`claude auth status`、`codex login status`、配合 Kimi token 文件的 `kimi provider list`、`opencode auth list`）；如果没有，工单会失败，并说明在那台机器上需要做什么，Swarm 从不替你登录。harness 按它为你的操作系统用户所做的配置运行，使用它自己的登录、配置、说明和 hook。Swarm 会在每一轮加入两样东西：一是 Claude Code 的 `attribution` 设置，其中每一部分都为空（`--settings`，会覆盖你自己的设置），这样它的提交和拉取请求就不会带 Co-Authored-By 尾注或 “Generated with” 行；二是只按路径暂存工单改动过的文件的指令，这样 hook 留在工单目录里的文件不会进入它的提交。Codex 只在你的 ChatGPT 工作区开启署名时才会加上它自己的尾注，Swarm 无法关闭这一点；指令会要求它不要这样做。Kimi Code 2.1.1 和 OpenCode 1.18.21 在这些模式下不会添加任何自己的署名。`executor.harnesses` 下的配置档可以修改内置配置档（命令、模型、参数、环境），也可以添加任意类型的新配置档；凭据从不写进设置：`keys` 指定每个凭据从哪个环境变量读取。配置档自己的变量和 key 也会作为该轮临时目录中的一个文件放进 Claude Code 的 `--settings`，否则你的 `~/.claude/settings.json` 中的 `env`（例如为中继设置的 `ANTHROPIC_BASE_URL`）会覆盖它们。

```json
"executor": {
  "harness": "claude",
  "harnesses": {
    "claude": { "model": "sonnet", "env": { "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1" } },
    "codex": { "command": "/Users/me/.local/bin/codex", "args": ["--profile", "work"] },
    "opencode": { "model": "deepseek/deepseek-flash" },
    "relay": { "kind": "claude", "env": { "ANTHROPIC_BASE_URL": "https://relay.example/anthropic" },
      "keys": { "ANTHROPIC_AUTH_TOKEN": "RELAY_API_KEY" } }
  }
}
```

如果 Anthropic 兼容的中继拒绝 Claude Code 的实验性 beta 请求头（返回 HTTP 400，并指出某个 `anthropic-beta` 值），就需要像上面那样在配置档的 `env` 中设置 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。外层 Claude Code 会话提供给它自身工具的变量（`CLAUDECODE`、桌面应用由宿主管理的服务商）会被丢弃，因此从 Claude Code 内部启动的宿主仍能找到 harness 登录所用的账号。

#### 通过 Claude Code 使用 GLM 和 DeepSeek

两个内置配置档让 Claude Code 通过相应服务商的 Anthropic 兼容端点运行其他模型，并采用这些服务商的 Claude Code 指南所设置的变量（智谱的 [GLM Coding Plan 指南](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)和 [DeepSeek 的指南](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)，截至 2026 年 11 月）。它们的 key 只从环境变量读取：

| 配置档 | 端点（`ANTHROPIC_BASE_URL`） | 模型 | Key |
| --- | --- | --- | --- |
| `claude-glm` | `https://open.bigmodel.cn/api/anthropic` | `glm-5.3[1m]`；Haiku 级别为 `glm-5.3-flash[1m]` | `ZHIPU_API_KEY` |
| `claude-deepseek` | `https://api.deepseek.com/anthropic` | 所有级别都用 `deepseek-flash[1m]` | `DEEPSEEK_API_KEY` |

两者还会设置这些服务商的其他变量（自动压缩窗口，GLM 还有 `API_TIMEOUT_MS=3000000` 和 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）。设置是在内置模型配置档的基础上追加，而不是替换它，因此 Z.ai 的国际版 GLM 端点写作 `"claude-glm": { "env": { "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic" } }`，换用另一个 key 变量则写作 `"keys": { "ANTHROPIC_AUTH_TOKEN": "MY_GLM_KEY" }`。DeepSeek 会把任何 `claude-opus*` 模型名映射到 `deepseek-v4-pro`，并按它的价格计费。OpenCode 无需 Claude Code 就能原生访问这两家：配置档 `{ "kind": "opencode", "model": "deepseek/deepseek-flash" }`（或 `zhipuai-coding-plan/glm-5.3`，或 Z.ai 的 `zai-coding-plan/glm-5.3`）会使用 `opencode auth login` 得到的 key，或者来自 `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` 的 key。

#### 检查本机的 harness

`swarm harness list`（也可以用 `swarm superagent harness list`）打印每个配置档的类型、命令、模型、是否已安装，以及它的 key 来自哪些变量、这些变量是否已设置（只显示名称）。`swarm harness check [<id>]` 还会运行每个 harness 的登录状态命令，并对尚未登录的 harness 说明该怎么做；带上 id 时，如果该配置档无法在本机运行，它会以非零状态退出。两者都支持 `--json`。

工单的权限模式会映射到 harness 自己的参数：

| `executor.permissionMode` | Claude Code | Codex | Kimi Code | OpenCode |
| --- | --- | --- | --- | --- |
| `full-auto` | `--permission-mode auto`（它的分类器会拦截有风险的操作）；权限提示会被拒绝 | `-s danger-full-access` 加 `approval_policy="never"`：没有沙箱（见下文） | 它的 Never Ask 模式，`--prompt` 总是使用该模式 | 一个除被阻止的命令外允许一切的 agent，配合 `--auto` |
| `yolo` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | 同 `full-auto` | 同 `full-auto` |

Codex 在这两种模式下都不使用沙箱。它的 `workspace-write` 沙箱会让工作区自身的 git 元数据保持只读，因此在那里运行的 worker 无法提交，除非有人逐个批准每次提交；在实际试验中，关闭审批时工单最终处于阻塞状态，使用 `--approve-for-me` 时，如果服务商不提供 Codex 的评审模型，或者模型没有向它请求，工单也同样被阻塞。Swarm 自己的 worker 也没有沙箱：它以你的操作系统用户身份运行。

Swarm 无法在其他 harness 内部执行它自己的规则。它在 `~/.swarm/settings.json` 中的权限规则、风险等级，以及它对破坏性命令要求的审批，在那里都不适用；由 harness 依据自己的模式、分类器或沙箱来决定，Swarm 看不到、也不会审计每一次工具调用。被阻止的命令只会以 Swarm 的 `PATH` 垫片的形式到达 harness，在 Claude Code 和 OpenCode 中还会以拒绝规则的形式到达；Codex 和 Kimi Code 没有拒绝某条命令的参数，而且任何 harness 都可以通过完整路径运行程序。Claude Code 只拿到工单工具（`--strict-mcp-config`）；Codex、Kimi Code 和 OpenCode 还会加载它们自身配置中的 MCP 服务器、插件和说明。预算是在事后根据 harness 打印的事件来停止它的，用量也是 harness 报告的数字。

### Harness 子代理

主 Swarm 委派的子代理（`agent.delegate`，即 `Agent` 工具）在进程内运行在 Swarm 的 coding loop 上，或者运行在某个 harness 上：agent 规格的 `harness` 字段（插件的 agent 规格也可以设置它）或委派调用的 `harness` 输入指定配置档，两者都有时以调用为准。这时子代理会作为该 harness 的一次无头轮次，在发起委派的会话的工作区中运行：规格的角色、输出契约和文件范围作为它的说明，任务包作为它的提示词，没有工单工具，规格的工具预算作为该轮的上限（`max_tool_calls` 次工具调用，以及 `max_turns + max_tool_calls` 条模型消息）。它的结果会像 Swarm 的 worker 那样返回给父级：harness 的最后一条消息作为摘要，后面跟着一行，说明运行的是哪个 harness 和模型、哪些约束无法对它强制执行，以及根据该轮前后的 git status 和 HEAD 得出的改动文件。指定了 harness 的委派调用会跳过 Swarm 关于“小型单文件任务留在主循环中”的检查。

规格的写入策略会在 harness 自身参数允许的范围内尽量保持：

- `read_only` 规格会在 harness 的只读模式下运行：Claude Code 使用它的 `dontAsk` 模式，只开放 Read、Grep、Glob 以及 git 的 status、diff、log 和 show；Codex 使用它的只读沙箱（来自你的 Codex 配置的 MCP 服务器在沙箱外运行）；Kimi Code 使用一个只有读取、搜索和网页工具的 agent；OpenCode 使用一个除读取、搜索、网页和 git 只读命令之外拒绝一切的 agent。如果某个配置档自己的 `args` 设置了 harness 的权限、沙箱或工具（例如 `--dangerously-skip-permissions` 或 `--auto`），它就无法保持只读，子代理也不会启动：父级会收到一个失败的结果，并说明原因。
- `scoped_write` 或 `workspace_write` 规格会在 harness 的 `full-auto` 模式下运行（Swarm 运行在 yolo 模式时则为 `yolo`）。harness 不会被限制在文件范围或工作区之内；它在文件范围之外改动的文件会在摘要中列出。在 `ask` 和 `auto-edit` 权限模式下，Swarm 会在这样的子代理启动前请求一次审批，因为它无法对 harness 内部的每次编辑或命令逐一询问。子代理会被告知不要提交、推送或创建拉取请求。

并行委派可以混用多个 harness：例如，一个在 OpenCode 上负责编写，一个在只读的 Claude Code 上负责评审，各自在后台运行，各有各的结果。它们的 token 会连同 harness 和模型一起记入运行时的用量记录，归在该 worker 名下。

## 网格

Swarm 设备可以连成一个 swarm：一台笔记本、一台常开的服务器和一台 GPU 机器用一个简短的配对码加入，之后无论身处何处都能互相访问。一台设备显示配对码，其他每台设备用它加入，每台加入的设备都会与所有成员配对，而不只是与显示配对码的那一台。

```bash
swarm mesh invite                          # 在任一成员上：打印一个配对码（例如 K7QM-4ZX2）并等待
swarm mesh join K7QM-4ZX2                  # 在每台要加入的设备上（或在 TUI 中用 /mesh join K7QM-4ZX2）
swarm node run                             # 在需要被其他设备访问的设备上：工单宿主和网格服务器
swarm node install                         # 同上，但作为服务：立即运行，登录时和崩溃后也会启动
swarm mesh status                          # 本节点及其对端：各自的访问方式、能力、负载
swarm mesh remove gpu                      # 把一台设备移出 swarm：每个成员都会忘记它
```

一个配对码在 15 分钟内有效，可供任意数量的设备使用，输错三次即作废。在 TUI 中，`/mesh invite` 会在 TUI 运行期间开放一个配对码，`/mesh` 列出整个 swarm。

每一对设备共享一个密钥，它是在配对时通过口令认证密钥交换（CPace）协商出来的：配对码证明两台设备都看到了它，而配对码和密钥本身都不会经过网络。两台设备之间的每条连接都是以它们的共享密钥为密钥的 TLS，所以只有这两台设备能读取连接内容或完成握手，节点也能凭这个密钥知道是哪个对端在调用。当一台设备能直接访问另一台时（局域网、tailnet、用 `swarm mesh advertise` 设置的转发端口），设备之间直接连接，否则通过中继连接；先完成握手的链路胜出。节点会在握手中报出自己的名字，所以一条绕回发起拨号的设备本身的链路（指向它自己的地址或中继名）会被拒绝，而不是被那台设备当作对端来应答；设备也只会根据对端自己的卡片来更新它对该对端的记录。中继（默认为 `wss://swarm-relay.w33d.xyz`，可以用 `swarm mesh relay <url>` 指定其他中继，或用 `swarm mesh relay off` 关闭）只负责把流接在一起：它能看到哪些设备名在连接、何时连接、传了多少数据，但永远看不到它们说了什么。设备在中继上监听所用的名字只有它的密钥才能认领，而且每次拨向某台设备的连接都用拨号设备的密钥签名，因此中继除了限制每个地址，也能限制每台设备；正在配对的设备以不签名的方式拨向配对码的邮箱，限额更严。`swarm mesh relay serve` 可以运行一个中继，它的 `/v1/health` 会返回计数；在使用其他中继的设备上生成的配对码会带上那个中继的名字（`K7QM-4ZX2@relay.example`），因此加入时无需任何设置。没有中继时，`swarm mesh invite --direct` 会打印一个包含本节点地址的、较长的一次性配对码。

通过某个成员加入的设备，会借助引荐凭证被介绍给其他成员：该成员用它与每个其他成员共享的密钥，为这对新配对的密钥分别封装一份，新设备第一次连接某个成员时会出示它。用 `swarm mesh remove` 移除的设备，会被每个得知此事的成员忘记，它以前的引荐也会被拒绝。

已配对设备的工单会显示在 TUI 中本节点工单的旁边（`/tickets`，状态栏也会统计其中需要你处理的工单），也会出现在 `swarm superagent tickets --all-devices` 中，地址写作 `<device>:<id>`。答复、停止和重试这类工单的操作会发往拥有它的设备，而 `/ticket @<device> <request>`（或 `swarm superagent request --device <name>`）会在那台设备上提交工作。已配对的设备相当于那台设备自己的操作者，所以只配对你自己控制的设备。

设备还可以把工具借给已配对的对端，对端的 Swarm 会话把它们当作 MCP 工具调用。在你指定文件夹之前，什么都不会借出：`swarm mesh lend shell ~/src/app` 借出在该文件夹中启动的命令执行（shell 仍然可以访问这个用户能访问的任何东西），`swarm mesh lend files ~/data` 借出在该文件夹内列出、读取和写入文件的能力，并拒绝通向文件夹之外的路径，包括符号链接。`swarm mesh lend` 显示借出了什么，`swarm mesh lend --stop shell` 收回借出。在其他设备上，`swarm mesh tools` 列出每个对端借出的工具，那里的每个 Swarm 会话都会把它们看作 `mcp__<peer>__shell`、`mcp__<peer>__read_file` 等工具，由对端的 `swarm node run` 在通往该对端的链路上通过 Streamable HTTP 提供。借来的工具算作远程工具，因此在 `ask` 模式下每次调用都要等待审批；不响应的对端会被跳过。

工单也可以留在本节点，而它的 worker 在一个已配对的节点上运行。`swarm superagent request --on <node>`（或 `/ticket --on <node> <request>`）以这种方式提交工单，`swarm superagent place <id> <node>|here` 移动它的下一个 worker；当路由器判断这项工作需要 `gpu` 或 `macos` 时，worker 会去往具备该能力且有空闲槽位的已配对节点。在 harness 上运行的工作（`--harness claude`、有人向机器人指定的 harness，或 `executor.harness`）也以同样的方式提出要求：节点会为每个在本机已安装、已登录且 key 已设置的 harness 配置档，在自己的能力中列出 `harness:<id>`，并每 10 分钟重新检查一次，这样在 Claude Code 上运行的工单就会在已登录 Claude Code 的设备上运行。可达的已配对节点中具备这项工作所需能力的都在忙时，工作会等待其中某个节点空出槽位，而不是在本节点上运行；只有没有任何可达的已配对节点具备这些能力时，它才在本节点运行，由它的 worker 说明缺少什么。接受该工单的节点始终是它的记录方，也是其存储的唯一写入者。另一个节点用自己的准备命令和凭据准备自己的工单目录（运行 GitHub 工单的节点需要在那里登录 agent 账号的 CLI），并持有一个它会续期的租约；如果租约失效，所有者会把该 worker 视为丢失，并重新放置这项工作。`swarm superagent ticket` 显示 worker 在哪里运行。放置只对以 `swarm node run` 方式运行的节点生效。

有空闲 worker 槽位的节点还可以主动拉取工作，而不必等着被分配。拉取默认关闭，直到运行 `swarm mesh pull on`（加上可重复使用的 `--repo owner/name`，只接这些仓库的工作）；之后节点会每 15 秒（没有开放的工作时频率更低）向已配对的节点询问在那里等待 worker 的工作：排在 `executor.maxWorkers` 之后的工作，或者需要所有者缺少的某种能力、而具备该能力的已配对节点都在忙的工作。它会认领符合自己能力和仓库范围的工作，最早的优先。由所有者来决定：第一个仍然有效的认领会通过与放置相同的提议和租约拿到这项工作，之后的认领会被拒绝，所有者自己永远不会启动一个已被认领的 Assignment。通过 `--on` 或 `place` 放置的工作、处于租约之下的工作，或在等待人处理的工作，永远不会开放。所有者默认会把自己等待中的工作交给开启了拉取的已配对节点，因为配对本来就允许对端在工作被放置到那里时运行本节点的工作，而拉取者只会拿走原本要等待的工作；`swarm mesh offer off` 会把这些工作留在本地。`swarm mesh status` 显示每个节点是否在拉取，以及两个方向上被拉取的工作，工单行会显示“pulled by <node>”。

### 让节点保持运行和最新

`swarm node install` 把本设备的节点作为一个由系统保持运行的服务：在 macOS 上是 launchd LaunchAgent（`~/Library/LaunchAgents/com.agent-swarm.node.plist`），在 Linux 上是 systemd 用户单元（`~/.config/systemd/user/swarm-node.service`）。它会立即启动，并在每次登录时启动、崩溃后重启，以 `node run` 的方式运行执行安装的那份安装中的 Node 可执行文件和 `dist/index.js`（`--no-host` 会被透传）。它的输出写入 `~/.swarm/logs/node.log`，超过 10 MB 后会转为 `node.log.1`。`swarm node logs -f` 跟踪这个日志，`swarm node status` 说明服务是否已安装并已加载、它的 pid 以及上一次是如何结束的，`swarm node uninstall` 移除服务，但保留日志和 env 文件。再次安装会重启节点。当设备上有另一个 superagent 宿主在运行时（终端里的 `swarm node run`，或启动了宿主的 TUI），安装会被拒绝，因为只有一个宿主能持有设备的锁：请先停止那一个。

服务看不到你的 shell 环境，只能看到 `PATH` 以及 Swarm 自己的 `SWARM_HOME` 和 `SWARM_MESH_HOME`。节点及其 worker 需要从环境读取的 key（服务商 key、`GH_TOKEN`）放在 `~/.swarm/node.env` 中，每行一个 `KEY=value`：安装时会创建这个文件，附带说明，权限为 600，节点每次启动时用 Node 的 `--env-file-if-exists` 加载它。plist 或单元文件中不会写入任何机密，而用 `swarm auth set-key` 保存的 key 本来就在 Swarm 的设置中。在没有图形界面的 Linux 机器上，`loginctl enable-linger` 能让用户服务在没有登录会话时继续运行，并在开机时启动它们；如果 lingering 处于关闭状态，安装时会提示。在容器中，请改为在容器的重启策略下运行 `swarm node run`。

每个节点的卡片会写明它的 Swarm 版本、它从 git 检出运行时的提交，以及它使用的网格协议：目前为 1，每当链路或路由格式改变时递增（该字段出现之前的卡片按 1 处理）。`swarm mesh status` 和 TUI 中的 `/mesh` 会标出使用其他协议的对端（它可能无法与本节点协作），或运行着其他 Swarm 版本或提交的对端，并提示用 `swarm update` 更新其中一方。

## 用量、价格和预算

每台设备都会在 `~/.swarm/state/swarm.db` 中记录它发出的每一次模型调用，以及它的工单 worker 和子代理运行的每一个 harness 轮次：包括 Swarm 自己的会话、工单 worker，以及工单宿主的路由和评估调用，每一条都带有服务商、模型、harness 和 token。`swarm usage` 把它们当作一本每次调用只计一次的账本来读取：

```bash
swarm usage                                   # 本设备最近 7 天，按模型
swarm usage --since 30d --by provider         # 也可以按 harness、设备、工单、天或来源
swarm usage --since 2026-11-01 --all-devices  # 加上每台有响应的已配对设备
swarm usage --since 24h --json
```

`input` 计入所有提示词 token，包括缓存命中和缓存写入，`cached` 计入缓存命中。在 TUI 中，`/usage [session_id]`（也可以用 `/debug usage`）显示一个会话的调用和本设备当天的情况，`GET /v1/sessions/:id/usage` 会在它的原始计数器旁边以 `ledger` 的形式加上同一本账本，而原始计数器的 token 行之间有重叠。`--all-devices` 通过每台已配对设备的 `swarm node run` 读取它的调用，用本设备的价格计价，并指出没有响应或运行着不带该路由的 Swarm 的设备。

费用来自一张按每百万 token 计价的价格表。Swarm 只为那些其服务商定价页面在 2026-11-07 确认过价格的模型内置价格，每个页面都在 `src/usage/prices.ts` 中注明了出处：DeepSeek Flash（包括它已退役的 `deepseek-v4-flash` 名称）和 V4 Pro 及其高峰时段，`moonshot` 上的 Kimi K3.1 Pro、K3、K2.7 Code 和 K2.6，OpenAI GPT-5.5、GPT-5.4 和 GPT-5.4 mini，Claude Sonnet 4.5 和 Haiku 4.5，以及 Gemini 2.5 Pro 和 Flash。其他所有模型都只显示 token 和 `unpriced`，直到 `~/.swarm/settings.json` 中的 `usage.prices` 为它设置价格；这项设置也会替换内置的价格：

```json
{
  "usage": {
    "prices": {
      "deepseek/deepseek-v4-flash": { "input": 0.15, "cachedInput": 0.003, "output": 0.6, "currency": "USD",
        "peak": { "hoursUtc": [[1, 4], [6, 10]], "factor": 2 } },
      "openai/gpt-5.5": { "input": 5, "cachedInput": 0.5, "output": 30, "long": { "above": 272000, "input": 10, "cachedInput": 1, "output": 45 } },
      "ollama/*": { "input": 0, "output": 0 }
    },
    "budgets": {
      "providers": { "deepseek": { "daily": 2, "monthly": 30 }, "kimi-coding": { "dailyTokens": 5000000 } },
      "harnesses": { "claude": { "monthly": 100 } }
    }
  }
}
```

价格的键为 `<provider>/<model>`，或用 `<provider>/*` 表示某个服务商的所有模型。`cachedInput`（缓存命中）和 `cacheWrite`（写入缓存的 token）默认等于 `input`，`currency` 默认为 USD；`long` 为超过 `above` 个 token 的提示词定价，`peak` 在它的 UTC 时段内（周一到周五）把每一项费率乘以倍数。自己报告费用的 harness 轮次（例如 Claude Code）保留它报告的费用；其他轮次按 `harness:<id>/<model>` 或 `harness:<id>/*` 定价。

预算按天（从本地午夜起算）和按月（从 1 日起算）限制某个服务商的调用或某个 harness 的轮次：`daily` 和 `monthly` 以金额计（`currency`，默认为 USD），统计已定价的调用；`dailyTokens` 和 `monthlyTokens` 统计输入和输出 token。每台设备只统计自己的调用。一旦达到上限，该服务商上的新模型调用会失败，harness 的下一轮或委派给它的子代理不会启动，并附带一条消息，说明是哪个上限、已经用掉多少，以及调高它的设置项；worker 触及上限的工单会收到一份说明此事的阻塞报告，待上限调高后再重试，TUI 的状态栏也会指出这个上限。每次调用之前都会重新读取上限，所以调高后立即生效。上限是在调用之前检查的，而不是在调用过程中：已经在运行的调用会完成，并行的调用可能因各自的用量而超过上限。`swarm usage` 和 `/usage` 显示每个上限的状态，以及金额上限因缺少价格而无法计入的调用数。

## 架构

```text
Human or automation request
  -> Swarm TUI, headless CLI, Gateway, or Symphony
  -> Work Kernel
  -> capability broker and local tools
  -> coding loop, workers, review, verification
  -> result card, artifacts, trace, memory
```

关键层次：

| 层 | 作用 |
| --- | --- |
| Swarm TUI | 产品交互界面和主 Swarm 对话。 |
| Work Kernel | 共享的执行事实来源：会话、尝试、租约、图、黑板、产物、审批、审计、用量、评审、最终结果。 |
| 能力平面 | 内置工具、MCP、技能、斜杠命令、agent 规格和插件的共享目录与 broker。 |
| ASP | 信封、路由、任务图、黑板、评审、共识和策略契约。 |
| Symphony | 在本地后台接收仓库自带工作来源里的工作。 |
| Gateway | 面向自动化和集成的本地 API 和 SSE 界面。 |

旧的 Agent Swarm Protocol 架构仍然保留，用于 full-swarm 和协议实验，但默认的产品路径是本地 coding loop，由主 Swarm 负责委派。

## 记忆和恢复

WorkSession 记忆记录最近的轮次、worker 结果、工具结果、工作区改动、评审输出、验证和最终结果。较早的条目会被压缩成抽取式摘要，同时保留最近的一段。

恢复时，Swarm 会注入一份新鲜度契约：

- 把之前的任务包、压缩后的记忆和 worker 结果当作历史线索，而不是当前事实；
- 在编辑或对代码状态下结论之前，用读取/搜索/git 工具刷新当前文件；
- 如果当前工作区与记忆不一致，以当前工作区为准。

`/memory [session_id]` 是面向用户的、基于同一份契约的视图。

## 调试

用以下方式启用调试日志：

```bash
swarm --debug
swarm --debug-trace
```

或者设置环境变量：

```bash
SWARM_DEBUG=1
SWARM_DEBUG_LEVEL=trace
```

JSON 行日志按聊天会话写入 `~/.swarm/logs/<session-id>.log`。日志超过 1 MB 时会滚动为 `<session-id>.part-N.log`。每条记录包含时间戳、PID、会话 id、级别、分区、消息和可选数据。

## 配置

默认情况下，所有状态都存放在 `~/.swarm/` 下。可以用 `SWARM_HOME` 覆盖。

```text
~/.swarm/
  config.json         provider API keys (plaintext)
  settings.json       model selection, runtime settings, provider definitions
  state/
    swarm.db          sessions, blackboard, artifacts, traces, usage, memory
  logs/               debug log files
```

关键环境变量：

| 变量 | 用途 |
| --- | --- |
| `SWARM_HOME` | 覆盖 `~/.swarm` 目录。 |
| `SWARM_DEBUG` | 启用调试日志（`1`、`true` 或 `verbose`）。 |
| `SWARM_DEBUG_LEVEL` | 日志级别（`trace`、`debug`、`info`、`warn`、`error`）。 |
| `SWARM_PERMISSION_MODE` | 覆盖权限：`ask`、`auto-edit`、`full-auto`、`yolo`。 |
| `SWARM_MODEL` | 覆盖规划器/默认模型。 |
| `SWARM_WORKER_MODEL` | 覆盖 worker 模型。 |
| `SWARM_AGGREGATOR_MODEL` | 覆盖汇总器模型。 |
| `SWARM_MAX_OUTPUT_TOKENS` | 覆盖每次响应的输出 token 上限，最大限制为 128000。 |
| `SWARM_DISABLE_PROMPT_CACHING` | 禁用服务商的提示词缓存提示和 cache-control 标记。 |
| `SWARM_PROMPT_CACHE_TTL` | 设置 Anthropic 的缓存 TTL 提示；用 `1h` 表示一小时的缓存块。 |
| `SWARM_PROMPT_CACHE_RETENTION` | 设置 OpenAI 的提示词缓存保留时间；在支持时用 `24h`。 |
| `SWARM_GEMINI_CACHE_TTL_SECONDS` | Gemini 显式 cachedContent 条目的 TTL。 |
| `SWARM_LSP_TYPESCRIPT_COMMAND` | 覆盖 `swarm lsp` 和基于 stdio 的 LSP 工具所用的 TypeScript LSP 命令。 |
| `SWARM_LSP_PYTHON_COMMAND` / `SWARM_LSP_RUST_COMMAND` / `SWARM_LSP_GO_COMMAND` | 为非 TypeScript 工作区启用范围较窄的 stdio LSP 提供方。 |
| `SWARM_TASK_TIMEOUT_MS` | 每个任务的超时时间，单位为毫秒。 |
| `SWARM_SHELL_AUTO_BACKGROUND_MS` | 前台 shell 命令运行超过这么多毫秒后转为后台进程（也可以用 `runtime.shellAutoBackgroundMs`；不设置则保持前台命令）。 |
| `SWARM_SUPERAGENT_HOME` | 覆盖工单宿主的状态目录（`~/.swarm/superagent`）。 |
| `OPENAI_API_KEY` | OpenAI 服务商的环境变量 key 来源。 |

## 开发

```bash
npm run check     # TypeScript 编译检查，不输出文件
npm run build     # 编译到 dist/
npm run evals     # 构建并运行本地产品回归评测
npm run release:gate # 构建并运行离线的 Claude Code 对标发布门禁
npm run smoke     # 构建并运行端到端冒烟测试
```

对标发布门禁默认离线运行。它报告当前操作者级别的计分卡，涵盖 TUI 可信度、缓存收益、服务商设置、Gateway/Symphony 控制平面证据、LSP 回退、产物/调试循环覆盖，以及有证据支撑的本地 Swarm v2 协作路径，全程不调用实际的服务商。`node dist/evals/local-evals.js --real-swarm` 覆盖缺陷修复、功能、重构、冲突、交接、Symphony 接收、LSP 回退和缓存复用场景，并使用模拟服务商的指标。接入外部服务商的实地试用是可选的。报告还包含一个回归分诊队列，附带证据链接、疑似负责的文件，以及下一步任务的建议。同一个门禁也可以在 TUI 中通过 `/evals --release-gate` 运行。

`.workflow/` 和 `.swarm/local-tests/` 下的本地规划和试用产物属于工作状态证据。除非某个任务明确要求发布这些产物，否则请把它们留在本地。

软件包的发布/安装使用 `package.json` 中的 `files` 允许列表，因此全局安装会包含 `dist/`、`docs/` 和各个 README。

## 基准测试 CLI

```bash
swarm bench run <suite>
swarm bench report <run_id>
swarm bench compare <run_a> <run_b>
```

内置套件包括 `ask-basic`、`repo-summary`、`small-edit`、`test-fix`、`read-only-audit`、`delegation-roi` 和 `tui-render`。

## 基准测试包装器

`bench/harbor` 包装器可以把本地 Swarm 软件包安装到隔离的基准测试环境中，通过环境变量转发模型配置，并上传报告、遥测和轨迹产物。
