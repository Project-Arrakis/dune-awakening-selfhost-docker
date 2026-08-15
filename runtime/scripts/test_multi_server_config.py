#!/usr/bin/env python3
"""Unit tests for runtime/scripts/multi-server-config.py.

Covers two real, reproduced findings from live multi-VM testing against
Red-Blink#156 (see the fork's own tracked issues #282 and #283 for the
full reproduction detail and context):

RunningDuneContainersTests guards issue #283: apply()'s own
running-container safety check must not block on always-on management
containers (the console, orchestrator, and public-probe) that never hold
a host-facing port this tool rewrites -- confirmed directly against
docker-compose.yml/docker-compose.web.yml/docker-compose.public-probe.yml,
none of which publish any port at all. Before the fix, following the
documented "stop the stack, then apply" procedure failed every time,
because the console itself (which an operator almost always uses to reach
a shell on this host) is always running by definition.

Run directly:
    python3 runtime/scripts/test_multi_server_config.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_MODULE_PATH = Path(__file__).resolve().parent / "multi-server-config.py"
_SPEC = importlib.util.spec_from_file_location("multi_server_config", _MODULE_PATH)
multi_server_config = importlib.util.module_from_spec(_SPEC)
sys.modules["multi_server_config"] = multi_server_config
_SPEC.loader.exec_module(multi_server_config)


def _docker_ps_result(names: list[str]) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=["docker", "ps", "--format", "{{.Names}}"],
        returncode=0,
        stdout="\n".join(names) + "\n" if names else "",
        stderr="",
    )


class RunningDuneContainersTests(unittest.TestCase):
    def test_management_only_containers_do_not_block(self):
        """Regression test for issue #283: exactly the scenario reproduced
        live against dune-dev -- game/database containers stopped via
        `dune stop`, only the console/orchestrator/public-probe still up."""
        with patch(
            "subprocess.run",
            return_value=_docker_ps_result([
                "dune-orchestrator",
                "redblink-dune-docker-console",
                "dune-public-probe",
            ]),
        ):
            self.assertEqual(multi_server_config.running_dune_containers(), [])

    def test_real_game_containers_still_block(self):
        """The fix must not become a blanket bypass -- containers that DO
        hold a host-facing port this tool rewrites must still block."""
        with patch(
            "subprocess.run",
            return_value=_docker_ps_result([
                "dune-postgres",
                "dune-rmq-game",
                "dune-rmq-admin",
                "dune-text-router",
                "dune-director",
                "dune-server-gateway",
                "dune-server-survival-1",
                "dune-server-overmap",
                "dune-orchestrator",
                "redblink-dune-docker-console",
                "dune-public-probe",
            ]),
        ):
            blocking = multi_server_config.running_dune_containers()
            self.assertEqual(
                sorted(blocking),
                sorted([
                    "dune-postgres",
                    "dune-rmq-game",
                    "dune-rmq-admin",
                    "dune-text-router",
                    "dune-director",
                    "dune-server-gateway",
                    "dune-server-survival-1",
                    "dune-server-overmap",
                ]),
            )

    def test_metrics_prometheus_container_still_blocks(self):
        """dune-prometheus DOES publish a host port this tool manages
        (METRICS_PROMETHEUS_PORT, see docker-compose.metrics.yml) -- it
        must not be added to the non-blocking exclusion set alongside the
        three genuinely portless management containers."""
        with patch(
            "subprocess.run",
            return_value=_docker_ps_result([
                "dune-prometheus",
                "dune-orchestrator",
            ]),
        ):
            self.assertEqual(
                multi_server_config.running_dune_containers(), ["dune-prometheus"]
            )

    def test_no_containers_running_returns_empty(self):
        with patch("subprocess.run", return_value=_docker_ps_result([])):
            self.assertEqual(multi_server_config.running_dune_containers(), [])

    def test_docker_unavailable_fails_open_to_empty_list(self):
        """Matches the pre-existing behavior (unchanged by this fix): if
        docker itself can't be queried, this returns [] rather than
        raising -- apply()'s own downstream logic is unaffected by this
        fix's exclusion list in that failure path."""
        with patch("subprocess.run", side_effect=OSError("docker not found")):
            self.assertEqual(multi_server_config.running_dune_containers(), [])


if __name__ == "__main__":
    unittest.main()
