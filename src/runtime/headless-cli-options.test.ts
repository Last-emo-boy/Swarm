import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

test("swarm help leads with result-first review and Observatory positioning", async () => {
  const result = await runCli(["help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Swarm Local Agent Workspace CLI/);
  assert.match(result.stdout, /Work:/);
  assert.match(result.stdout, /Ask:/);
  assert.match(result.stdout, /Automate:/);
  assert.match(result.stdout, /Setup:/);
  assert.match(result.stdout, /checkpoint undo/i);
  assert.match(result.stdout, /Codebase Deep Review/);
  assert.match(result.stdout, /Fix A Failing Test/);
  assert.match(result.stdout, /Explain This Repo/);
  assert.match(result.stdout, /help --advanced/);
  assert.doesNotMatch(result.stdout, /Kernel|Gateway|Symphony|MCP|LSP|full_swarm|route|planner|worker|aggregator/);
});

test("swarm advanced help keeps operator surfaces behind explicit detail", async () => {
  const result = await runCli(["help", "--advanced"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Result-first scenarios/);
  assert.match(result.stdout, /swarm review \[focus\] \[run flags\]/);
  assert.match(result.stdout, /Codebase Deep Review/);
  assert.match(result.stdout, /Swarm Observatory/);
  assert.match(result.stdout, /Kernel|Gateway|Symphony|MCP|LSP/);
});

test("swarm review help is available without provider preflight", async () => {
  const result = await runCli(["review", "--help"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: swarm review \[focus\] \[run flags\]/);
  assert.match(result.stdout, /result-first Codebase Deep Review/);
  assert.match(result.stdout, /swarm review "auth and permissions" --read-only/);
});

test("swarm metrics demo prints local product validation summary", async () => {
  const result = await runCli(["metrics", "--demo"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Product Translation Metrics/);
  assert.match(result.stdout, /time_to_impressive_result/);
  assert.match(result.stdout, /privacy=local-only prompt_text_stored=false/);
});

test("swarm metrics demo supports json output", async () => {
  const result = await runCli(["metrics", "--demo", "--json"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed.schema_version, "swarm.product_metrics_summary.v1");
  assert.equal((parsed.privacy as Record<string, unknown>).local_only, true);
  assert.equal((parsed.privacy as Record<string, unknown>).prompt_text_stored, false);
});

const invalidRunOptionCases: Array<{
  name: string;
  args: string[];
  expected: RegExp[];
}> = [
  {
    name: "invalid sandbox value",
    args: ["run", "--sandbox", "network", "objective"],
    expected: [
      /Invalid --sandbox: network/,
      /Expected workspace-write or read-only/
    ]
  },
  {
    name: "missing sandbox value",
    args: ["run", "--sandbox", "objective"],
    expected: [/Usage: swarm run/, /--sandbox workspace-write\|read-only/]
  },
  {
    name: "conflicting read-only and workspace-write sandbox",
    args: ["run", "--read-only", "--sandbox", "workspace-write", "objective"],
    expected: [/Use either --read-only or --sandbox workspace-write, not both/]
  },
  {
    name: "invalid permission mode",
    args: ["run", "--permission-mode", "root", "objective"],
    expected: [
      /Invalid --permission-mode: root/,
      /Expected ask, auto-edit, full-auto, or yolo/
    ]
  },
  {
    name: "invalid approval mode",
    args: ["run", "--approval-mode", "prompt", "objective"],
    expected: [/Invalid --approval-mode: prompt/, /Expected fail or wait/]
  },
  {
    name: "invalid output format",
    args: ["run", "--output-format", "xml", "objective"],
    expected: [
      /Invalid --output-format: xml/,
      /Expected text, json, or stream-json/
    ]
  },
  {
    name: "unknown run option",
    args: ["run", "--sandbox-experimental", "objective"],
    expected: [
      /Unknown swarm run option: --sandbox-experimental/,
      /Use swarm run --help for supported options/
    ]
  }
];

for (const item of invalidRunOptionCases) {
  test(`swarm run returns stable product error for ${item.name}`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "swarm-headless-cli-options-"));
    try {
      const result = await runCli([...item.args, "--workspace", workspace]);

      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stdout, "");
      for (const expected of item.expected) {
        assert.match(result.stderr, expected);
      }
      assertNoInternalErrorLeak(result.stderr);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

function assertNoInternalErrorLeak(stderr: string): void {
  assert.doesNotMatch(stderr, /No usable model provider/);
  assert.doesNotMatch(stderr, /node:internal/);
  assert.doesNotMatch(stderr, /src\/index\.ts:/);
  assert.doesNotMatch(stderr, /src\\index\.ts:/);
  assert.doesNotMatch(stderr, /\n\s+at /);
  assert.doesNotMatch(stderr, /Error:/);
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: resolve(process.cwd()),
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}
