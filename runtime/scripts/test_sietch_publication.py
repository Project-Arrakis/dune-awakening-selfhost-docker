#!/usr/bin/env python3
"""Exercise the real publisher send path without a database or RabbitMQ."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from sietch_publication import prepare, record


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.native = {
            "partitionId": 1, "serverId": "test-server", "ready": True,
            "reportTimestamp": 100,
            "players": [{"id": "test-player"}],
            "loginPassword": "test-secret-sentinel",
            "serverGameplaySettings": {
                "HarvestingSettings": {"miningOutputMultiplier": "2.0"},
                "CoreSettings": {"serverDisplayName": "Test Sietch"},
            },
        }
        self.snapshot = copy.deepcopy(self.native)
        self.snapshot.update(ready=False, players=[])
        self.snapshot["serverGameplaySettings"]["HarvestingSettings"]["miningOutputMultiplier"] = "1.0"

    def test_native_state_wins_even_after_a_readiness_downgrade(self):
        state = {}
        record(self.native, "native", state)
        for ready in (False, True):
            self.snapshot["ready"] = ready
            self.assertIsNone(prepare(self.snapshot, "snapshot", state))
        # An absent/old native heartbeat is never replayed with a newer time.
        self.snapshot["reportTimestamp"] = 1_000_000
        self.assertIsNone(prepare(self.snapshot, "snapshot", state))

    def test_ready_server_is_not_reset_after_publisher_upgrade_or_restart(self):
        self.snapshot["ready"] = True
        self.assertIsNone(prepare(self.snapshot, "snapshot", {}))

    def test_unready_startup_fallback_and_replacement_server_remain_available(self):
        state = {}
        first = prepare(self.snapshot, "snapshot", state)
        self.assertEqual(first, self.snapshot)
        record(first, "snapshot", state)
        native = prepare(self.native, "native", state)
        self.assertEqual(native["reportTimestamp"], 101)
        record(native, "native", state)
        replacement = dict(self.snapshot, serverId="replacement-server")
        startup = prepare(replacement, "snapshot", state)
        self.assertIsNotNone(startup)
        self.assertGreater(startup["reportTimestamp"], native["reportTimestamp"])
        record(startup, "snapshot", state)
        self.assertFalse(state["1"]["native"])

    def test_metadata_never_contains_players_settings_or_passwords(self):
        state = {}
        record(self.native, "native", state)
        self.assertEqual(set(state["1"]), {"serverId", "reportTimestamp", "native"})
        self.assertNotIn("test-secret-sentinel", json.dumps(state))
        self.assertNotIn("test-player", json.dumps(state))

    def run_send_path(self, commands):
        script = Path(__file__).with_name("publish-sietch-overrides.sh").read_text()
        function = script.split("publish_payload() (", 1)[1].split("\nheal_survival_alive_state()", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime/scripts").mkdir(parents=True)
            shutil.copyfile(Path(__file__).with_name("sietch_publication.py"), root / "runtime/scripts/sietch_publication.py")
            (root / "native.json").write_text(json.dumps(self.native))
            (root / "snapshot.json").write_text(json.dumps(self.snapshot))
            harness = '''set -euo pipefail
PUBLICATION_STATE_FILE=runtime/generated/state.json
FILTER_EXCHANGE=test-filter
SOURCE_ROUTING_KEY=server_state.Survival_1
dune_set_host_path_owner() { :; }
rmq_admin() {
  [ "${BROKER_FAIL:-false}" = false ] || return 1
  for argument in "$@"; do
    case "$argument" in payload=*) printf '%s\\n' "${argument#payload=}" >>sent.jsonl ;; esac
  done
}
'''+"publish_payload() ("+function+"\n"+commands
            result = subprocess.run(["bash", "-c", harness], cwd=root, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            sent = [json.loads(line) for line in (root / "sent.jsonl").read_text().splitlines()] if (root / "sent.jsonl").exists() else []
            state_file = root / "runtime/generated/state.json"
            state = json.loads(state_file.read_text()) if state_file.exists() else {}
            mode = state_file.stat().st_mode & 0o777 if state_file.exists() else None
            return sent, state, mode

    def test_actual_send_path_preserves_native_population_settings_and_order(self):
        sent, state, mode = self.run_send_path('''
publish_payload "$(cat snapshot.json)" snapshot
publish_payload "$(cat native.json)"
publish_payload "$(cat snapshot.json)" snapshot
publish_payload "$(cat native.json)"
''')
        self.assertEqual(len(sent), 3)
        self.assertEqual([payload["reportTimestamp"] for payload in sent], [100, 101, 102])
        for payload in sent[1:]:
            expected = dict(self.native, reportTimestamp=payload["reportTimestamp"])
            self.assertEqual(payload, expected)
        self.assertTrue(state["1"]["native"])
        self.assertEqual(mode, 0o600)

    def test_failed_send_does_not_record_a_native_publication(self):
        sent, state, _ = self.run_send_path('''
BROKER_FAIL=true
if publish_payload "$(cat native.json)"; then exit 9; fi
BROKER_FAIL=false
publish_payload "$(cat snapshot.json)" snapshot
''')
        self.assertEqual(len(sent), 1)
        self.assertFalse(state["1"]["native"])

    def test_overlapping_loop_and_one_shot_sends_stay_ordered(self):
        sent, state, _ = self.run_send_path('''
for attempt in 1 2 3 4; do
  publish_payload "$(cat native.json)" &
done
wait
''')
        self.assertEqual([payload["reportTimestamp"] for payload in sent], [100, 101, 102, 103])
        self.assertEqual(state["1"]["reportTimestamp"], 103)

    def test_native_preparation_only_changes_the_timestamp(self):
        state = {}
        record(self.native, "native", state)
        actual = prepare(self.native, "native", state)
        self.assertEqual(actual, dict(self.native, reportTimestamp=101))
        self.assertEqual(self.native["reportTimestamp"], 100)


if __name__ == "__main__":
    unittest.main()
