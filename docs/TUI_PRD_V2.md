# Swarm TUI PRD v2（协作驾驶舱版）

Status: Draft v2 (2026-05-28)
Owner: Product + Runtime + TUI

## 1. 产品目标

在保持 conversation-first 的前提下，把 Swarm TUI 从“通用 coding chat 终端”升级为“可操作的多 agent 协作驾驶舱”。

核心目标：

1. 用户在首屏可以同时理解 **对话进展 + 协作拓扑 + 风险状态**。
2. 协议对象（ownership/negotiation/blackboard）从“诊断信息”升级为“一等交互对象”。
3. 最终结果从“输出摘要”升级为“可审计决策链”。

## 2. 用户与场景

### 2.1 用户类型

- 日常开发者：希望快改快验，不想看噪声日志。
- Lead/Reviewer：希望判断协作是否失控、谁在阻塞。
- Agent Builder：希望观察协议行为与策略效果。

### 2.2 关键场景

- 场景 A：单任务快速修复，用户只看结果与风险。
- 场景 B：多 worker 并行，用户要快速定位阻塞 ownership。
- 场景 C：争议结果复盘，用户需看到 decision trail。

## 3. 体验原则

- Prompt 永远可见、可输入。
- 协作态要“可见、可跳转、可操作”，不只可阅读。
- 默认低噪声，细节通过显式动作展开。
- 所有关键状态有 evidence 文案，不给模糊 unknown。

## 4. 信息架构（IA）

首屏固定四层：

1. **Topology Strip（新增）**
   - squads / ownership / conflicts / approvals / policy
2. **Transcript 主区**
   - user/assistant/tool/result/progress
3. **Action Rail（增强）**
   - 当前动作、最近异常、可恢复建议
4. **Prompt + Footer**
   - 输入区 + 服务 pills + 快捷提示

## 5. 核心功能需求

### F1 Topology Strip

- 展示 active squad 数、blocked ownership 数、conflict 数、pending approvals 数。
- 支持键盘切换 focus，Enter 打开对应 detail。
- 宽度不足时压缩为 token 化摘要（如 `SQ2 OW1 CF0 AP2`）。

### F2 协作快捷操作

- `o`: 打开 ownership 列表，支持 take-over / reassign。
- `n`: 打开 negotiation thread 列表。
- `b`: 打开 blackboard claim/proposal/decision timeline。
- `r`: 对当前 blocked task 发起“建议重分配”动作（需审批策略允许）。

### F3 Decision Trail（结果卡增强）

结果卡新增结构化区块：

- split（如何拆解）
- assign（如何分配）
- verify（如何验证）
- decide（为何结论成立）
- risk（剩余风险与回滚建议）

### F4 品牌化角色层

引入稳定角色标记：

- Planner
- Worker
- Reviewer
- Aggregator

每条关键事件可显示三元 attribution：`decided by / executed by / verified by`。

## 6. 非功能需求

- 80/100/120/160 列无水平溢出。
- 长会话必须维持虚拟化与 append cache 性能。
- 不破坏现有 renderer 生命周期与 Ctrl+C 清理。
- NO_COLOR 模式保留状态可辨识（通过 label+layout）。

## 7. 成功指标

- 首次定位阻塞时间（TTFB: time-to-find-blocker）下降 30%。
- 用户使用协作快捷键占比 > 25%。
- 结果卡“可解释评分”（内部 dogfood）提升 20%。
- 因协作状态不透明导致的中断/误操作工单下降。

## 8. 发布策略

- Phase 1: Topology Strip + Decision Trail（默认开启）
- Phase 2: 协作快捷键（feature flag）
- Phase 3: 品牌视觉协议（默认开启，保留 monochrome 等效）

## 9. 风险与缓解

- 风险：首屏信息过载。
  - 缓解：Topology Strip 只展示计数+证据，详细信息延迟展开。
- 风险：快捷键冲突。
  - 缓解：统一 shortcuts registry，新增冲突测试。
- 风险：协作数据不一致。
  - 缓解：统一 surface projection 源，detail 引用同一快照版本。
