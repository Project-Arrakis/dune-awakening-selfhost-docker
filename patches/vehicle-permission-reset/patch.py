#!/usr/bin/env python3
"""Apply the version-locked vehicle permission reset compatibility patch."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path


SUPPORTED_SHA256 = "fb50dc3f9b70bd971091478fefdad679a6d824b5370bb0fd41dc0731208bb431"
PATCHED_SHA256 = "6e22925e692730a8e5600231659ebee2bf25091e1ea75d8425b4b6534386cd7a"
PATCH_OFFSET = 0xEE4BA83
ORIGINAL_BYTES = bytes.fromhex(
    "488d5db0"          # lea rbx,[rbp-0x50]
    "4c89f7"            # mov rdi,r14
    "31f6"              # xor esi,esi
    "ba01000000"        # mov edx,1
    "4889d9"            # mov rcx,rbx
    "e857a636ff"        # call startup-event registration
)
PATCHED_BYTES = bytes.fromhex(
    "4889df"            # mov rdi,rbx (UPermissionSubsystem)
    "e865000000"        # call OnServerStartupEnded
    "488d5db0"          # restore rbx for delegate cleanup
    "90909090909090909090"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f"error: {message}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Patch the supported Funcom game-server binary so each new world "
            "initializes its permission subsystem after an in-process reset."
        )
    )
    parser.add_argument("source", type=Path, help="stock DuneSandboxServer-Linux-Shipping")
    parser.add_argument("output", type=Path, help="path for the patched copy")
    args = parser.parse_args()

    if not args.source.is_file():
        fail(f"source is not a file: {args.source}")
    if args.source.resolve() == args.output.resolve():
        fail("source and output must be different; the stock binary is never modified in place")

    actual_sha = sha256(args.source)
    if actual_sha != SUPPORTED_SHA256:
        fail(
            "unsupported Funcom binary; expected SHA-256 "
            f"{SUPPORTED_SHA256}, got {actual_sha}"
        )

    with args.source.open("rb") as source:
        source.seek(PATCH_OFFSET)
        actual_bytes = source.read(len(ORIGINAL_BYTES))
    if actual_bytes != ORIGINAL_BYTES:
        fail(
            f"byte signature mismatch at 0x{PATCH_OFFSET:x}; refusing to create an unsafe patch"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.source, args.output)
    with args.output.open("r+b") as output:
        output.seek(PATCH_OFFSET)
        output.write(PATCHED_BYTES)
    shutil.copymode(args.source, args.output)

    with args.output.open("rb") as output:
        output.seek(PATCH_OFFSET)
        if output.read(len(PATCHED_BYTES)) != PATCHED_BYTES:
            fail("patched output verification failed")

    patched_sha = sha256(args.output)
    if patched_sha != PATCHED_SHA256:
        fail(
            "patched output hash mismatch; expected SHA-256 "
            f"{PATCHED_SHA256}, got {patched_sha}"
        )

    print(f"Created patched binary: {args.output}")
    print(f"Stock SHA-256:   {actual_sha}")
    print(f"Patched SHA-256: {patched_sha}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as exc:
        fail(str(exc))
