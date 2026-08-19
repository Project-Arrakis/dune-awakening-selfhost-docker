-- Funcom's base backup stores the original actors in place and marks them
-- actor_state = 'BaseBackup'. The shipped Coriolis cleanup preserves Travel,
-- VehicleBackup, and VehicleRecovery, but not BaseBackup, so Deep Desert
-- cleanup deletes the saved totem/building actors. The linked-actor foreign
-- keys cascade and the in-game restore list can no longer discover the base.
--
-- Patch the installed function instead of carrying a complete fork of it.
-- This preserves unrelated Funcom changes and fails closed if a future schema
-- no longer matches the reviewed deletion shape.

do $dune_coriolis_base_backup_patch$
declare
  target_oid oid;
  original_definition text;
  patched_definition text;
  desired_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('dune:coriolis-base-backup-preservation:v1', 0));
  perform set_config('search_path', 'dune, public', true);

  target_oid := to_regprocedure(
    'dune.delete_actors_and_respawns_on_server(dune.serverinfo,text[],boolean)'
  );
  if target_oid is null then
    raise exception using
      message = 'Coriolis base-backup compatibility patch: target Funcom function is missing.',
      hint = 'Do not start Deep Desert until the database schema/update has been checked.';
  end if;

  select pg_get_functiondef(target_oid) into original_definition;
  desired_count := regexp_count(
    original_definition,
    $pattern$s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'BaseBackup'$pattern$,
    1,
    'i'
  );

  if desired_count = 1 then
    raise notice 'Coriolis base-backup compatibility patch is already applied.';
    return;
  elsif desired_count > 1 then
    raise exception 'Coriolis base-backup compatibility patch: unexpected duplicate BaseBackup exclusions (%).', desired_count;
  end if;

  if original_definition !~* $pattern$DELETE[[:space:]]+FROM[[:space:]]+actors$pattern$
    or original_definition !~* $pattern$owner_account_id[[:space:]]+IS[[:space:]]+NULL$pattern$
    or original_definition !~* $pattern$server_info_match[(]a,[[:space:]]*in_server_info[)]$pattern$
    or regexp_count(original_definition, $pattern$s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'Travel'$pattern$, 1, 'i') <> 1
    or regexp_count(original_definition, $pattern$s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'VehicleBackup'$pattern$, 1, 'i') <> 1
    or regexp_count(original_definition, $pattern$s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'VehicleRecovery'$pattern$, 1, 'i') <> 1
  then
    raise exception using
      message = 'Coriolis base-backup compatibility patch: Funcom function shape is not recognized; no change was made.',
      hint = 'Review pg_get_functiondef(dune.delete_actors_and_respawns_on_server) before updating this patch.';
  end if;

  patched_definition := regexp_replace(
    original_definition,
    $pattern$(s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'VehicleBackup')$pattern$,
    $replacement$\1
        AND s.state IS DISTINCT FROM 'BaseBackup'$replacement$,
    'i'
  );
  if patched_definition = original_definition then
    raise exception 'Coriolis base-backup compatibility patch did not alter the target definition.';
  end if;

  execute patched_definition;

  select regexp_count(
    pg_get_functiondef(target_oid),
    $pattern$s[.]state[[:space:]]+IS[[:space:]]+DISTINCT[[:space:]]+FROM[[:space:]]+'BaseBackup'$pattern$,
    1,
    'i'
  ) into desired_count;
  if desired_count <> 1 then
    raise exception 'Coriolis base-backup compatibility patch verification failed (matching exclusions=%).', desired_count;
  end if;

  raise notice 'Applied Coriolis BaseBackup preservation compatibility patch.';
end
$dune_coriolis_base_backup_patch$;
