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

    def test_docker_unavailable_fails_closed_by_raising(self):
        """Upstream review finding: this previously returned [] (fail
        open) if Docker itself could not be queried (daemon down,
        permission denied, docker missing) -- silently allowing apply()
        to proceed as if nothing were running, which is strictly less
        safe than a query that succeeds and reports [] with confidence.
        This safety check must fail closed: a query failure is treated
        as "cannot verify, assume something might be running" and must
        raise, not silently return an empty list."""
        with patch("subprocess.run", side_effect=OSError("docker not found")):
            with self.assertRaises(multi_server_config.ConfigError):
                multi_server_config.running_dune_containers()

    def test_docker_permission_denied_fails_closed_by_raising(self):
        """Same fail-closed contract for the other real, reachable
        failure mode this finding named explicitly: a non-zero exit from
        `docker ps` (e.g. permission denied on the Docker socket)."""
        with patch(
            "subprocess.run",
            side_effect=subprocess.CalledProcessError(1, ["docker", "ps"], stderr="permission denied"),
        ):
            with self.assertRaises(multi_server_config.ConfigError):
                multi_server_config.running_dune_containers()


class UpsertEnvPermissionsTests(unittest.TestCase):
    """Upstream review finding: upsert_env() previously hardcoded mode
    0o644 on every write, unconditionally loosening any tighter
    permission (e.g. 0600) an operator had deliberately set on .env --
    a real credential-exposure regression, since .env can legitimately
    hold real secrets directly (ADMIN_PASSWORD, DUNE_DB_PASSWORD,
    DUNE_COMMAND_AUTH_TOKEN, DUNE_DISCORD_ADAPTER_TOKEN)."""

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)

    def test_preserves_an_existing_tighter_permission(self):
        import os
        path = Path(self._tmpdir.name) / ".env"
        path.write_text("EXISTING=1\n", encoding="utf-8")
        os.chmod(path, 0o600)
        multi_server_config.upsert_env(path, {"SERVER_IP": "1.2.3.4"})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600, "an existing 0600 .env must not be loosened to 0644 by upsert_env()")
        self.assertIn("SERVER_IP=1.2.3.4", path.read_text(encoding="utf-8"))

    def test_new_file_defaults_to_0644(self):
        """Matches this project's existing, already-established
        convention for a brand-new .env (see init.sh/manager.sh/
        memory.sh, which all explicitly `chmod 644 .env`) -- this fix
        only stops an EXISTING tighter permission from being
        overwritten, it does not change the default for a fresh file."""
        import os
        path = Path(self._tmpdir.name) / ".env"
        self.assertFalse(path.exists())
        multi_server_config.upsert_env(path, {"SERVER_IP": "1.2.3.4"})
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)


class NatLinesTests(unittest.TestCase):
    """Upstream review finding: nat_lines() previously listed the IGW
    range as if it should be forwarded, directly contradicting this
    project's own documented decision that IGW is internal map-to-map
    traffic and must never be publicly forwarded."""

    def test_igw_range_is_not_listed_as_a_forward_target(self):
        profile = multi_server_config.profile_for(1, multi_server_config.load_defaults())
        lines = multi_server_config.nat_lines(profile, bind_ip="10.0.0.5")
        forward_lines = [line for line in lines if line.startswith(("UDP ", "TCP "))]
        for line in forward_lines:
            self.assertNotIn("IGW", line, f"IGW must not appear in a real forward-target line: {line!r}")
        self.assertTrue(
            any("IGW" in line and "do NOT forward" in line for line in lines),
            "IGW must still be mentioned, but clearly labeled informational-only, not a forward target",
        )

    def test_player_game_range_is_still_a_real_forward_target(self):
        profile = multi_server_config.profile_for(1, multi_server_config.load_defaults())
        lines = multi_server_config.nat_lines(profile, bind_ip="10.0.0.5")
        self.assertTrue(
            any(line.startswith("UDP ") and "10.0.0.5" in line and "Player/Game" in line for line in lines),
            "the real Player/Game forward line must still be present and correctly targeted",
        )


class CommandApplyRollbackTests(unittest.TestCase):
    """Upstream review finding: apply() was not transactional -- if .env
    was updated and a LATER usersettings.py call failed, the host was
    left in a real, reachable mixed state with no automatic recovery.
    apply() must now roll back to the exact pre-apply state on any
    failure partway through its write sequence."""

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self._root = Path(self._tmpdir.name)
        (self._root / "runtime" / "generated").mkdir(parents=True)
        (self._root / "runtime" / "backups").mkdir(parents=True)

        self._patches = [
            patch.object(multi_server_config, "ROOT", self._root),
            patch.object(multi_server_config, "ENV_PATH", self._root / ".env"),
            patch.object(multi_server_config, "GENERATED_DIR", self._root / "runtime" / "generated"),
            patch.object(multi_server_config, "BACKUP_ROOT", self._root / "runtime" / "backups"),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _write_pre_apply_state(self):
        multi_server_config.ENV_PATH.write_text("SERVER_IP=old\nADMIN_BIND_PORT=8088\n", encoding="utf-8")
        (multi_server_config.GENERATED_DIR / "usersettings.json").write_text('{"engine": {"port": "7777"}}', encoding="utf-8")
        (multi_server_config.GENERATED_DIR / "gameplay-profile.ini").write_text("[Engine:URL]\nPort=7777\n", encoding="utf-8")

    def test_rolls_back_env_when_a_later_usersettings_call_fails(self):
        import argparse
        self._write_pre_apply_state()
        pre_env = multi_server_config.ENV_PATH.read_text(encoding="utf-8")
        pre_json = (multi_server_config.GENERATED_DIR / "usersettings.json").read_text(encoding="utf-8")

        args = argparse.Namespace(
            instance=2, public_ip="203.0.113.5", bind_ip="10.0.0.5",
            allow_running=True, dry_run=False,
        )

        def fake_usersettings_run(*call_args, **kwargs):
            if call_args and call_args[0] == "engine-set" and "port" in call_args:
                raise subprocess.CalledProcessError(1, call_args)
            return subprocess.CompletedProcess(args=call_args, returncode=0, stdout="", stderr="")

        with patch.object(multi_server_config, "usersettings_run", side_effect=fake_usersettings_run):
            with self.assertRaises(multi_server_config.ConfigError):
                multi_server_config.command_apply(args, multi_server_config.load_defaults())

        # .env must be back to EXACTLY the pre-apply content, not left
        # mid-way through the update (igw_port succeeded before port
        # failed, in this fixture's induced failure).
        self.assertEqual(multi_server_config.ENV_PATH.read_text(encoding="utf-8"), pre_env)
        self.assertEqual((multi_server_config.GENERATED_DIR / "usersettings.json").read_text(encoding="utf-8"), pre_json)

    def test_successful_apply_does_not_roll_back(self):
        import argparse
        self._write_pre_apply_state()
        args = argparse.Namespace(
            instance=2, public_ip="203.0.113.5", bind_ip="10.0.0.5",
            allow_running=True, dry_run=False,
        )
        with patch.object(
            multi_server_config, "usersettings_run",
            return_value=subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""),
        ) as mock_run:
            result = multi_server_config.command_apply(args, multi_server_config.load_defaults())
        self.assertEqual(result, 0)
        self.assertIn("SERVER_IP=203.0.113.5", multi_server_config.ENV_PATH.read_text(encoding="utf-8"))
        self.assertEqual(mock_run.call_count, 3, "engine-set igw_port, engine-set port, materialize-current")


class CommandApplyAllowRunningTests(unittest.TestCase):
    """The --allow-running escape hatch must not be blocked by the
    fail-closed Docker-query behavior above -- an operator who has
    already accepted responsibility for verifying the stack is stopped
    must not be unable to use that escape hatch just because Docker
    itself can't be queried right now (e.g. permission issue on this
    user, unrelated to whether the stack is actually running)."""

    def test_allow_running_skips_the_docker_query_entirely(self):
        import argparse
        args = argparse.Namespace(
            instance=1, public_ip="203.0.113.5", bind_ip="10.0.0.5",
            allow_running=True, dry_run=True,
        )
        with patch("subprocess.run", side_effect=OSError("docker not found")) as mock_run:
            result = multi_server_config.command_apply(args, multi_server_config.load_defaults())
        self.assertEqual(result, 0, "dry-run apply with --allow-running must succeed even if Docker cannot be queried at all")
        mock_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
