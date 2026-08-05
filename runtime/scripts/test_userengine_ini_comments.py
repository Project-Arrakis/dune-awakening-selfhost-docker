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

import base64
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

    @staticmethod
    def _encode(raw_text: str) -> str:
        return base64.b64encode(raw_text.encode("utf-8")).decode("ascii")

    def _save_engine(self, raw_text: str) -> None:
        self.assertEqual(usersettings.profile_engine_write_encoded(self._encode(raw_text)), 0)

    def _save_game(self, raw_text: str) -> None:
        self.assertEqual(usersettings.profile_game_write_encoded(self._encode(raw_text)), 0)

    def test_fresh_profile_synthesizes_url_and_identity_placeholders_only(self):
        usersettings.write_profile(usersettings.empty_profile())
        text = usersettings.profile_engine_text()
        self.assertIn("[Global:URL]", text)
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
        usersettings.write_profile(usersettings.empty_profile())
        raw = usersettings.profile_engine_text()
        self._save_engine(raw)
        profile = usersettings.read_profile()
        compiled = usersettings.compiled_userengine_ini(profile)
        self.assertIn("Port=7777", compiled)
        self.assertIn("IGWPort=7888", compiled)

    def test_unset_identity_placeholders_do_not_duplicate_after_round_trip(self):
        # Regression test: saving the synthesized document back verbatim (as a real
        # Advanced-tab save does) used to store the identity comments/placeholder
        # lines as literal "other" content, which then got re-synthesized AND
        # passed through on the next read -- duplicating them. Caught via a live
        # end-to-end check against the real console/api server, not by any single
        # round-trip unit test until this one.
        usersettings.write_profile(usersettings.empty_profile())
        first = usersettings.profile_engine_text()
        self._save_engine(first)
        second = usersettings.profile_engine_text()
        self.assertEqual(second, first)
        self.assertEqual(second.count('Bgd.ServerDisplayName="My Arrakis, My Dune"'), 1)
        self.assertEqual(second.count('Bgd.ServerLoginPassword="Sandworm"'), 1)
        self.assertEqual(second.count("; Set the name of every Sietch in the battlegroup"), 1)
        self.assertEqual(second.count("; Set a password for every Sietch in the battlegroup"), 1)

    def test_no_blank_line_growth_when_a_map_section_follows_console_variables(self):
        # Regression test: the previous test above didn't catch this because an
        # empty profile's [Global:ConsoleVariables] is the LAST section in the
        # document, so trailing blank-line growth got masked by rstrip(). Once a
        # Map-tier section follows it, growth becomes visible: each round trip
        # used to add one more blank line to [Global:ConsoleVariables] because the
        # identity synthesis's own "" separator got saved back as literal content
        # and re-added on top of on every subsequent read.
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "map_engine", "ConsoleVariables", "Sandstorm.Enabled", "0", "Survival_1")
        usersettings.write_profile(profile)
        first = usersettings.profile_engine_text()
        self._save_engine(first)
        second = usersettings.profile_engine_text()
        self._save_engine(second)
        third = usersettings.profile_engine_text()
        self.assertEqual(first, second)
        self.assertEqual(second, third)

    def test_blank_line_between_custom_cvars_survives_round_trip(self):
        # Regression test: the blank-line-growth fix above used to strip EVERY
        # blank line found under [Global:ConsoleVariables], not just the identity
        # synthesis's own separator -- silently collapsing spacing an admin added
        # between their own unrelated custom cvars on the very next read.
        profile = usersettings.empty_profile()
        # Hand-craft the stored lines directly (profile_set_key alone can't produce a
        # blank line between two keys) to simulate an admin's manually-saved spacing.
        usersettings.find_profile_section(profile, "engine", "ConsoleVariables", create=True)["lines"] = [
            "Custom.A=1", "", "Custom.B=2",
        ]
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertIn("Custom.A=1\n\nCustom.B=2", text)

    def test_identity_placeholders_do_not_leak_into_compiled_ini(self):
        # Regression test: profile_engine_text() correctly hides the unset-identity
        # placeholder lines from the Advanced tab, but after a round-trip save they
        # used to still get compiled into the real deployed per-server ini as stray
        # lines, since compiled_userengine_ini()'s unknown-line filter only reserved
        # the explanatory comments, not the placeholder value lines themselves.
        usersettings.write_profile(usersettings.empty_profile())
        raw = usersettings.profile_engine_text()
        self._save_engine(raw)
        compiled = usersettings.compiled_userengine_ini(usersettings.read_profile())
        self.assertNotIn('Bgd.ServerDisplayName="My Arrakis, My Dune"', compiled)
        self.assertNotIn('Bgd.ServerLoginPassword="Sandworm"', compiled)

    def test_map_engine_scoped_field_appears_in_combined_document(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "map_engine", "ConsoleVariables", "Sandstorm.Enabled", "0", "Survival_1")
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertIn("[Map:Survival_1:ConsoleVariables]", text)
        self.assertIn("Sandstorm.Enabled=0", text)

    def test_partition_engine_scoped_field_appears_in_combined_document(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "partition_engine", "ConsoleVariables", "sandworm.dune.Enabled", "0", "Survival_1", "3")
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertIn("[Partition:Survival_1:3:ConsoleVariables]", text)
        self.assertIn("sandworm.dune.Enabled=0", text)

    def test_scoped_sections_not_synthesized_when_absent(self):
        usersettings.write_profile(usersettings.empty_profile())
        text = usersettings.profile_engine_text()
        self.assertNotIn("[Map:", text)
        self.assertNotIn("[Partition:", text)

    def test_round_trip_preserves_resubmitted_and_drops_stale_scoped_sections(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "map_engine", "ConsoleVariables", "Sandstorm.Enabled", "0", "Survival_1")
        usersettings.profile_set_key(profile, "partition_engine", "ConsoleVariables", "sandworm.dune.Enabled", "0", "Survival_1", "3")
        usersettings.write_profile(profile)

        # Save with only the Map section resubmitted -- the Partition section is
        # stale (omitted) and must be dropped, not preserved.
        self._save_engine(
            "[Global:URL]\nPort=7777\nIGWPort=7888\n\n"
            "[Global:ConsoleVariables]\n\n"
            "[Map:Survival_1:ConsoleVariables]\nSandstorm.Enabled=0\n"
        )

        saved = usersettings.profile_engine_text()
        self.assertIn("[Map:Survival_1:ConsoleVariables]", saved)
        self.assertIn("Sandstorm.Enabled=0", saved)
        self.assertNotIn("[Partition:", saved)
        self.assertNotIn("sandworm.dune.Enabled", saved)

    def test_display_headers_use_global_map_partition_vocabulary(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "map_engine", "ConsoleVariables", "Sandstorm.Enabled", "0", "Survival_1")
        usersettings.profile_set_key(profile, "partition_engine", "ConsoleVariables", "sandworm.dune.Enabled", "0", "Survival_1", "3")
        usersettings.write_profile(profile)
        text = usersettings.profile_engine_text()
        self.assertIn("[Global:URL]", text)
        self.assertIn("[Map:Survival_1:ConsoleVariables]", text)
        self.assertIn("[Partition:Survival_1:3:ConsoleVariables]", text)
        self.assertNotIn("[Engine:", text)
        self.assertNotIn("[MapEngine:", text)
        self.assertNotIn("[PartitionEngine:", text)

    def test_round_trip_with_display_names_preserves_data(self):
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "map_engine", "ConsoleVariables", "Sandstorm.Enabled", "0", "Survival_1")
        usersettings.write_profile(profile)
        raw = usersettings.profile_engine_text()
        self.assertIn("[Map:Survival_1:ConsoleVariables]", raw)
        self._save_engine(raw)
        reloaded = usersettings.profile_engine_text()
        self.assertIn("[Map:Survival_1:ConsoleVariables]", reloaded)
        self.assertIn("Sandstorm.Enabled=0", reloaded)

    def test_usergame_shaped_paste_is_rejected_with_clear_error(self):
        usersettings.write_profile(usersettings.empty_profile())
        bad_raw = "[Global:/Script/DuneSandbox.DuneGameMode]\nm_GlobalXPMultiplier=1.0\n"
        with self.assertRaises(SystemExit):
            usersettings.profile_engine_write_encoded(self._encode(bad_raw))

    def test_map_engine_url_section_is_rejected(self):
        usersettings.write_profile(usersettings.empty_profile())
        bad_raw = "[Map:Survival_1:URL]\nPort=9999\n"
        with self.assertRaises(SystemExit):
            usersettings.profile_engine_write_encoded(self._encode(bad_raw))

    def test_custom_console_variable_key_still_saves(self):
        usersettings.write_profile(usersettings.empty_profile())
        self._save_engine("[Global:ConsoleVariables]\nCustom.Cvar=1\n")
        self.assertIn("Custom.Cvar=1", usersettings.profile_engine_text())

    def test_engine_exclusive_sections_are_rejected_from_the_usergame_tab(self):
        # Regression test: once the UserEngine Advanced tab started displaying its
        # headers with UserGame's own Global/Map/Partition vocabulary, pasting
        # UserEngine content into the UserGame tab stopped being rejected by the
        # scope check alone (Global/Map/Partition are UserGame's own legitimate
        # scopes) -- URL/ConsoleVariables are section names no real UserGame field
        # ever uses, so profile_game_write_encoded must reject them explicitly.
        usersettings.write_profile(usersettings.empty_profile())
        with self.assertRaises(SystemExit):
            self._save_game('[Global:ConsoleVariables]\nBgd.ServerDisplayName="Hijacked"\n')
        with self.assertRaises(SystemExit):
            self._save_game("[Map:Survival_1:ConsoleVariables]\nSandstorm.Enabled=1\n")
        with self.assertRaises(SystemExit):
            self._save_game("[Global:URL]\nPort=9999\n")

    def test_legacy_nonstandard_engine_section_can_be_resubmitted_unmodified(self):
        # Regression test: ENGINE_ALLOWED_SECTIONS_BY_SCOPE was added to stop a
        # brand-new, schema-unknown section name from being injected, but it also
        # started rejecting an UNMODIFIED resubmit of a section that predates that
        # allowlist (legal to save before it existed) -- discarding the whole save,
        # including unrelated edits made alongside it.
        profile = usersettings.empty_profile()
        usersettings.find_profile_section(profile, "engine", "LegacyCustom", create=True)["lines"] = ["SomeKey=SomeValue"]
        usersettings.write_profile(profile)

        rendered = usersettings.profile_engine_text()
        self.assertIn("[Global:LegacyCustom]", rendered)

        # Resubmit the legacy section unchanged, alongside a genuine edit.
        self._save_engine(rendered.replace("Port=7777", "Port=7778"))

        saved = usersettings.profile_engine_text()
        self.assertIn("[Global:LegacyCustom]", saved)
        self.assertIn("SomeKey=SomeValue", saved)
        self.assertIn("Port=7778", saved)

    def test_brand_new_nonstandard_engine_section_is_still_rejected(self):
        # The grandfather clause above must not swallow real injection attempts --
        # a section name that was never in the stored profile before this save is
        # still rejected even though it now shares vocabulary with a legacy one.
        usersettings.write_profile(usersettings.empty_profile())
        with self.assertRaises(SystemExit):
            self._save_engine("[Global:BrandNewSection]\nSomeKey=SomeValue\n")


if __name__ == "__main__":
    unittest.main()
