#!/usr/bin/env python3
"""Order Sietch reports without replacing native state with startup defaults.

Only publication metadata is retained: no players, gameplay values or passwords.
The caller holds the publication lock across prepare, RabbitMQ send and record.
"""
import json
import os
from pathlib import Path
import sys
import tempfile


def prepare(payload, source, state):
    previous = state.get(str(payload["partitionId"]), {})
    same_server = previous.get("serverId") == payload["serverId"]
    if source == "snapshot" and (
        payload.get("ready") or same_server and previous.get("native")
    ):
        # A ready map may already be serving players, including after this
        # publisher restarts. Never substitute guessed population/settings.
        # Nor replay a cached native report as a fresh heartbeat during a stall.
        return None
    result = dict(payload)
    result["reportTimestamp"] = max(
        int(payload.get("reportTimestamp", 0)),
        int(previous.get("reportTimestamp", 0)) + 1,
    )
    return result


def record(payload, source, state):
    partition = str(payload["partitionId"])
    previous = state.get(partition, {})
    state[partition] = {
        "serverId": payload["serverId"],
        "reportTimestamp": int(payload["reportTimestamp"]),
        "native": source == "native" or (
            previous.get("serverId") == payload["serverId"]
            and bool(previous.get("native"))
        ),
    }


def main():
    operation, filename, source = sys.argv[1:]
    if operation not in ("prepare", "record") or source not in ("snapshot", "native"):
        raise ValueError("Invalid publication operation")
    path = Path(filename)
    state = json.loads(path.read_text()) if path.exists() else {}
    payload = json.load(sys.stdin)
    if operation == "prepare":
        result = prepare(payload, source, state)
        if result is not None:
            print(json.dumps(result, separators=(",", ":")))
        return
    record(payload, source, state)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(state, stream, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
