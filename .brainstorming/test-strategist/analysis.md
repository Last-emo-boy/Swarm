# Test Strategist Analysis

## Immediate

- Prompt cache discipline is observable but not yet gated at the prompt-builder boundary. The runtime preserves diagnostics, but there is no regression that proves stable prefix ordering, cache key stability, or hit-rate thresholds across repeated main loop turns.
- The default conversation-first TUI is structurally covered, but narrow-terminal render behavior is still a risk. Add render/screenshot checks that keep current action and result visible while inspector content stays secondary.
- Gateway exposes Symphony routes, so boundary drift is the main product risk. Add contract tests to keep `/v1/symphony/status`, `/v1/symphony/preview`, and `/v1/symphony/cleanup` aligned with automation-only behavior and Work Kernel state.
- Symphony has scheduler/status coverage, but not an end-to-end smoke gate from local work-source intake through session creation, workspace lease allocation, and cleanup/retry transitions.

## Deferred

- LSP is stable enough to ship as a narrow local semantic service, but provider readiness, timeout rate, cancellation handling, and hover/completion/definition success rate need product-level metrics before wider expansion.
- Cross-surface observability should eventually unify cache hit rate, TUI layout health, Symphony totals, and LSP readiness in one operator-facing regression view.
