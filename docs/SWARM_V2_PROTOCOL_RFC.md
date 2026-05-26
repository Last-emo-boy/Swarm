# Swarm v2 Protocol RFC

Status: evidence-backed local Swarm v2 protocol surface; distributed and remote-worker scope remains deferred.

This document defines the semantic boundary for Swarm v2. The local actor,
mailbox, ownership, blackboard, source-adapter, workbench, protocol timeline,
real swarm offline eval, and legacy direct-path audit surfaces are
evidence-backed. Cross-host distributed network execution, complex consensus
beyond local protocol fixtures, and external provider dogfood remain deferred or
optional boundaries.

## Purpose

Swarm v2 moves Swarm from a main-controller-plus-worker execution model toward a
durable collaboration protocol. The current Work Kernel, Envelope, worker,
handoff, blackboard, Gateway, Symphony, and TUI surfaces remain valuable. The
change is that collaboration state should become protocol-mediated and
replayable instead of depending on direct runtime side effects.

Evidence-backed local Swarm v2 collaboration is the implemented local protocol
claim: durable actor identity, mailbox delivery, task and handoff ownership,
blackboard claim/proposal/decision flow, Gateway/Symphony/LSP participants,
protocol timeline diagnostics, `/swarm` workbench projection, offline real swarm
evals, and direct-path migration audit.

## Terms

Agent Actor:
: A first-class participant with persistent identity, status, capabilities,
  inbox, outbox, heartbeat, and current ownership projection. A worker record is
  a compatibility projection of one kind of actor work; it is not the complete
  actor model.

Envelope Bus:
: The durable message path for agent-to-agent interaction. It records delivery
  state, correlation, reply relationships, TTL, retry policy, fan-out recipients,
  and replay metadata.

Mailbox:
: The per-actor inbox/outbox projection derived from durable envelopes and
  delivery state. Actors accept work by consuming mailbox messages, not by being
  invoked only through a direct runtime method.

Ownership Contract:
: The explicit protocol state that says who owns a task, handoff, file scope,
  claim, review, decision, or runner attempt at a point in time.

Handoff:
: Ownership transfer between participants. A v2 handoff has request, accept,
  reject, renew, checkpoint, return, take-back, timeout, and conflict semantics.

Blackboard Collaboration:
: A shared protocol space for evidence, claims, locks, proposals, reviews,
  decisions, and results. Blackboard facts must be traceable to an envelope or
  explicitly marked as a legacy direct write.

Participant:
: Any actor or source adapter that enters the swarm protocol. Main Swarm,
  workers, Symphony, Gateway, blackboard, and future local adapters can all be
  participants.

## Required Invariants

- Every new agent-to-agent interaction MUST be representable as an Envelope.
- New Swarm v2 paths MUST persist delivery state instead of relying only on the
  trace log or in-memory router state.
- Every first-class participant MUST have identity, status, capability
  lifecycle, heartbeat, inbox, outbox, and current ownership projection.
- Task ownership MUST be explicit: create, assign, accept or reject, start,
  progress, checkpoint, result or fail, cancel, and supersede.
- Handoff MUST be an ownership transfer protocol, not only a worker invocation
  mode.
- Blackboard claim, proposal, review, decision, result, lock, and unlock facts
  MUST be causally linked to envelopes where v2 paths are used.
- Symphony MUST enter as `symphony.scheduler` participant or as an explicit
  source adapter, not as an invisible side runner.
- Gateway MUST normalize external control actions into envelopes or mark the
  action as a compatibility exception.
- TUI MUST display v2 state from durable protocol projections, not decorative
  mock topology.

## Source Of Truth

| Concern | v1/current source | v2 target source | Migration rule |
| --- | --- | --- | --- |
| Message trace | `TraceStore` rows | Envelope delivery store plus trace projection | Keep trace as read-compatible history; do not use it alone as delivery truth. |
| Delivery state | Router memory, request timeout, child process send | Durable queued/delivered/acked/failed/expired/superseded rows | New v2 routes write delivery state before projections. |
| Worker status | `WorkerStateStore` | Agent actor state plus task ownership projection | Preserve worker APIs as compatibility projections. |
| Handoff status | `HandoffStore` active/returned/taken_back/failed | Handoff ownership transfer lifecycle | Map v2 states back to old status values until old consumers migrate. |
| Blackboard facts | `BlackboardStore` direct writes and router writes | Blackboard collaboration entries linked to envelopes | Legacy direct writes remain allowed only when marked as compatibility exceptions. |
| Symphony work | `SymphonyScheduler` claim/session/runner side effects | `symphony.scheduler` actor/source-adapter envelopes | Keep existing CLI and Gateway status while adding participant identity and mailbox flow. |
| Gateway control | HTTP handlers calling runtime/store helpers | `gateway.local` actor/source-adapter envelopes | Synchronous HTTP responses may return accepted/result projections. |
| TUI state | Runtime events, stores, WorkSnapshot helpers | Durable actor, mailbox, ownership, and collaboration projections | TUI can keep existing views but v2 topology must come from real protocol state. |

## Compatibility Matrix

| Surface | Current path | v2 target | Compatibility boundary |
| --- | --- | --- | --- |
| Main Swarm run | `SwarmRuntime.run()` and `CodingAgentLoop` | Main Swarm actor owns the user task and emits protocol state | Keep current entrypoint; add write-through envelopes for v2-owned state. |
| Worker delegation | `invokeAgent()` creates `WorkerRecord` and runs `CodingAgentLoop` | `task.assign` enters worker inbox; worker accepts and reports result by envelope | `invokeAgent()` remains a wrapper until callers are migrated. |
| Parallel worker | Background Promise plus worker store updates | Durable ownership, mailbox, checkpoint, and result envelopes | Old worker status output must still work. |
| Handoff | Handoff store status record tied to worker mode | Handoff request/accept/renew/checkpoint/return/take-back protocol | Old status enum remains a projection. |
| Blackboard tools | Router-backed and direct store writes | Collaboration protocol entries with envelope causality | Existing read/search/list tools stay stable. |
| Symphony tick | Scheduler claims and creates sessions/tasks directly | Symphony participant creates/assigns/returns through bus | Existing preview/tick/run-once commands stay compatible. |
| Gateway actions | HTTP routes call runtime controls | Gateway participant emits correlated command envelopes | Existing endpoint schemas stay compatible. |
| TUI agents view | Worker/handoff/Symphony status summaries | Actor topology, mailbox, heartbeat, ownership, and conflict surface | Default input still routes through main Swarm. |

## Direct Paths To Migrate

- `SwarmRuntime.invokeAgent()` central worker creation and loop execution.
- `HandoffStore.create()`, `finish()`, and `takeBack()` as direct ownership
  mutation paths.
- Direct blackboard writes that do not carry source envelope metadata.
- `SymphonyScheduler.dispatchItem()` direct session/task/attempt/blackboard
  side effects.
- Gateway control routes that mutate runtime or stores without protocol
  causality.
- TUI views that infer swarm topology from partial store snapshots instead of
  actor/mailbox/ownership projections.

## Allowed Compatibility Adapters

- Work Kernel stores may remain as query-optimized projections.
- `TraceStore` may remain as historical envelope replay output.
- Existing CLI and Gateway commands may keep their response schemas.
- Existing worker and handoff status enums may remain as mapped projections.
- Direct writes are allowed during migration only when marked as legacy
  compatibility writes and covered by replay/divergence audit.
- New critical direct writes for task, handoff, blackboard, Symphony, or Gateway
  state must be registered in `DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES`
  with `source_envelope_id`, `protocol_adapter`, or `legacy_exception` cause.
- A critical write with no protocol cause must fail `auditLegacyDirectPaths()`
  and must not be merged without either an envelope path or an explicit
  migration exception.

## Removal Checklist

1. Replace each `legacy_exception_remaining` warning with an envelope-backed
   adapter or remove the direct write.
2. Keep `DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS` aligned with task, handoff,
   blackboard, Symphony, and Gateway migration owners.
3. Keep `DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES` aligned with every
   remaining critical store mutation while migration is in progress.
4. Require `source_envelope_id` metadata for Blackboard collaboration writes
   unless a named compatibility exception is still active.
5. Keep replay/divergence tests green before deleting a compatibility adapter.

## Migration Gates

1. Durable Envelope delivery state exists and is tested.
2. Agent actor and mailbox projections exist and can represent main Swarm,
   worker, Symphony, Gateway, and blackboard participants.
3. At least one worker execution can be replayed from v2 protocol state.
4. At least one handoff lifecycle can be replayed from v2 protocol state.
5. At least one Symphony tick or run-once path enters through the participant
   model.
6. TUI topology displays real actor/mailbox/ownership data.
7. Migration audit reports divergence between protocol projections and legacy
   stores.

## Non-Goals For The First Pass

- No cross-host distributed network transport requirement.
- No immediate removal of Work Kernel stores.
- No mandatory remote workers.
- No default transcript flood of every low-level envelope.
- No complex consensus claim beyond the local protocol fixtures and release-gate
  evals.
- No mandatory external provider dogfood in the default release gate.
- No claim that Swarm v2 is complete beyond the local evidence-backed protocol surface.

## Related Backlog

The planned backlog lives under:

- `.workflow/scratch/20260524-plan-cand-prod-058-swarm-v2-protocol-convergence/plan.json`
- `.workflow/scratch/20260524-plan-cand-prod-058-swarm-v2-protocol-convergence/.task/`
