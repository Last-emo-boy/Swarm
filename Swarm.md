下面给你设计一个 **Agent Swarm Protocol，简称 ASP**。它是在你前面那个 **Envelope 通信机制** 上扩展出来的多 agent 协作协议。

一句话：

> Envelope 是“单条消息的信封格式”，Agent Swarm Protocol 是“很多 agent 如何发现彼此、分工、协作、竞争、汇总、纠错、终止任务”的完整协议。

---

# 1. 协议目标

这个协议要解决的是：

```text
一个复杂任务进来
↓
多个 agent 自动组队
↓
拆任务
↓
分配任务
↓
并行执行
↓
共享中间状态
↓
互相校验
↓
汇总结果
↓
输出最终答案
```

它适合这些场景：

* 多专家 agent 协作
* Planner + Worker + Reviewer 架构
* 研究型 agent swarm
* 自动化运维 swarm
* 代码生成 / 代码审查 swarm
* 安全分析 swarm
* 多工具 agent 编排
* 多模型协同推理

---

# 2. 总体架构

可以设计成这样：

```text
User Request
    ↓
Swarm Gateway
    ↓
Swarm Coordinator / Planner
    ↓
Envelope Router
    ↓
┌───────────────┬───────────────┬───────────────┐
│ ResearchAgent │ CodeAgent     │ ToolAgent     │
├───────────────┼───────────────┼───────────────┤
│ ReviewAgent   │ MemoryAgent   │ CriticAgent   │
└───────────────┴───────────────┴───────────────┘
    ↓
Result Aggregator
    ↓
Final Response
```

核心组件：

| 组件                  | 作用                                          |
| ------------------- | ------------------------------------------- |
| `Swarm Gateway`     | 接收用户请求，创建 swarm session                     |
| `Coordinator`       | 总控，负责拆任务、分配任务、合并结果                          |
| `Router`            | 根据 agent_id / role / capability 路由 envelope |
| `Agent Registry`    | 记录所有 agent 能力、状态、负载                         |
| `Blackboard`        | 共享任务状态、中间结果、证据                              |
| `Aggregator`        | 汇总多个 agent 的输出                              |
| `Reviewer / Critic` | 审查结果、发现冲突、要求重做                              |

---

# 3. Swarm Protocol 的分层

建议协议分四层：

```text
L4: Swarm Task Protocol
    任务分解、分配、汇总、终止

L3: Coordination Protocol
    投标、锁、状态同步、共识、冲突解决

L2: Envelope Protocol
    消息元信息、路由、trace、权限、TTL

L1: Transport Protocol
    HTTP / WebSocket / Redis / NATS / Kafka / 内存队列
```

你前面设计的是 **L2 Envelope Protocol**。

现在我们设计的是上面的 **L3 + L4**。

---

# 4. 核心对象模型

整个 swarm 协议里有几个核心对象：

```text
Swarm
 ├── Session
 ├── Task
 │    ├── Subtask
 │    ├── Assignment
 │    └── Artifact
 ├── Agent
 ├── Message / Envelope
 ├── Blackboard
 └── Trace
```

---

## 4.1 Swarm Session

一个用户任务对应一个 swarm session。

```ts
type SwarmSession = {
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
```

示例：

```json
{
  "swarm_id": "swarm_001",
  "session_id": "sess_001",
  "user_request_id": "user_req_001",
  "objective": "分析这个代码库的安全问题并给出修复建议",
  "status": "running",
  "coordinator": {
    "agent_id": "planner_01"
  },
  "participants": [
    {
      "agent_id": "code_agent_01"
    },
    {
      "agent_id": "security_agent_01"
    },
    {
      "agent_id": "review_agent_01"
    }
  ],
  "policy": {
    "max_parallel_tasks": 8,
    "require_review": true,
    "consensus": "reviewer_approval",
    "timeout_ms": 120000
  }
}
```

---

## 4.2 Agent Registry

每个 agent 启动后，需要注册自己。

```ts
type AgentCard = {
  agent_id: string;
  name: string;
  role: string;

  capabilities: string[];

  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;

  status: "idle" | "busy" | "offline" | "degraded";

  load: {
    running_tasks: number;
    max_tasks: number;
  };

  cost?: {
    unit: "token" | "request" | "second";
    estimate: number;
  };

  reliability?: {
    success_rate: number;
    avg_latency_ms: number;
  };

  metadata?: Record<string, unknown>;
};
```

示例：

```json
{
  "agent_id": "security_agent_01",
  "name": "Security Analysis Agent",
  "role": "security_reviewer",
  "capabilities": [
    "code.audit",
    "solidity.audit",
    "threat_modeling",
    "vulnerability.explain"
  ],
  "status": "idle",
  "load": {
    "running_tasks": 0,
    "max_tasks": 3
  },
  "reliability": {
    "success_rate": 0.96,
    "avg_latency_ms": 3200
  }
}
```

---

# 5. 基础 Envelope 扩展

前面的 envelope 可以扩展成 swarm envelope。

```ts
type SwarmEnvelope<T = unknown> = {
  id: string;
  version: string;

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

  created_at: string;
  ttl_ms?: number;

  priority: "low" | "normal" | "high" | "critical";

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
    scopes: string[];
    delegation_chain?: string[];
  };

  payload: T;
};
```

---

# 6. Swarm 消息类型

建议定义这些消息类型：

```ts
type SwarmMessageType =
  | "swarm.init"
  | "swarm.join"
  | "swarm.leave"
  | "swarm.heartbeat"
  | "swarm.shutdown"

  | "agent.register"
  | "agent.update_status"
  | "agent.capability_query"
  | "agent.capability_response"

  | "task.propose"
  | "task.decompose"
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
  | "blackboard.lock"
  | "blackboard.unlock"

  | "review.request"
  | "review.result"
  | "critique.result"

  | "consensus.request"
  | "consensus.vote"
  | "consensus.result"

  | "artifact.create"
  | "artifact.update"

  | "error"
  | "ack";
```

可以按模块分：

```text
Swarm 生命周期：
swarm.init / join / leave / shutdown

Agent 管理：
agent.register / update_status / capability_query

任务管理：
task.create / assign / start / progress / result / fail

竞标机制：
bid.request / bid.submit / bid.award

共享状态：
blackboard.write / read / update / lock

审查机制：
review.request / review.result

共识机制：
consensus.request / vote / result

制品管理：
artifact.create / artifact.update
```

---

# 7. Swarm 生命周期

完整生命周期：

```text
created
  ↓
agent_discovery
  ↓
planning
  ↓
task_decomposition
  ↓
assignment
  ↓
execution
  ↓
review
  ↓
aggregation
  ↓
completed / failed / cancelled
```

对应流程：

```text
1. swarm.init
2. agent.capability_query
3. task.decompose
4. task.create
5. bid.request 或 task.assign
6. task.accept
7. task.start
8. task.progress
9. task.result
10. review.request
11. review.result
12. consensus.result
13. artifact.create
14. swarm.shutdown
```

---

# 8. Task / Subtask 设计

任务需要结构化，不要只传一句自然语言。

```ts
type SwarmTask = {
  task_id: string;
  parent_task_id?: string;

  title: string;
  description: string;

  objective: string;

  type:
    | "research"
    | "coding"
    | "analysis"
    | "review"
    | "tool_call"
    | "planning"
    | "aggregation";

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
```

示例：

```json
{
  "task_id": "task_security_audit",
  "title": "审计 Solidity 合约安全问题",
  "description": "检查合约中的权限、重入、转账、元数据、mint 权限和不可转让逻辑。",
  "objective": "输出高风险、中风险、低风险问题以及修复建议。",
  "type": "analysis",
  "status": "pending",
  "required_capabilities": [
    "solidity.audit",
    "security.review"
  ],
  "inputs": {
    "contract_path": "contracts/Anniversary.sol"
  },
  "expected_output": {
    "format": "json",
    "schema": {
      "issues": "array",
      "summary": "string"
    }
  },
  "acceptance_criteria": [
    "必须指出可利用条件",
    "必须给出修复建议",
    "必须区分严重级别"
  ]
}
```

---

# 9. 任务分配机制

Swarm 里有三种分配模式。

---

## 9.1 Coordinator 指派模式

适合小系统。

```text
Planner 直接决定哪个 agent 干什么
```

消息：

```json
{
  "type": "task.assign",
  "from": {
    "agent_id": "planner_01"
  },
  "to": {
    "agent_id": "security_agent_01"
  },
  "payload": {
    "task_id": "task_security_audit",
    "required_capabilities": [
      "solidity.audit"
    ],
    "inputs": {
      "contract_path": "contracts/Anniversary.sol"
    }
  }
}
```

优点：

* 简单
* 可控
* 容易 debug

缺点：

* Coordinator 压力大
* 不够自治

---

## 9.2 Capability 路由模式

适合中等系统。

```text
Planner 只声明需要什么能力
Router 自动找合适 agent
```

```json
{
  "type": "task.assign",
  "to": {
    "capability": "solidity.audit"
  },
  "routing": {
    "mode": "any"
  },
  "payload": {
    "task_id": "task_security_audit"
  }
}
```

Router 根据：

* agent 能力
* 当前负载
* 可靠性
* 历史延迟
* 成本

选择 agent。

---

## 9.3 Contract Net / Bidding 模式

适合更复杂的 swarm。

流程：

```text
Coordinator 发布任务
↓
多个 agent 投标
↓
Coordinator 选择最合适 agent
↓
任务授予
```

### bid.request

```json
{
  "type": "bid.request",
  "from": {
    "agent_id": "planner_01"
  },
  "to": {
    "capability": "code.audit"
  },
  "routing": {
    "mode": "broadcast"
  },
  "payload": {
    "task_id": "task_audit_001",
    "description": "审计 Solidity 合约",
    "required_capabilities": [
      "solidity.audit"
    ],
    "deadline_ms": 60000
  }
}
```

### bid.submit

```json
{
  "type": "bid.submit",
  "from": {
    "agent_id": "security_agent_01"
  },
  "to": {
    "agent_id": "planner_01"
  },
  "payload": {
    "task_id": "task_audit_001",
    "confidence": 0.92,
    "estimated_time_ms": 15000,
    "estimated_cost": 1200,
    "reason": "具备 Solidity 和权限审计能力，当前空闲"
  }
}
```

### bid.award

```json
{
  "type": "bid.award",
  "from": {
    "agent_id": "planner_01"
  },
  "to": {
    "agent_id": "security_agent_01"
  },
  "payload": {
    "task_id": "task_audit_001",
    "assignment_id": "assign_001"
  }
}
```

---

# 10. Blackboard 共享状态机制

Swarm 不能只靠点对点消息，否则上下文容易丢。建议设计一个 **Blackboard**。

它是共享工作区，保存：

* 当前计划
* 子任务状态
* 中间结果
* 证据
* 文件引用
* agent 观察
* 冲突点
* 最终 artifact

---

## 10.1 Blackboard 数据结构

```ts
type BlackboardEntry = {
  entry_id: string;
  swarm_id: string;
  task_id?: string;

  key: string;
  value: unknown;

  type:
    | "plan"
    | "observation"
    | "evidence"
    | "result"
    | "critique"
    | "decision"
    | "artifact";

  created_by: AgentAddress;
  created_at: string;
  updated_at?: string;

  visibility: "private" | "team" | "public";

  version: number;

  tags?: string[];
};
```

示例：

```json
{
  "entry_id": "bb_001",
  "swarm_id": "swarm_001",
  "task_id": "task_security_audit",
  "key": "audit.findings.reentrancy",
  "type": "evidence",
  "value": {
    "severity": "high",
    "description": "external call before state update",
    "file": "Vault.sol",
    "line": 88
  },
  "created_by": {
    "agent_id": "security_agent_01"
  },
  "visibility": "team",
  "version": 1,
  "tags": [
    "security",
    "solidity",
    "reentrancy"
  ]
}
```

---

## 10.2 Blackboard 写入消息

```json
{
  "type": "blackboard.write",
  "from": {
    "agent_id": "security_agent_01"
  },
  "to": {
    "agent_id": "blackboard"
  },
  "payload": {
    "key": "audit.findings.access_control",
    "type": "evidence",
    "value": {
      "severity": "medium",
      "description": "ADMIN role can change base metadata without delay",
      "recommendation": "add timelock or event logging"
    },
    "visibility": "team",
    "tags": [
      "access_control",
      "metadata"
    ]
  }
}
```

---

# 11. 协作模式设计

不同任务可以用不同 swarm 模式。

---

## 11.1 Pipeline 模式

适合固定流程。

```text
Planner → Researcher → Coder → Reviewer → Aggregator
```

比如：

```text
需求分析
  ↓
代码生成
  ↓
测试生成
  ↓
安全审查
  ↓
最终输出
```

适合代码开发、报告生成、信息收集。

---

## 11.2 Parallel Expert 模式

适合多角度分析。

```text
同一个问题
  ├── SecurityAgent
  ├── PerformanceAgent
  ├── ProductAgent
  └── LegalAgent
        ↓
    Aggregator
```

比如分析一个运维工具：

* 架构 agent 看系统设计
* 安全 agent 看权限和隔离
* 成本 agent 看部署成本
* 产品 agent 看差异化

---

## 11.3 Debate 模式

适合高风险决策。

```text
Proposer Agent 提方案
Critic Agent 反驳
Judge Agent 判断
```

流程：

```text
proposal
  ↓
critique
  ↓
revision
  ↓
review
  ↓
decision
```

适合：

* 安全设计
* 架构方案
* 智能合约审计
* 高价值决策

---

## 11.4 Map-Reduce 模式

适合大规模资料处理。

```text
大任务
  ↓
切成 N 个小任务
  ↓
多个 worker 并行处理
  ↓
reduce agent 汇总
```

比如：

* 分析大量日志
* 扫描代码库
* 处理很多文档
* 批量网页调研

---

## 11.5 Market / Auction 模式

适合动态 agent 集群。

```text
任务发布
  ↓
agent 自己判断能不能做
  ↓
投标
  ↓
最佳 agent 获得任务
```

适合：

* agent 数量很多
* 能力重叠
* 成本和速度不同
* 需要弹性调度

---

# 12. Review / Critic 机制

Swarm 最重要的是不能只让 worker 输出，还要有 review。

```ts
type ReviewResult = {
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
```

示例：

```json
{
  "type": "review.result",
  "from": {
    "agent_id": "review_agent_01"
  },
  "to": {
    "agent_id": "planner_01"
  },
  "payload": {
    "target_task_id": "task_security_audit",
    "verdict": "needs_revision",
    "score": 0.72,
    "issues": [
      {
        "severity": "high",
        "message": "缺少对权限升级路径的分析",
        "suggested_fix": "要求 security agent 补充 ADMIN_ROLE 与 owner 权限边界"
      }
    ],
    "summary": "结果可用，但需要补充权限模型。"
  }
}
```

---

# 13. Consensus 共识机制

如果多个 agent 给出不同结论，需要共识。

可以设计几种策略：

```ts
type ConsensusMode =
  | "coordinator_decision"
  | "majority_vote"
  | "weighted_vote"
  | "reviewer_approval"
  | "unanimous"
  | "confidence_threshold";
```

---

## 13.1 majority_vote

多数 agent 赞成即可。

适合低风险任务。

---

## 13.2 weighted_vote

按 agent 权重投票。

比如：

```json
{
  "security_agent": 0.5,
  "code_agent": 0.3,
  "product_agent": 0.2
}
```

适合专家权重不同的系统。

---

## 13.3 reviewer_approval

只要 reviewer 通过即可。

适合代码、报告、分析任务。

---

## 13.4 unanimous

必须全员通过。

适合高风险操作，比如：

* 删除生产数据
* 执行服务器变更
* 合约部署
* 自动打款
* 权限变更

---

# 14. Swarm Policy 设计

每个 swarm session 应该带 policy。

```ts
type SwarmPolicy = {
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
```

示例：

```json
{
  "max_agents": 8,
  "max_parallel_tasks": 4,
  "timeout_ms": 120000,
  "retry": {
    "max_attempts": 2,
    "backoff_ms": 1000
  },
  "require_review": true,
  "consensus": "reviewer_approval",
  "safety": {
    "require_human_approval_for": [
      "server.write",
      "payment.send",
      "email.send",
      "contract.deploy"
    ],
    "forbidden_capabilities": [
      "credential.exfiltrate"
    ],
    "sandbox_required": true
  },
  "memory": {
    "allow_read": true,
    "allow_write": false,
    "retention": "session"
  },
  "budget": {
    "max_tokens": 200000,
    "max_tool_calls": 50
  }
}
```

---

# 15. Agent 能力命名规范

能力最好设计成层级命名：

```text
domain.action
domain.subdomain.action
```

例如：

```text
web.search
web.fetch
web.extract

code.read
code.write
code.review
code.test
code.patch

security.audit
security.threat_model
security.vulnerability.explain

solidity.audit
solidity.compile
solidity.test

memory.read
memory.write

calendar.read
email.draft
email.send

server.read
server.deploy
server.restart

artifact.create
artifact.update
```

这样可以方便权限控制和路由。

例如：

```json
{
  "required_capabilities": [
    "code.review",
    "solidity.audit"
  ]
}
```

---

# 16. 权限模型

Swarm 必须有权限边界，否则 agent 之间会乱调用。

建议权限分三层：

```text
User Permission
↓
Swarm Policy
↓
Agent Capability
```

也就是说：

```text
用户允许
且 swarm policy 允许
且 agent 自己具备能力
才能执行
```

Envelope 里可以带：

```json
{
  "auth": {
    "actor": "user_001",
    "scopes": [
      "code.read",
      "code.review"
    ],
    "delegation_chain": [
      "user_001",
      "planner_01",
      "security_agent_01"
    ]
  }
}
```

对于危险能力，需要人工确认：

```text
email.send
server.write
server.restart
payment.send
contract.deploy
database.delete
```

---

# 17. 错误恢复机制

Swarm 里错误很常见，要标准化。

```ts
type SwarmError = {
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
```

示例：

```json
{
  "type": "error",
  "payload": {
    "error_code": "AGENT_TIMEOUT",
    "message": "security_agent_01 did not return result within ttl",
    "retryable": true,
    "failed_agent": {
      "agent_id": "security_agent_01"
    },
    "failed_task_id": "task_security_audit",
    "recovery_suggestion": "retry_different_agent"
  }
}
```

---

# 18. 幂等和去重

所有关键消息都要可去重。

```json
{
  "idempotency_key": "task_security_audit:attempt_1"
}
```

尤其是这些操作：

* `task.assign`
* `task.result`
* `artifact.create`
* `blackboard.write`
* `email.send`
* `server.deploy`
* `contract.deploy`

否则重试时可能重复执行。

---

# 19. 最小可用版 ASP

如果你想先落地，不要一开始做太复杂。

可以先做这个最小协议：

```ts
type MessageType =
  | "agent.register"
  | "task.create"
  | "task.assign"
  | "task.accept"
  | "task.result"
  | "task.fail"
  | "review.request"
  | "review.result"
  | "blackboard.write"
  | "error";
```

最小 envelope：

```ts
type SwarmEnvelope<T = unknown> = {
  id: string;
  version: "1.0";

  swarm_id: string;
  task_id?: string;

  from: string;
  to: string | { capability: string };

  type: MessageType;
  intent: string;

  correlation_id?: string;
  reply_to?: string;

  created_at: string;
  ttl_ms?: number;

  payload: T;
};
```

最小组件：

```text
Coordinator
Router
Agent Registry
Blackboard
Worker Agents
Reviewer Agent
Aggregator
```

这个版本已经够你做：

* 自动拆任务
* 多 agent 并发
* 按能力路由
* 中间结果共享
* reviewer 审查
* 最终汇总

---

# 20. 推荐协议流程示例

假设用户说：

> 帮我审计这个 Solidity 合约。

流程如下：

```text
1. Gateway 创建 swarm session
2. Planner 读取用户目标
3. Planner 查询可用 agent
4. Planner 拆成子任务：
   - 语法与编译检查
   - 权限模型检查
   - 重入与转账检查
   - NFT 业务逻辑检查
   - 修复建议生成
5. Router 分配给多个 agent
6. agent 并行执行
7. agent 写 blackboard
8. Reviewer 审查所有 finding
9. Aggregator 汇总报告
10. Coordinator 输出最终结果
```

消息链：

```text
swarm.init
agent.capability_query
task.decompose
task.assign
task.accept
task.start
blackboard.write
task.result
review.request
review.result
artifact.create
swarm.shutdown
```

---

# 21. 一个完整 JSON 示例

## 21.1 初始化 Swarm

```json
{
  "id": "env_001",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "from": {
    "agent_id": "gateway"
  },
  "to": {
    "agent_id": "planner_01"
  },
  "type": "swarm.init",
  "intent": "solidity.audit",
  "created_at": "2026-04-30T12:00:00Z",
  "payload": {
    "objective": "审计用户上传的 Solidity 合约并输出修复建议",
    "policy": {
      "max_agents": 6,
      "max_parallel_tasks": 4,
      "require_review": true,
      "consensus": "reviewer_approval",
      "timeout_ms": 120000
    }
  }
}
```

---

## 21.2 Planner 创建任务

```json
{
  "id": "env_002",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "from": {
    "agent_id": "planner_01"
  },
  "to": {
    "agent_id": "router"
  },
  "type": "task.create",
  "intent": "task.decompose.result",
  "created_at": "2026-04-30T12:00:03Z",
  "payload": {
    "tasks": [
      {
        "task_id": "task_compile_check",
        "title": "检查合约编译与依赖",
        "required_capabilities": [
          "solidity.compile"
        ]
      },
      {
        "task_id": "task_security_check",
        "title": "检查安全漏洞",
        "required_capabilities": [
          "solidity.audit",
          "security.audit"
        ]
      },
      {
        "task_id": "task_business_logic",
        "title": "检查 NFT 业务逻辑",
        "required_capabilities": [
          "nft.logic.review"
        ]
      },
      {
        "task_id": "task_fix_suggestion",
        "title": "生成修复建议",
        "required_capabilities": [
          "code.patch",
          "solidity.write"
        ],
        "dependencies": [
          "task_compile_check",
          "task_security_check",
          "task_business_logic"
        ]
      }
    ]
  }
}
```

---

## 21.3 Router 分配任务

```json
{
  "id": "env_003",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "task_id": "task_security_check",
  "from": {
    "agent_id": "router"
  },
  "to": {
    "capability": "solidity.audit"
  },
  "type": "task.assign",
  "intent": "solidity.audit",
  "routing": {
    "mode": "any",
    "require_ack": true,
    "retry": {
      "max_attempts": 2,
      "backoff_ms": 1000
    }
  },
  "created_at": "2026-04-30T12:00:05Z",
  "ttl_ms": 60000,
  "payload": {
    "task_id": "task_security_check",
    "description": "检查合约安全问题",
    "inputs": {
      "source_ref": "artifact_contract_source_001"
    },
    "expected_output": {
      "format": "json"
    }
  }
}
```

---

## 21.4 Agent 返回结果

```json
{
  "id": "env_004",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "task_id": "task_security_check",
  "from": {
    "agent_id": "security_agent_01"
  },
  "to": {
    "agent_id": "planner_01"
  },
  "type": "task.result",
  "intent": "solidity.audit.result",
  "correlation_id": "corr_task_security_check",
  "reply_to": "env_003",
  "created_at": "2026-04-30T12:00:20Z",
  "payload": {
    "status": "completed",
    "summary": "发现 2 个中风险问题和 1 个低风险问题。",
    "findings": [
      {
        "severity": "medium",
        "title": "ADMIN 可以修改 metadata，缺少变更延迟",
        "impact": "可能造成用户看到的 NFT 元数据被中心化修改",
        "recommendation": "增加 timelock、事件日志或冻结机制"
      },
      {
        "severity": "medium",
        "title": "batchMint 缺少单次数量限制",
        "impact": "可能导致 gas 过高或 DoS",
        "recommendation": "增加 maxBatchSize"
      }
    ]
  }
}
```

---

## 21.5 Reviewer 审查

```json
{
  "id": "env_005",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "from": {
    "agent_id": "planner_01"
  },
  "to": {
    "capability": "review.security"
  },
  "type": "review.request",
  "intent": "review.audit_result",
  "routing": {
    "mode": "any"
  },
  "created_at": "2026-04-30T12:00:25Z",
  "payload": {
    "target_task_id": "task_security_check",
    "review_focus": [
      "漏洞是否真实",
      "严重级别是否合理",
      "修复建议是否可执行"
    ]
  }
}
```

---

## 21.6 Review Result

```json
{
  "id": "env_006",
  "version": "1.0",
  "swarm_id": "swarm_solidity_audit_001",
  "session_id": "sess_001",
  "from": {
    "agent_id": "review_agent_01"
  },
  "to": {
    "agent_id": "planner_01"
  },
  "type": "review.result",
  "intent": "review.audit_result.completed",
  "created_at": "2026-04-30T12:00:35Z",
  "payload": {
    "target_task_id": "task_security_check",
    "verdict": "approve",
    "score": 0.88,
    "summary": "审计结论基本可靠，建议补充事件日志和权限边界描述。"
  }
}
```

---

# 22. 最推荐的目录结构

如果你要实现成项目，可以这样组织：

```text
agent-swarm/
├── protocol/
│   ├── envelope.ts
│   ├── message-types.ts
│   ├── task.ts
│   ├── agent-card.ts
│   ├── blackboard.ts
│   └── policy.ts
│
├── runtime/
│   ├── router.ts
│   ├── coordinator.ts
│   ├── registry.ts
│   ├── blackboard-store.ts
│   └── scheduler.ts
│
├── agents/
│   ├── base-agent.ts
│   ├── planner-agent.ts
│   ├── worker-agent.ts
│   ├── reviewer-agent.ts
│   └── aggregator-agent.ts
│
├── transport/
│   ├── memory-transport.ts
│   ├── redis-transport.ts
│   └── websocket-transport.ts
│
└── examples/
    ├── code-review-swarm.ts
    └── research-swarm.ts
```

---

# 23. TypeScript 核心类型草案

```ts
export type AgentAddress = {
  agent_id?: string;
  role?: string;
  capability?: string;
};

export type SwarmMessageType =
  | "swarm.init"
  | "swarm.join"
  | "swarm.leave"
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
  | "review.request"
  | "review.result"
  | "consensus.request"
  | "consensus.vote"
  | "consensus.result"
  | "artifact.create"
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
```

---

# 24. Python 版核心类型草案

```python
from typing import Any, Dict, List, Optional, Literal, Union
from pydantic import BaseModel
from datetime import datetime


class AgentAddress(BaseModel):
    agent_id: Optional[str] = None
    role: Optional[str] = None
    capability: Optional[str] = None


class RetryPolicy(BaseModel):
    max_attempts: int = 2
    backoff_ms: int = 1000


class RoutingPolicy(BaseModel):
    mode: Literal[
        "direct",
        "broadcast",
        "any",
        "all",
        "role",
        "capability",
    ] = "direct"

    require_ack: bool = False
    retry: Optional[RetryPolicy] = None


class TraceContext(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None


class AuthContext(BaseModel):
    actor: Optional[str] = None
    scopes: List[str] = []
    delegation_chain: List[str] = []


class SwarmEnvelope(BaseModel):
    id: str
    version: Literal["1.0"] = "1.0"

    swarm_id: str
    session_id: str

    task_id: Optional[str] = None
    subtask_id: Optional[str] = None

    from_agent: AgentAddress
    to: Union[AgentAddress, List[AgentAddress]]

    type: str
    intent: str

    correlation_id: Optional[str] = None
    reply_to: Optional[str] = None
    idempotency_key: Optional[str] = None

    created_at: datetime
    ttl_ms: Optional[int] = None

    priority: Literal["low", "normal", "high", "critical"] = "normal"

    routing: Optional[RoutingPolicy] = None
    trace: Optional[TraceContext] = None
    auth: Optional[AuthContext] = None

    payload: Dict[str, Any]
```

注意 Python 里 `from` 是关键字，所以用了 `from_agent`。

---

# 25. 最终推荐版本

我建议你的 Agent Swarm Protocol 第一版定成这样：

```text
协议名：ASP / Agent Swarm Protocol
版本：1.0

核心组件：
1. Swarm Session
2. Agent Registry
3. Envelope Router
4. Task Scheduler
5. Blackboard
6. Reviewer
7. Aggregator

核心消息：
1. swarm.init
2. agent.register
3. task.create
4. task.assign
5. task.result
6. blackboard.write
7. review.request
8. review.result
9. artifact.create
10. error

核心能力：
1. 按 capability 路由
2. request / response 关联
3. 任务拆解
4. 并行执行
5. 中间状态共享
6. 审查机制
7. 错误重试
8. 最终汇总
```

最小运行流：

```text
User Request
  ↓
swarm.init
  ↓
agent.register / capability query
  ↓
task.create
  ↓
task.assign
  ↓
task.result
  ↓
review.request
  ↓
review.result
  ↓
artifact.create
  ↓
final response
```

核心思想：

> Agent Swarm Protocol = Envelope + Agent Registry + Task Graph + Blackboard + Review + Consensus + Policy。

Envelope 管单条消息，ASP 管整个多 agent 群体协作。
