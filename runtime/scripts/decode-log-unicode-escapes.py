#!/usr/bin/env python3
"""Decode JSON-style Unicode escapes in log text read from stdin."""

from __future__ import annotations

import re
import sys


UNICODE_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")


def decode_unicode_escape(match: re.Match[str]) -> str:
    return chr(int(match.group(1), 16))


def main() -> None:
    text = sys.stdin.read()
    sys.stdout.write(UNICODE_ESCAPE.sub(decode_unicode_escape, text))


if __name__ == "__main__":
    main()
