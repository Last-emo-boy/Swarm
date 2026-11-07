/**
 * Loaded before every test file (package.json "test"). Tests run on developers' machines, which may be paired with real
 * mesh devices: a test that builds a Swarm runtime would reach them to borrow their tools, and a node would dial the real
 * relay. Each test process gets a mesh of its own instead; tests that need one set SWARM_MESH_HOME themselves.
 * Likewise a Swarm home: a test that builds a runtime or a TUI with default settings would otherwise add sessions, usage
 * rows and tool output to the developer's ~/.swarm. An inherited SWARM_HOME is the developer's own home, so it is
 * replaced too; tests that need a particular home set SWARM_HOME themselves.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_HOME = join(tmpdir(), `swarm-test-home-${process.pid}`);
process.env.SWARM_MESH_HOME ??= join(tmpdir(), `swarm-test-mesh-${process.pid}`);
process.env.SWARM_MESH_RELAY ??= "off";
