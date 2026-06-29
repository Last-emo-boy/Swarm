// Pure tool-task scope/policy helpers, kept dependency-free (only a type import)
// so headless artifact builders can read declared scope/policy without eagerly
// pulling in local-tools and the whole LSP subgraph through tool-task-sandbox.
import type { SandboxWritePolicy } from "./sandbox-policy.js";

export function declaredToolTaskWritePolicy(inputs: Record<string, unknown>): SandboxWritePolicy | undefined {
  if (inputs.read_only === true || inputs.readOnly === true) {
    return "read_only";
  }
  const value = [inputs.write_policy, inputs.writePolicy, inputs.sandbox_mode, inputs.sandboxMode, inputs.sandbox]
    .find((item) => typeof item === "string" && item.trim().length > 0);
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "workspace_write" || value === "workspace-write") {
    return "workspace_write";
  }
  if (value === "scoped_write" || value === "scoped-write") {
    return "scoped_write";
  }
  if (value === "read_only" || value === "read-only" || value === "readonly") {
    return "read_only";
  }
  return undefined;
}

export function declaredToolTaskFileScope(inputs: Record<string, unknown>): string[] | undefined {
  const value = inputs.file_scope ?? inputs.fileScope;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length ? normalized : undefined;
}
