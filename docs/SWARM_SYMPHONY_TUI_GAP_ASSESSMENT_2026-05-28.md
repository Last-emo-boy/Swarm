# Swarm / Symphony 实现度评估（2026-05-28）

## 1) 结论（TL;DR）

- **Swarm 协议层（ASP）已经实现了本地可用的 v1 能力**：包含 envelope/blackboard/ownership/handoff/协作投影与回放证据，足以支撑“单机/本地多 agent 协作”的主路径。  
- **Symphony 已达到“可运行的本地调度器”状态**：具备 work source 拉取、并发调度、重试恢复、workspace 生命周期、runner 事件回传和状态可观测。  
- **与你们文档里的“完整愿景”相比，仍是“本地优先、分布式延后”**：跨主机路由、复杂共识、分布式 checkpoint/trace 等明确被标注为 deferred。  
- **TUI 产品化能力较成熟，但品牌识别尚不足**：当前大量采用 CC-style 的交互原则（这是好事），但在“Swarm 独有信息架构 + 视觉语义叙事 + 协作心智模型”上还有明显提升空间。

## 2) 对照 Swarm.md（ASP 设计）

### 已落地（强）

- 运行时已提供 swarm 协作可视投影：participants / mailbox / ownership / negotiations / squads / conflicts 等核心协作态。  
- 提供 swarm workbench 与 summary 输出，能把黑板、handoff、actor heartbeat 等“协作证据”显式展示。  
- 具备与本地 work-board 的关联投影，说明协议态和执行态已开始融合而非分离。

### 未完全落地（按设计文档口径）

- 分布式 transport（跨 host 网络路由）仍未作为“完成能力”对外承诺。  
- 更复杂共识策略（超出 reviewer/本地协议夹具）未完成产品化。  
- 更丰富 checkpoint 编排仍停留在“有边界能力（list/create/revert）”，非全局编排层。

### 评估

- 如果你们目标是 **“本地可用、可验证、可发布”**：已基本达标。  
- 如果你们目标是 **“广域分布式 swarm 平台”**：仍在 roadmap 中段。

## 3) 对照 Symphony.md（服务编排设计）

### 已落地（强）

- 设计里要求的 orchestrator / workspace / runner / observability 主干在 README 的当前状态声明中已经逐项对应。  
- 明确支持 repository-owned workflow（`WORKFLOW.md`）和本地工作源，符合规范“策略在仓库内版本化”的核心思想。  
- 具备失败恢复、生命周期、运行状态输出与共享状态格式（CLI/Gateway/TUI）的一致性描述。

### 边界与风险

- “无持久 DB 也能恢复”的实践质量要继续靠故障注入回归测试保障（尤其是 kill -9 / partial writes / 重入）。  
- 当前优势是“本地自治 + 可解释”；若未来接入远端 provider 和多租户语义，治理复杂度会跃升。

### 评估

- Symphony 作为 **本地 daemon 编排器** 已可用；作为 **云控制平面替代品** 还不是目标，也不该被当前版本要求。

## 4) TUI：现在做得好在哪里

- 产品边界正确：把 TUI 作为主入口，其他 surface 作为自动化/证据渠道。  
- 交互原则正确：conversation-first、键盘优先、低噪声状态、显式 detail surface。  
- 工程基础扎实：自研 DOM renderer、input parser、focus/layering、virtual transcript、性能与视觉回归测试链路完整。  
- 主题系统已具备语义 token 和 profile（dark/contrast/monochrome），有后续塑造“品牌化 TUI”基础。

## 5) 为什么你会感觉“像 Claude Code，而不是 Swarm”

这是一个正常且准确的产品感知：

1. **交互骨架相似**：conversation + transcript + status rail + footer pills 本身是现代 coding-agent TUI 的收敛形态。  
2. **信息优先级仍偏“工具事件流”**：用户首先看到的是会话与工具执行，而不是“swarm 协作状态机”的叙事中心。  
3. **品牌语义还在 token 层，未形成“默认主视图叙事”**：你们有 `swarm/workboard/ownership` 数据，但默认视图里它们还不是第一层心智地图。

## 6) 建议的 TUI 重构方向（保留优点 + 建立自我风格）

### A. 信息架构：从“聊天 UI”升级为“协作驾驶舱”

- 默认首屏仍是可输入对话，但在 transcript 上方/侧边给出 **Swarm Topology Strip**：
  - Active squad
  - Owner leases
  - Risk/conflict count
  - Current policy mode（approval/sandbox）
- 把 “我问了什么” 与 “Swarm 正在如何协作解决”并列呈现。

### B. 视觉语义：强化“协作身份层”

- 让 user/assistant/tool 之外，新增并强化 **planner/worker/reviewer/aggregator** 角色徽标体系。  
- 每条关键事件附带 `who decided / who executed / who verified` 三元标签。

### C. 交互语法：把协议动作变成一等快捷操作

- 新增面向 swarm 的直接动作：
  - `r` 重分配当前阻塞任务
  - `o` 打开 ownership 冲突列表并可一键 take-over
  - `n` 展开 negotiation thread
  - `b` 快速跳转 blackboard claim/proposal/decision
- 目标：从“看日志”升级为“调度协作”。

### D. 结果叙事：从“命令输出”升级为“决策链证明”

- Result Card 增加 **Decision Trail**（简版因果链）：
  - 任务拆分 → 关键分配 → 冲突处理 → 验证结论 → 最终建议
- 对你们这种 Swarm 产品，这会是与通用 coding TUI 的核心差异点。

## 7) 一个可执行的重构路线（建议 3 个阶段）

1. **Phase 1（低风险）**：只加新视图，不改默认键位语义
   - 增加 `Swarm Topology Strip`
   - 在 Result Card 增加 Decision Trail
2. **Phase 2（中风险）**：引入协作操作快捷键
   - ownership / negotiation / blackboard 快捷入口
3. **Phase 3（高辨识度）**：品牌化视觉协议
   - 角色徽标、协作链路色彩、冲突/风险动效节奏

每阶段都沿用现有 release gate，避免“风格升级破坏稳定性”。

## 8) 现在是否“已经可以实现我们的功能”？

- **如果你们当前功能定义是：本地多 agent 协作开发 + 可观测 + 可恢复 + 可审批执行**，答案是：**是，已经可用，并且工程上比较扎实**。  
- **如果你们下一步功能定义是：强分布式 swarm 网络编排**，答案是：**尚未完全实现，当前版本属于明确的本地优先架构**。  
- **如果你们产品目标是“有自己风格的 TUI”**，答案是：**技术地基已具备，现在主要是产品信息架构与视觉语义重构问题，而不是底层能力不足**。
