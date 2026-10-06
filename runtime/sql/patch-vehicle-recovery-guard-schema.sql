-- Keep Dune Docker's temporary vehicle-recovery guard compatible with both
-- the legacy actor_state table and the current inline actors.state column.
-- The patch is deliberately conditional: installations without this optional
-- project-owned guard are left untouched.

DO $patch$
DECLARE
  guard_function regprocedure;
BEGIN
  guard_function := to_regprocedure('dune_runtime.guard_recovered_vehicle_restore()');
  IF guard_function IS NULL THEN
    RAISE NOTICE 'Vehicle-recovery guard is not installed; no compatibility patch is needed.';
    RETURN;
  END IF;

  IF to_regclass('dune_runtime.vehicle_recovery_guard') IS NULL THEN
    RAISE EXCEPTION 'Vehicle-recovery guard function exists without its runtime state table; no change was made.';
  END IF;

  EXECUTE $definition$
    CREATE OR REPLACE FUNCTION dune_runtime.guard_recovered_vehicle_restore()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'dune', 'dune_runtime', 'pg_temp'
    AS $body$
    DECLARE
      is_recovering boolean := false;
      guarded_until timestamp with time zone;
      seconds_remaining integer;
    BEGIN
      IF to_regclass('dune.actor_state') IS NOT NULL THEN
        EXECUTE $query$
          SELECT EXISTS (
            SELECT 1
            FROM dune.actor_state ast
            WHERE ast.actor_id = $1
              AND ast.state = 'VehicleRecovery'
          )
        $query$
        INTO is_recovering
        USING old.id;
      ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'dune'
          AND table_name = 'actors'
          AND column_name = 'state'
      ) THEN
        is_recovering := coalesce(to_jsonb(old) ->> 'state', '') = 'VehicleRecovery';
      ELSE
        RAISE EXCEPTION 'Unsupported Dune actor-state schema; vehicle-recovery guard cannot run safely.';
      END IF;

      IF NOT is_recovering THEN
        RETURN new;
      END IF;

      SELECT g.ready_after
        INTO guarded_until
      FROM dune_runtime.vehicle_recovery_guard g
      WHERE g.partition_id = new.partition_id
        AND g.ready_after > clock_timestamp();

      IF guarded_until IS NULL THEN
        RETURN new;
      END IF;

      seconds_remaining := greatest(
        1,
        ceil(extract(epoch FROM guarded_until - clock_timestamp()))::integer
      );
      RAISE EXCEPTION USING
        errcode = '55000',
        message = format(
          'Vehicle recovery is waiting for map permissions to finish loading. Try again in %s seconds.',
          seconds_remaining
        );
    END;
    $body$
  $definition$;

  RAISE NOTICE 'Vehicle-recovery guard now supports the installed actor-state schema.';
END
$patch$;
