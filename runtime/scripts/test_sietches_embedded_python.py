#!/usr/bin/env python3
"""Compile-check every Python block embedded in sietches.sh.

`bash -n sietches.sh` only validates the surrounding shell -- the body of a
`python3 -c '...'` or `<<'PY' ... PY` heredoc is just a string literal to
bash, so a syntax error inside one is invisible to bash's own syntax check
and to any test that only exercises the underlying usersettings.py commands
the heredoc shells out to (those pass even when the heredoc calling them is
broken). This is exactly how normalize_deepdesert_labels() shipped with an
f-string SyntaxError (`f"{partition[\"partitionId\"]}..."`, invalid because
the escaped quote isn't valid inside an f-string expression) that made every
reconcile silently no-op via its own `2>/dev/null || true` guard -- caught
only by running the real command against a real deployment.

The `python3 -c '...'` form has a second, sharper hazard the naive fix
walked straight into: bash single quotes have NO escape mechanism, so a
literal `'` anywhere inside the block -- even to close a Python dict-key
string -- ends the bash string right there. Everything after becomes literal
bash, and python3 only ever sees the truncated prefix. That prefix can still
be syntactically broken (unterminated string/bracket), so the extractor
below finds the closing quote the same way bash's own single-quote scanner
does -- first literal `'`, full stop, no line-anchoring, no escaping -- and
compiles exactly what bash would actually hand to python3. A block that
looks fine at the source-text level but truncates early is exactly the
`partition['partitionId']` case that shipped: valid Python if you squint at
the full source, but bash never gets that far.

Run directly:
    python3 runtime/scripts/test_sietches_embedded_python.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import unittest
from pathlib import Path

SIETCHES_SH = Path(__file__).resolve().parent / "sietches.sh"


def extract_python_blocks(text: str) -> list[tuple[int, str]]:
    """Return (starting_line_number, source) for each embedded Python block.

    Handles the two forms used throughout sietches.sh:
      - `<<'PY'` ... a line that is exactly `PY` (quoted heredoc delimiter --
        content is literal, no character-level quote parsing needed)
      - `python3 -c '...'` -- content ends at the first literal `'`
        character bash finds, scanning byte by byte across lines exactly
        like bash's own single-quote parser (no escaping exists inside
        single quotes, so line position is irrelevant).
    """
    lines = text.splitlines()
    blocks: list[tuple[int, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "<<'PY'" in line or '<<"PY"' in line:
            start = i + 1
            body: list[str] = []
            i += 1
            while i < len(lines) and lines[i] != "PY":
                body.append(lines[i])
                i += 1
            if i >= len(lines):
                raise AssertionError(f"Unterminated <<'PY' heredoc starting at line {start}")
            blocks.append((start, "\n".join(body)))
            i += 1
            continue
        marker = "python3 -c '"
        if marker in line:
            start = i + 1
            remainder = "\n".join(lines[i:])
            offset = remainder.index(marker) + len(marker)
            close = remainder.find("'", offset)
            if close == -1:
                raise AssertionError(f"Unterminated python3 -c '...' block starting at line {start}")
            blocks.append((start, remainder[offset:close]))
            # Resume scanning after the closing quote, which may be on a
            # later line than it started -- recompute how many lines that
            # consumed rather than assuming single-line blocks.
            consumed_lines = remainder[:close].count("\n")
            i += consumed_lines + 1
            continue
        i += 1
    return blocks


class EmbeddedPythonSyntaxTests(unittest.TestCase):
    def test_every_embedded_python_block_compiles(self):
        text = SIETCHES_SH.read_text(encoding="utf-8")
        blocks = extract_python_blocks(text)
        # A minimum count pins the extractor itself to the file's known
        # shape -- if sietches.sh stops matching either pattern entirely
        # (e.g. a refactor), silently checking zero blocks must not pass.
        self.assertGreaterEqual(
            len(blocks), 15,
            "Expected at least 15 embedded Python blocks in sietches.sh -- "
            "the extractor may no longer be matching this file's heredoc/"
            "python3 -c patterns.",
        )
        failures = []
        for line_no, source in blocks:
            try:
                compile(source, f"sietches.sh:{line_no}", "exec")
            except SyntaxError as exc:
                failures.append(f"sietches.sh:{line_no}: {exc}")
        self.assertEqual(failures, [], "Syntax errors in embedded Python:\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
