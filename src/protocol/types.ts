export type AgentAddress = {
  agent_id?: string;
  role?: string;
  capability?: string;
};

export type AgentStatus = "idle" | "busy" | "offline" | "degraded";

export type SwarmMessageType =
  | "swarm.init"
  | "swarm.join"
  | "swarm.leave"
  | "swarm.shutdown"
  | "agent.register"
  | "agent.update_status"
  | "task.create"
  | "task.assign"
  | "task.accept"
  | "task.reject"
  | "task.start"
  | "task.progress"
  | "task.result"
  | "task.fail"
  | "task.cancel"
  | "bid.request"
  | "bid.submit"
  | "bid.award"
  | "blackboard.write"
  | "blackboard.read"
  | "blackboard.update"
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
  timeout_ms: number;
  retry: {
    max_attempts: number;
    backoff_ms: number;
  };
  require_review: boolean;
  consensus: ConsensusMode;
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
  };
};

export type SwarmSession = {
  swarm_id: string;
  session_id: string;
  user_request_id: string;
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
  deadline_at?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
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
};

export type ReviewResult = {
  target_task_id: string;
  reviewer: AgentAddress;
  verdict: "approve" | "reject" | "needs_revision";
  score: number;
  issues?: {
    severity: "low" | "medium" | "high";
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
  data?: unknown;
  artifacts?: {
    path: string;
    type: string;
    summary?: string;
  }[];
};
