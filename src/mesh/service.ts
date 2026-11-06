/**
 * `swarm node install`: this device's node as a service the system keeps running, a launchd LaunchAgent on macOS or a
 * systemd user unit on Linux, so peers reach it without anyone running `swarm node run` by hand. The service runs this
 * Node binary and this install's dist/index.js, appends its output to <SWARM_HOME>/logs/node.log, which the node caps,
 * and loads secrets from <SWARM_HOME>/node.env (mode 600): the plist or unit holds only paths, PATH and Swarm's own
 * location, never a key.
 */
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { getSwarmPaths } from "../config/settings.js";
import { runCommand, swarmRoot, type Run } from "../update.js";

export const LAUNCHD_LABEL = "com.agent-swarm.node";
export const SYSTEMD_UNIT = "swarm-node.service";
/** node.log grows to this size before the node moves it to node.log.1, keeping one older file. */
export const LOG_CAP_BYTES = 10 * 1024 * 1024;
/** What the service takes from the shell that installed it: where programs and Swarm's state are, never secrets. */
const CARRIED = ["PATH", "SWARM_HOME", "SWARM_MESH_HOME"];

const ENV_TEMPLATE = `# Environment for this device's Swarm node service (swarm node install).
#
# The node and its ticket workers read this file each time the service starts. Put the keys they need from the
# environment here, one KEY=value per line, for example:
#
#   OPENAI_API_KEY=sk-...
#   GH_TOKEN=ghp_...
#
# Keys saved with swarm auth set-key live in Swarm's settings and need no line here. Keep this file private (mode 600):
# the service's plist or unit holds no keys, only this file does. After changing it, run swarm node install again to
# restart the node with it.
`;

export interface ServiceHost {
  platform: NodeJS.Platform;
  /** The user's home directory and uid. */
  home: string;
  uid: number;
  /** Swarm's home: ~/.swarm unless SWARM_HOME names another. */
  swarmHome: string;
  /** The environment `swarm node install` runs in; only PATH and Swarm's location variables reach the service. */
  env: NodeJS.ProcessEnv;
  /** The Node binary and the Swarm entry point the service runs. */
  node: string;
  entry: string;
  run: Run;
}

/**
 * The Node binary the service runs: the `node` on PATH that is this same binary, when there is one, because a version
 * manager's link (such as mise's node/24/bin/node or Homebrew's bin/node) survives upgrades its target does not; else
 * this binary.
 */
export function stableNode(execPath: string, path = ""): string {
  const self = realpathSync(execPath);
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try {
      if (realpathSync(join(dir, "node")) === self) return join(dir, "node");
    } catch { /* No node there. */ }
  }
  return execPath;
}

export function serviceHost(): ServiceHost {
  return {
    platform: process.platform, home: homedir(), uid: process.getuid?.() ?? 0, swarmHome: getSwarmPaths().home, env: process.env,
    node: stableNode(process.execPath, process.env.PATH), entry: join(swarmRoot(), "dist", "index.js"), run: runCommand
  };
}

export interface ServiceFiles {
  manager: "launchd" | "systemd";
  /** The plist or unit, and what it says. */
  file: string;
  text: string;
  envFile: string;
  logFile: string;
  /** The command line the service runs. */
  program: string[];
}

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(program: string[], env: Record<string, string>, home: string, log: string): string {
  const string = (text: string): string => `<string>${xml(text)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by swarm node install; swarm node uninstall removes it. Secrets go in the env file the node loads, not here. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    ${string(arg)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>\n    ${string(value)}`).join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  ${string(home)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  ${string(log)}
  <key>StandardErrorPath</key>
  ${string(log)}
</dict>
</plist>
`;
}

/** systemd expands % specifiers in every value, and $ variables in ExecStart. */
const specifiers = (text: string): string => text.replace(/%/g, "%%");
const quoted = (text: string): string => `"${specifiers(text).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

function unit(program: string[], env: Record<string, string>, log: string): string {
  return `# Written by swarm node install; swarm node uninstall removes it. Secrets go in the env file the node loads, not here.
[Unit]
Description=Swarm node: the superagent host and the mesh server

[Service]
ExecStart=${program.map((arg) => quoted(arg).split("$").join("$$")).join(" ")}
WorkingDirectory=~
${Object.entries(env).map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=append:${specifiers(log)}
StandardError=append:${specifiers(log)}

[Install]
WantedBy=default.target
`;
}

/** The service's files for this system: where the plist or unit goes and what it says, and the env and log files. */
export function serviceFiles(host: ServiceHost, options: { withHost?: boolean } = {}): ServiceFiles {
  const envFile = join(host.swarmHome, "node.env");
  const logFile = join(host.swarmHome, "logs", "node.log");
  const program = [host.node, `--env-file-if-exists=${envFile}`, host.entry, "node", "run", ...(options.withHost === false ? ["--no-host"] : []), "--log", logFile];
  const env = Object.fromEntries(CARRIED.flatMap((key) => host.env[key] ? [[key, host.env[key]!]] : []));
  if (host.platform === "darwin") {
    const file = join(host.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return { manager: "launchd", file, text: plist(program, env, host.home, logFile), envFile, logFile, program };
  }
  if (host.platform === "linux") {
    const config = host.env.XDG_CONFIG_HOME && isAbsolute(host.env.XDG_CONFIG_HOME) ? host.env.XDG_CONFIG_HOME : join(host.home, ".config");
    const file = join(config, "systemd", "user", SYSTEMD_UNIT);
    return { manager: "systemd", file, text: unit(program, env, logFile), envFile, logFile, program };
  }
  throw new Error(`swarm node install knows launchd (macOS) and systemd (Linux), not ${host.platform}: run swarm node run under this system's own service manager.`);
}

export interface ServiceStatus {
  manager: ServiceFiles["manager"];
  file: string;
  /** Whether the plist or unit is in place, and whether the service manager has it loaded. */
  installed: boolean;
  loaded: boolean;
  /** The node's pid while it runs. */
  pid?: number;
  /** How it last ended, such as "exit code 1"; "never exited" while its first run lasts. */
  lastExit?: string;
  envFile: string;
  logFile: string;
  /** Why the service manager could not be asked. */
  problem?: string;
}

const launchdTarget = (host: ServiceHost): string => `gui/${host.uid}/${LAUNCHD_LABEL}`;
const systemctl = (host: ServiceHost, ...args: string[]) => host.run("systemctl", ["--user", ...args], host.home);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The top-level `key = value` lines of `launchctl print`; nested sections are indented further. */
const launchdFields = (text: string): Map<string, string> =>
  new Map([...text.matchAll(/^\t([a-z][a-z ]*) = (.*)$/gm)].map((match) => [match[1]!, match[2]!.trim()]));

export async function serviceStatus(host: ServiceHost): Promise<ServiceStatus> {
  const files = serviceFiles(host);
  const base = { manager: files.manager, file: files.file, installed: existsSync(files.file), envFile: files.envFile, logFile: files.logFile };
  if (files.manager === "launchd") {
    const printed = await host.run("launchctl", ["print", launchdTarget(host)], host.home);
    if (printed.code !== 0) return { ...base, loaded: false };
    const fields = launchdFields(printed.stdout);
    const pid = Number(fields.get("pid"));
    const code = fields.get("last exit code");
    const signal = fields.get("last terminating signal");
    const lastExit = signal ? `signal ${signal}` : code === "(never exited)" ? "never exited" : code ? `exit code ${code}` : undefined;
    return { ...base, loaded: true, ...(pid ? { pid } : {}), ...(lastExit ? { lastExit } : {}) };
  }
  const shown = await systemctl(host, "show", SYSTEMD_UNIT, "--property=LoadState,ActiveState,MainPID,ExecMainCode,ExecMainStatus,ExecMainExitTimestamp");
  if (shown.code !== 0) return { ...base, loaded: false, problem: `systemctl --user does not answer: ${shown.stderr.trim()}` };
  const fields = new Map(shown.stdout.split("\n").flatMap((line) => {
    const at = line.indexOf("=");
    return at > 0 ? [[line.slice(0, at), line.slice(at + 1).trim()] as const] : [];
  }));
  const pid = Number(fields.get("MainPID"));
  // ExecMainCode is the waitid() code: 1 an exit with ExecMainStatus as its code, 2 or 3 a signal of that number.
  const lastExit = !fields.get("ExecMainExitTimestamp") ? (pid ? "never exited" : undefined)
    : fields.get("ExecMainCode") === "1" ? `exit code ${fields.get("ExecMainStatus")}` : `signal ${fields.get("ExecMainStatus")}`;
  return { ...base, loaded: fields.get("LoadState") === "loaded" && base.installed, ...(pid ? { pid } : {}), ...(lastExit ? { lastExit } : {}) };
}

/** A superagent host that holds this device's lock, as `lockHolder` reads it. */
export interface LockHolder { pid: number; startedAt: string }

export interface Installed {
  files: ServiceFiles;
  /** Whether install wrote the env file now; it keeps one that exists. */
  envCreated: boolean;
  /** Things to do that install could not, such as turning on lingering. */
  notes: string[];
}

/**
 * Writes the service's files and (re)loads it, which starts the node. `holder` is a superagent host that holds this
 * device's lock: the service's own node may (install again restarts it), anything else is refused, because the
 * service's node would fail on the lock and be restarted over and over.
 */
export async function installService(host: ServiceHost, options: { withHost: boolean; holder?: LockHolder }): Promise<Installed> {
  const files = serviceFiles(host, options);
  if (!existsSync(host.entry)) throw new Error(`${host.entry} does not exist: build this Swarm first (npm run build in ${dirname(dirname(host.entry))}).`);
  if (options.holder && options.holder.pid !== (await serviceStatus(host)).pid) {
    throw new Error(`Another superagent host already runs on this device (pid ${options.holder.pid}, since ${options.holder.startedAt}): a swarm node run or swarm superagent run in a terminal, or a TUI that started one. Only one host may hold the device's lock and the service runs its own, so stop that one first, then run swarm node install again.`);
  }
  mkdirSync(dirname(files.logFile), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(files.file), { recursive: true });
  const envCreated = !existsSync(files.envFile);
  if (envCreated) writeFileSync(files.envFile, ENV_TEMPLATE, { mode: 0o600 });
  chmodSync(files.envFile, 0o600);
  writeFileSync(files.file, files.text, { mode: 0o644 });
  return { files, envCreated, notes: files.manager === "launchd" ? await loadLaunchd(host, files) : await loadSystemd(host) };
}

async function loadLaunchd(host: ServiceHost, files: ServiceFiles): Promise<string[]> {
  const target = launchdTarget(host);
  await host.run("launchctl", ["bootout", target], host.home);
  // bootout returns while the old node may still be stopping; bootstrap fails until launchd has let it go.
  for (let tries = 0; tries < 40 && (await host.run("launchctl", ["print", target], host.home)).code === 0; tries++) await sleep(250);
  await host.run("launchctl", ["enable", target], host.home);
  const booted = await host.run("launchctl", ["bootstrap", `gui/${host.uid}`, files.file], host.home);
  if (booted.code !== 0) throw new Error(`launchctl bootstrap gui/${host.uid} ${files.file} failed: ${booted.stderr.trim() || `exit code ${booted.code}`}`);
  return [];
}

async function loadSystemd(host: ServiceHost): Promise<string[]> {
  const reloaded = await systemctl(host, "daemon-reload");
  if (reloaded.code !== 0) {
    throw new Error(`systemctl --user does not answer (${reloaded.stderr.trim() || `exit code ${reloaded.code}`}). The unit is written, but a systemd user manager must run for this user: log in on the box, or run loginctl enable-linger, then swarm node install again.`);
  }
  for (const args of [["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
    const ran = await systemctl(host, ...args);
    if (ran.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed: ${ran.stderr.trim() || `exit code ${ran.code}`}`);
  }
  const linger = await host.run("loginctl", ["show-user", String(host.uid), "--property=Linger"], host.home);
  return linger.stdout.trim().replace(/^Linger=/, "") === "no"
    ? ["Lingering is off for this user, so systemd stops the node when you log out and starts it at your next login. On a headless box run loginctl enable-linger so it runs from boot."]
    : [];
}

/** Stops the service and removes its plist or unit; the env file and logs stay. Says whether one was installed. */
export async function uninstallService(host: ServiceHost): Promise<boolean> {
  const files = serviceFiles(host);
  const installed = existsSync(files.file);
  if (files.manager === "launchd") await host.run("launchctl", ["bootout", launchdTarget(host)], host.home);
  else await systemctl(host, "disable", "--now", SYSTEMD_UNIT);
  rmSync(files.file, { force: true });
  if (files.manager === "systemd") await systemctl(host, "daemon-reload");
  return installed;
}

/** Restarts the service's node when it is installed and loaded, as after an update; says what it did. */
export async function restartService(host: ServiceHost = serviceHost()): Promise<string | undefined> {
  if (host.platform !== "darwin" && host.platform !== "linux") return undefined;
  const status = await serviceStatus(host);
  if (!status.installed || !status.loaded) return undefined;
  const ran = status.manager === "launchd"
    ? await host.run("launchctl", ["kickstart", "-k", launchdTarget(host)], host.home)
    : await systemctl(host, "restart", SYSTEMD_UNIT);
  return ran.code === 0 ? "Restarted the node service on the new code." : `The node service still runs the old code: restarting it failed (${ran.stderr.trim()}). swarm node install restarts it.`;
}

/** Moves the log to `<log>.1` once it outgrows `cap`; the service keeps appending to the emptied file. */
export function capLog(file: string, cap = LOG_CAP_BYTES): boolean {
  try {
    if (statSync(file).size <= cap) return false;
  } catch {
    return false;
  }
  copyFileSync(file, `${file}.1`);
  truncateSync(file, 0);
  return true;
}

/** Caps the log now and every minute while the node runs. */
export function keepLogCapped(file: string, cap = LOG_CAP_BYTES): void {
  capLog(file, cap);
  setInterval(() => capLog(file, cap), 60_000).unref();
}

/** Prints the end of the node's log, and follows it with `follow` until Ctrl+C. */
export function showLog(file: string, follow: boolean): Promise<void> {
  if (!existsSync(file)) {
    console.log(`No node log at ${file} yet: it starts when the node service runs (swarm node install).`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const tail = spawn("tail", ["-n", "200", ...(follow ? ["-F"] : []), file], { stdio: "inherit" });
    tail.once("error", reject);
    tail.once("exit", () => resolve());
  });
}
