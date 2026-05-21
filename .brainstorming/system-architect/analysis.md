# System Architect Analysis

## Findings
1. `openai-provider` 里 `preparePrompt`、`promptCachePolicy`、`trackPromptCacheDiagnostics` 分散管理 stable prefix、cache key、tool schema hash 和 request prefix hash，缓存边界容易被系统提示、工具顺序或动态尾部改动打散。Immediate: 把稳定前缀和变更原因收敛成统一 prompt contract。Deferred: 再按 provider 做更细的 cache scope。
2. 默认 TUI 已经是 conversation-first，但 `StatusRail`、`CurrentActionRow`、`ResultCardPanel`、`InspectorPane` 仍会在窄屏下争抢底部空间。Immediate: 只保留当前任务、当前动作、最终结果在主面，把 cache/trace/LSP 细节压到 inspector。Deferred: 再把 operator / inspector 分成更清楚的模式层。
3. `SwarmRuntime` 和 `CapabilityPlane` 共享 Swarm / Symphony / Gateway 入口是对的，但 `Gateway` 现在同时暴露能力、插件、MCP、Symphony 的读写接口，边界很容易被理解成第二个交互 UI。Immediate: 把 automation surface 的定位写进路由、权限和文档一致性。Deferred: 再细分只读和可变能力面。
4. LSP 现在有 TypeScript-first semantic gateway (`src/lsp/gateway.ts`) 和 stdio / manager 路由 (`src/lsp/stdio-tools.ts`, `src/lsp/manager.ts`) 两套链路，结果形状、超时和 recovery 语义需要统一，否则 diagnostics / definition / completion 会漂移。Immediate: 对齐 status、timeout、fallback、recoverySuggestion。Deferred: 仅在测试覆盖足够时再扩语言 provider。
5. 需要把回归门放到 surface 上，而不是只看实现：prompt cache hit rate 要按 scope / provider / changed reason 统计，TUI 要测窄屏渲染和 completion overlay，Gateway / Symphony 要测 fail-closed live control，LSP 要测 route parity 和 timeout fallback。
