-- Dune's engine reads blueprint transforms and scales from zero-based
-- PostgreSQL arrays. Older Console imports used ordinary array literals,
-- which PostgreSQL stored with a lower bound of 1. Normalize only that known
-- legacy shape; native zero-based rows and unexpected shapes remain untouched.

DO $patch$
DECLARE
  repaired_instances bigint := 0;
  repaired_placeables bigint := 0;
  repaired_pentashields bigint := 0;
BEGIN
  IF to_regclass('dune.building_blueprint_instances') IS NOT NULL THEN
    UPDATE dune.building_blueprint_instances
       SET transform = ('[0:3]=' || transform::text)::real[]
     WHERE array_lower(transform, 1) = 1
       AND array_length(transform, 1) = 4;
    GET DIAGNOSTICS repaired_instances = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprint_placeables') IS NOT NULL THEN
    UPDATE dune.building_blueprint_placeables
       SET transform = ('[0:5]=' || transform::text)::real[]
     WHERE array_lower(transform, 1) = 1
       AND array_length(transform, 1) = 6;
    GET DIAGNOSTICS repaired_placeables = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprint_pentashields') IS NOT NULL THEN
    UPDATE dune.building_blueprint_pentashields
       SET scale = ('[0:2]=' || scale::text)::smallint[]
     WHERE array_lower(scale, 1) = 1
       AND array_length(scale, 1) = 3;
    GET DIAGNOSTICS repaired_pentashields = ROW_COUNT;
  END IF;

  RAISE NOTICE 'Normalized blueprint arrays: % instances, % placeables, % pentashields.',
    repaired_instances, repaired_placeables, repaired_pentashields;
END
$patch$;
