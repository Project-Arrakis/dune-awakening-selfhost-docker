#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
python3 - "$repo_root" <<'PY'
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(sys.argv[1]) / "runtime/scripts"))
import usersettings as settings


class BattlEyeSettings(unittest.TestCase):
    def test_native_default_is_preserved(self):
        profile = settings.parse_profile_text("")
        self.assertEqual(settings.profile_engine_values(profile)["battleye_enabled"], "False")
        self.assertNotIn("BattlEye.Enabled=", settings.compiled_userengine_ini(profile))

    def test_existing_advanced_override_remains_effective(self):
        profile = settings.parse_profile_text("[Engine:ConsoleVariables]\nBattlEye.Enabled=True\n")
        self.assertEqual(settings.profile_engine_values(profile)["battleye_enabled"], "True")
        self.assertIn("BattlEye.Enabled=True", settings.compiled_userengine_ini(profile))

    def test_map_and_partition_overrides_use_existing_precedence(self):
        profile = settings.parse_profile_text(
            "[Engine:ConsoleVariables]\nBattlEye.Enabled=True\n"
            "[MapEngine:Survival_1:ConsoleVariables]\nBattlEye.Enabled=False\n"
            "[PartitionEngine:Survival_1:3:ConsoleVariables]\nBattlEye.Enabled=True\n"
        )
        self.assertNotIn("BattlEye.Enabled=", settings.compiled_userengine_ini(profile, "Survival_1", "2"))
        self.assertIn("BattlEye.Enabled=True", settings.compiled_userengine_ini(profile, "Survival_1", "3"))
        self.assertIn("BattlEye.Enabled=True", settings.compiled_userengine_ini(profile, "DeepDesert_1", "1"))

    def test_boolean_metadata_stays_server_only(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            settings.metadata()
        fields = json.loads(output.getvalue())["engine"]
        field = next(field for field in fields if field["id"] == "battleye_enabled")
        self.assertEqual(field["type"], "boolean")
        self.assertEqual(field["label"], "BattlEye Anti-Cheat")
        self.assertEqual(field["clientFile"], "")
        profile = settings.parse_profile_text("[Engine:ConsoleVariables]\nBattlEye.Enabled=True\n")
        self.assertNotIn("BattlEye", settings.client_engine_ini(profile))

    def test_materialization_uses_userengine_and_preserves_custom_settings(self):
        profile = settings.parse_profile_text("[Engine:ConsoleVariables]\nBattlEye.Enabled=True\n")
        with tempfile.TemporaryDirectory(prefix="dune-battleye-settings-") as root:
            saved = Path(root)
            settings.write_compiled_userengine(saved / "UserSettings/UserEngine.ini", profile)
            custom = saved / "Config/LinuxServer/ServerCustomSettings.ini"
            custom.parent.mkdir(parents=True)
            original = "[/Script/DuneSandbox.UserServerCustomSettings]\nDifficultyLevel=Custom\nIsBattlEyeEnabled=False\n"
            custom.write_text(original)
            settings.write_server_custom_settings(saved, profile, "Survival_1", "1")
            self.assertEqual(custom.read_text(), original)
            self.assertIn("BattlEye.Enabled=True", (saved / "UserSettings/UserEngine.ini").read_text())


sys.argv = [sys.argv[0]]
unittest.main()
PY
