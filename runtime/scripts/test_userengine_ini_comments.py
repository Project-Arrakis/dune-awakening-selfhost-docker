#!/usr/bin/env python3
"""Unit tests for UserEngine.ini comment placement in usersettings.py.

Guards the "comments before values" design: ENGINE_FIELD_INI_COMMENTS is the
single schema-level source of per-field ini comments, emitted directly beside
a surviving value by compiled_userengine_ini(). userengine_ini_text() (the
Advanced-editor "raw" document) is hand-written separately and must keep its
comment wording in sync -- check_comments_match_userengine_ini_text is the
drift guard referenced by the comment above userengine_ini_text()'s def.

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


class CommentDriftGuardTests(unittest.TestCase):
    def test_every_schema_comment_appears_in_userengine_ini_text(self):
        raw_all = usersettings.userengine_ini_text({})
        missing = [
            (field_id, line)
            for field_id, lines in usersettings.ENGINE_FIELD_INI_COMMENTS.items()
            for line in lines
            if f"; {line}" not in raw_all
        ]
        self.assertEqual(missing, [], f"ENGINE_FIELD_INI_COMMENTS drifted from userengine_ini_text(): {missing}")


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


if __name__ == "__main__":
    unittest.main()
