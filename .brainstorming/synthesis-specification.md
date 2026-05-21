# Synthesis Specification

## Conflict Resolution

- Cache prefix discipline and cache-aware routing are the same problem in practice. Treat prompt assembly as one contract: stable prefix first, variable tail last, fixed ordering for tools and shared context, and diagnostics that explain why a prefix missed.
- The default TUI must stay conversation-first. Keep current task, current action, and final result in the main surface; move trace, cache, worker, and LSP detail into inspector views instead of widening the bottom rail.
- Swarm, Symphony, and Gateway are distinct surfaces, not alternate entry points. Swarm is the operator UI, Symphony is background intake and scheduling, and Gateway is automation/API only.
- The LSP should remain a narrow local semantic service. Keep it TypeScript-first, keep route parity and cancellation semantics tight, and defer any move toward a broader language platform.

## Prioritized Opportunities

1. Prompt contract and prefix discipline. Immediate. Lock stable instructions, tool definitions, and reusable workspace context ahead of variable turn content. This is the highest leverage lever for latency, cost, and model consistency.
2. Cache diagnostics and regression gates. Immediate. Surface cache key, cache mode, hit rate, and changed prefix fields where operators already inspect runtime status, and add regressions that prove prefix stability across repeated turns.
3. TUI simplification and inspector split. Immediate. Keep the default surface focused on read, write, approve, and resume, with dense runtime data behind explicit inspector commands and narrow-terminal render checks.
4. Boundary hardening across Swarm, Symphony, and Gateway. Next. Make product language, routing, and docs agree that Swarm is the operator surface, Symphony is background intake, and Gateway is automation only.
5. Narrow LSP productization. Next. Keep only the semantic operations the product already exposes, align stdio and tool-routing behavior, and add parity and timeout coverage before widening provider scope.
6. Cross-surface health signals. Deferred. Unify cache, TUI, Symphony, and LSP signals in an operator-facing status view only after the main surface is stable and readable.

## Roadmap Shape

### Immediate
- Stabilize prompt prefix order and cache boundaries.
- Add cache visibility and miss explanation.
- Simplify the default TUI layout.

### Next
- Harden product boundaries and naming.
- Productize the narrow TypeScript-first LSP surface.

### Deferred
- Any broader observability consolidation.
- Any distributed cache, IDE replacement, or platform rewrite.

## Success Signals

- Cache hit rate rises without prompt-shape drift.
- Narrow-terminal TUI keeps task, action, and result visible.
- Gateway and Symphony remain clearly non-interactive in both docs and routes.
- LSP requests preserve route parity, timeout behavior, and cancellation semantics.
