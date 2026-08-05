#!/usr/bin/env python3
"""Unit tests for the Global -> Map -> Partition (UserGame) and
Global -> Map -> Partition (UserEngine, internally Engine -> MapEngine ->
PartitionEngine) override-precedence chains in usersettings.py.

Each tier's merge function only overlays a value when that tier actually has
one stored -- an unset tier must fall through to the next broader tier's
value (or the schema default if nothing is set anywhere). These tests pin
that behavior down directly against the merge functions
(profile_global_values/profile_map_values/profile_partition_values and
profile_engine_values/profile_map_engine_values/profile_partition_engine_values),
then confirm the same precedence survives into the actually-deployed
compiled_usergame_ini()/compiled_userengine_ini() output.

Before this file, override precedence was only exercised by
profile_selftest() -- a manual CLI self-test, not run in CI -- and even
that only covered Global->Map for UserGame and both UserEngine hops; a
UserGame Partition override winning over a Map override was never verified
anywhere.

Run directly:
    python3 runtime/scripts/test_profile_override_precedence.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import usersettings  # noqa: E402

MAP_NAME = "Survival_1"
PARTITION_ID = "3"
OTHER_PARTITION_ID = "7"


class ProfilePathTestCase(unittest.TestCase):
    """Shared PROFILE_PATH redirection so these tests never touch
    runtime/generated/gameplay-profile.ini, regardless of where this file is
    run from -- matching ProfileEngineTextTests in
    test_userengine_ini_comments.py. Only usersettings.write_profile() /
    read_profile() consult PROFILE_PATH; the merge functions used below take
    a profile dict directly and need no redirection, but write_profile() is
    used to prove a real save/reload round trip preserves precedence too."""

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self._original_path = usersettings.PROFILE_PATH
        usersettings.PROFILE_PATH = Path(self._tmpdir.name) / "gameplay-profile.ini"

    def tearDown(self):
        usersettings.PROFILE_PATH = self._original_path
        self._tmpdir.cleanup()


class GameFieldOverridePrecedenceTests(ProfilePathTestCase):
    """UserGame.ini's Global -> Map -> Partition chain."""

    FIELD_ID = "global_xp_multiplier"

    def _spec(self):
        return usersettings.MAP_FIELDS[self.FIELD_ID]

    def test_unset_field_falls_through_to_schema_default_at_every_tier(self):
        _section, _key, default = self._spec()
        profile = usersettings.empty_profile()
        self.assertEqual(usersettings.profile_global_values(profile)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], default)

    def test_map_overrides_global_but_not_a_different_map(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "2.0")

        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")
        # A sibling map with no override of its own still sees the Global value.
        self.assertEqual(usersettings.profile_map_values(profile, "Survival_2")[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_global_values(profile)[self.FIELD_ID], "2.0")

    def test_partition_overrides_map_but_not_a_sibling_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)

        # Before any Partition override, both partitions inherit the Map value.
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")

        usersettings.profile_set_key(profile, "partition", section, key, "4.0", MAP_NAME, PARTITION_ID)
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")
        # The sibling partition and the map itself are unaffected.
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")

    def test_compiled_ini_reflects_the_winning_tier_at_each_level(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition", section, key, "4.0", MAP_NAME, PARTITION_ID)

        compiled_map_only = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertIn(f"{key}=3.0", compiled_map_only)
        self.assertNotIn(f"{key}=2.0", compiled_map_only)
        self.assertNotIn(f"{key}=4.0", compiled_map_only)

        compiled_partition = usersettings.compiled_usergame_ini(profile, MAP_NAME, PARTITION_ID)
        self.assertIn(f"{key}=4.0", compiled_partition)
        self.assertNotIn(f"{key}=3.0", compiled_partition)

        compiled_sibling_partition = usersettings.compiled_usergame_ini(profile, MAP_NAME, OTHER_PARTITION_ID)
        self.assertIn(f"{key}=3.0", compiled_sibling_partition)
        self.assertNotIn(f"{key}=4.0", compiled_sibling_partition)


class EngineFieldOverridePrecedenceTests(ProfilePathTestCase):
    """UserEngine.ini's Global -> Map -> Partition chain (internally
    Engine -> MapEngine -> PartitionEngine; the Advanced tab displays these
    with the same Global/Map/Partition words UserGame uses, see
    ENGINE_HEADER_DISPLAY_NAMES, but the underlying merge functions below are
    keyed by the internal names)."""

    FIELD_ID = "mining_output_multiplier"

    def _spec(self):
        return usersettings.ENGINE_FIELDS[self.FIELD_ID]

    def test_unset_field_falls_through_to_schema_default_at_every_tier(self):
        _section, _key, default = self._spec()
        profile = usersettings.empty_profile()
        self.assertEqual(usersettings.profile_engine_values(profile)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], default)

    def test_map_overrides_global_but_not_a_different_map(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "2.0")

        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, "Survival_2")[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_engine_values(profile)[self.FIELD_ID], "2.0")

    def test_partition_overrides_map_but_not_a_sibling_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)

        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")

        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")

    def test_compiled_ini_reflects_the_winning_tier_at_each_level(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)

        compiled_global = usersettings.compiled_userengine_ini(profile)
        self.assertIn(f"{key}=2.0", compiled_global)

        compiled_map_only = usersettings.compiled_userengine_ini(profile, MAP_NAME)
        self.assertIn(f"{key}=3.0", compiled_map_only)
        self.assertNotIn(f"{key}=2.0", compiled_map_only)
        self.assertNotIn(f"{key}=4.0", compiled_map_only)

        compiled_partition = usersettings.compiled_userengine_ini(profile, MAP_NAME, PARTITION_ID)
        self.assertIn(f"{key}=4.0", compiled_partition)
        self.assertNotIn(f"{key}=3.0", compiled_partition)

        compiled_sibling_partition = usersettings.compiled_userengine_ini(profile, MAP_NAME, OTHER_PARTITION_ID)
        self.assertIn(f"{key}=3.0", compiled_sibling_partition)
        self.assertNotIn(f"{key}=4.0", compiled_sibling_partition)

    def test_precedence_survives_a_real_save_and_reload_round_trip(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        reloaded = usersettings.read_profile()
        self.assertEqual(usersettings.profile_engine_values(reloaded)[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_map_engine_values(reloaded, MAP_NAME)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_engine_values(reloaded, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")


if __name__ == "__main__":
    unittest.main()
