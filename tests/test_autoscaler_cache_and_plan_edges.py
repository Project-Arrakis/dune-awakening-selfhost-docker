#!/usr/bin/env python3
"""Edge cases the upstream autoscaler/chat-binding tests do not cover (issue #1162).

Kept in its own file so tests/test_autoscaler_log_cache.py and
tests/test_chat_binding_batch.py stay identical to upstream's and the next merge
of them stays mechanical.
"""
import importlib.util
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLAN = load("binding_plan", "runtime/scripts/chat-binding-plan.py")
CACHE = load("director_cache", "runtime/scripts/director-log-cache.py")


def plan_lines(count):
    return "".join(f"chat.map\tkey{i}\tuser{i}_queue\n" for i in range(count))


def run_plan(count):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "plan"
        path.write_text(plan_lines(count), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(ROOT / "runtime/scripts/chat-binding-plan.py"), str(path)],
            capture_output=True, text=True,
        )
    return result


class BindingPlanChunking(unittest.TestCase):
    """The plan is applied in batches of 200 to bound argv size and per-operation broker work."""

    def counts(self, total):
        result = run_plan(total)
        self.assertEqual(result.returncode, 0, result.stderr)
        return [line.count("{binding,") for line in result.stdout.splitlines()]

    def test_batch_boundaries(self):
        self.assertEqual(self.counts(1), [1])
        self.assertEqual(self.counts(200), [200])
        self.assertEqual(self.counts(201), [200, 1])
        self.assertEqual(self.counts(450), [200, 200, 50])

    def test_every_binding_lands_in_exactly_one_batch(self):
        result = run_plan(450)
        for i in range(450):
            self.assertEqual(result.stdout.count(f'<<"user{i}_queue">>'), 1, f"user{i}_queue")

    def test_an_invalid_line_stops_the_whole_run_before_anything_is_printed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan"
            # 200 good lines (a full first batch), then a line that tries to break out of the Erlang term.
            path.write_text(plan_lines(200) + 'chat.map\tkey"}]\tuser_queue\n', encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(ROOT / "runtime/scripts/chat-binding-plan.py"), str(path)],
                capture_output=True, text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid chat binding plan", result.stderr)

    def test_destination_must_be_a_queue(self):
        with self.assertRaises(ValueError):
            PLAN.expression("chat.map\tkey\tnot-a-queue\n")
        with self.assertRaises(ValueError):
            PLAN.expression("\tkey\tuser_queue\n")  # empty exchange


class DirectorLogTimestamps(unittest.TestCase):
    """`append` silently drops a line whose timestamp it cannot parse."""

    def stored(self, *lines):
        db = CACHE.connect(":memory:")
        self.addCleanup(db.close)
        CACHE.append(db, list(lines))
        return [row[0] for row in db.execute("select line from logs order by id")]

    def test_docker_nanosecond_timestamps_are_kept(self):
        # `docker logs --timestamps` emits RFC3339Nano (up to 9 fractional digits). The orchestrator
        # image's Python (ubuntu:24.04 -> 3.12) parses these; an interpreter that cannot would drop
        # EVERY real line and leave the cache empty while scanners see "no evidence".
        nano = "2026-10-08T12:00:00.123456789Z director says hello"
        micro = "2026-10-08T12:00:01.123456Z second line"
        whole = "2026-10-08T12:00:02Z third line"
        self.assertEqual(self.stored(nano, micro, whole), [nano, micro, whole])

    def test_lines_without_a_leading_timestamp_are_dropped(self):
        # Documented behaviour change from the old `docker logs` file: a multi-line message's
        # continuation lines carry no timestamp and are not cached.
        good = "2026-10-08T12:00:00Z first"
        self.assertEqual(self.stored(good, "  at SomeStack.frame()", "", "not-a-stamp text"), [good])


if __name__ == "__main__":
    unittest.main()
