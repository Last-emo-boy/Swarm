# Harbor wrapper

Run Swarm through Harbor's installed-agent interface:

```bash
harbor trials start \
  -p <task-path> \
  --agent-import-path bench.harbor.swarm_agent:SwarmCliAgent
```

Required environment:

- `SWARM_BIN` or `SWARM_BINARY`: path to the built Swarm CLI binary
- `SWARM_PACKAGE`: optional local `npm pack` tarball; when set, the wrapper uploads and installs it inside the Harbor environment
- `SWARM_HOME`: optional in-sandbox Swarm home, defaults to `/logs/agent/swarm-home`
- `SWARM_MODEL`: model ref such as `openai/gpt-5.5`; used for planner, worker, and aggregator unless the specific variables below are set
- `SWARM_WORKER_MODEL` / `SWARM_AGGREGATOR_MODEL`: optional role-specific model refs
- `SWARM_RUN_MODE`: optional Swarm run mode, defaults to `coding_loop`
- model API keys needed by your configured provider

Build a package for sandbox installation:

```bash
npm run build
npm pack --pack-destination bench/harbor
export SWARM_PACKAGE="$PWD/bench/harbor/agent-swarm-cli-0.1.0.tgz"
```

Run against an existing Harbor dataset once Docker or a cloud environment is configured:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2 \
  --n-tasks 1 \
  --agent-import-path bench.harbor.swarm_agent:SwarmCliAgent \
  --agent-env SWARM_PACKAGE="$SWARM_PACKAGE" \
  --agent-env SWARM_MODEL="openai/gpt-5.5"
```

The wrapper writes `report.json`, `telemetry.json`, `trajectory.json`, and `swarm.log` into Harbor's agent logs directory.
