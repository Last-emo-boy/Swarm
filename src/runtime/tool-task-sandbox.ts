import { normalizeToolAction } from "../tools/local-tools.js";
import type { ToolAction } from "../tools/types.js";
import { isReadOnlySandboxAction, type SandboxWritePolicy } from "./sandbox-policy.js";
import { declaredToolTaskFileScope, declaredToolTaskWritePolicy } from "./tool-task-scope.js";

// Re-export the dependency-free scope/policy helpers so existing importers keep
// working; the definitions live in tool-task-scope.js to stay off the eager path.
export { declaredToolTaskFileScope, declaredToolTaskWritePolicy } from "./tool-task-scope.js";

export function sandboxedToolTaskInputs(inputs: Record<string, unknown>, capability: string): Record<string, unknown> {
  let action: ToolAction;
  try {
    action = normalizeToolAction(inputs, capability);
  } catch {
    return inputs;
  }

  const existingFileScope = declaredToolTaskFileScope(inputs);
  const existingWritePolicy = declaredToolTaskWritePolicy(inputs) ?? (existingFileScope?.length ? "scoped_write" : undefined);
  const writePolicy = existingWritePolicy ?? inferredToolTaskWritePolicy(action);
  const fileScope = existingFileScope ?? (writePolicy === "scoped_write" ? toolTaskTargetPaths(action) : undefined);
  if (!writePolicy && !fileScope?.length) {
    return inputs;
  }
  return {
    ...inputs,
    ...(writePolicy ? { write_policy: writePolicy } : {}),
    ...(fileScope?.length ? { file_scope: fileScope } : {})
  };
}

export function taskContractForToolAction(
  action: ToolAction,
  options: {
    writePolicy?: SandboxWritePolicy;
    fileScope?: string[];
  } = {}
): {
  write_policy?: SandboxWritePolicy;
  file_scope?: string[];
} {
  const explicitScope = options.fileScope?.map((item) => item.trim()).filter(Boolean);
  const inferredPolicy = inferredToolTaskWritePolicy(action);
  const inferredScope = inferredPolicy === "scoped_write" ? toolTaskTargetPaths(action) : undefined;
  if (options.writePolicy === "read_only") {
    return { write_policy: "read_only" };
  }
  if (options.writePolicy === "scoped_write") {
    if (inferredPolicy === "read_only") {
      return { write_policy: "read_only" };
    }
    return stripEmptyTaskContract({
      write_policy: "scoped_write",
      file_scope: explicitScope?.length ? explicitScope : inferredScope
    });
  }
  if (options.writePolicy === "workspace_write") {
    if (inferredPolicy === "read_only") {
      return { write_policy: "read_only" };
    }
    if (inferredPolicy === "scoped_write") {
      return stripEmptyTaskContract({
        write_policy: "scoped_write",
        file_scope: explicitScope?.length ? explicitScope : inferredScope
      });
    }
    return stripEmptyTaskContract({
      write_policy: "workspace_write",
      file_scope: explicitScope
    });
  }
  if (explicitScope?.length) {
    return stripEmptyTaskContract({
      write_policy: inferredPolicy === "read_only" ? "read_only" : "scoped_write",
      file_scope: inferredPolicy === "read_only" ? undefined : explicitScope
    });
  }
  return stripEmptyTaskContract({
    write_policy: inferredPolicy,
    file_scope: inferredScope
  });
}

function inferredToolTaskWritePolicy(action: ToolAction): SandboxWritePolicy | undefined {
  if (isReadOnlySandboxAction(action)) {
    return "read_only";
  }
  return toolTaskTargetPaths(action).length ? "scoped_write" : undefined;
}

function toolTaskTargetPaths(action: ToolAction): string[] {
  switch (action.type) {
    case "file.write":
    case "file.edit":
    case "file.mkdir":
    case "file.delete":
    case "file.patch":
    case "json.edit":
      return [action.path];
    case "file.move":
      return [action.source, action.destination];
    case "file.copy":
      return [action.destination];
    case "notebook.edit":
      return [action.notebookPath];
    default:
      return [];
  }
}

function stripEmptyTaskContract<T extends { write_policy?: SandboxWritePolicy; file_scope?: string[] }>(value: T): T {
  if (Array.isArray(value.file_scope) && value.file_scope.length === 0) {
    delete value.file_scope;
  }
  if (!value.write_policy) {
    delete value.write_policy;
  }
  return value;
}
