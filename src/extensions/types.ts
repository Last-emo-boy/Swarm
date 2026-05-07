import type { RiskClass } from "../protocol/types.js";

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

export type CapabilityDiagnostic = {
  severity: "info" | "warn" | "error";
  message: string;
  code?: string;
  metadata?: Record<string, unknown>;
};

export type CapabilityDescriptor = {
  id: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  trust: CapabilityTrust;
  providerId: string;
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  riskClass: RiskClass;
  permissionName: string;
  modelVisible: boolean;
  userVisible: boolean;
  status?: "available" | "disabled" | "failed" | "pending";
  diagnostics?: CapabilityDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type CapabilityFilter = {
  kind?: CapabilityKind | string;
  source?: CapabilitySource | string;
  trust?: CapabilityTrust | string;
  providerId?: string;
  provider?: string;
  modelVisible?: boolean;
  userVisible?: boolean;
  includeDisabled?: boolean;
  query?: string;
};

export type CapabilityProviderSnapshot = {
  providerId: string;
  title: string;
  capabilities: number;
  diagnostics: CapabilityDiagnostic[];
  refreshedAt?: string;
};

export type CapabilityProvider = {
  readonly id: string;
  readonly title?: string;
  listCapabilities(): CapabilityDescriptor[] | Promise<CapabilityDescriptor[]>;
  refresh?(): void | Promise<void>;
  diagnostics?(): CapabilityDiagnostic[];
  dispose?(): void | Promise<void>;
};

