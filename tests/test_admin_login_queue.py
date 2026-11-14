"""Native login-queue safety regressions with fake broker/database only."""
from pathlib import Path
import shlex
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "runtime/scripts/admin-tools.sh").read_text()
FUNCTIONS = SOURCE.split('cmd="${1:-help}"', 1)[0].replace(
    'cd "$(dirname "$0")/../.."', f"cd {shlex.quote(str(ROOT))}", 1
)


class LoginQueueSafetyTests(unittest.TestCase):
    def run_repair(self, *, consumers="0", state="running", owner="", status="Offline", extra="", force=True):
        body = f"""
rmq_login_queue_row() {{ printf '%s\\t%s\\t%s\\t%s\\t%s\\n' synthetic_queue {shlex.quote(consumers)} 0 {shlex.quote(state)} {shlex.quote(owner)}; }}
player_status_for_fls() {{ printf '%s\\n' {shlex.quote(status + '|Survival_1')}; }}
audit_admin_action() {{ :; }}
docker() {{ printf 'DELETE_CALL'; printf ' %s' "$@"; printf '\\n'; }}
{extra}
repair_login_queue_command synthetic --yes {'--force' if force else ''}
"""
        return subprocess.run(["bash", "-s"], input=FUNCTIONS + "\n" + body,
                              text=True, capture_output=True, cwd=ROOT, timeout=10)

    def test_force_does_not_delete_consumed_queue(self):
        result = self.run_repair(consumers="1", status="Online")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DELETE_CALL", result.stdout)
        self.assertIn("still in use", result.stderr)
        self.assertIn("consumers=1", result.stdout)

    def test_owner_without_consumer_is_still_active(self):
        result = self.run_repair(owner="<rabbit@fixture.1.2.3>")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DELETE_CALL", result.stdout)
        self.assertIn("Client connection: Connected", result.stdout)

    def test_invalid_count_and_non_running_state_fail_closed(self):
        for kwargs in ({"consumers": "unknown"}, {"state": "down"}):
            with self.subTest(kwargs=kwargs):
                result = self.run_repair(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("DELETE_CALL", result.stdout)

    def test_idle_queue_uses_atomic_broker_guard(self):
        result = self.run_repair(status="Online", extra="""
docker() { [ "$*" = 'exec dune-rmq-game rabbitmqctl -q delete_queue synthetic_queue --if-unused' ]; }
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Deleted stale login queue", result.stdout)

    def test_online_db_without_force_still_refuses(self):
        result = self.run_repair(status="Online", force=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("DELETE_CALL", result.stdout)

    def test_absent_queue_is_idempotent(self):
        result = self.run_repair(extra="rmq_login_queue_row() { return 1; }")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("DELETE_CALL", result.stdout)
        self.assertIn("Nothing needs to be deleted", result.stdout)

    def test_inspection_error_is_not_reported_as_absent(self):
        result = self.run_repair(extra="rmq_login_queue_row() { return 2; }")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not inspect", result.stderr)
        self.assertNotIn("No RabbitMQ login queue", result.stdout)

    def test_reconnecting_consumer_rejected_by_broker(self):
        result = self.run_repair(extra="docker() { printf 'precondition_failed: queue in use'; return 65; }")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("queue in use", result.stderr)
        self.assertIn("Active queues are never forcibly deleted", result.stderr)

    def test_queue_disappears_between_check_and_delete(self):
        result = self.run_repair(extra="""
docker() { printf 'not_found'; return 65; }
rmq_login_queue_row() {
  if [ -f "$queue_state_marker" ]; then return 1; fi
  touch "$queue_state_marker"
  printf 'synthetic_queue\\t0\\t0\\trunning\\t\\n'
}
queue_state_marker="$(mktemp)"
rm "$queue_state_marker"
trap 'rm -f "$queue_state_marker"' EXIT
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already gone", result.stdout)

    def test_listing_failure_has_distinct_return_code(self):
        result = subprocess.run(
            ["bash", "-s"], input=FUNCTIONS + "\nrmq_login_queues() { return 1; }\nrmq_login_queue_row synthetic_queue\n",
            text=True, capture_output=True, cwd=ROOT, timeout=10)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
