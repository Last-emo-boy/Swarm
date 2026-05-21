import { strict as assert } from "node:assert";
import test from "node:test";
import type { ToolAction } from "../tools/types.js";
import { sandboxedToolTaskInputs, taskContractForToolAction } from "./tool-task-sandbox.js";

test("sandboxedToolTaskInputs infers write policy and file scope from tool inputs", () => {
  const cases: Array<{
    name: string;
    inputs: Record<string, unknown>;
    capability: string;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "read action becomes read-only",
      inputs: { action: "Read", path: "src/runtime/tool-task-sandbox.ts" },
      capability: "tool.file.read",
      expected: { action: "Read", path: "src/runtime/tool-task-sandbox.ts", write_policy: "read_only" }
    },
    {
      name: "write action becomes scoped-write with the target path",
      inputs: { action: "Write", path: "src/runtime/generated.ts", content: "export {};\n" },
      capability: "tool.file.write",
      expected: {
        action: "Write",
        path: "src/runtime/generated.ts",
        content: "export {};\n",
        write_policy: "scoped_write",
        file_scope: ["src/runtime/generated.ts"]
      }
    },
    {
      name: "explicit file scope implies scoped-write and normalizes glob targets",
      inputs: {
        action: "Bash",
        command: "npm test",
        file_scope: [" src/**/*.test.ts ", "", "docs/*.md"]
      },
      capability: "tool.shell.exec",
      expected: {
        action: "Bash",
        command: "npm test",
        write_policy: "scoped_write",
        file_scope: ["src/**/*.test.ts", "docs/*.md"]
      }
    },
    {
      name: "explicit read-only flag wins over write target inference",
      inputs: { action: "Write", path: "src/runtime/generated.ts", content: "export {};\n", read_only: true },
      capability: "tool.file.write",
      expected: {
        action: "Write",
        path: "src/runtime/generated.ts",
        content: "export {};\n",
        read_only: true,
        write_policy: "read_only"
      }
    },
    {
      name: "explicit workspace-write policy avoids inferred file scope",
      inputs: { action: "Write", path: "src/runtime/generated.ts", content: "export {};\n", writePolicy: "workspace_write" },
      capability: "tool.file.write",
      expected: {
        action: "Write",
        path: "src/runtime/generated.ts",
        content: "export {};\n",
        writePolicy: "workspace_write",
        write_policy: "workspace_write"
      }
    }
  ];

  for (const item of cases) {
    assert.deepEqual(sandboxedToolTaskInputs(item.inputs, item.capability), item.expected, item.name);
  }
});

test("taskContractForToolAction infers read-only, scoped-write, and explicit contracts", () => {
  const cases: Array<{
    name: string;
    action: ToolAction;
    options?: Parameters<typeof taskContractForToolAction>[1];
    expected: ReturnType<typeof taskContractForToolAction>;
  }> = [
    {
      name: "read action becomes read-only",
      action: { type: "file.read", path: "src/runtime/tool-task-sandbox.ts" },
      expected: { write_policy: "read_only", file_scope: undefined }
    },
    {
      name: "write action becomes scoped-write with the target path",
      action: { type: "file.write", path: "src/runtime/generated.ts", content: "export {};\n" },
      expected: { write_policy: "scoped_write", file_scope: ["src/runtime/generated.ts"] }
    },
    {
      name: "explicit file scope overrides inferred write target",
      action: { type: "file.write", path: "src/runtime/generated.ts", content: "export {};\n" },
      options: { fileScope: [" src/runtime/*.ts ", "docs/*.md", ""] },
      expected: { write_policy: "scoped_write", file_scope: ["src/runtime/*.ts", "docs/*.md"] }
    },
    {
      name: "explicit read-only policy wins over write target inference",
      action: { type: "file.write", path: "src/runtime/generated.ts", content: "export {};\n" },
      options: { writePolicy: "read_only" },
      expected: { write_policy: "read_only" }
    },
    {
      name: "explicit workspace-write policy stays workspace-wide for untargeted writes",
      action: { type: "shell.exec", command: "npm test" },
      options: { writePolicy: "workspace_write" },
      expected: { write_policy: "workspace_write", file_scope: undefined }
    },
    {
      name: "explicit workspace-write policy keeps targeted writes scoped to the target",
      action: { type: "file.write", path: "src/runtime/generated.ts", content: "export {};\n" },
      options: { writePolicy: "workspace_write" },
      expected: { write_policy: "scoped_write", file_scope: ["src/runtime/generated.ts"] }
    }
  ];

  for (const item of cases) {
    assert.deepEqual(taskContractForToolAction(item.action, item.options), item.expected, item.name);
  }
});

test("taskContractForToolAction scopes move source and destination while copy scopes only destination", () => {
  assert.deepEqual(
    taskContractForToolAction({
      type: "file.move",
      source: "src/runtime/source.ts",
      destination: "src/runtime/destination.ts"
    }),
    {
      write_policy: "scoped_write",
      file_scope: ["src/runtime/source.ts", "src/runtime/destination.ts"]
    }
  );

  assert.deepEqual(
    taskContractForToolAction({
      type: "file.copy",
      source: "src/runtime/template.ts",
      destination: "src/runtime/copied.ts"
    }),
    {
      write_policy: "scoped_write",
      file_scope: ["src/runtime/copied.ts"]
    }
  );
});
