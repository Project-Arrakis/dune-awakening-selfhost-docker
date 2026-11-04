"""Build a validated, idempotent RabbitMQ binding batch (never delete queues)."""

import re
import sys
from pathlib import Path


def expression(plan):
    bindings = []
    for line in plan.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not all(
            re.fullmatch(r"[A-Za-z0-9_.:@#/+=-]*", part) for part in parts
        ):
            raise ValueError("Invalid chat binding plan")
        exchange, key, queue = parts
        if not exchange or not queue.endswith("_queue"):
            raise ValueError("Invalid chat binding destination")
        bindings.append(
            '{binding,{resource,<<"/">>,exchange,<<"' + exchange
            + '">>},<<"' + key + '">>,{resource,<<"/">>,queue,<<"'
            + queue + '">>},[]}'
        )
    return (
        "Results = [catch rabbit_binding:add(B, <<\"repair-chat-exchanges\">>) "
        "|| B <- [" + ",".join(bindings) + "]], "
        "case lists:all(fun(R) -> R =:= ok end, Results) of "
        'true -> io:format("chat-bindings-ok~n"), ok; '
        'false -> io:format("chat-bindings-failed~n"), error end.'
    )


if __name__ == "__main__":
    lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
    # Bound argv size and per-operation broker work on larger Battlegroups.
    for offset in range(0, len(lines), 200):
        print(expression("\n".join(lines[offset:offset + 200])))
