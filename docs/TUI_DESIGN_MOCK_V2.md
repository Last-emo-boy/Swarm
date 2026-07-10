# Swarm TUI 设计稿 v2（文本线框 + 交互稿）

Status: Draft (2026-05-28)

## 1. 首屏线框（120 columns）

```text
┌ Swarm ───────────────────────────────────────────────────────────────────────────────────────────┐
│ TOPOLOGY  SQ:2(active)  OW:1(blocked)  CF:0  AP:2(wait)  POLICY:scoped-write  [Enter: detail] │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ USER      修复 CI 里 parser 的 flaky test，并说明 root cause                                    │
│ SWARM     已拆分为 3 个子任务，先定位 nondeterminism 来源，再收敛 patch。                         │
│ WORKER#1  Running tests: parser/retry.spec.ts                                                    │
│ TOOL      npm test -- parser/retry.spec.ts (folded, 320 lines)                                  │
│ REVIEWER  建议增加 deterministic seed，避免 clock drift。                                        │
│ RESULT    ✅ fixed 2 files / ✅ tests pass / ⚠ risk: legacy retry path untouched                 │
│           Decision Trail: [split][assign][verify][decide][risk]                                 │
│                                                                                                  │
│ > Ask Swarm:                                                                                     │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ mode:auto  perm:approval  sandbox:workspace  Gateway:ON  Symphony:2run  LSP:ready  MCP:3        │
│ / search · o ownership · n negotiation · b blackboard · r reassign · Esc back                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. 窄屏线框（80 columns）

```text
┌ Swarm ────────────────────────────────────────────────────────────────┐
│ TOPO SQ2 OW1 CF0 AP2 POL:SW                                          │
├───────────────────────────────────────────────────────────────────────┤
│ USER   修复 flaky test                                                │
│ SWARM  已拆解，正在验证。                                              │
│ ...                                                                   │
│ > Ask Swarm:                                                          │
├───────────────────────────────────────────────────────────────────────┤
│ auto · approval · ws · G:on · Sy:2 · LSP:ok                          │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. Ownership Overlay

```text
┌ Ownership (blocked first) ────────────────────────────────────────────┐
│ [1] task:parser-seed owner:worker#2 status:blocked wait:review        │
│ [2] handoff:handoff_17 owner:reviewer status:pending                  │
│                                                                        │
│ Enter open · t take-over · a reassign · Esc close                     │
└────────────────────────────────────────────────────────────────────────┘
```

## 4. Negotiation Overlay

```text
┌ Negotiation Threads ───────────────────────────────────────────────────┐
│ neg_23  assign policy conflict  from:planner to:reviewer  status:open │
│ neg_21  test scope narrowing     from:worker2 to:planner  status:done │
│                                                                        │
│ Enter open thread · c resolve proposal · Esc close                     │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. Blackboard Timeline Overlay

```text
┌ Blackboard Timeline ───────────────────────────────────────────────────┐
│ claim      task/parser      by worker#1   10:31:10Z                   │
│ proposal   fix/seed         by worker#1   10:31:43Z                   │
│ decision   accept/proposal  by reviewer   10:32:12Z                   │
│ artifact   test-log         by tool       10:32:18Z                   │
│                                                                        │
│ / filter · Enter detail · y copy id · Esc close                       │
└────────────────────────────────────────────────────────────────────────┘
```

## 6. Decision Trail 展开态

```text
RESULT CARD
- Summary: flaky parser fixed via deterministic seed + retry bound
- Changed: src/parser/retry.ts, src/parser/retry.spec.ts
- Checks: npm test parser ✅

Decision Trail
  split:
    - isolate nondeterminism source
    - reproduce under stress run
  assign:
    - worker#1 owns repro
    - worker#2 owns patch
  verify:
    - reviewer requires 100x loop pass
  decide:
    - accept seed patch; reject timeout-only workaround
  risk:
    - legacy retry path not fully covered
```

## 7. 视觉语义建议

- Planner: cyan marker
- Worker: magenta marker
- Reviewer: yellow marker
- Aggregator: green marker
- Danger/Conflict: red token + `!` glyph
- Monochrome 模式改用前缀标签（`[PLAN] [WORK] [REV] [AGG]`）

## 8. 交互节奏

1. 用户输入后，先看到 Topology Strip 数值变化，再看到 transcript 细节。
2. 冲突出现时，Action Rail 只提示“可处理动作”，不自动弹窗。
3. 用户按 `o/n/b` 进入对应 overlay，Esc 返回 prompt。
4. 结果出现时默认折叠 Decision Trail，按 Enter 或快捷键展开。

## 9. 可用性验收清单

- Prompt 在任意 overlay 操作后可 1 次 Esc 返回。
- 空 Enter 不打开 command output 详情页。
- 80 列下无横向滚动。
- Monochrome 仍可区分角色与状态。
- Ctrl+C 后终端状态完整恢复。
