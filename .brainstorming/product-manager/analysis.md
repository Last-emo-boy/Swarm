# Product Manager Analysis

## Immediate Opportunities

1. Tighten prompt prefix discipline first. The highest-leverage, lowest-risk lift is to keep stable instructions, tool definitions, and reusable workspace context at the front of the prompt, then move per-turn content to the tail. This directly targets cache hit rate without changing the runtime model.

2. Simplify the default TUI hierarchy. The conversation surface should keep the current task, current action, and final result visible first, with cache, trace, worker, and LSP detail behind explicit inspector views. This reduces cognitive load without removing observability.

3. Harden the Swarm/Symphony/Gateway split in product language and navigation. Swarm should remain the operator surface, Symphony the background intake/scheduler, and Gateway the automation API. The main risk is accidental surface bleed, where users start treating Gateway or Symphony as alternate UIs.

4. Productize the LSP as a narrow semantic helper, not a second workspace. The best near-term scope is the already-implemented local semantic operations: completion, hover, definition, references, symbols, diagnostics, rename preview, format preview, progress, and cancellation. Avoid broadening it into a generic language platform.

5. Make cache and LSP health observable in the same place users inspect runtime status. Surface cache hit rate, cache key, changed prefix fields, and LSP request success/failure in the operator flow so misses and regressions are explainable, not just logged.

## Sequencing

- First: cache prefix discipline and stable tool ordering.
- Second: TUI simplification and inspector separation.
- Third: boundary hardening across Swarm, Symphony, and Gateway.
- Fourth: LSP polish and request-quality metrics.

## Deferred

- Multi-host or distributed cache work.
- Any move that makes Gateway the primary UX.
- Any expansion of Symphony into manual conversation handling.
