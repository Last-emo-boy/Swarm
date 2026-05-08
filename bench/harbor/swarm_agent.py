"""Harbor installed-agent wrapper for the Swarm CLI.

This wrapper is intentionally thin:
- it shells out to a local `swarm run` binary
- it writes Swarm's JSON report, telemetry, and trajectory into Harbor's logs dir
- it propagates the resulting token counts back into Harbor's agent context
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class SwarmCliAgent(BaseInstalledAgent):
    """Run the local Swarm CLI as a Harbor installed agent."""

    @staticmethod
    def name() -> str:
        return "swarm-cli"

    def get_version_command(self) -> str | None:
        return f"{shlex.quote(self._swarm_binary())} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        package_path = self._swarm_package()
        if package_path:
            await self._install_swarm_package(environment, package_path)
            return

        await self.exec_as_agent(
            environment,
            command=f"command -v {shlex.quote(self._swarm_binary())}",
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        swarm_binary = shlex.quote(self._swarm_binary())
        run_mode = shlex.quote(self._swarm_run_mode())
        agent_dir = environment.env_paths.agent_dir.as_posix()
        command = (
            "set -euo pipefail; "
            f"mkdir -p {shlex.quote(agent_dir)}; "
            f"{swarm_binary} run "
            f"--mode {run_mode} "
            '--workspace "$(pwd)" '
            "--json "
            f"--report {shlex.quote(f'{agent_dir}/report.json')} "
            f"--telemetry {shlex.quote(f'{agent_dir}/telemetry.json')} "
            f"--trajectory {shlex.quote(f'{agent_dir}/trajectory.json')} "
            f"{shlex.quote(instruction)} "
            f"2>&1 | tee {shlex.quote(f'{agent_dir}/swarm.log')}"
        )
        await self.exec_as_agent(environment, command=command, env=self._swarm_env(environment))

    def populate_context_post_run(self, context: AgentContext) -> None:
        telemetry_path = self.logs_dir / "telemetry.json"
        if not telemetry_path.exists():
            return

        try:
            telemetry = json.loads(telemetry_path.read_text())
        except Exception:
            return

        llm = telemetry.get("llm") if isinstance(telemetry, dict) else {}
        if isinstance(llm, dict):
            context.n_input_tokens = int(llm.get("input_tokens") or 0)
            context.n_cache_tokens = int(llm.get("cached_input_tokens") or 0)
            context.n_output_tokens = int(llm.get("output_tokens") or 0)

        if isinstance(telemetry, dict) and "error" in telemetry:
            context.metadata = {
                **(context.metadata or {}),
                "swarm_error": telemetry.get("error"),
            }

    def _swarm_binary(self) -> str:
        return self._get_env("SWARM_BIN") or self._get_env("SWARM_BINARY") or "swarm"

    def _swarm_package(self) -> Path | None:
        value = self._get_env("SWARM_PACKAGE")
        return Path(value).expanduser().resolve() if value else None

    async def _install_swarm_package(self, environment: BaseEnvironment, package_path: Path) -> None:
        if not package_path.exists():
            raise FileNotFoundError(f"SWARM_PACKAGE does not exist: {package_path}")

        remote_package = "/tmp/swarm-cli.tgz"
        await environment.upload_file(package_path, remote_package)
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then "
                "  true; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache nodejs npm; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y nodejs npm; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y nodejs npm; "
                "else "
                "  echo 'node and npm are required to install Swarm' >&2; exit 1; "
                "fi; "
                f"npm install -g {shlex.quote(remote_package)}; "
                "swarm --version"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    def _swarm_run_mode(self) -> str:
        return self._get_env("SWARM_RUN_MODE") or "coding_loop"

    def _swarm_env(self, environment: BaseEnvironment) -> dict[str, str]:
        agent_dir = environment.env_paths.agent_dir.as_posix()
        env = {
            "SWARM_HOME": self._get_env("SWARM_HOME") or f"{agent_dir}/swarm-home",
            "SWARM_PERMISSION_MODE": self._get_env("SWARM_PERMISSION_MODE") or "yolo",
        }
        for key in (
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_BASE_URL",
            "SWARM_MODEL",
            "SWARM_WORKER_MODEL",
            "SWARM_AGGREGATOR_MODEL",
            "SWARM_MAX_OUTPUT_TOKENS",
            "SWARM_TASK_TIMEOUT_MS",
            "SWARM_DISABLE_PROMPT_CACHING",
            "SWARM_PROMPT_CACHE_TTL",
            "SWARM_PROMPT_CACHE_RETENTION",
            "SWARM_GEMINI_CACHE_TTL_SECONDS",
            "SWARM_DEBUG",
            "SWARM_DEBUG_LEVEL",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value
        if env.get("SWARM_MODEL"):
            env.setdefault("SWARM_WORKER_MODEL", env["SWARM_MODEL"])
            env.setdefault("SWARM_AGGREGATOR_MODEL", env["SWARM_MODEL"])
        return env
