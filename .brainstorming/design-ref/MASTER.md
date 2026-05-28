# Swarm Board TUI Design System

## Product Definition

Swarm Board presents an agent run as an observable, intervenable, and accountable local workflow. Worker Board shows who is doing the work, Attention shows where the run needs help, Result Preview shows the likely settlement while work is still running, and Product Result Card closes the run with evidence.

The default running experience is not a log stream. Logs, trace events, protocol names, and raw transcripts live behind detail/debug affordances.

## Selected Variant

Selected direction: Operational Workroom.

Why this variant:

- It matches the user's target concept: process view, exception view, and settlement view are projections of the same run state.
- It keeps the product calm and dense enough for terminal work.
- It avoids exposing internal protocol terms in the default surface.
- It supports mouse interaction without making mouse support required.

Rejected variants:

- Command Center: too dashboard-like for a local coding run.
- Conversation Led: too close to chat/log output during active work.

## Information Architecture

Idle state:

- Conversation transcript remains primary.
- Swarm Board may be absent or collapsed because there is no active run state.

Normal run:

- Swarm header panel.
- Worker Board.
- Current Worker, when a selected or most-active worker exists.
- Result Preview.
- Compact footer counters and detail affordance.

Attention needed:

- Same Worker Board remains visible.
- A row escalates to slow, blocked, conflicted, uncertain, failed, or approval.
- Attention panel appears below Worker Board.
- Result Preview explains what is currently blocked.

Finished:

- Product Result Card becomes the primary surface.
- Worker rows graduate into Worker Summary.
- Attention items graduate into Attention History.
- Next actions are explicit commands.

Debug/detail:

- `/workers`, detail key, or row click opens worker transcript/detail.
- Internal terms such as ASP, handoff contract, blackboard claim, gateway lease, and runtime event payloads are shown only here.

## State Rules

Board-first rule:

- If a run is busy, awaiting approval, waiting attention, verifying, done, partial, failed, or cancelled, the main pane renders Swarm Board or Product Result Card before transcript output.

Log containment rule:

- Raw event logs, tool streams, and trace lines are never the default active-run surface.
- They can appear inside detail views, debug views, worker transcript drawers, or command output views.

Attention rule:

- Stuck is not a modal.
- A worker row changes status first.
- The Attention panel then provides evidence, recommendation, and actions.

Result derivation rule:

- Product Result Card must be derived from the same state that powered Worker Board and Attention.
- Result Card cannot invent contributors, blockers, or checks that were never represented in run state.

## Data Projection

RunBoardState drives every surface:

- `workers` -> Worker Board rows and final Worker Summary.
- `attentionItems` -> Attention panel and final Attention History.
- `resultPreview` -> running settlement preview.
- `finalResult` -> Product Result Card.

Worker row fields:

- Name: user-readable role label.
- Status: queued, active, waiting, blocked, stuck, done, failed.
- Current: concise action.
- Age: duration of current status.
- Evidence: file, command, test, or finding.

Attention kinds:

- slow: command or worker is alive but stale.
- blocked: waiting on another worker, approval, lock, or test result.
- conflicted: workers disagree on evidence or path.
- uncertain: Swarm needs direction because confidence is low.
- failed: command or worker has failed and needs resolution.
- approval: policy requires user permission.

## Component Contracts

Swarm header:

- Required lines: Objective, Phase, Focus.
- Optional header metadata: repo, mode, risk, session.
- Must fit in 80 columns by clipping metadata first, never the phase.

Worker Board:

- Rows are single-line at 100 columns and above.
- At 80 columns, evidence may be hidden and current action clipped.
- Entire row is a click target.
- Enter on selected row opens the same detail path.

Attention panel:

- Shows the highest severity unresolved item first.
- Always includes a recommendation when Swarm can make one.
- Actions use bracketed key labels, for example `[w] wait`.
- Mouse click on an action calls the same handler as the keyboard key.

Result Preview:

- Running summary of likely outcome, changed files, verification status, confidence, and blockers.
- Must be short enough to remain visible below Attention on 80-column screens.

Product Result Card:

- Required sections: Status, Objective, Risk, Summary, Changed, Verified, Worker Summary, Attention History, Next.
- Failed or partial results must include recovery or next diagnostic action.

Footer:

- Shows counters: Workers, Blocked/Stuck, Files, Checks, Approvals, Detail.
- Footer pills are click targets.
- Footer click equivalents: Detail Enter, `/workers`, `/diff`, `/continue`, `/commit`.

## Terminal Mouse Interaction

Mouse support is a progressive enhancement, not a GUI dependency.

Implementation model:

- Enable raw terminal input during TUI lifecycle.
- Enable terminal mouse reporting when capability checks pass.
- Prefer SGR mouse mode 1006 with normal tracking 1000.
- Parse reports into terminal cell coordinates.
- Use renderer hit testing to dispatch click/wheel to the element occupying that cell.
- Disable with `SWARM_TUI_MOUSE=0`.

Required click targets:

- Worker row: select/open detail.
- Attention action: invoke the same action as its shortcut key.
- Result next action: invoke command or fill prompt with command.
- Footer pill: open matching detail view.
- Scroll region: wheel scrolls nearest scrollable panel.

Keyboard equivalence:

- Every click target must have a visible or documented keyboard path.
- Mouse focus must not steal the prompt unless the target explicitly edits the prompt.

External references:

- xterm mouse tracking and SGR 1006 reports: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- Node TTY raw mode: https://nodejs.org/api/tty.html#readstreamsetrawmodemode
- Microsoft virtual terminal input: https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences

## Responsive Terminal Rules

80 columns:

- Show header, Worker Board, one Attention or Result Preview block, footer.
- Worker row shape: `[RUN] Test Runner  running focused test  01:12`.
- Evidence moves to selected worker detail or second line only when room exists.

100 columns:

- Show evidence at row end when it fits.
- Keep Result Preview visible.
- Attention actions may wrap to two rows.

120 columns:

- Preferred default layout.
- Header metadata can remain in the first border title.
- Worker rows include status, label, action, age, and evidence.

160 columns:

- Keep one-column vertical board unless an explicit detail split is open.
- Optional right detail rail may show selected worker transcript excerpt.
- Do not turn default view into a dashboard grid.

Short height:

- Preserve Worker Board and highest severity Attention item first.
- Collapse Current Worker before collapsing Result Preview.
- Hide debug/detail surfaces first.

## Visual Language

Tone:

- Dense, calm, accountable, local-tool focused.

Color:

- Dark profile is default.
- Contrast profile must remain legible in high-contrast terminals.
- Monochrome mode preserves meaning through badges and text.

Borders:

- Rounded borders when supported.
- Single-line ASCII fallback when Unicode borders are disabled or terminal height is too small.

Status:

- Use `[RUN]`, `[ASK]`, `[WARN]`, `[ERR]`, `[OK]` as semantic anchors.
- Color may reinforce meaning but cannot be the only signal.

## Acceptance Checklist

- Running work renders Swarm Board first, not transcript/log first.
- Attention appears as a row state plus inline panel, not a modal.
- Result Card can be traced back to workers, checks, changed files, and attention history.
- Mouse click works for rows/actions in capable terminals.
- `SWARM_TUI_MOUSE=0` degrades cleanly to keyboard-only.
- 80-column terminal remains usable without overlapping text.
- Debug view exposes internals without polluting the default UI.
