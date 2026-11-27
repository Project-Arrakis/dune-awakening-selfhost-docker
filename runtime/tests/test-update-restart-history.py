"""Exercise the actual updater completion branches with isolated lifecycle stubs."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
UPDATE = (SCRIPTS / "update.sh").read_text()
TAIL = UPDATE[UPDATE.index('if [ "$cmd" = "install" ]; then\n  echo "Install/bootstrap step finished."'):]


class UpdateRestartHistoryTests(unittest.TestCase):
    def run_branch(self, command="run", stopped="0", start_exit=0, history_fails=False):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            scripts = root / "runtime/scripts"
            scripts.mkdir(parents=True)
            for name, body in [("start-all.sh", f"exit {start_exit}"),
                               ("completion.sh", "set -euo pipefail\nstop_temporary_postgres() { :; }\n" + TAIL)]:
                path = scripts / name
                path.write_text("#!/usr/bin/env bash\n" + body + "\n")
                path.chmod(0o755)
            shutil.copy(SCRIPTS / "restart-history.sh", scripts)
            history = root / "history.jsonl"
            if history_fails:
                history.mkdir()
            result = subprocess.run(["bash", str(scripts / "completion.sh")], cwd=root,
                                    env={**os.environ, "cmd": command, "stack_was_stopped": stopped,
                                         "DUNE_RESTART_HISTORY_FILE": str(history)},
                                    capture_output=True, text=True)
            rows = [json.loads(line) for line in history.read_text().splitlines()] if history.is_file() else []
            return result, rows

    def test_running_battlegroup_update_records_one_restart(self):
        result, rows = self.run_branch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["scope"], rows[0]["source"], rows[0]["reason"], rows[0]["result"]),
                         ("battlegroup", "Game Update", "Game update", "Succeeded"))

    def test_failed_restart_preserves_exit_and_records_failure(self):
        result, rows = self.run_branch(start_exit=7)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["result"], "Failed")

    def test_stopped_battlegroup_has_no_restart_entry(self):
        result, rows = self.run_branch(stopped="1")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(rows, [])

    def test_bootstrap_has_no_restart_entry(self):
        result, rows = self.run_branch(command="install")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(rows, [])

    def test_journal_failure_does_not_fail_update(self):
        result, rows = self.run_branch(history_fails=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("WARN Game update restart history", result.stderr)
        self.assertEqual(rows, [])

    def test_no_update_and_assets_only_exit_before_restart_logging(self):
        no_update = UPDATE.index('echo "No update available. Nothing changed."')
        assets_only = UPDATE.index('echo "Game files and images are installed. No database work was performed."')
        journal = UPDATE.index('runtime/scripts/restart-history.sh record battlegroup')
        self.assertIn("exit 0", UPDATE[no_update:no_update + 120])
        self.assertIn("exit 0", UPDATE[assets_only:assets_only + 260])
        self.assertGreater(journal, assets_only)


if __name__ == "__main__":
    unittest.main()
