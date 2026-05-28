# Synthesis Changelog: Swarm Board / RunBoard TUI Front End

## Source Set

- Guidance specification generated in session `.workflow/.csv-wave/20260527-brainstorm-swarm-board-tui-front-end`.
- Role analyses: product-manager, ux-expert, ui-designer, system-architect, test-strategist.
- Current code anchors referenced by roles: `SwarmChatApp.tsx`, `RuntimeEvent`, `work-state.ts`, `work-board.ts`, `swarm-surface.ts`, `result-card.ts`, `ResultCard.tsx`, `ActivityTimeline.tsx`, `CurrentActionRow.tsx`, `ActionLog.tsx`, `display-width.ts`, and existing conversation/focus tests.

## Decisions

1. P0 milestone is RunBoard projection, Worker Board rows, Attention Panel, and busy Overview integration.
2. P1 milestone is result preview continuity, final Result Card contribution fields, centralized evidence ordering, debug detail bridge, and release gates.
3. Default placement is the busy Overview body. Chat remains primary and the board is not a startup dashboard.
4. `SwarmSurfacePanel` and `WorkBoard` are diagnostic/detail sources, not default product copy.
5. Attention taxonomy remains explicit: `slow`, `blocked`, `conflicted`, `uncertain`, `failed`, and `approval`.
6. Slow/stuck detection is deferred behind config and tests. Deterministic approval/failed/blocked/conflict signals ship first.
7. Result Card must be extended from the existing model when evidence is ready. It must not be forked.
8. Rendering must use structured row view models and display-width clipping to pass 80/100/120/160-column gates.
9. First rollout should use `shadow` or `pane` mode, then promote to default after projection, render, focus, and protocol-leakage checks pass.

## Conflict Log

- [RESOLVED] Overview vs new dashboard: use busy Overview, not startup dashboard.
- [RESOLVED] Visible UI first vs projection first: build pure projection layer first.
- [RESOLVED] Protocol detail visibility: default rows use product labels, detail/debug owns protocol evidence.
- [RESOLVED] Stuck terminology: use attention taxonomy and avoid generic stuck copy.
- [RESOLVED] Immediate controls: render only existing supported actions.
- [RESOLVED] Result attribution: show sparse but accurate contribution evidence later.
- [RESOLVED] Rendering strategy: explicit field budgets and display-width helpers.
- [RESOLVED] Testing priority: reducer/selector/mapper tests before visible rollout.
- [SUGGESTED] Add `RunBoardConfig.mode` with `off | shadow | pane | default`.
- [UNRESOLVED] Exact slow/stale threshold values.
- [UNRESOLVED] Full keyboard row navigation and action keybinding scope.

## Confidence Score

Overall confidence: **0.89 high**.

Dimension scores:

- Role coverage: 0.96
- Cross-role consistency: 0.92
- Feature completeness: 0.90
- Spec quality: 0.88
- Design feasibility: 0.87

Weighted synthesis factors:

- Analysis depth: 0.90
- Evidence strength: 0.88
- Coverage breadth: 0.94
- User validation: 0.80
- Consistency: 0.92

Quality gate: unresolved conflicts = 2, below the warning threshold of more than 3 unresolved conflicts.
