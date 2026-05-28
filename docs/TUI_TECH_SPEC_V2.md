# Swarm TUI Tech Spec v2（Topology/Decision Trail/Collab Ops）

Status: Draft v2 (2026-05-28)

## 1. Scope

实现以下增量，不重写 renderer：

1. Topology Strip 组件与状态选择器
2. Result Card Decision Trail 数据通道
3. 协作快捷键与动作路由
4. 新增快照/交互回归测试

## 2. 现有能力复用

- 状态源：`src/tui/state/*`
- 协作投影：`src/tui/swarm-surface.ts`
- 结果卡：`src/tui/run-board/ProductResultCard.tsx` + `src/tui/components/ResultCard.tsx`
- 快捷键注册：`src/tui/shortcuts.ts`
- 布局骨架：`src/tui/components/ConversationFullscreenLayout.tsx`

## 3. 设计方案

### 3.1 Topology Strip

新增：

- `src/tui/components/TopologyStrip.tsx`
- `src/tui/components/TopologyStrip.test.tsx`

数据契约：

```ts
type TopologyStripModel = {
  squads_active: number;
  ownership_blocked: number;
  conflicts_open: number;
  approvals_pending: number;
  policy_mode: string;
  evidence: string[];
};
```

选择器来源：

- swarm surface summary
- work-board summary
- approval queue snapshot
- permission/sandbox mode

布局：

- >=120 cols: 全标签
- 100-119 cols: 缩写标签
- <100 cols: token 模式（`SQ/OW/CF/AP`）

### 3.2 Decision Trail

新增结果卡字段：

```ts
type DecisionTrail = {
  split?: string[];
  assign?: string[];
  verify?: string[];
  decide?: string[];
  risk?: string[];
};
```

注入路径：

- work result formatter 生成 trail
- ResultCard 渲染 trail 分区（可折叠）
- 空值时不渲染区块

### 3.3 协作快捷键

新增快捷映射：

- `o` ownership overlay
- `n` negotiation overlay
- `b` blackboard timeline overlay
- `r` reassign intent action

实现原则：

- overlay 抢占键盘事件优先级高于 prompt
- prompt focus 时仅在非输入编辑上下文触发单键动作
- 所有动作进入统一 action-log，带 source 与 trace id

### 3.4 Overlay 路由

新增 route 类型：

- `overlay:ownership`
- `overlay:negotiation`
- `overlay:blackboard`

统一由 `InspectorPane` / modal root 驱动，避免多套焦点系统。

## 4. 可观测性

新增 telemetry 事件：

- `tui.topology.open`
- `tui.collab.shortcut`
- `tui.decision_trail.expand`
- `tui.reassign.intent`

日志要求：

- 不记录原始 prompt
- 记录 overlay 类型、目标 id、动作耗时

## 5. 测试计划

- 单元测试：
  - Topology 模型映射
  - 快捷键冲突/优先级
  - Decision Trail 空态/截断/折叠
- 集成测试：
  - replay fixture 验证 prompt 不失焦
  - overlay 打开/关闭与 Esc 回退
- 视觉测试：
  - 80/100/120/160 列快照
  - dark/contrast/monochrome 对比

## 6. 发布门禁（沿用并新增）

必跑：

- `node --import tsx --test "src/tui/**/*.test.ts"`
- `node --import tsx --test src/evals/local-evals.test.ts`
- `npm run release:gate`
- `npm run smoke`

新增建议门禁：

- `node --import tsx --test src/tui/components/TopologyStrip.test.tsx`
- `node --import tsx --test src/tui/shortcuts.test.ts`

## 7. 回滚策略

- 使用 `SWARM_TUI_EXPERIMENTAL_COLLAB=0` 一键关闭新增协作层。
- Decision Trail 渲染失败时降级为原 Result Card 内容。
- Topology Strip 无数据时不显示空框，仅保留原 header 行为。
