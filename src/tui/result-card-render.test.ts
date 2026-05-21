import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render } from "ink";
import type { ResultCard } from "../runtime/result-card.js";
import { ResultCard as ResultCardPanel } from "./components/ResultCard.js";

test("ResultCard renders sectioned outcome hierarchy with cache and checkpoint detail", async () => {
  const plain = stripAnsi(await renderElement(React.createElement(ResultCardPanel, {
    card: {
      sessionId: "session-result-card-123456",
      status: "failed",
      route: "work",
      summary: "Verification failed after TUI polish.",
      changedFiles: ["src/tui/components/ResultCard.tsx", "src/tui/components/ApprovalOverlay.tsx", "src/tui/theme.ts", "src/tui/conversation-layout.ts"],
      checks: [
        { command: "npm run check failed", status: "failed" },
        { command: "node --import tsx --test src/tui/result-card-render.test.tsx", status: "passed" }
      ],
      review: { status: "warning", summary: "Review found a narrow viewport risk." },
      risks: [{ level: "high", message: "One verification check failed." }],
      artifacts: [],
      next: ["rerun focused tests", "inspect the failed check"],
      checkpoint: {
        id: "cp-1",
        name: "Before TUI polish",
        mode: "snapshot",
        revertAvailable: true
      },
      cache: {
        status: "cache_hit",
        cacheMode: "prefix-structured",
        hitRate: 0.64,
        writeRate: 0.12,
        changed: ["requestPrefixHash4096"]
      }
    } satisfies ResultCard
  })));

  assert.match(plain, /SUMMARY Verification failed after TUI polish\./);
  assert.match(plain, /CHANGED src\/tui\/components\/ResultCard\.tsx/);
  assert.match(plain, /CHECKS npm run check failed \[ERR\]/);
  assert.match(plain, /REVIEW \[WARN\] Review found a narrow viewport risk\./);
  assert.match(plain, /RISKS high: One verification check failed\./);
  assert.match(plain, /NEXT rerun focused tests/);
  assert.match(plain, /CHECKPOINT Before TUI polish snapshot rollback \/revert last/);
  assert.match(plain, /CACHE cache:cache_hit hit 64%, write 12%/);
});

function renderElement(element: React.ReactElement): Promise<string> {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  const app = render(element, {
    stdout: stream as unknown as NodeJS.WriteStream,
    stderr: stream as unknown as NodeJS.WriteStream,
    patchConsole: false
  });
  return new Promise((resolve) => {
    setTimeout(() => {
      app.unmount();
      resolve(output);
    }, 20);
  });
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}
