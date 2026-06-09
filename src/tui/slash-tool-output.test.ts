import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { prepareSlashToolOutput } from "./slash-tool-output.js";

test("prepareSlashToolOutput keeps short slash content display-compatible", async () => {
  const fixture = createFixture();
  try {
    const result = await prepareSlashToolOutput("slash-session-short", "slash.short", {
      action: "file.read",
      status: "success",
      summary: "Read file",
      content: "short content",
      data: { ignored: true }
    });

    assert.equal(result.detail, "short content");
    assert.equal(result.content, "short content");
    assert.equal(result.outputRef, undefined);
  } finally {
    fixture.close();
  }
});

test("prepareSlashToolOutput preserves existing outputRef without rewriting", async () => {
  const fixture = createFixture();
  try {
    const result = await prepareSlashToolOutput("slash-session-existing", "slash.existing", {
      action: "shell.exec",
      status: "success",
      summary: "Command completed",
      outputRef: "/existing/output",
      data: { kind: "external" }
    });

    assert.equal(result.detail, "Full output: /existing/output");
    assert.equal(result.content, "Full output: /existing/output");
    assert.equal(result.outputRef, "/existing/output");
  } finally {
    fixture.close();
  }
});

test("prepareSlashToolOutput persists long slash detail through shared materializer", async () => {
  const fixture = createFixture();
  try {
    const detail = "x".repeat(18_001);
    const result = await prepareSlashToolOutput("slash-session-long", "slash.long", {
      action: "shell.exec",
      status: "success",
      summary: "Command completed",
      content: detail
    }, { attempt: 9 });

    assert.ok(result.outputRef);
    assert.equal(basename(result.outputRef!), "slash.long.9.output");
    assert.equal(readFileSync(result.outputRef!, "utf8"), detail);
    assert.match(result.content ?? "", /Full output:/);
    assert.notEqual(result.content, detail);
    assert.equal(result.detail, detail);
  } finally {
    fixture.close();
  }
});

function createFixture(): { close(): void } {
  const root = mkdtempSync(join(tmpdir(), "swarm-slash-tool-output-"));
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = root;
  return {
    close: () => {
      if (previousHome === undefined) {
        delete process.env.SWARM_HOME;
      } else {
        process.env.SWARM_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}
