import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createCheckpoint,
  latestCheckpoint,
  listCheckpoints,
  revertCheckpoint
} from "./checkpoints.js";

test("checkpoints create, list, and revert snapshot workspace state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-"));
  try {
    const filePath = join(workspace, "src", "example.txt");
    const extraPath = join(workspace, "extra.txt");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(filePath, "before\n", "utf8");

    const checkpoint = await createCheckpoint(workspace, "before edit", "unit test");
    assert.equal(checkpoint.name, "before edit");
    assert.equal(checkpoint.mode, "snapshot");
    assert.equal(checkpoint.status, "available");
    assert.equal(checkpoint.revertAvailable, true);

    await writeFile(filePath, "after\n", "utf8");
    await writeFile(extraPath, "remove me\n", "utf8");

    assert.deepEqual((await listCheckpoints(workspace)).map((item) => item.id), [checkpoint.id]);
    assert.equal((await latestCheckpoint(workspace))?.id, checkpoint.id);

    const reverted = await revertCheckpoint(workspace);
    assert.equal(reverted?.id, checkpoint.id);
    assert.equal(reverted?.status, "reverted");
    assert.equal(await readFile(filePath, "utf8"), "before\n");
    await assert.rejects(() => readFile(extraPath, "utf8"), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoints CLI lists, creates, and reverts workspace snapshots as JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-cli-"));
  try {
    const filePath = join(workspace, "src", "example.txt");
    const extraPath = join(workspace, "extra.txt");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(filePath, "before\n", "utf8");

    const emptyList = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "list",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.equal(emptyList.code, 0, emptyList.stderr);
    assert.equal(emptyList.stderr, "");
    assert.deepEqual(JSON.parse(emptyList.stdout), {
      workspace,
      checkpoints: []
    });

    const createResult = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "create",
      "before edit",
      "--reason",
      "cli smoke",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.equal(createResult.code, 0, createResult.stderr);
    assert.equal(createResult.stderr, "");
    const created = JSON.parse(createResult.stdout) as {
      workspace: string;
      checkpoint: {
        id: string;
        name: string;
        mode: string;
        status: string;
        revertAvailable: boolean;
      };
    };
    assert.equal(created.workspace, workspace);
    assert.match(created.checkpoint.id, /^cp_/);
    assert.equal(created.checkpoint.name, "before edit");
    assert.equal(created.checkpoint.mode, "snapshot");
    assert.equal(created.checkpoint.status, "available");
    assert.equal(created.checkpoint.revertAvailable, true);

    await writeFile(filePath, "after\n", "utf8");
    await writeFile(extraPath, "remove me\n", "utf8");

    const revertResult = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "revert",
      "last",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.equal(revertResult.code, 0, revertResult.stderr);
    assert.equal(revertResult.stderr, "");
    const reverted = JSON.parse(revertResult.stdout) as typeof created;
    assert.equal(reverted.workspace, workspace);
    assert.equal(reverted.checkpoint.id, created.checkpoint.id);
    assert.equal(reverted.checkpoint.status, "reverted");
    assert.equal(reverted.checkpoint.revertAvailable, true);
    assert.equal(await readFile(filePath, "utf8"), "before\n");
    await assert.rejects(() => readFile(extraPath, "utf8"), /ENOENT/);

    const finalList = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "list",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.equal(finalList.code, 0, finalList.stderr);
    assert.equal(finalList.stderr, "");
    const listed = JSON.parse(finalList.stdout) as {
      workspace: string;
      checkpoints: Array<{
        id: string;
        name: string;
        mode: string;
        status: string;
        revertAvailable: boolean;
      }>;
    };
    assert.equal(listed.workspace, workspace);
    assert.equal(listed.checkpoints[0]?.id, created.checkpoint.id);
    assert.equal(listed.checkpoints[0]?.status, "reverted");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoints CLI reports empty and missing-manifest revert states", async () => {
  const emptyWorkspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-cli-empty-"));
  const missingWorkspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-cli-missing-"));
  try {
    const emptyRevert = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "revert",
      "last",
      "--workspace",
      emptyWorkspace,
      "--json"
    ]);
    assert.notEqual(emptyRevert.code, 0);
    assert.equal(emptyRevert.stdout, "");
    assert.match(emptyRevert.stderr, /No checkpoint found to revert\./);

    const filePath = join(missingWorkspace, "src", "example.txt");
    await mkdir(join(missingWorkspace, "src"), { recursive: true });
    await writeFile(filePath, "before\n", "utf8");

    const createResult = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "create",
      "missing manifest",
      "--workspace",
      missingWorkspace,
      "--json"
    ]);
    assert.equal(createResult.code, 0, createResult.stderr);
    assert.equal(createResult.stderr, "");
    const created = JSON.parse(createResult.stdout) as {
      workspace: string;
      checkpoint: {
        id: string;
        mode: string;
        status: string;
        revertAvailable: boolean;
      };
    };
    assert.equal(created.workspace, missingWorkspace);
    assert.match(created.checkpoint.id, /^cp_/);
    assert.equal(created.checkpoint.mode, "snapshot");
    assert.equal(created.checkpoint.status, "available");
    assert.equal(created.checkpoint.revertAvailable, true);

    await rm(join(missingWorkspace, ".swarm", "checkpoints", created.checkpoint.id, "manifest.json"), { force: true });

    const missingRevert = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "revert",
      "last",
      "--workspace",
      missingWorkspace,
      "--json"
    ]);
    assert.equal(missingRevert.code, 0, missingRevert.stderr);
    assert.equal(missingRevert.stderr, "");
    const reverted = JSON.parse(missingRevert.stdout) as typeof created;
    assert.equal(reverted.workspace, missingWorkspace);
    assert.equal(reverted.checkpoint.id, created.checkpoint.id);
    assert.equal(reverted.checkpoint.status, "missing");
    assert.equal(reverted.checkpoint.revertAvailable, false);

    const missingList = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "list",
      "--workspace",
      missingWorkspace,
      "--json"
    ]);
    assert.equal(missingList.code, 0, missingList.stderr);
    assert.equal(missingList.stderr, "");
    const listed = JSON.parse(missingList.stdout) as {
      workspace: string;
      checkpoints: Array<{
        id: string;
        status: string;
        revertAvailable: boolean;
      }>;
    };
    assert.equal(listed.workspace, missingWorkspace);
    assert.equal(listed.checkpoints[0]?.id, created.checkpoint.id);
    assert.equal(listed.checkpoints[0]?.status, "missing");
    assert.equal(listed.checkpoints[0]?.revertAvailable, false);

    const textList = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "list",
      "--workspace",
      missingWorkspace
    ]);
    assert.equal(textList.code, 0, textList.stderr);
    assert.equal(textList.stderr, "");
    assert.match(textList.stdout, /\[missing\/snapshot\]/);
    assert.match(textList.stdout, /revert=no/);
  } finally {
    await rm(emptyWorkspace, { recursive: true, force: true });
    await rm(missingWorkspace, { recursive: true, force: true });
  }
});

test("checkpoints CLI reports invalid commands and usage without provider setup", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-cli-invalid-"));
  try {
    const unknownCommand = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "inspect",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.notEqual(unknownCommand.code, 0);
    assert.equal(unknownCommand.stdout, "");
    assert.match(unknownCommand.stderr, /Unknown checkpoints command: inspect/);
    assertCleanCheckpointCliFailure(unknownCommand);

    const missingCreateName = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "create",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.notEqual(missingCreateName.code, 0);
    assert.equal(missingCreateName.stdout, "");
    assert.match(missingCreateName.stderr, /Usage: swarm checkpoints create <name>/);
    assertCleanCheckpointCliFailure(missingCreateName);

    const invalidLimit = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "list",
      "--limit",
      "zero",
      "--workspace",
      workspace,
      "--json"
    ]);
    assert.notEqual(invalidLimit.code, 0);
    assert.equal(invalidLimit.stdout, "");
    assert.match(invalidLimit.stderr, /Invalid --limit: zero\. Expected a positive integer\./);
    assertCleanCheckpointCliFailure(invalidLimit);

    const help = await runCli([
      "--import",
      "tsx",
      "src/index.ts",
      "checkpoints",
      "--help"
    ]);
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.match(help.stdout, /Usage: swarm checkpoints \[list\] \[--workspace <path>\] \[--json\]/);
    assert.match(help.stdout, /swarm checkpoints create <name> \[--reason <text>\] \[--workspace <path>\] \[--json\]/);
    assert.match(help.stdout, /swarm checkpoints revert \[checkpoint_id\|last\] \[--workspace <path>\] \[--json\]/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoint revert marks missing snapshots and returns undefined when empty", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "swarm-checkpoint-missing-"));
  try {
    assert.equal(await revertCheckpoint(workspace), undefined);

    const checkpoint = await createCheckpoint(workspace, "missing manifest");
    await rm(join(workspace, ".swarm", "checkpoints", checkpoint.id, "manifest.json"), { force: true });

    const missing = await revertCheckpoint(workspace, checkpoint.id);
    assert.equal(missing?.status, "missing");
    assert.equal(missing?.revertAvailable, false);
    assert.equal((await listCheckpoints(workspace))[0]?.status, "missing");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function assertCleanCheckpointCliFailure(result: { stdout: string; stderr: string }): void {
  assert.doesNotMatch(result.stderr, /No usable model provider/);
  assert.doesNotMatch(result.stderr, /node:internal/);
  assert.doesNotMatch(result.stderr, /src\/index\.ts:/);
  assert.doesNotMatch(result.stderr, /src\\index\.ts:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.doesNotMatch(result.stderr, /Error:/);
  assert.doesNotMatch(result.stdout, /"checkpoint"/);
  assert.doesNotMatch(result.stdout, /"checkpoints"/);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
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
