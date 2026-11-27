"""Native CLI regressions; fake broker/database only, never spawn real vehicles."""
from pathlib import Path
import shlex
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "runtime/scripts/admin-tools.sh").read_text()
FUNCTIONS = SOURCE.split('cmd="${1:-help}"', 1)[0].replace(
    'cd "$(dirname "$0")/../.."', f"cd {shlex.quote(str(ROOT))}", 1
)
ROW = "Online|Survival_1|1|server-one|0|0|0|0|0|0|1|0|Pawn|123|10"


class SpawnSafetyTests(unittest.TestCase):
    def run_shell(self, body):
        return subprocess.run(["bash", "-s"], input=FUNCTIONS + "\n" + body,
                              text=True, capture_output=True, cwd=ROOT, timeout=10)

    def test_waits_for_new_serial_and_uses_updated_snapshot(self):
        new = ROW.replace("|0|0|0|0|0|0|1|", "|20|0|0|0|0|0|1|").removesuffix("10") + "11"
        result = self.run_shell(f"""
SECONDS=0
sleep() {{ SECONDS=$((SECONDS+1)); }}
player_position_for_fls() {{ if [ "$SECONDS" -lt 2 ]; then printf '%s\\n' '{ROW}'; else printf '%s\\n' '{new}'; fi; }}
fresh_player_position_for_fls synthetic '{ROW}'
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), new)
        self.assertIn("stand still", result.stderr)

    def test_no_heartbeat_never_accepts_repeated_stale_position(self):
        result = self.run_shell(f"""
SECONDS=0
sleep() {{ SECONDS=$((SECONDS+60)); }}
player_position_for_fls() {{ printf '%s\\n' '{ROW}'; }}
fresh_player_position_for_fls synthetic '{ROW}'
""")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Nothing was spawned", result.stderr)

    def test_native_spawn_uses_new_position_not_old_snapshot(self):
        new = ROW.replace("|0|0|0|0|0|0|1|", "|20|0|0|0|0|0|1|").removesuffix("10") + "11"
        result = self.run_shell(f"""
SECONDS=0
sleep() {{ SECONDS=$((SECONDS+1)); }}
resolve_vehicle() {{ printf '%s\\n' '{{"id":"Sandbike","actor_class":"Bike","template":"T1"}}'; }}
resolve_player_id() {{ printf 'synthetic'; }}
player_position_for_fls() {{ if [ "$SECONDS" -lt 2 ]; then printf '%s\\n' '{ROW}'; else printf '%s\\n' '{new}'; fi; }}
spawn_vehicle_at_command() {{ printf 'verified-placement=%s,%s,%s\\n' "$4" "$5" "$6"; }}
spawn_vehicle_command synthetic Sandbike T1 1000
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("verified-placement=1020.0,0.0,0.0", result.stdout)
        self.assertNotIn("Computed spawn point", result.stdout)

    def test_invalid_saved_coordinates_fail_closed(self):
        result = self.run_shell("compute_spawn_in_front nan 0 0 0 0 0 1 1000")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Nothing was spawned", result.stderr)

    def test_travel_logout_and_pawn_replacement_abort(self):
        for changed in (ROW.replace("Online", "Offline"), ROW.replace("|1|server-one|", "|2|server-two|"), ROW.replace("|123|10", "|124|11")):
            with self.subTest(snapshot=changed):
                result = self.run_shell(f"""
sleep() {{ :; }}
player_position_for_fls() {{ printf '%s\\n' '{changed}'; }}
fresh_player_position_for_fls synthetic '{ROW}'
""")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("Nothing was spawned", result.stderr)

    def test_missing_serial_fails_closed(self):
        result = self.run_shell(f"fresh_player_position_for_fls synthetic '{ROW.removesuffix('10')}'")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cannot verify", result.stderr)

    def test_publish_success_consumes_large_output_without_sigpipe(self):
        result = self.run_shell("""
require_token_file() { :; }
require_rmq_game_running() { :; }
build_outer_b64() { printf 'AA=='; }
docker() { printf 'publish=ok\\n'; printf '%200000s\\n' ''; }
publish_inner_json '{}' synthetic >/dev/null
""")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_publish_missing_ack_and_process_error_still_fail(self):
        for response in ("printf 'publish=error\\n'", "printf 'broker unavailable\\n'; return 9"):
            result = self.run_shell("""
require_token_file() { :; }
require_rmq_game_running() { :; }
build_outer_b64() { printf 'AA=='; }
docker() { """ + response + """; }
publish_inner_json '{}' synthetic >/dev/null
""")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("RabbitMQ publish", result.stderr)

    def test_placement_fields_not_written_to_audit_summary(self):
        result = self.run_shell("""redact_payload_summary '{"PlayerId":"synthetic","X":1,"Y":2,"Z":3,"Rotation":4,"TemplateName":"T0"}'""")
        self.assertEqual(result.returncode, 0, result.stderr)
        import json
        payload = json.loads(result.stdout)
        for key in ("PlayerId", "X", "Y", "Z", "Rotation"):
            self.assertEqual(payload[key], "<redacted>")
        self.assertEqual(payload["TemplateName"], "T0")


if __name__ == "__main__":
    unittest.main()
