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

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
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

    FIELD_ID = "default_reconnect_grace_period_seconds"

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


class RetiredModifierAndCoriolisMetadataTests(ProfilePathTestCase):
    RETIRED_IDS = {
        "global_xp_multiplier",
        "global_fame_multiplier",
        "global_progression_speed_multiplier",
        "global_harvest_health_multiplier",
        "cutteray_hem_multiplier_per_node_tier_table",
        "global_damage_to_npcs_multiplier",
    }

    def test_retired_controls_are_absent_from_schema_and_generated_ini(self):
        self.assertTrue(self.RETIRED_IDS.isdisjoint(usersettings.MAP_FIELDS))
        profile = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\n"
            "m_GlobalXPMultiplier=100.0\n"
            "m_GlobalDamageToNpcsMultiplier=1000.0\n"
            "UnknownCommunitySetting=keep\n"
        )
        compiled = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        client = usersettings.client_game_ini(profile, MAP_NAME)
        for retired in ("m_GlobalXPMultiplier", "m_GlobalDamageToNpcsMultiplier"):
            self.assertNotIn(retired, compiled)
            self.assertNotIn(retired, client)
        self.assertIn("UnknownCommunitySetting=keep", compiled)
        self.assertIn("UnknownCommunitySetting=keep", client)

    def test_saving_profile_removes_only_retired_keys(self):
        profile = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\n"
            "m_GlobalFameMultiplier=3.0\n"
            "m_DefaultReconnectGracePeriodSeconds=600\n"
        )
        usersettings.write_profile(profile)
        saved = usersettings.PROFILE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("m_GlobalFameMultiplier", saved)
        self.assertIn("m_DefaultReconnectGracePeriodSeconds=600", saved)

    def test_coriolis_restart_metadata_names_its_map_process_scope(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.metadata(), 0)
        payload = json.loads(output.getvalue())
        field = next(row for row in payload["game"] if row["id"] == "restart_server_on_coriolis_cycle_end")
        self.assertEqual(field["label"], "Restart Map Process At Coriolis Cycle End")
        self.assertIn("does not queue a Console battlegroup restart", field["description"])


class StakingExtensionArrayTests(ProfilePathTestCase):
    """Staking timers are ten-element native arrays, exposed as one safe scalar."""

    FIELD_ID = "staking_unit_extension_default_times"
    KEY = "m_StakingUnitExtensionDefaultTimes"

    def assert_complete_array(self, rendered: str, value: str):
        lines = rendered.splitlines()
        self.assertEqual(lines.count(f"!{self.KEY}=ClearArray"), 1)
        self.assertEqual(lines.count(f".{self.KEY}={value}"), usersettings.STAKING_EXTENSION_ARRAY_LENGTH)
        self.assertFalse(any(line.startswith((f"{self.KEY}=", f"+{self.KEY}=", f"-{self.KEY}=")) for line in lines))

    def test_blank_value_preserves_funcom_packaged_defaults(self):
        rendered = usersettings.compiled_usergame_ini(usersettings.empty_profile(), MAP_NAME)
        self.assertNotIn(self.KEY, rendered)

    def test_scalar_is_compiled_as_a_complete_duplicate_preserving_array(self):
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "2.000000")
        self.assert_complete_array(usersettings.client_game_ini(profile, MAP_NAME), "2.000000")

    def test_map_and_partition_precedence_selects_one_complete_array(self):
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        usersettings.set_profile_field(profile, "map", MAP_NAME, "", self.FIELD_ID, "3")
        usersettings.set_profile_field(profile, "partition", MAP_NAME, PARTITION_ID, self.FIELD_ID, "4")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "3.000000")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME, PARTITION_ID), "4.000000")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME, OTHER_PARTITION_ID), "3.000000")

    def test_saving_cleans_legacy_array_fragments(self):
        profile = usersettings.parse_profile_text(
            f"[Global:{usersettings.BUILDING_SETTINGS_SECTION}]\n"
            f"{self.KEY}=1\n-{self.KEY}=60.000000\n.{self.KEY}=120.000000\n"
        )
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        self.assertEqual(profile["sections"][0]["lines"], [f"{self.KEY}=2.000000"])
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "2.000000")

    def test_invalid_or_dangerously_extreme_values_are_rejected(self):
        for value in ("0", "nan", "604801"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                usersettings.normalize_staking_extension_seconds(value)


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


class PartitionEngineValuesManyCommandTests(ProfilePathTestCase):
    """`partition-engine-values-many` backs both sietches.sh's display-name
    resolution (dimensions()/runtime_args()) and the console API's
    resolvePartitionDisplayNamesFromRuntime -- one profile read resolving
    server_display_name (Bgd.ServerDisplayName) for several partitions at
    once. It must apply the exact same partition -> map -> global precedence
    as the singular partition-engine-values command, not a simplified or
    stale copy of it."""

    FIELD_ID = "server_display_name"

    def _spec(self):
        return usersettings.ENGINE_FIELDS[self.FIELD_ID]

    def _run_command(self, map_name, partition_ids):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            usersettings.partition_engine_values_many_command(map_name, partition_ids)
        return json.loads(buffer.getvalue())

    def test_resolves_distinct_partitions_in_one_call(self):
        # server_display_name is deliberately excluded from SCOPED_ENGINE_FIELDS
        # (see usersettings.py:516-519), so unlike most engine fields it has no
        # per-map override tier -- only global (every Sietch in the battlegroup)
        # and per-partition (the battlegroup editor / "sietches set-display"),
        # matching the UserEngine.ini comment ("Set the name of every Sietch in
        # the battlegroup ... use the battlegroup editor instead" for per-Sietch
        # names). This asserts partition vs. global, not partition vs. map.
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "Battlegroup Wide Name")
        usersettings.profile_set_key(profile, "partition_engine", section, key, "Named Sietch", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID, OTHER_PARTITION_ID])

        # The partition with its own override wins over the battlegroup-wide name...
        self.assertEqual(result[PARTITION_ID][self.FIELD_ID], "Named Sietch")
        # ...while its sibling, with no override of its own, still falls
        # through to the global name rather than coming back empty.
        self.assertEqual(result[OTHER_PARTITION_ID][self.FIELD_ID], "Battlegroup Wide Name")

    def test_matches_the_singular_command_for_the_same_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "Global Name")
        usersettings.profile_set_key(profile, "partition_engine", section, key, "Partition Name", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID, OTHER_PARTITION_ID])
        reloaded = usersettings.read_profile()

        self.assertEqual(
            result[PARTITION_ID][self.FIELD_ID],
            usersettings.profile_partition_engine_values(reloaded, MAP_NAME, PARTITION_ID)[self.FIELD_ID],
        )
        self.assertEqual(
            result[OTHER_PARTITION_ID][self.FIELD_ID],
            usersettings.profile_partition_engine_values(reloaded, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID],
        )
        # Sanity: the sibling with no partition override actually fell through
        # to the global name, so this isn't trivially true for both sides.
        self.assertEqual(result[OTHER_PARTITION_ID][self.FIELD_ID], "Global Name")

    def test_a_name_set_via_sietches_set_display_is_visible_in_bulk(self):
        # `sietches set-display` writes into this exact field via
        # `usersettings.py partition-engine-set ... server_display_name`
        # (see runtime/scripts/sietches.sh) -- simulate that write directly
        # through the same profile API rather than shelling out.
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "partition_engine", section, key, "The Kulon Show", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID])
        self.assertEqual(result[PARTITION_ID][self.FIELD_ID], "The Kulon Show")


if __name__ == "__main__":
    unittest.main()
