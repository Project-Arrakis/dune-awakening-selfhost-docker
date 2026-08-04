#!/usr/bin/env python3
"""Unit tests for UserEngine.ini comment placement and Advanced-tab rendering
in usersettings.py.

CommentBeforeValueTests guards the "comments before values" design:
ENGINE_FIELD_INI_COMMENTS is the single schema-level source of per-field ini
comments, emitted directly beside a surviving value by compiled_userengine_ini().

ProfileEngineTextTests guards profile_engine_text() (the Advanced UserEngine.ini
tab): Port/IGWPort/Bgd.ServerDisplayName/Bgd.ServerLoginPassword are always
synthesized from schema (server identity, not tunables), while everything else
is a sparse pass-through of what's actually stored in the profile -- matching
profile_game_text()'s behavior.

Run directly:
    python3 runtime/scripts/test_userengine_ini_comments.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import usersettings  # noqa: E402


class CommentBeforeValueTests(unittest.TestCase):
    def test_all_defaults_produces_no_orphaned_comment(self):
        compiled = usersettings.compiled_userengine_ini({})
        self.assertNotIn("; Mining multipliers", compiled)

    def test_comment_sits_directly_above_its_value(self):
        profile = {}
        section, key, _default = usersettings.ENGINE_FIELDS["mining_output_multiplier"]
        usersettings.profile_set_key(profile, "engine", section, key, "7.7")
        lines = usersettings.compiled_userengine_ini(profile).splitlines()
        value_idx = lines.index("Dune.GlobalMiningOutputMultiplier=7.7")
        self.assertEqual(lines[value_idx - 1], "; Mining multipliers")

    def test_shared_comment_appears_once_for_the_one_surviving_key(self):
        profile = {}
        section, key, _default = usersettings.ENGINE_FIELDS["vehicle_mining_output_multiplier"]
        usersettings.profile_set_key(profile, "engine", section, key, "3.5")
        lines = usersettings.compiled_userengine_ini(profile).splitlines()
        self.assertEqual(lines.count("; Mining multipliers"), 1)
        value_idx = lines.index("Dune.GlobalVehicleMiningOutputMultiplier=3.5")
        self.assertEqual(lines[value_idx - 1], "; Mining multipliers")
        self.assertFalse(any(l.startswith("Dune.GlobalMiningOutputMultiplier=") for l in lines))
        self.assertFalse(any(l.startswith("SecurityZones.PvpResourceMultiplier=") for l in lines))


class ProfileEngineTextTests(unittest.TestCase):
    """profile_engine_text() reads/writes PROFILE_PATH internally (it has no
    profile-dict parameter, matching profile_game_text()'s signature), so these
    tests redirect PROFILE_PATH to a throwaway tempfile for their duration --
    never touching runtime/generated/gameplay-profile.ini, regardless of where
    this file is run from."""

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self._original_path = usersettings.PROFILE_PATH
        usersettings.PROFILE_PATH = Path(self._tmpdir.name) / "gameplay-profile.ini"

    def tearDown(self):
        usersettings.PROFILE_PATH = self._original_path
        self._tmpdir.cleanup()

    def test_fresh_profile_synthesizes_url_and_identity_placeholders_only(self):
        usersettings.write_profile(usersettings.empty_profile())
        text = usersettings.profile_engine_text()
        self.assertIn("[Engine:URL]", text)
        self.assertIn("Port=7777", text)
        self.assertIn("IGWPort=7888", text)
        self.assertIn(';Bgd.ServerDisplayName="My Arrakis, My Dune"', text)
        self.assertIn(';Bgd.ServerLoginPassword="Sandworm"', text)
        self.assertNotIn("Sandstorm.Enabled", text)
        self.assertNotIn("Dune.GlobalMiningOutputMultiplier", text)

    def test_one_changed_field_shows_only_that_field_plus_identity(self):
        profile = usersettings.empty_profile()
        section, key, _default = usersettings.ENGINE_FIELDS["mining_output_multiplier"]
        usersettings.profile_set_key(profile, "engine", section, key, "7.7")
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertIn("Dune.GlobalMiningOutputMultiplier=7.7", text)
        self.assertIn("Port=7777", text)
        self.assertIn(';Bgd.ServerDisplayName="My Arrakis, My Dune"', text)
        self.assertNotIn("Sandstorm.Enabled", text)
        self.assertNotIn("Dune.GlobalVehicleMiningOutputMultiplier", text)

    def test_saved_display_name_renders_once_not_duplicated(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", "ConsoleVariables", "Bgd.ServerDisplayName", '"Arrakeen"')
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertEqual(text.count("Bgd.ServerDisplayName="), 1)
        self.assertIn('Bgd.ServerDisplayName="Arrakeen"', text)

    def test_round_trips_through_advanced_editor_save(self):
        import base64
        usersettings.write_profile(usersettings.empty_profile())
        raw = usersettings.profile_engine_text()
        encoded = base64.b64encode(raw.encode("utf-8")).decode("ascii")
        self.assertEqual(usersettings.profile_engine_write_encoded(encoded), 0)
        profile = usersettings.read_profile()
        compiled = usersettings.compiled_userengine_ini(profile)
        self.assertIn("Port=7777", compiled)
        self.assertIn("IGWPort=7888", compiled)


if __name__ == "__main__":
    unittest.main()
