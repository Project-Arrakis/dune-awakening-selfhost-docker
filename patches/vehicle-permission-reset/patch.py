#!/usr/bin/env python3
"""Apply the version-locked vehicle permission reset compatibility patch."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path


SUPPORTED_BUILDS = {
    # Funcom 2051294-0-shipping
    "fb50dc3f9b70bd971091478fefdad679a6d824b5370bb0fd41dc0731208bb431": {
        "patched_sha256": "6e22925e692730a8e5600231659ebee2bf25091e1ea75d8425b4b6534386cd7a",
        "offset": 0xEE4BA83,
        "original": bytes.fromhex("488d5db04c89f731f6ba010000004889d9e857a636ff"),
    },
    # Funcom 2064155-0-shipping
    "51a26e1e5c67cceef98fdb34ee4953c2016079216cda4668a6033a017c9e601e": {
        "patched_sha256": "2ed150f8acaf7fe975664ab6021ed2cd8fa4138edf230f050e437b9acaaa2d01",
        "offset": 0xEE55783,
        "original": bytes.fromhex("488d5db04c89f731f6ba010000004889d9e857a036ff"),
    },
}
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
    build = SUPPORTED_BUILDS.get(actual_sha)
    if build is None:
        fail(
            "unsupported Funcom binary; no version-locked patch matches SHA-256 "
            f"{actual_sha}"
        )
    patch_offset = int(build["offset"])
    original_bytes = bytes(build["original"])
    patched_sha256 = str(build["patched_sha256"])

    with args.source.open("rb") as source:
        source.seek(patch_offset)
        actual_bytes = source.read(len(original_bytes))
    if actual_bytes != original_bytes:
        fail(
            f"byte signature mismatch at 0x{patch_offset:x}; refusing to create an unsafe patch"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.source, args.output)
    with args.output.open("r+b") as output:
        output.seek(patch_offset)
        output.write(PATCHED_BYTES)
    shutil.copymode(args.source, args.output)

    with args.output.open("rb") as output:
        output.seek(patch_offset)
        if output.read(len(PATCHED_BYTES)) != PATCHED_BYTES:
            fail("patched output verification failed")

    patched_sha = sha256(args.output)
    if patched_sha != patched_sha256:
        fail(
            "patched output hash mismatch; expected SHA-256 "
            f"{patched_sha256}, got {patched_sha}"
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
