import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { Ran } from "../update.js";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, capLog, installService, restartService, serviceFiles, serviceStatus, stableNode, uninstallService, type ServiceHost } from "./service.js";

const root = mkdtempSync(join(tmpdir(), "swarm-service-"));
after(() => rmSync(root, { recursive: true, force: true }));

const SECRETS = { OPENAI_API_KEY: "sk-test-not-a-real-key", GH_TOKEN: "ghp_testtoken0000", ANTHROPIC_API_KEY: "sk-ant-test-key" };

type Answer = Partial<Ran> | (() => Partial<Ran>);

/**
 * A device whose home is a temporary folder and whose service manager is a script: `answers` says what each command
 * prints, keyed by its program and first argument (after --user), and every command is recorded.
 */
function device(platform: "darwin" | "linux", answers: Record<string, Answer> = {}): ServiceHost & { ran: string[] } {
  const home = mkdtempSync(join(root, `${platform}-`));
  const entry = join(home, "Swarm & Co", "dist", "index.js");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "");
  const ran: string[] = [];
  return {
    platform, home, uid: 501, swarmHome: join(home, ".swarm"), node: "/opt/node/bin/node", entry, ran,
    env: { ...SECRETS, PATH: "/opt/node/bin:/usr/bin:/bin", SWARM_HOME: join(home, ".swarm"), HOME: home, TERM: "xterm" },
    run: async (command, args) => {
      ran.push([command, ...args].join(" "));
      const answer = answers[`${command} ${args[0] === "--user" ? args[1] : args[0]}`] ?? {};
      return { code: 0, stdout: "", stderr: "", ...(typeof answer === "function" ? answer() : answer) };
    }
  };
}

const NOT_LOADED = { code: 113, stderr: `Could not find service "${LAUNCHD_LABEL}" in domain for user gui: 501` };

/** launchd as far as the service goes: bootout unloads the agent, bootstrap loads it, print shows `loaded` while loaded. */
function launchd(loaded: string | undefined): Record<string, Answer> {
  let printed = loaded;
  return {
    "launchctl print": () => printed === undefined ? NOT_LOADED : { stdout: printed },
    "launchctl bootout": () => { printed = undefined; return {}; },
    "launchctl bootstrap": () => { printed = loaded ?? "\tstate = running\n"; return {}; }
  };
}
const running = (pid: number): string => `gui/501/${LAUNCHD_LABEL} = {\n\tstate = running\n\tpid = ${pid}\n\tlast exit code = (never exited)\n\t\tpid = 1\n}\n`;

/** Puts the service's file in place without loading anything. */
function placeFile(host: ServiceHost): void {
  const { file, text } = serviceFiles(host);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("the LaunchAgent runs this Node and Swarm with node run, restarts after a failure and logs to node.log, holding no secrets", () => {
  const host = device("darwin");
  const files = serviceFiles(host, { withHost: true });
  assert.equal(files.file, join(host.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
  assert.deepEqual(files.program, [host.node, `--env-file-if-exists=${join(host.swarmHome, "node.env")}`, host.entry, "node", "run", "--log", join(host.swarmHome, "logs", "node.log")]);
  assert.match(files.text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(files.text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(files.text.includes(`<key>StandardOutPath</key>\n  <string>${files.logFile}</string>`));
  assert.ok(files.text.includes(`<key>StandardErrorPath</key>\n  <string>${files.logFile}</string>`));
  assert.match(files.text, /<string>[^<]*Swarm &amp; Co\/dist\/index.js<\/string>/, "paths are escaped for XML");
  assert.match(files.text, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(files.text, /<key>SWARM_HOME<\/key>/);
  for (const secret of Object.values(SECRETS)) assert.equal(files.text.includes(secret), false, `${secret} stays out of the plist`);
  assert.equal(files.text.includes("TERM"), false, "only PATH and Swarm's own locations are carried over");
  assert.ok(serviceFiles(host, { withHost: false }).program.includes("--no-host"));
});

test("the systemd user unit quotes its command, restarts on failure, appends to node.log and holds no secrets", () => {
  const host = { ...device("linux"), env: { ...SECRETS, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: "" } };
  host.entry = join(host.home, "100% $wift", "dist", "index.js");
  const files = serviceFiles(host, { withHost: false });
  assert.equal(files.file, join(host.home, ".config", "systemd", "user", SYSTEMD_UNIT));
  const execStart = /^ExecStart=(.*)$/m.exec(files.text)?.[1];
  assert.equal(execStart, [host.node, `--env-file-if-exists=${files.envFile}`, host.entry.replace("%", "%%").replace("$", () => "$$"), "node", "run", "--no-host", "--log", files.logFile]
    .map((arg) => `"${arg}"`).join(" "));
  assert.match(files.text, /^Restart=on-failure$/m);
  assert.ok(files.text.includes(`\nStandardOutput=append:${files.logFile}\n`));
  assert.ok(files.text.includes(`\nStandardError=append:${files.logFile}\n`));
  assert.match(files.text, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
  assert.match(files.text, /^WantedBy=default.target$/m);
  for (const secret of Object.values(SECRETS)) assert.equal(files.text.includes(secret), false, `${secret} stays out of the unit`);
  assert.throws(() => serviceFiles({ ...host, platform: "win32" }), /launchd \(macOS\) and systemd \(Linux\), not win32/);
});

test("install on macOS writes the plist, a private env file and the log folder, then reloads the agent", async () => {
  const host = device("darwin", launchd(undefined));
  const { files, envCreated, notes } = await installService(host, { withHost: true });
  assert.equal(readFileSync(files.file, "utf8"), files.text);
  assert.ok(envCreated);
  assert.equal(statSync(files.envFile).mode & 0o777, 0o600);
  assert.match(readFileSync(files.envFile, "utf8"), /^# Environment for this device's Swarm node service/);
  assert.ok(existsSync(join(host.swarmHome, "logs")));
  assert.deepEqual(notes, []);
  const target = `gui/501/${LAUNCHD_LABEL}`;
  assert.deepEqual(host.ran, [`launchctl bootout ${target}`, `launchctl print ${target}`, `launchctl enable ${target}`, `launchctl bootstrap gui/501 ${files.file}`]);

  writeFileSync(files.envFile, "OPENAI_API_KEY=sk-mine\n", { mode: 0o644 });
  const again = await installService(host, { withHost: true });
  assert.equal(again.envCreated, false);
  assert.equal(readFileSync(files.envFile, "utf8"), "OPENAI_API_KEY=sk-mine\n", "an existing env file is kept");
  assert.equal(statSync(files.envFile).mode & 0o777, 0o600, "and made private");
  assert.equal(readFileSync(files.file, "utf8").includes("sk-mine"), false);
});

test("install on Linux enables and restarts the user unit, and says when lingering is off", async () => {
  const host = device("linux", { "loginctl show-user": { stdout: "Linger=no\n" } });
  const { files, notes } = await installService(host, { withHost: true });
  assert.ok(existsSync(files.file));
  assert.deepEqual(host.ran, [
    "systemctl --user daemon-reload", `systemctl --user enable ${SYSTEMD_UNIT}`, `systemctl --user restart ${SYSTEMD_UNIT}`, "loginctl show-user 501 --property=Linger"
  ]);
  assert.match(notes.join(" "), /loginctl enable-linger/);

  const noBus = device("linux", { "systemctl daemon-reload": { code: 1, stderr: "Failed to connect to bus: No medium found" } });
  await assert.rejects(installService(noBus, { withHost: true }), /systemctl --user does not answer \(Failed to connect to bus[^)]*\)[\s\S]*enable-linger/);
});

test("install refuses while another superagent host holds the lock, but not the service's own node", async () => {
  const host = device("darwin", launchd(running(4242)));
  await assert.rejects(installService(host, { withHost: true, holder: { pid: 777, startedAt: "2026-11-06T09:00:00.000Z" } }),
    /Another superagent host already runs on this device \(pid 777, since 2026-11-06T09:00:00.000Z\)[\s\S]*stop that one first/);
  assert.equal(existsSync(serviceFiles(host).file), false, "nothing is written");
  await installService(host, { withHost: true, holder: { pid: 4242, startedAt: "2026-11-06T09:00:00.000Z" } });
  assert.ok(existsSync(serviceFiles(host).file), "the service's own node is restarted by installing again");

  const unbuilt = device("darwin", launchd(undefined));
  rmSync(unbuilt.entry);
  await assert.rejects(installService(unbuilt, { withHost: true }), /does not exist: build this Swarm first/);
});

test("status reads launchctl and systemctl: loaded, pid and how the node last ended", async () => {
  const mac = device("darwin", { "launchctl print": { stdout: `gui/501/${LAUNCHD_LABEL} = {\n\tstate = not running\n\tlast exit code = 1\n\tspawn type = daemon\n}\n` } });
  placeFile(mac);
  assert.deepEqual(await serviceStatus(mac), { manager: "launchd", file: serviceFiles(mac).file, installed: true, loaded: true, lastExit: "exit code 1",
    envFile: join(mac.swarmHome, "node.env"), logFile: join(mac.swarmHome, "logs", "node.log") });
  assert.deepEqual(await serviceStatus(device("darwin", { "launchctl print": NOT_LOADED })).then(({ installed, loaded }) => ({ installed, loaded })), { installed: false, loaded: false });

  const linux = device("linux", { "systemctl show": { stdout: "LoadState=loaded\nActiveState=active\nMainPID=3100\nExecMainCode=0\nExecMainStatus=0\nExecMainExitTimestamp=\n" } });
  placeFile(linux);
  const status = await serviceStatus(linux);
  assert.deepEqual([status.loaded, status.pid, status.lastExit], [true, 3100, "never exited"]);
  const crashed = device("linux", { "systemctl show": { stdout: "LoadState=loaded\nMainPID=0\nExecMainCode=2\nExecMainStatus=9\nExecMainExitTimestamp=Fri 2026-11-06 09:00:00 UTC\n" } });
  assert.equal((await serviceStatus(crashed)).lastExit, "signal 9");
  const absent = device("linux", { "systemctl show": { stdout: "LoadState=not-found\nMainPID=0\nExecMainExitTimestamp=\n" } });
  assert.deepEqual([(await serviceStatus(absent)).loaded, (await serviceStatus(absent)).installed], [false, false]);
});

test("uninstall stops the service and removes its file but keeps the env file; restart only touches a loaded service", async () => {
  const host = device("linux");
  const { files } = await installService(host, { withHost: true });
  host.ran.length = 0;
  assert.equal(await uninstallService(host), true);
  assert.deepEqual(host.ran, [`systemctl --user disable --now ${SYSTEMD_UNIT}`, "systemctl --user daemon-reload"]);
  assert.equal(existsSync(files.file), false);
  assert.ok(existsSync(files.envFile));
  assert.equal(await uninstallService(host), false);

  const mac = device("darwin", launchd(running(12)));
  assert.equal(await restartService(mac), undefined, "not installed: nothing to restart");
  placeFile(mac);
  await mac.run("launchctl", ["bootstrap"], mac.home);
  mac.ran.length = 0;
  assert.match(await restartService(mac) ?? "", /Restarted the node service/);
  assert.ok(mac.ran.includes(`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`));
});

test("the node's log moves to node.log.1 once it outgrows its cap", () => {
  const log = join(root, "node.log");
  writeFileSync(log, "x".repeat(100));
  assert.equal(capLog(log, 200), false);
  writeFileSync(log, "y".repeat(300));
  assert.equal(capLog(log, 200), true);
  assert.equal(readFileSync(`${log}.1`, "utf8"), "y".repeat(300));
  assert.equal(statSync(log).size, 0);
  assert.equal(capLog(join(root, "missing.log"), 200), false);
});

test("the service runs a version manager's stable link to this Node when PATH has one", () => {
  const link = join(root, "node-24", "bin");
  mkdirSync(link, { recursive: true });
  symlinkSync(process.execPath, join(link, "node"));
  const other = join(root, "other", "bin");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "node"), "#!/bin/sh\n");
  assert.equal(stableNode(process.execPath, ["relative/bin", other, join(root, "nowhere"), link].join(":")), join(link, "node"));
  assert.equal(stableNode(process.execPath, other), process.execPath, "a different node on PATH is not this one");
});
