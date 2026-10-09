#!/usr/bin/env python3
"""Regression coverage for dune-awakening-selfhost-docker#1163.

follow_director_hagga_handoffs hands a player a grant carrying the Survival_1
partition, port and IP. The log-cache `stream` outlives Director restarts (the
`docker logs -f` pipe it replaced ended on one, which refreshed the target), and
a Director restart also restarts Survival_1, so a target computed once per
pipeline can go stale. The consumer now re-reads TARGET_FILE for every event and
the autoscaler's main loop keeps that file fresh.

AUTOSCALER_UNDER_TEST points the test at another copy of the script (mutation
checks); it defaults to runtime/scripts/autoscaler.sh.
"""
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(os.environ.get("AUTOSCALER_UNDER_TEST", ROOT / "runtime/scripts/autoscaler.sh"))
SOURCE = SCRIPT.read_text()


def hagga_program():
    function = SOURCE.split("follow_director_hagga_handoffs() {", 1)[1].split("scan_deepdesert_loading_responses()", 1)[0]
    return function.split("3<<'PY'", 1)[1].split("\nPY\n", 1)[0].split("\n", 1)[1]


def target(partition_id, port=7778, ip="10.0.0.1"):
    return {"partition_id": partition_id, "dimension": 0, "port": port, "ip": ip}


def event(request_id):
    payload = {"Code": 1, "MapName": "Survival_1", "RequestID": request_id}
    return 'Notified player(s) "test-player" of travel response SH_Arrakeen3: ' + json.dumps(payload) + "\n"


class Consumer:
    """One long-lived consumer process, like the real stream pipeline."""

    def __init__(self, env):
        self.proc = subprocess.Popen(
            ["python3", "-u", "-c", hagga_program()],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, **env},
        )
        self.watchdog = threading.Timer(30, self.proc.kill)
        self.watchdog.start()

    def send(self, line):
        self.proc.stdin.write(line)
        self.proc.stdin.flush()

    def settle(self):
        # A skipped event prints nothing, so there is no output to wait for. The
        # consumer handles a line in microseconds; half a second is far above
        # that even on a loaded runner, and it only needs to order our writes.
        time.sleep(0.5)

    def grant(self):
        out = self.proc.stdout.readline()
        flow, origin, body = out.strip().split("|", 2)
        return flow, json.loads(body)["grant"]

    def finish(self):
        self.proc.stdin.close()
        stdout = self.proc.stdout.read()
        stderr = self.proc.stderr.read()
        self.proc.wait(timeout=10)
        self.watchdog.cancel()
        return stdout, stderr, self.proc.returncode


class HaggaTargetRefresh(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.target_file = Path(self.dir.name) / "survival-target.json"

    def write_target(self, value, raw=None):
        tmp = self.target_file.with_suffix(".tmp")
        tmp.write_text(raw if raw is not None else json.dumps(value))
        os.replace(tmp, self.target_file)

    def test_target_is_reread_for_every_event(self):
        self.write_target(target(1, port=7778, ip="10.0.0.1"))
        consumer = Consumer({"TARGET_FILE": str(self.target_file)})
        consumer.send(event("flow-1"))
        flow, grant = consumer.grant()
        self.assertEqual((flow, grant["PartitionId"], grant["Port"], grant["Ip"]), ("flow-1", 1, 7778, "10.0.0.1"))
        # Survival_1 moved while the same consumer process kept running.
        self.write_target(target(37, port=7790, ip="10.0.0.9"))
        consumer.send(event("flow-2"))
        flow, grant = consumer.grant()
        self.assertEqual((flow, grant["PartitionId"], grant["Port"], grant["Ip"]), ("flow-2", 37, 7790, "10.0.0.9"))
        _, stderr, code = consumer.finish()
        self.assertEqual(code, 0, stderr)

    def test_no_ready_survival_skips_the_event_and_recovers(self):
        consumer = Consumer({"TARGET_FILE": str(self.target_file)})  # file does not exist
        consumer.send(event("flow-skipped"))
        consumer.settle()
        self.write_target(None, raw="{ not json")  # unreadable target
        consumer.send(event("flow-also-skipped"))
        consumer.settle()
        self.write_target(target(5))
        consumer.send(event("flow-ok"))
        flow, grant = consumer.grant()
        # Only the event that had a valid target produced a grant; nothing stale was granted.
        self.assertEqual((flow, grant["PartitionId"]), ("flow-ok", 5))
        stdout, stderr, code = consumer.finish()
        self.assertEqual((stdout, code), ("", 0), stderr)

    def test_target_json_environment_still_works(self):
        # The path the original program used (and upstream's own test exercises).
        consumer = Consumer({"TARGET_JSON": json.dumps(target(3)), "TARGET_FILE": ""})
        consumer.send(event("flow-compat"))
        flow, grant = consumer.grant()
        self.assertEqual((flow, grant["PartitionId"]), ("flow-compat", 3))
        consumer.finish()

    def test_refresh_function_writes_removes_and_rate_limits(self):
        function = SOURCE.split("refresh_survival_target_file() {", 1)[1].split("\n}\n", 1)[0]
        calls = Path(self.dir.name) / "calls"
        script = f'''
set -euo pipefail
refresh_survival_target_file() {{{function}
}}
SURVIVAL_TARGET_FILE="{self.target_file}"
SURVIVAL_TARGET_REFRESH_SECONDS=1000
echo '{json.dumps(target(8))}' >"{Path(self.dir.name) / "answer"}"
survival_partition_target_json() {{ echo x >>"{calls}"; cat "{Path(self.dir.name) / "answer"}"; }}
refresh_survival_target_file
cat "{self.target_file}"
refresh_survival_target_file
refresh_survival_target_file
echo "queries=$(wc -l <"{calls}")"
SURVIVAL_TARGET_REFRESHED_AT=0
: >"{Path(self.dir.name) / "answer"}"
refresh_survival_target_file
[ ! -e "{self.target_file}" ] && echo removed-when-no-ready-server
'''
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.strip().splitlines()
        self.assertEqual(json.loads(lines[0])["partition_id"], 8)
        self.assertIn("queries=1", lines)  # three calls inside the interval cost one query
        self.assertIn("removed-when-no-ready-server", lines)

    def test_loop_wiring(self):
        function = SOURCE.split("follow_director_hagga_handoffs() {", 1)[1].split("scan_deepdesert_loading_responses()", 1)[0]
        self.assertIn('TARGET_FILE="${SURVIVAL_TARGET_FILE:-}"', function)
        self.assertNotIn("TARGET_JSON=", function.split("3<<'PY'", 1)[0])
        main_loop = SOURCE.rsplit("while true; do\n  ensure_director_log_cache", 1)[1]
        self.assertIn("refresh_survival_target_file", main_loop.split("scan_", 1)[0])


if __name__ == "__main__":
    unittest.main()
