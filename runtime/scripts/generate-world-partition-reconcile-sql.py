#!/usr/bin/env python3
"""Generate an additive world-partition reconciliation transaction."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def sql_string(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def load_rows(path: Path) -> list[dict[str, object]]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, list):
        raise ValueError("partition catalog must contain a JSON array")

    rows: list[dict[str, object]] = []
    seen: set[tuple[str, int]] = set()
    for raw in payload:
        if not isinstance(raw, dict):
            raise ValueError("partition catalog rows must be JSON objects")
        map_name = str(raw.get("map") or "").strip()
        if not map_name:
            raise ValueError("partition catalog row is missing map")
        partition_id = int(raw["id"])
        dimension = int(raw.get("dimension") or 0)
        key = (map_name.casefold(), dimension)
        if key in seen:
            raise ValueError(f"duplicate map/dimension in partition catalog: {map_name}/{dimension}")
        seen.add(key)
        rows.append(
            {
                "map": map_name,
                "id": partition_id,
                "dimension": dimension,
                "blocked": bool(raw.get("disable", False)),
                "definition": {
                    "type": "box2d_array",
                    "box": {
                        "min_x": raw.get("minX", 0),
                        "min_y": raw.get("minY", 0),
                        "max_x": raw.get("maxX", 1),
                        "max_y": raw.get("maxY", 1),
                    },
                },
            }
        )
    return rows


def reserved_partition_ids() -> set[int]:
    raw = os.environ.get("DUNE_RESERVED_PARTITION_IDS", "")
    return {int(value) for value in raw.split(",") if value.strip()}


def emit(rows: list[dict[str, object]]) -> None:
    reserved_ids = reserved_partition_ids()
    print("-- Generated from the installed Funcom world-template partition catalog.")
    print("-- Additive only: existing map dimensions and customized rows are preserved.")
    print("begin;")
    print("select pg_advisory_xact_lock(hashtextextended('dune-docker:world-partitions', 0));")
    print(
        "select setval('dune.world_partition_partition_id_seq', "
        "greatest((select coalesce(max(partition_id), 1) from dune.world_partition), "
        "(select last_value from dune.world_partition_partition_id_seq)), true);"
    )

    for row in rows:
        map_sql = sql_string(row["map"])
        definition_sql = sql_string(json.dumps(row["definition"], separators=(",", ":")))
        blocked_sql = "true" if row["blocked"] else "false"
        canonical_available = row["id"] not in reserved_ids
        canonical_condition = (
            f"not exists (select 1 from dune.world_partition where partition_id = {row['id']})"
            if canonical_available
            else "false"
        )
        fallback_notice = (
            "canonical ID % has an existing partition override"
            if not canonical_available
            else "canonical ID % was already in use"
        )
        print(
            f"""
do $reconcile$
begin
  if exists (
    select 1
    from dune.world_partition
    where lower(map) = lower({map_sql})
      and dimension_index = {row['dimension']}
  ) then
    raise notice 'World partition already present: % dimension %', {map_sql}, {row['dimension']};
  elsif {canonical_condition} then
    insert into dune.world_partition (
      partition_id, server_id, map, partition_definition, dimension_index, blocked, label
    ) values (
      {row['id']}, null, {map_sql}, {definition_sql}::jsonb,
      {row['dimension']}, {blocked_sql}, null
    );
    raise notice 'Added official world partition: % dimension % (ID %)',
      {map_sql}, {row['dimension']}, {row['id']};
  else
    insert into dune.world_partition (
      server_id, map, partition_definition, dimension_index, blocked, label
    ) values (
      null, {map_sql}, {definition_sql}::jsonb,
      {row['dimension']}, {blocked_sql}, null
    );
    raise notice 'Added official world partition: % dimension % ({fallback_notice})',
      {map_sql}, {row['dimension']}, {row['id']};
  end if;
end
$reconcile$;"""
        )

    print(
        "select setval('dune.world_partition_partition_id_seq', "
        "greatest((select coalesce(max(partition_id), 1) from dune.world_partition), "
        "(select last_value from dune.world_partition_partition_id_seq)), true);"
    )
    print("commit;")


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} PARTITION_CATALOG", file=sys.stderr)
        return 2
    try:
        rows = load_rows(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f"Cannot generate world-partition reconciliation: {exc}", file=sys.stderr)
        return 1
    if not rows:
        print("Cannot generate world-partition reconciliation: catalog is empty", file=sys.stderr)
        return 1
    emit(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
