# Swarm Extension Capability Plane

Status: design draft

Purpose: integrate MCP servers, Agent Skills, project extensions, slash commands,
agent specs, and built-in local tools into one Swarm service capability layer.

## Product Goal

Swarm should feel like one local coding agent even when its abilities come from
many places. Users should configure or install capabilities once, then see them
through the TUI, Gateway, Work Kernel records, approvals, audit, and runtime
events with the same semantics as built-in tools.

This design makes Swarm both:

- an MCP host/client that can connect to local or remote MCP servers;
- an MCP server that can expose selected Swarm capabilities to other local
  clients through the Gateway;
- an Agent Skills-compatible client that discovers, activates, and preserves
  skill context;
- a unified capability service for local tools, skills, slash commands, agent
  specs, Symphony, and future plugins.

## Current Repo Fit

The current repository already has the right anchors:

- `src/server/gateway.ts` is the local service API and SSE surface.
- `src/runtime/runtime.ts` owns Work Kernel stores, events, Gateway-visible
  state, agent specs, and the coding-loop entrypoint.
- `src/runtime/coding-agent-loop.ts` renders the model tool catalog and executes
  tool calls through `runLocalTool`.
- `src/tools/local-tools.ts` and `src/tools/types.ts` define the current built-in
  local tool action union and result shape.
- `src/tools/permissions.ts` centralizes approval, deny-list, workspace, and
  risk classification.
- `src/tui/slash-commands.ts` and `src/tui/SwarmChatApp.tsx` provide explicit
  TUI controls.
- `docs/WORK_KERNEL.md` already defines Work Kernel sessions, attempts,
  artifacts, blackboard, approvals, audit, trace, and workspace leases as the
  shared execution truth.

The missing layer is a capability registry and broker between the model/TUI/API
and the concrete implementations.

## External Protocol Notes

The MCP specification currently marks version `2025-11-25` as latest. It defines
hosts, clients, and servers over JSON-RPC, with server features for resources,
prompts, and tools, and client features for roots, sampling, and elicitation.
Standard transports are stdio and Streamable HTTP.

Agent Skills are directories containing `SKILL.md` plus optional `scripts/`,
`references/`, and `assets/`. The standard integration strategy is progressive
disclosure: load only name and description at startup, load full instructions
when activated, and load bundled resources on demand.

Design implication for Swarm: MCP and skills must not be treated as raw prompt
text or ad hoc tool calls. They should be normalized into Swarm capability
records, policy checks, audit rows, and ToolResult-compatible outputs.

References:

- https://modelcontextprotocol.io/specification/2025-11-25
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- https://modelcontextprotocol.io/specification/2025-11-25/server/prompts
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://agentskills.io/specification
- https://agentskills.io/client-implementation/adding-skills-support

## Architecture

```text
TUI / CLI / Gateway / Symphony
        |
        v
Capability Plane
  - CapabilityRegistry
  - CapabilityBroker
  - Provider adapters
  - Policy projection
  - Catalog ranking
        |
        +--> Built-in local tools
        +--> MCP clients
        +--> Swarm MCP server
        +--> Agent Skills
        +--> Slash commands
        +--> Agent specs
        +--> Future plugins
        |
        v
Work Kernel
  - session
  - run attempt
  - approval
  - audit
  - blackboard
  - artifact
  - usage
  - trace
```

The registry answers "what exists?" The broker answers "may this be used now,
how do we invoke it, how do we record it, and how do we normalize the result?"

## Core Types

```ts
export type CapabilityKind =
  | "local_tool"
  | "mcp_tool"
  | "mcp_resource"
  | "mcp_prompt"
  | "skill"
  | "slash_command"
  | "agent_spec"
  | "plugin";

export type CapabilitySource =
  | "builtin"
  | "user"
  | "project"
  | "workspace"
  | "mcp"
  | "plugin";

export type CapabilityTrust = "builtin" | "trusted" | "untrusted" | "disabled";

export type CapabilityDescriptor = {
  id: string;                 // stable, globally unique in this Swarm process
  kind: CapabilityKind;
  source: CapabilitySource;
  trust: CapabilityTrust;
  providerId: string;         // local-tools, mcp:<server>, skills:<scope>, etc.
  name: string;               // model-facing short name
  title?: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  riskClass: "r0" | "r1" | "r2" | "r3" | "r4";
  permissionName: string;     // used by allow/ask/deny rules
  modelVisible: boolean;
  userVisible: boolean;
  metadata?: Record<string, unknown>;
};

export type CapabilityInvocation = {
  capabilityId: string;
  arguments: Record<string, unknown>;
  sessionId?: string;
  taskId?: string;
  reason?: string;
};
```

Provider adapters implement:

```ts
export type CapabilityProvider = {
  id: string;
  source: CapabilitySource;
  refresh(): Promise<CapabilityDescriptor[]>;
  invoke?(call: CapabilityInvocation): Promise<ToolResult>;
  readResource?(call: CapabilityInvocation): Promise<ToolResult>;
  getPrompt?(call: CapabilityInvocation): Promise<ToolResult>;
  dispose?(): Promise<void> | void;
};
```

## Capability Providers

### Built-In Local Tool Provider

Wrap the current `normalizeToolAction`, `runLocalTool`, `renderToolSchemas`, and
permission helpers behind `LocalToolCapabilityProvider`.

First implementation should keep the existing `ToolAction` union intact and
only add an adapter facade. This avoids breaking TUI, Gateway, and evals while
creating a path for dynamic tools.

### MCP Client Provider

Add an `McpClientProvider` that connects to configured MCP servers and projects
their tools, resources, and prompts into Swarm descriptors.

Supported phases:

1. stdio transport only, because it maps cleanly to the local service and can
   be managed as a child process.
2. Streamable HTTP transport for remote servers after auth, Origin, timeout,
   and retry policy are explicit.
3. Resources and prompts surfaced after tool invocation is stable.
4. Sampling and elicitation only after TUI approval UX exists for server-to-user
   and server-to-model requests.

MCP tool calls normalize into `ToolResult`:

- text content becomes `content`;
- structured content goes into `data`;
- resource links become artifact or blackboard references;
- MCP errors become `status: "failed"`, `errorCode`, `retryable`,
  `recoverable`, and `recoverySuggestion`.

### Swarm MCP Server Provider

Swarm should also expose a local MCP endpoint from the Gateway.

Add a service endpoint such as:

- `POST /mcp`
- `GET /mcp`

This endpoint should expose only selected capabilities, never the whole internal
runtime by default. Initial server-side MCP features:

- tools:
  - `swarm.start_session`
  - `swarm.send_message`
  - `swarm.interrupt`
  - `swarm.approval_decision`
  - read-only status tools such as `swarm.session_status`
- resources:
  - `swarm://sessions/{id}`
  - `swarm://sessions/{id}/events`
  - `swarm://sessions/{id}/trace`
  - `swarm://sessions/{id}/audit`
- prompts:
  - `swarm_self_review`
  - `swarm_code_review`
  - `swarm_symphony_work_item`

Default posture: disabled until the user enables `settings.extensions.mcpServer`
or starts `swarm serve --mcp`.

### Agent Skills Provider

Add a `SkillProvider` that scans configured skill roots, parses `SKILL.md`
metadata, and exposes each skill as a `skill` descriptor plus a dedicated
`skill.activate` tool.

Recommended scan roots:

- project: `<workspace>/.swarm/skills`
- project interoperability: `<workspace>/.agents/skills`
- user: `~/.swarm/skills`
- user interoperability: `~/.agents/skills`
- explicit paths from settings

Precedence:

1. trusted project skills
2. user skills
3. built-in bundled skills

Project skills should be hidden until the workspace is trusted. If a skill name
collides, higher precedence shadows lower precedence and diagnostics should be
visible in `/skills` and Gateway output.

Activation behavior:

- Model-driven: the model sees a compact catalog and calls `skill.activate`.
- User-explicit: the TUI supports `/skill <name>` and optional `$name` mention.
- Returned content is wrapped with skill name, directory, and resource listing.
- Bundled resources are not eagerly read; the model can read specific files
  through normal file tools, subject to policy.
- `allowed-tools` in `SKILL.md` is treated as a request or hint, never as a
  policy override.
- Skill activation is written to blackboard and marked as durable context so
  context compaction does not silently remove active skill instructions.

### Slash Command Provider

Slash commands are explicit TUI controls, not model-controlled tools. Still,
they should be registered as capabilities so `/help`, Gateway, docs, and future
plugins can render one catalog.

Model visibility should be `false` for most slash commands. User visibility is
`true`.

### Agent Spec Provider

The current built-in agent specs should be projected into the same registry with
`kind: "agent_spec"`. This gives the TUI and Gateway one endpoint for:

- model/tool capabilities;
- human slash controls;
- delegation personas;
- skill and MCP extension availability.

## Settings Shape

Extend `SwarmSettings` with an `extensions` section:

```ts
extensions: {
  capabilities: {
    disabled: string[];
    hiddenFromModel: string[];
  };
  skills: {
    enabled: boolean;
    loadProjectSkills: "never" | "trustedWorkspaces" | "always";
    roots: string[];
    maxSkills: number;
  };
  mcp: {
    enabled: boolean;
    exposeGatewayServer: boolean;
    servers: Record<string, {
      disabled?: boolean;
      transport: "stdio" | "http";
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      trust: "user" | "project" | "workspace";
      exposeTools?: boolean;
      exposeResources?: boolean;
      exposePrompts?: boolean;
      timeoutMs?: number;
    }>;
  };
}
```

Environment variables in MCP server config should support indirection, but
resolved secret values must not be echoed in TUI, Gateway, audit, or debug logs.

## Permissions

Add permission names:

- `McpTool(server:name)`
- `McpResource(server:uri)`
- `McpPrompt(server:name)`
- `Skill(name)`
- `Plugin(name)`

The broker should apply permission checks in this order:

1. capability disabled or hidden by settings;
2. workspace trust gate;
3. deny rules;
4. deterministic risk class;
5. approval mode;
6. provider-specific checks;
7. invocation.

MCP roots are informational, not an access-control boundary. Swarm must enforce
workspace and deny rules itself, especially when it launches local MCP servers
or passes local paths to them.

## Gateway API

Add read endpoints first:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/capabilities` | List normalized capabilities with filters for kind/source/provider/model visibility |
| `GET /v1/capabilities/:id` | Inspect one descriptor, diagnostics, and provider metadata |
| `POST /v1/capabilities/refresh` | Refresh skills and MCP discovery |
| `GET /v1/skills` | List skills, precedence, trust, diagnostics |
| `POST /v1/skills/:name/activate` | Activate a skill for a session |
| `GET /v1/mcp/servers` | List configured MCP server connection states |
| `POST /v1/mcp/servers/:id/refresh` | Reconnect and refresh one MCP server catalog |
| `GET /mcp` / `POST /mcp` | Optional Swarm MCP server transport endpoint |

Add invocation later:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/capabilities/:id/invoke` | Invoke a user-approved capability call |
| `GET /v1/mcp/servers/:id/resources` | List server resources |
| `POST /v1/mcp/servers/:id/resources/read` | Read one resource |
| `GET /v1/mcp/servers/:id/prompts` | List server prompts |
| `POST /v1/mcp/servers/:id/prompts/get` | Render one prompt |

Gateway invocation must use the same approval handler and audit path as TUI
tool calls.

## TUI Surface

Add commands:

- `/capabilities [kind|provider]`
- `/skills`
- `/skill <name>`
- `/mcp`
- `/mcp <server_id>`
- `/mcp-refresh [server_id]`

The default chat path should not require the user to micromanage these. The
TUI commands are for inspection, explicit activation, and debugging.

Approval dialogs should show:

- capability source and trust state;
- MCP server id or skill path;
- operation type;
- target URI, command, or resource;
- exact arguments after redaction;
- why the model wants it;
- rollback or recovery guidance when applicable.

## Runtime Integration

The coding loop should move from a static tool list to a catalog projection:

```text
available capabilities =
  registry.list()
  -> filter by role/persona allowed tools
  -> filter by policy and trust
  -> rank or narrow by objective
  -> render compact schemas for model
```

Do not expose every installed MCP tool and skill to the model at once. The first
implementation can use deterministic filters:

- always include built-in local tools;
- include `skill.activate` when skills exist;
- include MCP tools only from enabled trusted servers;
- cap by count and description bytes;
- prefer read-only tools before high-risk tools.

Later, add a retrieval step over capability descriptions to pick the smallest
relevant catalog for the current turn.

## Work Kernel Recording

Every capability lifecycle event should map to existing kernel records:

- discovery diagnostics: blackboard entry and Gateway status;
- activation: blackboard entry and optional artifact for large instruction text;
- invocation: run attempt, tool result event, audit row, usage row;
- long output: artifact;
- external connection failure: recovery metadata;
- capability list changes: runtime event.

No MCP, skill, or plugin path should create a second private status system.

## Security Model

Threats to handle explicitly:

- untrusted project skills injecting instructions;
- MCP server descriptions or prompt outputs manipulating policy;
- lookalike tools with trusted names;
- local MCP servers reading files outside the workspace;
- remote MCP servers receiving local paths, secrets, or resource contents;
- skill scripts bypassing tool approval;
- server-initiated sampling or elicitation asking for sensitive data;
- extension catalog bloat causing wrong tool selection.

Required controls:

- project skills and project MCP config gated by workspace trust;
- stable namespaced ids such as `mcp.github.search_issues`, not ambiguous raw
  names;
- secrets redacted in all status and audit surfaces;
- all skill scripts run through normal shell permission checks;
- MCP sampling disabled by default and always user-approved;
- MCP elicitation surfaced only through TUI/Gateway approval UX;
- remote MCP server allowlist and auth posture before enabling Streamable HTTP;
- deny rules override all extension-level allow hints.

## Implementation Plan

### Phase 1: Registry Without Execution

Files:

- `src/extensions/types.ts`
- `src/extensions/registry.ts`
- `src/extensions/builtin-tools.ts`
- `src/extensions/skills.ts`
- `src/extensions/capability-plane.ts`

Work:

- define descriptors and provider interfaces;
- project built-in local tools, slash commands, and agent specs into registry;
- add Gateway `GET /v1/capabilities`;
- add `/capabilities` TUI command;
- persist no new tables yet, derive from runtime plus diagnostics;
- add local evals for descriptor stability and permission projection.

### Phase 2: Skills

Work:

- add `SkillProvider` scanning user and trusted project roots;
- parse `SKILL.md` frontmatter leniently;
- add `skill.activate` tool and `/skills` `/skill`;
- write activations to blackboard;
- protect active skill content from compaction;
- add settings and diagnostics.

This phase gives immediate product differentiation without external server
lifecycle risk.

### Phase 3: MCP Client, stdio First

Work:

- add `@modelcontextprotocol/sdk`;
- add `McpClientProvider`;
- connect configured stdio servers;
- list tools into the registry;
- invoke MCP tools through CapabilityBroker;
- normalize MCP results and errors into `ToolResult`;
- route every call through approval, audit, usage, and output persistence.

Keep resources/prompts visible but not automatically injected until tool calls
are reliable.

### Phase 4: MCP Resources And Prompts

Work:

- expose `mcp.resource.read` and `mcp.prompt.get` through the broker;
- let MCP prompts appear as user-selectable slash-style prompt capabilities;
- store read resources as artifacts when large;
- add subscriptions/list-changed support only after static list/read works.

### Phase 5: Swarm As MCP Server

Work:

- add Gateway `/mcp` Streamable HTTP endpoint;
- expose selected read-only resources and safe tools;
- keep write/session mutation tools behind explicit opt-in and approval;
- add localhost binding and auth guidance before remote exposure.

### Phase 6: Plugins And Distribution

Work:

- define project/user plugin manifest;
- let plugins register skills, MCP servers, slash commands, and agent specs;
- add install/update/disable commands;
- add signature or checksum metadata for trusted plugin bundles.

## First Implementation Slice

The safest first coding iteration should be:

1. Add the extension type and registry modules.
2. Register built-in local tools, slash commands, and agent specs as
   descriptors.
3. Add `GET /v1/capabilities`.
4. Add a TUI `/capabilities` command.
5. Add evals for descriptor count, namespacing, and visibility.

This produces a visible service surface with no new execution risk. After that,
skills can be added as the first external-looking capability because they are
filesystem-based and can reuse existing read/approval boundaries.

## Success Criteria

- One catalog lists built-in tools, skills, MCP tools/resources/prompts, slash
  commands, agent specs, and plugins.
- All model-invokable capabilities pass through the same permission and approval
  path.
- TUI and Gateway show the same capability state and diagnostics.
- Capability invocation produces ToolResult-compatible output and Work Kernel
  records.
- Project-provided skills or MCP config cannot silently affect an untrusted
  workspace.
- Users can disable any capability or provider without editing code.
- Swarm can consume external MCP servers and optionally expose itself as a local
  MCP server.
