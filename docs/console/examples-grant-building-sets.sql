-- Grant DarkDante (a) the 37 "Construction"-category building patents from
-- the earlier batch that were originally (incorrectly) written into
-- m_KnownItemRecipes instead of delivered as real items -- 3 items from that
-- original 40 are genuine schematics (Thumper, 2 Landsraad contract
-- recipes), already correctly granted via the recipe list, and are
-- intentionally NOT repeated here -- plus (b) the 27 "Filmic Archive" DLC
-- placeables, plus (c) 4 confirmed-grantable Filmic Archive customization
-- items (Sardaukar Bator stillsuit, Sardaukar Scout chestpiece, Caladan
-- Trenchcoat top+gloves) -- already present in this build's item catalog
-- (announced at Gamescom 2026, ships Sept 22; content is pre-loaded
-- client/server-side ahead of the entitlement unlock -- see
-- docs/console/building-set-grants.md for sources and the full mechanism
-- writeup). Run this IDENTICAL script in both dune-dev and dune-prod's
-- Advanced SQL Console -- same game build, same schema, same item IDs.
--
-- DarkDante must be OFFLINE (confirmed for both instances at time of writing).
--
-- Mechanism: these are all category=buildings/source=BuildingSets "patent"
-- items. Per console/api/src/adminCatalog.js + duneDb.js, the ONLY
-- server-supported way to actually unlock a building set is to deliver the
-- real patent-token item into the player's inventory (dune.items) and let
-- Dune's own game server consume it into dune.building_progression on next
-- login -- there is no direct writer for building_progression anywhere in
-- this codebase, and hand-writing it would guess at state a closed-source
-- process owns. This script replicates exactly what
-- duneDb.giveItemToPlayer()/grantBuildingUnlock() do for an offline target:
-- same dune.items insert shape (columns, stats JSON, position-claiming
-- convention), same dedupe-if-already-owned-or-pending check.
--
-- Idempotent: safe to re-run. Items already pending in DarkDante's inventory,
-- or already owned per dune.building_progression, are skipped.

DO $$
DECLARE
  v_actor_id integer;
  v_character_id integer;
  v_inventory_id integer;
  v_max_item_count integer;
  v_has_is_new boolean;
  v_has_acquisition_time boolean;
  v_has_building_progression boolean;
  v_owned_lc text[] := ARRAY[]::text[];
  v_pending_lc text[] := ARRAY[]::text[];
  v_template_id text;
  v_bare_id text;
  v_already_pending boolean;
  v_next_pos integer;
  v_cols text[];
  v_vals text[];
  v_sql text;
  v_granted int := 0;
  v_skipped int := 0;
  v_stats jsonb := '{"FCustomizationStats":[[],{}],"FItemStackAndDurabilityStats":[[],{"CurrentDurability":100,"MaxDurability":100,"DecayedMaxDurability":100}]}'::jsonb;
  -- 37 Construction-category building patents (re-grant, correct mechanism)
  -- + 27 Filmic Archive DLC placeables, both confirmed category=buildings,
  -- source=BuildingSets in runtime/data/admin-items.json as of 2026-09-02.
  -- See docs/console/building-set-grants.md for the 5 additional "probable
  -- but unconfirmed name" Filmic Archive items intentionally left out.
  v_items text[] := ARRAY[
    'BasicLighting_Patent',
    'SurvivalFabricator_Patent',
    'WearablesFabricator_Patent',
    'WindturbineDirectional_Patent',
    'SpiceSilo_Patent',
    'MediumOreRefinery_Patent',
    'MediumStorageContainer_Patent',
    'MediumChemicalRefinery_Patent',
    'MediumSpiceRefinery_Patent',
    'BasicFabricator_Patent',
    'WindTurbineOmni_Patent',
    'Totem_Patent',
    'BasicContainer_Patent',
    'SmallOreRefinery_Patent',
    'PowerGenerator_Patent',
    'AdvancedWearablesFabricator_Patent',
    'AdvancedSurvivalFabricator_Patent',
    'LargeOreRefinery_Patent',
    'LargeSpiceRefinery_Patent',
    'StorageContainer_Patent',
    'SpiceGenerator_Patent',
    'Atre_BasicLighting_Patent',
    'Hark_BasicLighting_Patent',
    'Choam_AdvLighting_Patent',
    'Totem_Small_Patent',
    'MTX_Neut_DesertMechanic_StorageContainer_Patent',
    'MTX_Atre_Troopship_Relief_Placeable_Patent',
    'MTX_Atre_Flagship_Relief_Placeable_Patent',
    'MTX_Neut_Raider_Makeshift_Lampost_Placeable_Patent',
    'MTX_Smug_BuildingSet_Patent',
    'Developer_Storage_Container_Patent',
    'MTX_Smug_BuildingSet_Placeables_Patent',
    'MTX_Atre_TeaHouse_Relief_Placeable_Patent',
    'MTX_B1C3_RoofToppers_01_Placeables_Patent',
    'MTX_B1C3_RoofToppers_02_Placeables_Patent',
    'PolarFabricator_Patent',
    'IceRefinery_Patent',
    'MTX_Atre_Movie_Chair_Patent',
    'MTX_Atre_Movie_Bench_Patent',
    'MTX_Atre_Movie_LargeCarpet_Patent',
    'MTX_Atre_Movie_SmallCarpet_Patent',
    'MTX_Atre_Movie_DecorativePlate_Patent',
    'MTX_Atre_Movie_Painting_Patent',
    'MTX_Atre_Movie_LargeDesk_Patent',
    'MTX_Atre_Movie_Table_Patent',
    'MTX_Atre_Movie_Dresser_Patent',
    'MTX_Atre_Movie_Cabinet_Patent',
    'MTX_Atre_Movie_Bonsai_Patent',
    'MTX_Atre_Movie_BullStatue_Patent',
    'MTX_Atre_Movie_DecorativeBox_Patent',
    'MTX_Atre_Movie_DecorativeWineBottle_Patent',
    'MTX_Atre_Movie_FoodPlatter_01_Patent',
    'MTX_Atre_Movie_Glass_01_Patent',
    'MTX_Atre_Movie_Glass_02_Patent',
    'MTX_Atre_Movie_PlateCutlery_Patent',
    'MTX_Atre_Movie_CaladanCastle_Hologram_Patent',
    'MTX_Atre_Movie_Vase_01_Patent',
    'MTX_Atre_Movie_WaterPitcher_Patent',
    'MTX_Atre_Movie_WindChimes_Patent',
    'MTX_Atre_Movie_Window_Patent',
    'MTX_Caladan_Movie_Bed_Patent',
    'MTX_Caladan_Movie_Mural_Patent',
    'MTX_Caladan_Movie_Cushion_Patent',
    'MTX_Atre_Hologram_CaladanEmblem_Patent',
    -- Confirmed-grantable Filmic Archive customization/wardrobe items (not
    -- building patents -- no building_progression entry will ever match
    -- these, which is fine, the owned-check below just no-ops for them).
    'MTX_Sard_Stillsuit_01_SetVariant',
    'MTX_Sard_Scout_SetVariant',
    'MTX_Atre_CaladanTrenchcoat_SetVariant_Top',
    'MTX_Atre_CaladanTrenchcoat_SetVariant_Gloves'
  ];
BEGIN
  -- Resolve DarkDante's actor + backpack inventory (inventory_type = 0), same
  -- as resolvePlayerTarget()/giveItemToPlayer()'s primary lookup, and lock it.
  IF (
    SELECT count(*) FROM dune.actors a
    JOIN dune.player_state ps ON ps.player_pawn_id = a.id
    WHERE a.class ILIKE '%PlayerCharacter%' AND ps.character_name ILIKE 'DarkDante'
  ) <> 1 THEN
    RAISE EXCEPTION 'DarkDante did not resolve to exactly one player character -- narrow the match before running this';
  END IF;

  SELECT a.id, ps.id
    INTO v_actor_id, v_character_id
  FROM dune.actors a
  JOIN dune.player_state ps ON ps.player_pawn_id = a.id
  WHERE a.class ILIKE '%PlayerCharacter%'
    AND ps.character_name ILIKE 'DarkDante';

  SELECT id, COALESCE(max_item_count, 0)
    INTO v_inventory_id, v_max_item_count
  FROM dune.inventories
  WHERE actor_id = v_actor_id AND inventory_type = 0
  ORDER BY id
  LIMIT 1
  FOR UPDATE;

  IF v_inventory_id IS NULL THEN
    RAISE EXCEPTION 'DarkDante has no backpack inventory (dune.inventories inventory_type=0)';
  END IF;

  -- Optional building_progression ownership check (skip cleanly if this
  -- schema doesn't have it -- matches supportsCraftingRecipes-style capability
  -- detection used throughout duneDb.js).
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dune' AND table_name = 'building_progression'
      AND column_name IN ('character_id', 'learned_building_sets', 'new_buildable_pieces')
    GROUP BY table_name
    HAVING count(*) = 3
  ) INTO v_has_building_progression;

  IF v_has_building_progression THEN
    SELECT
      ARRAY(SELECT lower(x) FROM unnest(COALESCE(learned_building_sets, '{}')) x),
      ARRAY(SELECT lower(x) FROM unnest(COALESCE(new_buildable_pieces, '{}')) x)
      INTO v_owned_lc, v_pending_lc
    FROM dune.building_progression
    WHERE character_id = v_character_id
    LIMIT 1;
    v_owned_lc := COALESCE(v_owned_lc, ARRAY[]::text[]) || COALESCE(v_pending_lc, ARRAY[]::text[]);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dune' AND table_name = 'items' AND column_name = 'is_new'
  ) INTO v_has_is_new;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dune' AND table_name = 'items' AND column_name = 'acquisition_time'
  ) INTO v_has_acquisition_time;

  FOREACH v_template_id IN ARRAY v_items LOOP
    v_bare_id := regexp_replace(v_template_id, '_Patent$', '', 'i');

    -- Skip if already owned per building_progression (bare or _Patent alias).
    IF v_has_building_progression AND (
      lower(v_template_id) = ANY(v_owned_lc) OR lower(v_bare_id) = ANY(v_owned_lc)
    ) THEN
      RAISE NOTICE 'SKIP (already owned): %', v_template_id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Skip if already sitting as an unconsumed patent item in the inventory.
    SELECT EXISTS (
      SELECT 1 FROM dune.items i
      WHERE i.inventory_id = v_inventory_id AND i.template_id = v_template_id
    ) INTO v_already_pending;
    IF v_already_pending THEN
      RAISE NOTICE 'SKIP (already pending in inventory): %', v_template_id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Claim the lowest free position_index (matches createStackPositionClaimer's
    -- "low" direction used by the player-give path), bounded by max_item_count
    -- when the inventory is slot-capped; otherwise fall back to max+1.
    IF v_max_item_count > 0 THEN
      SELECT min(candidate)
        INTO v_next_pos
      FROM generate_series(0, v_max_item_count - 1) candidate
      WHERE candidate NOT IN (
        SELECT position_index FROM dune.items WHERE inventory_id = v_inventory_id
      );
      IF v_next_pos IS NULL THEN
        RAISE EXCEPTION 'DarkDante''s backpack has no free item slots -- stopped before % (% granted so far)', v_template_id, v_granted;
      END IF;
    ELSE
      SELECT COALESCE(max(position_index), -1) + 1
        INTO v_next_pos
      FROM dune.items WHERE inventory_id = v_inventory_id;
    END IF;

    v_cols := ARRAY['inventory_id', 'template_id', 'stack_size', 'quality_level', 'position_index', 'stats'];
    v_vals := ARRAY[v_inventory_id::text, quote_literal(v_template_id), '1', '0', v_next_pos::text, quote_literal(v_stats::text) || '::jsonb'];
    IF v_has_is_new THEN
      v_cols := array_append(v_cols, 'is_new'::text);
      v_vals := array_append(v_vals, 'false'::text);
    END IF;
    IF v_has_acquisition_time THEN
      v_cols := array_append(v_cols, 'acquisition_time'::text);
      v_vals := array_append(v_vals, extract(epoch FROM now())::bigint::text);
    END IF;

    v_sql := format('INSERT INTO dune.items (%s) VALUES (%s)', array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
    EXECUTE v_sql;
    RAISE NOTICE 'GRANTED: % (slot %)', v_template_id, v_next_pos;
    v_granted := v_granted + 1;
  END LOOP;

  RAISE NOTICE '--- Building set grant complete: % granted, % skipped (of 68 total) ---', v_granted, v_skipped;
END $$;

-- Verify: pending patent/wardrobe items now sitting in DarkDante's backpack,
-- waiting for Dune to process them on next login. Should show up to 68 rows
-- (fewer if any were already owned/pending and correctly skipped).
SELECT i.template_id, i.position_index
FROM dune.items i
JOIN dune.inventories inv ON inv.id = i.inventory_id
JOIN dune.actors a ON a.id = inv.actor_id
JOIN dune.player_state ps ON ps.player_pawn_id = a.id
WHERE ps.character_name ILIKE 'DarkDante'
  AND i.template_id IN (
    'BasicLighting_Patent','SurvivalFabricator_Patent','WearablesFabricator_Patent',
    'WindturbineDirectional_Patent','SpiceSilo_Patent','MediumOreRefinery_Patent',
    'MediumStorageContainer_Patent','MediumChemicalRefinery_Patent','MediumSpiceRefinery_Patent',
    'BasicFabricator_Patent','WindTurbineOmni_Patent','Totem_Patent','BasicContainer_Patent',
    'SmallOreRefinery_Patent','PowerGenerator_Patent','AdvancedWearablesFabricator_Patent',
    'AdvancedSurvivalFabricator_Patent','LargeOreRefinery_Patent','LargeSpiceRefinery_Patent',
    'StorageContainer_Patent','SpiceGenerator_Patent','Atre_BasicLighting_Patent',
    'Hark_BasicLighting_Patent','Choam_AdvLighting_Patent','Totem_Small_Patent',
    'MTX_Neut_DesertMechanic_StorageContainer_Patent','MTX_Atre_Troopship_Relief_Placeable_Patent',
    'MTX_Atre_Flagship_Relief_Placeable_Patent','MTX_Neut_Raider_Makeshift_Lampost_Placeable_Patent',
    'MTX_Smug_BuildingSet_Patent','Developer_Storage_Container_Patent',
    'MTX_Smug_BuildingSet_Placeables_Patent','MTX_Atre_TeaHouse_Relief_Placeable_Patent',
    'MTX_B1C3_RoofToppers_01_Placeables_Patent','MTX_B1C3_RoofToppers_02_Placeables_Patent',
    'PolarFabricator_Patent','IceRefinery_Patent',
    'MTX_Atre_Movie_Chair_Patent','MTX_Atre_Movie_Bench_Patent','MTX_Atre_Movie_LargeCarpet_Patent',
    'MTX_Atre_Movie_SmallCarpet_Patent','MTX_Atre_Movie_DecorativePlate_Patent','MTX_Atre_Movie_Painting_Patent',
    'MTX_Atre_Movie_LargeDesk_Patent','MTX_Atre_Movie_Table_Patent','MTX_Atre_Movie_Dresser_Patent',
    'MTX_Atre_Movie_Cabinet_Patent','MTX_Atre_Movie_Bonsai_Patent','MTX_Atre_Movie_BullStatue_Patent',
    'MTX_Atre_Movie_DecorativeBox_Patent','MTX_Atre_Movie_DecorativeWineBottle_Patent','MTX_Atre_Movie_FoodPlatter_01_Patent',
    'MTX_Atre_Movie_Glass_01_Patent','MTX_Atre_Movie_Glass_02_Patent','MTX_Atre_Movie_PlateCutlery_Patent',
    'MTX_Atre_Movie_CaladanCastle_Hologram_Patent','MTX_Atre_Movie_Vase_01_Patent','MTX_Atre_Movie_WaterPitcher_Patent',
    'MTX_Atre_Movie_WindChimes_Patent','MTX_Atre_Movie_Window_Patent','MTX_Caladan_Movie_Bed_Patent',
    'MTX_Caladan_Movie_Mural_Patent','MTX_Caladan_Movie_Cushion_Patent','MTX_Atre_Hologram_CaladanEmblem_Patent',
    'MTX_Sard_Stillsuit_01_SetVariant','MTX_Sard_Scout_SetVariant',
    'MTX_Atre_CaladanTrenchcoat_SetVariant_Top','MTX_Atre_CaladanTrenchcoat_SetVariant_Gloves'
  )
ORDER BY i.template_id;
