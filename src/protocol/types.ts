export type AgentAddress = {
  agent_id?: string;
  role?: string;
  capability?: string;
};

export type AgentStatus = "idle" | "busy" | "offline" | "degraded";
export type RiskClass = "r0" | "r1" | "r2" | "r3" | "r4";
export type ApprovalMode = "read-only" | "on-request" | "on-failure" | "auto" | "yolo";

export type WorkItem = {
  source: "user" | "gateway" | "symphony" | "self" | "worker" | string;
  source_id?: string;
  /**
   * Deprecated compatibility field for older persisted sessions.
   * New local Work Kernel code should write and read source_id instead.
   */
  external_id?: string;
  human_id?: string;
  title: string;
  description?: string;
  labels: string[];
  priority?: number | null;
  state?: string;
  url?: string;
  metadata: Record<string, unknown>;
};

export type WorkspaceLease = {
  lease_id: string;
  session_id: string;
  workspace_root: string;
  workspace_path: string;
  scope: string[];
  write_boundary: "workspace" | "read_only" | "custom";
  created_at: string;
  metadata: Record<string, unknown>;
};

export type RunAttemptKind =
  | "coding_turn"
  | "tool_call"
  | "worker_run"
  | "swarm_task"
  | "review"
  | "verification"
  | "chat_response";

export type RunAttemptStatus = "started" | "completed" | "failed" | "cancelled" | "stopped";

export type RunAttempt = {
  attempt_id: string;
  session_id: string;
  task_id?: string;
  runner_id?: string;
  kind: RunAttemptKind;
  status: RunAttemptStatus;
  attempt: number;
  title?: string;
  terminal_reason?: string;
  started_at: string;
  ended_at?: string;
  last_event_at: string;
  workspace_path?: string;
  error_code?: string;
  recovery_suggestion?: string;
  metadata: Record<string, unknown>;
};

export type WorkSessionOutcome = {
  changed_files: string[];
  intermediate_artifacts: string[];
  tests_run: string[];
  final_summary: string;
};

export type SwarmMessageType =
  | "swarm.init"
  | "swarm.join"
  | "swarm.leave"
  | "swarm.heartbeat"
  | "swarm.shutdown"
  | "agent.register"
  | "agent.update_status"
  | "agent.capability_query"
  | "agent.capability_response"
  | "approval.request"
  | "approval.grant"
  | "approval.deny"
  | "user.message"
  | "task.create"
  | "task.assign"
  | "task.accept"
  | "task.reject"
  | "task.start"
  | "task.progress"
  | "task.checkpoint"
  | "task.result"
  | "task.fail"
  | "task.cancel"
  | "task.supersede"
  | "handoff.request"
  | "handoff.accept"
  | "handoff.reject"
  | "handoff.renew"
  | "handoff.checkpoint"
  | "handoff.return"
  | "handoff.take_back"
  | "handoff.conflict"
  | "handoff.timeout"
  | "negotiation.propose"
  | "negotiation.counter"
  | "negotiation.accept"
  | "negotiation.decline"
  | "negotiation.delegate"
  | "negotiation.escalate"
  | "squad.create"
  | "squad.join"
  | "squad.leave"
  | "squad.role.assign"
  | "squad.dissolve"
  | "bid.request"
  | "bid.submit"
  | "bid.award"
  | "blackboard.write"
  | "blackboard.read"
  | "blackboard.update"
  | "blackboard.lock"
  | "blackboard.unlock"
  | "blackboard.subscribe"
  | "blackboard.claim"
  | "blackboard.release"
  | "blackboard.proposal"
  | "blackboard.review"
  | "blackboard.decision"
  | "blackboard.result"
  | "blackboard.notification"
  | "review.request"
  | "review.result"
  | "consensus.request"
  | "consensus.vote"
  | "consensus.result"
  | "artifact.create"
  | "artifact.update"
  | "error"
  | "ack";

export type SwarmEnvelope<T = unknown> = {
  id: string;
  version: "1.0";
  swarm_id: string;
  session_id: string;
  task_id?: string;
  subtask_id?: string;
  attempt?: number;
  from: AgentAddress;
  to: AgentAddress | AgentAddress[];
  type: SwarmMessageType;
  intent: string;
  correlation_id?: string;
  reply_to?: string;
  idempotency_key?: string;
  created_at: string;
  ttl_ms?: number;
  priority?: "low" | "normal" | "high" | "critical";
  routing?: {
    mode: "direct" | "broadcast" | "any" | "all" | "role" | "capability";
    require_ack?: boolean;
    retry?: {
      max_attempts: number;
      backoff_ms: number;
    };
  };
  trace?: {
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
  };
  auth?: {
    actor?: string;
    scopes?: string[];
    delegation_chain?: string[];
  };
  payload: T;
};

export type AgentCard = {
  agent_id: string;
  name: string;
  role: string;
  capabilities: string[];
  status: AgentStatus;
  load: {
    running_tasks: number;
    max_tasks: number;
  };
  reliability?: {
    success_rate: number;
    avg_latency_ms: number;
  };
  metadata?: Record<string, unknown>;
};

export type ConsensusMode =
  | "coordinator_decision"
  | "majority_vote"
  | "weighted_vote"
  | "reviewer_approval"
  | "unanimous"
  | "confidence_threshold";

export type SwarmPolicy = {
  max_agents: number;
  max_parallel_tasks: number;
  max_depth?: number;
  max_concurrency?: number;
  timeout_ms: number;
  retry: {
    max_attempts: number;
    backoff_ms: number;
  };
  require_review: boolean;
  consensus: ConsensusMode;
  approval_mode?: ApprovalMode;
  network_access?: "deny" | "allowlist" | "allow";
  allow_domains?: string[];
  human_approval_for?: string[];
  safety: {
    require_human_approval_for: string[];
    forbidden_capabilities: string[];
    sandbox_required: boolean;
  };
  memory: {
    allow_read: boolean;
    allow_write: boolean;
    retention: "none" | "session" | "long_term";
  };
  budget?: {
    max_tokens?: number;
    max_cost?: number;
    max_tool_calls?: number;
    max_wall_time_ms?: number;
    max_agents?: number;
    max_depth?: number;
  };
};

export type SwarmSession = {
  swarm_id: string;
  session_id: string;
  user_request_id: string;
  source?: WorkItem;
  parent_session_id?: string;
  workspace_lease_id?: string;
  objective: string;
  status:
    | "created"
    | "planning"
    | "running"
    | "reviewing"
    | "aggregating"
    | "completed"
    | "failed"
    | "cancelled";
  coordinator: AgentAddress;
  participants: AgentAddress[];
  created_at: string;
  updated_at: string;
  deadline_at?: string;
  policy: SwarmPolicy;
};

export type SwarmTask = {
  task_id: string;
  parent_task_id?: string;
  title: string;
  description: string;
  objective: string;
  type: "research" | "coding" | "analysis" | "review" | "tool_call" | "planning" | "aggregation";
  status:
    | "created"
    | "pending"
    | "assigned"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  required_capabilities: string[];
  inputs: Record<string, unknown>;
  expected_output: {
    format: "text" | "json" | "markdown" | "artifact" | "patch";
    schema?: Record<string, unknown>;
  };
  dependencies?: string[];
  assigned_to?: AgentAddress;
  risk_class?: RiskClass;
  deadline_at?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
};

export type TaskStateSnapshot = {
  session_id: string;
  swarm_id: string;
  task_id: string;
  parent_task_id?: string;
  subtask_id?: string;
  title: string;
  status: SwarmTask["status"];
  attempt: number;
  required_capabilities: string[];
  dependencies: string[];
  assigned_to?: AgentAddress;
  capability?: string;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  file_scope?: string[];
  last_error?: string;
  updated_at: string;
};

export type BlackboardEntry = {
  entry_id: string;
  swarm_id: string;
  session_id: string;
  task_id?: string;
  key: string;
  value: unknown;
  type: "plan" | "observation" | "evidence" | "result" | "critique" | "decision" | "artifact";
  created_by: AgentAddress;
  created_at: string;
  updated_at?: string;
  visibility: "private" | "team" | "public";
  version: number;
  tags?: string[];
  metadata?: BlackboardCollaborationMetadata;
};

export type BlackboardCollaborationKind =
  | "write"
  | "update"
  | "lock"
  | "unlock"
  | "claim"
  | "claim_release"
  | "claim_conflict"
  | "proposal"
  | "review"
  | "decision"
  | "result"
  | "subscription";

export type BlackboardClaimStatus = "claimed" | "released" | "expired" | "conflict";
export type BlackboardDecisionStatus = "proposed" | "reviewed" | "accepted" | "rejected" | "superseded";
export type BlackboardDecisionPolicyMode =
  | "single_owner"
  | "reviewer_approval"
  | "quorum"
  | "user_approval"
  | "timeout_fallback";
export type BlackboardDecisionPolicyStatus =
  | "open"
  | "waiting"
  | "satisfied"
  | "blocked"
  | "timeout_fallback";

export type BlackboardDecisionPolicy = {
  mode: BlackboardDecisionPolicyMode;
  risk_level?: RiskClass;
  required_reviewers?: string[];
  quorum?: number;
  timeout_ms?: number;
  fallback_status?: Extract<BlackboardDecisionStatus, "accepted" | "rejected" | "superseded">;
  user_approval_required?: boolean;
  reason?: string;
};

export type BlackboardDecisionVote = {
  voter?: string;
  vote: "approve" | "reject" | "abstain" | string;
  confidence?: number;
  reason?: string;
  source_envelope_id?: string;
};

export type BlackboardDecisionOutcome = {
  status: BlackboardDecisionStatus;
  reason?: string;
  votes?: BlackboardDecisionVote[];
  policy_status?: BlackboardDecisionPolicyStatus;
  supersedes_decision_id?: string;
};

export type BlackboardCollaborationMetadata = {
  kind?: BlackboardCollaborationKind;
  source_envelope_id?: string;
  source_envelope_ids?: string[];
  correlation_id?: string;
  reply_to?: string;
  owner_agent_id?: string;
  source_agent_id?: string;
  claim_key?: string;
  claim_status?: BlackboardClaimStatus;
  decision_status?: BlackboardDecisionStatus;
  decision_policy?: BlackboardDecisionPolicy;
  decision_policy_status?: BlackboardDecisionPolicyStatus;
  decision_waiting_for?: string[];
  decision_votes?: BlackboardDecisionVote[];
  decision_outcome?: BlackboardDecisionOutcome;
  proposal_id?: string;
  review_id?: string;
  decision_id?: string;
  result_id?: string;
  subscription_id?: string;
  target_key?: string;
  target_tags?: string[];
  expires_at?: string;
  released_at?: string;
  conflict_with_entry_id?: string;
  conflict_reason?: string;
  [key: string]: unknown;
};

export type BlackboardSubscriptionFilter = {
  key?: string;
  keyPrefix?: string;
  tag?: string;
  taskId?: string;
  agentId?: string;
  claimKey?: string;
  proposalId?: string;
  kind?: BlackboardCollaborationKind;
  decisionStatus?: BlackboardDecisionStatus;
};

export type BlackboardSubscriptionRecord = {
  subscription_id: string;
  session_id: string;
  subscriber: AgentAddress;
  filter: BlackboardSubscriptionFilter;
  source_envelope_id?: string;
  correlation_id?: string;
  created_at: string;
  expires_at?: string;
};

export type BlackboardEventRecord = {
  event_id: string;
  swarm_id: string;
  session_id: string;
  task_id?: string;
  key: string;
  kind: BlackboardCollaborationKind;
  actor: AgentAddress;
  source_envelope_id?: string;
  correlation_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ReviewResult = {
  target_task_id: string;
  reviewer: AgentAddress;
  verdict: "approve" | "reject" | "needs_revision";
  score: number;
  issues?: {
    severity: "low" | "medium" | "high";
    task_id?: string;
    message: string;
    evidence?: string;
    suggested_fix?: string;
  }[];
  summary: string;
};

export type SwarmError = {
  error_code:
    | "AGENT_TIMEOUT"
    | "AGENT_UNAVAILABLE"
    | "CAPABILITY_NOT_FOUND"
    | "TASK_FAILED"
    | "INVALID_PAYLOAD"
    | "PERMISSION_DENIED"
    | "CONSENSUS_FAILED"
    | "BUDGET_EXCEEDED"
    | "DEPENDENCY_FAILED";
  message: string;
  retryable: boolean;
  failed_agent?: AgentAddress;
  failed_task_id?: string;
  recovery_suggestion?:
    | "retry_same_agent"
    | "retry_different_agent"
    | "decompose_again"
    | "ask_human"
    | "abort_swarm";
};

export type GeneratedPlan = {
  objective: string;
  summary: string;
  intent?: "inspect_only" | "modify_workspace" | "create_project" | "report_only";
  tasks: SwarmTask[];
  final_artifact?: {
    path: string;
    format: "markdown" | "json" | "text";
  };
};

export type AgentResultPayload = {
  status: "completed" | "failed";
  summary: string;
  content?: string;
  outputRef?: string;
  toolStatus?: "success" | "partial" | "failed";
  errors?: string[];
  errorCode?: string;
  retryable?: boolean;
  recoverable?: boolean;
  recoverySuggestion?: "retry_same_agent" | "retry_different_agent" | "decompose_again" | "ask_human" | "abort_swarm";
  toolRecoverySuggestion?: string;
  sandbox?: unknown;
  data?: unknown;
  artifacts?: {
    path: string;
    type: string;
    summary?: string;
  }[];
};

export type WorkContractWorker = {
  worker_id: string;
  display_name: string;
  role_title?: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  capability: string;
  objective: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  handoff_id?: string;
  claim_owner?: string;
  lease_age?: WorkLeaseAge;
  heartbeat_state?: WorkHeartbeatState;
  stale_reason?: string;
  resume_command?: string;
  last_artifact?: string;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  file_scope: string[];
  requested_by?: string;
  blocked_reason?: string;
  updated_at: string;
};

export type WorkLeaseAge = {
  since: string;
  age_ms: number;
  label: string;
};

export type WorkHeartbeatState = "fresh" | "stale" | "missing" | "blocked" | "stopped" | "complete";

export type HandoffProtocolStatus =
  | "requested"
  | "accepted"
  | "rejected"
  | "renewed"
  | "checkpointed"
  | "returned"
  | "taken_back"
  | "failed"
  | "stale"
  | "conflict"
  | "timeout";

export type WorkContractHandoff = {
  handoff_id: string;
  worker_id: string;
  source_agent: string;
  target_agent_spec_id: string;
  reason: string;
  status: "active" | "returned" | "taken_back" | "failed";
  protocol_status?: HandoffProtocolStatus;
  requester_agent_id?: string;
  owner_agent_id?: string;
  claim_owner?: string;
  scope: string[];
  lease_age?: WorkLeaseAge;
  heartbeat_state?: WorkHeartbeatState;
  stale_reason?: string;
  conflict_reason?: string;
  deadline_at?: string;
  lease_expires_at?: string;
  accepted_at?: string;
  last_checkpoint?: unknown;
  return_contract?: unknown;
  write_policy: "read_only" | "scoped_write" | "workspace_write";
  file_scope: string[];
  updated_at: string;
};

export type WorkContractSummary = {
  active_workers: number;
  running_workers: number;
  pending_workers: number;
  resumable_workers: number;
  active_handoffs: number;
  read_only: number;
  scoped_write: number;
  workspace_write: number;
  scoped_targets: string[];
};

export type TaskContractRecord = {
  task_id: string;
  parent_task_id?: string;
  title: string;
  status: SwarmTask["status"];
  attempt: number;
  capability?: string;
  write_policy?: "read_only" | "scoped_write" | "workspace_write";
  file_scope: string[];
  dependencies: string[];
  last_error?: string;
  updated_at: string;
};

export type TaskContractSummary = {
  total: number;
  pending: number;
  running: number;
  blocked: number;
  completed: number;
  failed: number;
  read_only: number;
  scoped_write: number;
  workspace_write: number;
  scoped_targets: string[];
};

export type WorkContractSnapshot = {
  summary: WorkContractSummary;
  active_workers: WorkContractWorker[];
  resumable_workers: WorkContractWorker[];
  active_handoffs: WorkContractHandoff[];
};

export type WorkSnapshot = {
  session: {
    session_id: string;
    swarm_id: string;
    objective: string;
    status: SwarmSession["status"];
    source?: WorkItem;
    parent_session_id?: string;
    workspace_lease_id?: string;
    created_at: string;
    updated_at: string;
  };
  workspace?: WorkspaceLease;
  attempts: RunAttempt[];
  workers: unknown[];
  graph: {
    tasks: TaskStateSnapshot[];
    edges: unknown[];
  };
  blackboard_counts: Record<string, number>;
  changed_files: string[];
  checks: string[];
  review?: ReviewResult;
  verification?: unknown;
  usage_summary: Record<string, number>;
  task_contracts: {
    summary: TaskContractSummary;
    tasks: TaskContractRecord[];
  };
  work_contracts: WorkContractSnapshot;
  context_summary?: {
    entries: number;
    compactions: number;
    health: "empty" | "active" | "compacted";
    last_learned?: {
      entry_id: string;
      kind: string;
      role: string;
      created_at: string;
    };
    last_compacted_at?: string;
    latest_compaction?: {
      compaction_id: string;
      pre_tokens: number;
      post_tokens: number;
      strategy: string;
      created_at: string;
    };
  };
  final_outcome?: WorkSessionOutcome;
};
