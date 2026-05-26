# Swarm TUI Product Spec

This spec turns the CC-style TUI study into Swarm-specific product requirements. It is intentionally product-facing: implementation details live in `docs/TUI_RENDERER.md`; this file defines what the terminal experience must feel like and how it is accepted.

## Product Boundary

Swarm's primary product interface is the CLI TUI. Headless CLI, Gateway, MCP, and Symphony surfaces are automation and evidence channels that must feed the TUI, not compete with it.

The TUI must open directly into the usable conversation surface. It must not start as a dashboard, marketing page, or system-status wall.

## Borrowed From CC

- Conversation-first layout: prompt and transcript are the default focus.
- Dense semantic rows: user, assistant, tool, result, approval, and progress rows keep stable markers and labels.
- Explicit detail surfaces: command output, tool result detail, logs, cache, LSP, Gateway, and Symphony detail open only from an explicit action.
- Keyboard-first operation: shortcuts are discoverable, but the prompt keeps priority.
- Low-noise status: service health is visible as compact pills and rail items instead of verbose panels.
- Visual restraint: semantic color accents carry meaning; body text stays neutral and readable.

## Not Borrowed

- No external brand copy or upstream-specific product naming.
- No default auto-open of command output detail panes.
- No single-purpose dashboard as the initial screen.
- No dependence on a remote web UI, browser DOM, or graphical shell.
- No rainbow palette. Semantic color diversity is required, but the color budget must remain restrained.

## Visual System

Required semantic channels:

- `brand.focus`: prompt focus, selected command, primary accent.
- `role.user`: user prompt marker and command entry marker.
- `role.assistant`: assistant row body accent without tinting all neutral text.
- `role.tool`: tool-use surfaces and capability affordances.
- `status.success`, `status.warning`, `status.danger`, `status.running`, `status.pending`: service and action state.
- `surface.selection`, `surface.searchMatch`, `surface.user`: local background meaning only.

The default dark profile must show at least four distinct semantic foreground colors in product smoke artifacts. `NO_COLOR` and monochrome profiles must keep labels, selected state, warning/error state, and search matches distinguishable by text and layout.

## Main Interface

The first viewport must contain:

- A visible prompt row with `Ask Swarm` or current input.
- A conversation transcript area that can render the startup logo, user rows, assistant rows, tool rows, result rows, and progress rows.
- A footer service cluster with mode, permission, sandbox, Gateway, Skills, Cache, LSP, Symphony, Tasks, Approvals, and MCP when space allows.
- A shortcut hint on wide terminals when the user is not typing.

Acceptance:

- 80, 100, 120, and 160 column captures have no horizontal overflow.
- Short viewports keep the prompt visible.
- Long transcripts virtualize mounted rows and preserve append cache reuse.

## Output Panel

Command output and tool output are transcript events first. Detail panes are secondary.

Required behavior:

- Empty Enter must not open a `COMMAND OUTPUT` screen.
- Running commands must not steal prompt focus.
- Long outputs are foldable and searchable.
- Explicit detail views must preserve route and selected row metadata for diagnosis.

Acceptance:

- Replay fixtures prove startup Enter does not open command output.
- Smoke artifacts prove no `COMMAND OUTPUT session:-` marker appears after startup.
- Tool result rows expose compact preview and full detail without tinting neutral output.

## Status Rail And Footer

The service model is shared between footer pills, status rail, `/status`, and inspector detail.

Each service item must have:

- `state`: normalized runtime state, not a vague `unknown` when a better state exists.
- `evidence`: short visible proof such as `NO PROVIDER`, `HIT 74%`, `OFF`, or `2 run`.
- `tone`: semantic state color.
- `action hint`: where to inspect or recover.

MCP, Skills, LSP, Gateway, Cache, Symphony, Tasks, and Approvals must use the same compact grammar. Unknown services stay muted until actionable.

## Approval Surface

Approval overlays are modal product surfaces, not raw tool dumps.

Required content:

- The decision controls appear before high-risk detail.
- The risk row includes permission name, risk class, sandbox, read/write scope, and predicted impact when available.
- Sensitive paths and secret-like values are redacted.
- Keyboard decisions are claimed by the approval overlay before prompt fallback.

## Logs And Diagnosis

Logs are a diagnosis surface, not main conversation content.

Required behavior:

- `/logs` or inspector detail shows recent provider, cache, MCP, SKILL, LSP, Gateway, Symphony, approval, and command-output anomalies.
- Raw prompt text, API keys, Authorization headers, and secret-like values are redacted.
- Each actionable log entry should point at an artifact, transcript row, session id, task id, or next action.

## Search And Navigation

Required shortcuts:

- `/`: transcript search.
- `Esc`: close active overlay/search/detail or return focus to the prompt.
- `Tab` and `Shift+Tab`: cycle focus zones when overlays exist.
- Left/Right: cycle footer service targets.
- Enter: submit prompt only when the prompt owns focus.

Shortcut hints must match actual behavior and compress on narrow terminals.

## Extension Inspector

The inspector must expose extension state without taking over the first screen.

Required sections:

- MCP: disabled, enabled-empty, configured, connected, pending, failed, degraded.
- Skills: empty, active, shadowed, untrusted, disabled, degraded.
- Plugins and capabilities: counts, hidden/disabled state, recent diagnostics.
- LSP: disabled, no-provider, not-configured, starting, ready, degraded, failed.

## Evidence And Release Gates

Every major TUI change must preserve these gates:

- `node --import tsx --test "src/tui/**/*.test.ts"`
- `node --import tsx --test src/evals/local-evals.test.ts`
- `npm run release:gate`
- `npm run smoke`
- Optional manual check: `npm install -g .` then `swarm tui-smoke --json`.

Required artifacts:

- Plain screen snapshot.
- ANSI screen snapshot.
- Profile diff or token audit.
- Debug log with redacted input.
- Checklist proving prompt visibility, semantic colors, command-output guard, renderer crash absence, and clean Ctrl+C cleanup.

## Current Caveats

This spec does not claim full external parity. Live-provider quality, real-repo benchmark breadth, and screenshot-level diffing should continue to expand, but the offline gates above are the minimum product bar for this iteration.
