/**
 * Loaded before every test file (package.json "test"). Tests run on developers' machines, which may be paired with real
 * mesh devices: a test that builds a Swarm runtime would reach them to borrow their tools, and a node would dial the real
 * relay. Each test process gets a mesh of its own instead; tests that need one set SWARM_MESH_HOME themselves.
 * Likewise a Swarm home: a test that builds a runtime or a TUI with default settings would otherwise add sessions, usage
 * rows and tool output to the developer's ~/.swarm. An inherited SWARM_HOME is the developer's own home, so it is
 * replaced too; tests that need a particular home set SWARM_HOME themselves.
 *
 * The developer's machine may also have a signed-in lark-cli and gh. A test that leaves an effect queue running with a
 * message for such a Source would launch them for real: during B1 a test did, and lark-cli posted about a made-up message
 * fifteen times. So each test process gets a directory first on PATH whose lark-cli, lark-bot and gh are scripts that say
 * so on stderr and exit 97, and lark-cli's configuration directory names an empty directory, so an absolute path to the
 * real one finds no signed-in profile either. A test that needs a working fake CLI writes its own and names it by path,
 * which still runs. This guard is not exhaustive: a program launched with an absolute path that does not read
 * LARKSUITE_CLI_CONFIG_DIR, or a copy of the CLI started with LARKSUITE_CLI_CONFIG_DIR set back to the developer's
 * own, could still reach the network.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

process.env.SWARM_HOME = join(tmpdir(), `swarm-test-home-${process.pid}`);
process.env.SWARM_MESH_HOME ??= join(tmpdir(), `swarm-test-mesh-${process.pid}`);
process.env.SWARM_MESH_RELAY ??= "off";

const bin = join(tmpdir(), `swarm-test-bin-${process.pid}`);
const config = join(tmpdir(), `swarm-test-lark-config-${process.pid}`);
mkdirSync(bin, { recursive: true });
mkdirSync(config, { recursive: true });
for (const name of ["lark-cli", "lark-bot", "gh"]) {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "swarm-test-guard: ${name} is not available in tests; write a fake and name it by path." >&2\nexit 97\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}
process.env.PATH = [bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
// An inherited value is the developer's own profile, so it is replaced too, as SWARM_HOME is.
process.env.LARKSUITE_CLI_CONFIG_DIR = config;
