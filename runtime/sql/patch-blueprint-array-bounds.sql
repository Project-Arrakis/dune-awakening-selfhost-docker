-- Console imports used ordinary one-based PostgreSQL arrays before v1.4.26
-- and were verified in game. v1.4.26 changed those rows to explicit zero-based
-- bounds without runtime evidence. Restore only Console-owned imports, which
-- are identified by building_blueprints.player_id. Native Funcom blueprints
-- have player_id IS NULL and must retain their native array metadata.

DO $patch$
DECLARE
  repaired_instances bigint := 0;
  repaired_placeables bigint := 0;
  repaired_pentashields bigint := 0;
  repaired_placeable_axes bigint := 0;
BEGIN
  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_instances') IS NOT NULL THEN
    UPDATE dune.building_blueprint_instances child
       SET transform = ARRAY[
         child.transform[0], child.transform[1], child.transform[2], child.transform[3]
       ]::real[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.transform, 1) = 0
       AND array_length(child.transform, 1) = 4;
    GET DIAGNOSTICS repaired_instances = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_placeables') IS NOT NULL THEN
    UPDATE dune.building_blueprint_placeables child
       SET transform = ARRAY[
         child.transform[0], child.transform[1], child.transform[2],
         child.transform[3], child.transform[4], child.transform[5]
       ]::real[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.transform, 1) = 0
       AND array_length(child.transform, 1) = 6;
    GET DIAGNOSTICS repaired_placeables = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_pentashields') IS NOT NULL THEN
    UPDATE dune.building_blueprint_pentashields child
       SET scale = ARRAY[child.scale[0], child.scale[1], child.scale[2]]::smallint[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.scale, 1) = 0
       AND array_length(child.scale, 1) = 3;
    GET DIAGNOSTICS repaired_pentashields = ROW_COUNT;
  END IF;

  -- Patch 1.5 names the persisted placeable components
  -- X,Y,Z,Yaw,Pitch,Roll. Solido JSON uses rx,ry,rz, where ry is yaw. Imports
  -- made by earlier Console versions wrote rx,ry,rz directly and therefore
  -- placed yaw in the pitch slot. Migrate only Console-owned blueprints and
  -- record the repair so later database updates cannot swap the axes again.
  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_placeables') IS NOT NULL THEN
    CREATE SCHEMA IF NOT EXISTS dune_runtime;
    CREATE TABLE IF NOT EXISTS dune_runtime.compatibility_migrations (
      name text PRIMARY KEY,
      applied_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
    );

    IF NOT EXISTS (
      SELECT 1
      FROM dune_runtime.compatibility_migrations
      WHERE name = 'blueprint-placeable-yaw-first-v1'
    ) THEN
      UPDATE dune.building_blueprint_placeables child
         SET transform = ARRAY[
           child.transform[array_lower(child.transform, 1)],
           child.transform[array_lower(child.transform, 1) + 1],
           child.transform[array_lower(child.transform, 1) + 2],
           child.transform[array_lower(child.transform, 1) + 4],
           child.transform[array_lower(child.transform, 1) + 3],
           child.transform[array_lower(child.transform, 1) + 5]
         ]::real[]
        FROM dune.building_blueprints blueprint
       WHERE child.building_blueprint_id = blueprint.id
         AND blueprint.player_id IS NOT NULL
         AND array_length(child.transform, 1) = 6;
      GET DIAGNOSTICS repaired_placeable_axes = ROW_COUNT;

      INSERT INTO dune_runtime.compatibility_migrations (name)
      VALUES ('blueprint-placeable-yaw-first-v1');
    END IF;
  END IF;

  RAISE NOTICE 'Restored Console blueprint arrays: % instances, % placeables, % pentashields; corrected % placeable rotations.',
    repaired_instances, repaired_placeables, repaired_pentashields, repaired_placeable_axes;
END
$patch$;
