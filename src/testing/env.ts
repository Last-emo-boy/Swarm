/**
 * Loaded before every test file (package.json "test"). Tests run on developers' machines, which may be paired with real
 * mesh devices: a test that builds a Swarm runtime would reach them to borrow their tools, and a node would dial the real
 * relay. Each test process gets a mesh of its own instead; tests that need one set SWARM_MESH_HOME themselves.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_MESH_HOME ??= join(tmpdir(), `swarm-test-mesh-${process.pid}`);
process.env.SWARM_MESH_RELAY ??= "off";
