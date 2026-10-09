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
        self.proc.stdout.close()
        self.proc.stderr.close()
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

    def refresh(self, query_script, *, age_seconds=None, extra=""):
        """Run refresh_survival_target_file in its own bash (errexit on) with a stubbed lookup.

        query_script is the body of survival_partition_target_json; it decides the exit status
        (0 = ready server, 2 = ran and found none, 1 = the query itself failed)."""
        function = SOURCE.split("refresh_survival_target_file() {", 1)[1].split("\n}\n", 1)[0]
        touch = f'touch -d "@$(( $(date +%s) - {age_seconds} ))" "{self.target_file}"' if age_seconds is not None else ":"
        script = f'''
set -euo pipefail
refresh_survival_target_file() {{{function}
}}
SURVIVAL_TARGET_FILE="{self.target_file}"
survival_partition_target_json() {{ {query_script}; }}
{extra}
{touch}
refresh_survival_target_file
echo SURVIVED
'''
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True)

    def test_refresh_writes_the_target_when_a_server_is_ready(self):
        result = self.refresh(f"echo '{json.dumps(target(8))}'")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.target_file.read_text())["partition_id"], 8)
        self.assertFalse(self.target_file.with_suffix(".json.tmp").exists())

    def test_refresh_removes_the_target_when_the_query_finds_no_ready_server(self):
        self.write_target(target(8))
        result = self.refresh("return 2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.target_file.exists(), "a confirmed absence must not leave a stale endpoint")

    def test_a_failed_lookup_keeps_the_last_good_target_briefly_then_drops_it(self):
        # A short database blip must not drop every handoff (the consumer used to keep its
        # last target); a long outage must not keep granting an endpoint nobody can verify.
        self.write_target(target(8))
        fresh = self.refresh("return 1", age_seconds=5)
        self.assertEqual(fresh.returncode, 0, fresh.stderr)
        self.assertTrue(self.target_file.exists(), "kept through a short outage")
        stale = self.refresh("return 1", age_seconds=600)
        self.assertEqual(stale.returncode, 0, stale.stderr)
        self.assertFalse(self.target_file.exists(), "dropped once older than the staleness limit")

    def test_a_failed_write_is_reported_and_never_ends_the_autoscaler(self):
        self.write_target(target(8))
        result = self.refresh(f"echo '{json.dumps(target(9))}'", extra="mv() { return 1; }")
        self.assertEqual(result.returncode, 0, result.stderr)  # errexit is on in this shell
        self.assertIn("SURVIVED", result.stdout)
        self.assertIn("could not write", result.stderr)
        self.assertEqual(json.loads(self.target_file.read_text())["partition_id"], 8, "previous target kept")
        self.assertFalse(self.target_file.with_suffix(".json.tmp").exists(), "no half-written temp file left")

    def test_normal_exit_leaves_no_cache_directory_behind(self):
        # stop_director_log_cache ends with rmdir, which fails on a non-empty
        # directory: the target file added in #1163 must be removed with the rest.
        function = SOURCE.split("stop_director_log_cache() {", 1)[1].split("\n}\n", 1)[0]
        cache = Path(self.dir.name) / "director-log-cache.ABC123"
        cache.mkdir()
        for name in ("recent.sqlite", "recent.sqlite-wal", "recent.sqlite-shm", "survival-target.json", "survival-target.json.tmp"):
            (cache / name).write_text("x")
        script = f'''
set -euo pipefail
stop_director_log_cache() {{{function}
}}
DIRECTOR_LOG_CACHE_PID=999999
DIRECTOR_LOG_CACHE_DIR="{cache}"
DIRECTOR_LOG_CACHE_FILE="{cache}/recent.sqlite"
SURVIVAL_TARGET_FILE="{cache}/survival-target.json"
stop_director_log_cache
'''
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(cache.exists(), "the cache directory was left behind: " + str(list(cache.glob("*"))))

    def test_stop_halts_the_refresher_before_removing_its_files(self):
        # The refresher rewrites the target file every few seconds. If it is still running when the
        # cache directory is cleaned up, a write after the removal makes `rmdir` fail silently and
        # leaves the directory behind (#1186). A hot writer makes the race certain; the run is
        # repeated so a missing kill cannot pass by luck.
        function = SOURCE.split("stop_director_log_cache() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("SURVIVAL_TARGET_PID=$!", SOURCE.split("follow_survival_target &", 1)[1][:40])
        leftovers = []
        for attempt in range(25):
            cache = Path(self.dir.name) / f"director-log-cache.RACE{attempt}"
            cache.mkdir()
            (cache / "recent.sqlite").write_text("x")
            script = f'''
set -euo pipefail
stop_director_log_cache() {{{function}
}}
DIRECTOR_LOG_CACHE_PID=999999
DIRECTOR_LOG_CACHE_DIR="{cache}"
DIRECTOR_LOG_CACHE_FILE="{cache}/recent.sqlite"
SURVIVAL_TARGET_FILE="{cache}/survival-target.json"
( while true; do echo '{{}}' >"$SURVIVAL_TARGET_FILE.tmp" 2>/dev/null && mv -f "$SURVIVAL_TARGET_FILE.tmp" "$SURVIVAL_TARGET_FILE" 2>/dev/null; done ) &
SURVIVAL_TARGET_PID=$!
# Whatever stop_director_log_cache does, never leave the hot writer running (it would hold the
# pipes open and hang the test run).
trap 'kill "$SURVIVAL_TARGET_PID" 2>/dev/null || true' EXIT
sleep 0.05
stop_director_log_cache
'''
            result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            if cache.exists():
                leftovers.append(attempt)
        self.assertEqual(leftovers, [], "the refresher outlived the cleanup and recreated its files")

    def stop_script(self, cache, body):
        function = SOURCE.split("stop_director_log_cache() {", 1)[1].split("\n}\n", 1)[0]
        return f'''
set -euo pipefail
stop_director_log_cache() {{{function}
}}
DIRECTOR_LOG_CACHE_PID=999999
DIRECTOR_LOG_CACHE_DIR="{cache}"
DIRECTOR_LOG_CACHE_FILE="{cache}/recent.sqlite"
SURVIVAL_TARGET_FILE="{cache}/survival-target.json"
{body}
'''

    def test_stop_kills_the_refresher_not_just_its_files(self):
        # Deterministic: after the cleanup the refresher process must be gone (#1186).
        cache = Path(self.dir.name) / "director-log-cache.KILL"
        cache.mkdir()
        script = self.stop_script(cache, '''
( while true; do sleep 0.05; done ) &
SURVIVAL_TARGET_PID=$!
trap 'kill "$SURVIVAL_TARGET_PID" 2>/dev/null || true' EXIT
stop_director_log_cache
if kill -0 "$SURVIVAL_TARGET_PID" 2>/dev/null; then echo REFRESHER-STILL-RUNNING; fi
''')
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("REFRESHER-STILL-RUNNING", result.stdout)
        self.assertFalse(cache.exists())

    def test_cleanup_survives_a_straggler_write_between_rm_and_rmdir(self):
        # A `mv` the refresher had already started can finish just after the removal and recreate the
        # file, making the first rmdir fail. Simulate exactly that, deterministically: the first rmdir
        # recreates the file and fails; the cleanup must go round again.
        cache = Path(self.dir.name) / "director-log-cache.STRAGGLER"
        cache.mkdir()
        (cache / "recent.sqlite").write_text("x")
        script = self.stop_script(cache, '''
calls=0
rmdir() {
  calls=$((calls + 1))
  if [ "$calls" = 1 ]; then echo straggler >"$SURVIVAL_TARGET_FILE"; return 1; fi
  command rmdir "$@"
}
stop_director_log_cache
''')
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(cache.exists(), "a single cleanup pass left the directory behind: " + str(list(cache.glob("*"))))

    def test_loop_wiring(self):
        function = SOURCE.split("follow_director_hagga_handoffs() {", 1)[1].split("scan_deepdesert_loading_responses()", 1)[0]
        self.assertIn('TARGET_FILE="${SURVIVAL_TARGET_FILE:-}"', function)
        self.assertNotIn("TARGET_JSON=", function.split("3<<'PY'", 1)[0])
        # The refresh runs on its own cadence, started next to the other followers, so the age of
        # a grant's target does not depend on how long one pass of the serial main loop takes.
        self.assertIn("\nfollow_survival_target &\n", SOURCE)
        follower = SOURCE.split("follow_survival_target() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('kill -0 "$$"', follower)
        self.assertIn("refresh_survival_target_file", follower)
        main_loop = SOURCE.rsplit("while true; do\n  ensure_director_log_cache", 1)[1]
        self.assertNotIn("refresh_survival_target_file", main_loop, "a second writer would race the follower")

    def test_lookup_status_distinguishes_no_server_from_a_failed_query(self):
        function = SOURCE.split("survival_partition_target_json() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("|| return 1", function)
        self.assertIn('[ -n "$row" ] || return 2', function)


if __name__ == "__main__":
    unittest.main()
