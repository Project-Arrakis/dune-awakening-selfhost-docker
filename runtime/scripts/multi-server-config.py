#!/usr/bin/env python3
"""Plan, apply, and verify globally non-overlapping multi-server port profiles.

This helper is designed for dune-awakening-selfhost-docker deployments where
multiple isolated VMs share one public IPv4 address. It derives the stock
single-server defaults from the checked-out repository and applies one uniform
instance stride to every managed port and port-range base.

Global invariant:
    No numeric port assigned to any managed service on any generated instance
    may overlap any other managed port or range, regardless of protocol.

Examples:
    python3 runtime/scripts/multi-server-config.py plan --instances 3
    python3 runtime/scripts/multi-server-config.py apply \
        --instance 2 --public-ip 203.0.113.10 --bind-ip 192.168.68.128
    python3 runtime/scripts/multi-server-config.py verify --instance 2
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ENV = ROOT / "runtime" / "scripts" / "runtime-env.sh"
USERSETTINGS = ROOT / "runtime" / "scripts" / "usersettings.py"
SPAWN_SERVER = ROOT / "runtime" / "scripts" / "spawn-server.sh"
ENV_EXAMPLE = ROOT / ".env.example"
ENV_PATH = ROOT / ".env"
GENERATED_DIR = ROOT / "runtime" / "generated"
BACKUP_ROOT = ROOT / "runtime" / "backups"

# One stride for every port/base is intentional. It makes the allocation model
# easy to audit and, unlike the earlier mixed-stride model, prevents the VM2
# player range from overlapping VM1's IGW range.
INSTANCE_PORT_STRIDE = 1000

SERVICE_DEFAULT_PATTERNS = {
    "postgres": ("POSTGRES_PORT", "resolve_postgres_port"),
    "rmq_admin": ("RMQ_ADMIN_PORT", "resolve_rmq_admin_port"),
    "rmq_game": ("RMQ_GAME_PORT", "resolve_rmq_game_port"),
    "rmq_game_http": ("RMQ_GAME_HTTP_PORT", "resolve_rmq_game_http_port"),
    "text_router": ("TEXT_ROUTER_PORT", "resolve_text_router_port"),
    "director": ("DIRECTOR_PORT", "resolve_director_port"),
}


@dataclass(frozen=True)
class Defaults:
    client: int
    igw: int
    client_max_offset: int
    igw_max_offset: int
    postgres: int
    rmq_admin: int
    rmq_game: int
    rmq_game_http: int
    text_router: int
    director: int
    admin_web: int


@dataclass(frozen=True)
class Profile:
    instance: int
    client: int
    client_end: int
    igw: int
    igw_end: int
    postgres: int
    rmq_admin: int
    rmq_game: int
    rmq_game_http: int
    text_router: int
    director: int
    admin_web: int


@dataclass(frozen=True)
class Allocation:
    instance: int
    name: str
    start: int
    end: int

    @property
    def label(self) -> str:
        value = str(self.start) if self.start == self.end else f"{self.start}-{self.end}"
        return f"VM{self.instance} {self.name} {value}"


class ConfigError(RuntimeError):
    pass


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"Cannot read required file: {path}: {exc}") from exc


def parse_service_defaults() -> dict[str, int]:
    text = read_text(RUNTIME_ENV)
    values: dict[str, int] = {}
    for field, (env_key, function_name) in SERVICE_DEFAULT_PATTERNS.items():
        pattern = (
            rf"{re.escape(function_name)}\(\)\s*\{{\s*"
            rf"port_env_value\s+{re.escape(env_key)}\s+([0-9]+)\s*;\s*\}}"
        )
        match = re.search(pattern, text)
        if not match:
            raise ConfigError(
                f"Could not derive {env_key} default from {RUNTIME_ENV}. "
                "The runtime source may have changed; update this helper before applying."
            )
        values[field] = int(match.group(1))
    return values


def parse_engine_defaults() -> tuple[int, int]:
    text = read_text(USERSETTINGS)
    port_match = re.search(
        r'"port"\s*:\s*\(\s*"URL"\s*,\s*"Port"\s*,\s*"([0-9]+)"\s*\)', text
    )
    igw_match = re.search(
        r'"igw_port"\s*:\s*\(\s*"URL"\s*,\s*"IGWPort"\s*,\s*"([0-9]+)"\s*\)', text
    )
    if not port_match or not igw_match:
        raise ConfigError(
            f"Could not derive Port/IGWPort defaults from {USERSETTINGS}. "
            "The usersettings schema may have changed."
        )
    return int(port_match.group(1)), int(igw_match.group(1))


def parse_pool_offsets() -> tuple[int, int]:
    text = read_text(SPAWN_SERVER)
    client_offsets = [int(v) for v in re.findall(r"CLIENT_PORT_BASE\s*\+\s*([0-9]+)", text)]
    igw_offsets = [int(v) for v in re.findall(r"IGW_PORT_BASE\s*\+\s*([0-9]+)", text)]
    if not client_offsets or not igw_offsets:
        raise ConfigError(f"Could not derive dynamic game/IGW pool size from {SPAWN_SERVER}.")
    return max(client_offsets), max(igw_offsets)


def parse_admin_default() -> int:
    text = read_text(ENV_EXAMPLE)
    match = re.search(r"(?m)^ADMIN_BIND_PORT=([0-9]+)\s*$", text)
    if not match:
        raise ConfigError(f"Could not derive ADMIN_BIND_PORT from {ENV_EXAMPLE}.")
    return int(match.group(1))


def load_defaults() -> Defaults:
    service = parse_service_defaults()
    client, igw = parse_engine_defaults()
    client_max_offset, igw_max_offset = parse_pool_offsets()
    return Defaults(
        client=client,
        igw=igw,
        client_max_offset=client_max_offset,
        igw_max_offset=igw_max_offset,
        postgres=service["postgres"],
        rmq_admin=service["rmq_admin"],
        rmq_game=service["rmq_game"],
        rmq_game_http=service["rmq_game_http"],
        text_router=service["text_router"],
        director=service["director"],
        admin_web=parse_admin_default(),
    )


def profile_for(instance: int, defaults: Defaults) -> Profile:
    if instance < 1:
        raise ConfigError("Instance number must be 1 or greater.")
    offset = (instance - 1) * INSTANCE_PORT_STRIDE
    profile = Profile(
        instance=instance,
        client=defaults.client + offset,
        client_end=defaults.client + offset + defaults.client_max_offset,
        igw=defaults.igw + offset,
        igw_end=defaults.igw + offset + defaults.igw_max_offset,
        postgres=defaults.postgres + offset,
        rmq_admin=defaults.rmq_admin + offset,
        rmq_game=defaults.rmq_game + offset,
        rmq_game_http=defaults.rmq_game_http + offset,
        text_router=defaults.text_router + offset,
        director=defaults.director + offset,
        admin_web=defaults.admin_web + offset,
    )
    validate_profile(profile)
    return profile


def allocations(profile: Profile) -> list[Allocation]:
    return [
        Allocation(profile.instance, "Player/Game UDP", profile.client, profile.client_end),
        Allocation(profile.instance, "IGW UDP", profile.igw, profile.igw_end),
        Allocation(profile.instance, "PostgreSQL TCP", profile.postgres, profile.postgres),
        Allocation(profile.instance, "RMQ Admin TCP", profile.rmq_admin, profile.rmq_admin),
        Allocation(profile.instance, "RMQ Game TCP", profile.rmq_game, profile.rmq_game),
        Allocation(profile.instance, "RMQ Game HTTP TCP", profile.rmq_game_http, profile.rmq_game_http),
        Allocation(profile.instance, "Text Router TCP", profile.text_router, profile.text_router),
        Allocation(profile.instance, "Director TCP", profile.director, profile.director),
        Allocation(profile.instance, "Admin Web TCP", profile.admin_web, profile.admin_web),
    ]


def ranges_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return max(a_start, b_start) <= min(a_end, b_end)


def validate_port(value: int, label: str) -> None:
    if not 1 <= value <= 65535:
        raise ConfigError(f"{label}={value} is outside the valid port range 1-65535.")


def validate_allocations(rows: list[Allocation]) -> None:
    for row in rows:
        validate_port(row.start, row.label)
        validate_port(row.end, row.label)
        if row.start > row.end:
            raise ConfigError(f"Invalid range: {row.label}")

    # Deliberately ignore protocol here. The community policy is stricter than
    # the kernel's TCP/UDP tuple rules: a numeric port belongs to exactly one
    # managed endpoint anywhere in the generated multi-VM plan.
    ordered = sorted(rows, key=lambda row: (row.start, row.end, row.instance, row.name))
    for index, left in enumerate(ordered):
        for right in ordered[index + 1 :]:
            if right.start > left.end:
                break
            if ranges_overlap(left.start, left.end, right.start, right.end):
                raise ConfigError(
                    "Global port collision detected: "
                    f"{left.label} overlaps {right.label}. "
                    "Every managed port across every VM must be numerically unique."
                )


def validate_profile(profile: Profile) -> None:
    validate_allocations(allocations(profile))


def validate_profiles(profiles: list[Profile]) -> None:
    rows: list[Allocation] = []
    for profile in profiles:
        rows.extend(allocations(profile))
    validate_allocations(rows)


def validate_instance_capacity(instance: int, defaults: Defaults) -> None:
    # Validate every profile from VM1 through the requested VM. This catches a
    # collision introduced by the requested instance against any earlier VM.
    profiles = [profile_for(i, defaults) for i in range(1, instance + 1)]
    validate_profiles(profiles)


def validate_ipv4(value: str, label: str) -> str:
    try:
        parsed = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ConfigError(f"{label} must be a valid IPv4 address: {value}") from exc
    if parsed.version != 4:
        raise ConfigError(f"{label} must be IPv4 for this guide: {value}")
    return str(parsed)


def env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def atomic_write(path: Path, content: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = None
    try:
        existing_mode = path.stat().st_mode & 0o777
    except OSError:
        pass
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode if mode is not None else (existing_mode or 0o644))
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def upsert_env(path: Path, updates: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines() if path.exists() else []
    seen: set[str] = set()
    out: list[str] = []
    key_pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
    for raw in lines:
        match = key_pattern.match(raw)
        if not match:
            out.append(raw)
            continue
        key = match.group(1)
        if key not in updates:
            out.append(raw)
            continue
        if key in seen:
            continue
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    missing = [key for key in updates if key not in seen]
    if missing:
        if out and out[-1].strip():
            out.append("")
        out.append("# Multi-server / single-public-IP instance profile")
        for key in missing:
            out.append(f"{key}={updates[key]}")
    atomic_write(path, "\n".join(out).rstrip() + "\n", 0o644)


def make_backup() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = BACKUP_ROOT / f"multi-server-config-{stamp}"
    suffix = 0
    while backup_dir.exists():
        suffix += 1
        backup_dir = BACKUP_ROOT / f"multi-server-config-{stamp}-{suffix}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    for path in (ENV_PATH, GENERATED_DIR / "usersettings.json", GENERATED_DIR / "gameplay-profile.ini"):
        if not path.exists():
            continue
        relative = path.relative_to(ROOT)
        target = backup_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    return backup_dir


def usersettings_run(*args: str, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(USERSETTINGS), *args],
        cwd=ROOT,
        text=True,
        check=True,
        capture_output=capture,
    )


def usersettings_engine_values() -> dict[str, str]:
    result = usersettings_run("engine-values", capture=True)
    values: dict[str, str] = {}
    for raw in result.stdout.splitlines():
        if "\t" not in raw:
            continue
        key, value = raw.split("\t", 1)
        values[key.strip()] = value.strip()
    return values


def running_dune_containers() -> list[str]:
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            cwd=ROOT,
            text=True,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    return [
        name.strip()
        for name in result.stdout.splitlines()
        if name.strip().startswith("dune-") or name.strip() == "redblink-dune-docker-console"
    ]


def profile_env(profile: Profile, public_ip: str, bind_ip: str) -> dict[str, str]:
    return {
        "SERVER_IP": public_ip,
        "SERVER_IP_MODE": "public",
        "SERVER_BIND_IP": bind_ip,
        "POSTGRES_PORT": str(profile.postgres),
        "RMQ_ADMIN_PORT": str(profile.rmq_admin),
        "RMQ_GAME_PORT": str(profile.rmq_game),
        "RMQ_GAME_HTTP_PORT": str(profile.rmq_game_http),
        "TEXT_ROUTER_PORT": str(profile.text_router),
        "DIRECTOR_PORT": str(profile.director),
        "ADMIN_BIND_PORT": str(profile.admin_web),
        "ADMIN_WEB_PORT": str(profile.admin_web),
        # Retained for console/documentation compatibility. UserEngine is authoritative.
        "CLIENT_PORT_BASE": str(profile.client),
        "IGW_PORT_BASE": str(profile.igw),
    }


def print_profile(profile: Profile) -> None:
    print(f"Instance {profile.instance}")
    print(f"  Player/game UDP : {profile.client}-{profile.client_end}")
    print(f"  IGW UDP         : {profile.igw}-{profile.igw_end}")
    print(f"  PostgreSQL TCP  : {profile.postgres}")
    print(f"  RMQ Admin TCP   : {profile.rmq_admin}")
    print(f"  RMQ Game TCP    : {profile.rmq_game}")
    print(f"  RMQ Game HTTP   : {profile.rmq_game_http}")
    print(f"  Text Router TCP : {profile.text_router}")
    print(f"  Director TCP    : {profile.director}")
    print(f"  Admin Web TCP   : {profile.admin_web}")


def nat_lines(profile: Profile, bind_ip: str = "<VM_LAN_IP>") -> list[str]:
    return [
        f"TCP {profile.rmq_game} -> {bind_ip}:{profile.rmq_game}",
        f"TCP {profile.rmq_game_http} -> {bind_ip}:{profile.rmq_game_http}",
        f"UDP {profile.client}-{profile.client_end} -> {bind_ip}:{profile.client}-{profile.client_end}",
        f"TCP {profile.admin_web} -> {bind_ip}:{profile.admin_web}  # only if exposing Web Console",
    ]


def command_plan(args: argparse.Namespace, defaults: Defaults) -> int:
    profiles = [profile_for(i, defaults) for i in range(1, args.instances + 1)]
    validate_profiles(profiles)
    if args.json:
        print(json.dumps({"stride": INSTANCE_PORT_STRIDE, "defaults": asdict(defaults), "profiles": [asdict(p) for p in profiles]}, indent=2))
        return 0
    print(f"Global instance port stride: +{INSTANCE_PORT_STRIDE}")
    print("Policy: no numeric port may overlap any other managed port across any VM.\n")
    print("Derived repository defaults:")
    print(json.dumps(asdict(defaults), indent=2))
    print()
    for profile in profiles:
        print_profile(profile)
        print("  Public NAT:")
        for line in nat_lines(profile):
            print(f"    {line}")
        print()
    print("VALIDATION: all generated managed ports are globally non-overlapping.")
    return 0


def command_apply(args: argparse.Namespace, defaults: Defaults) -> int:
    validate_instance_capacity(args.instance, defaults)
    profile = profile_for(args.instance, defaults)
    public_ip = validate_ipv4(args.public_ip, "--public-ip")
    bind_ip = validate_ipv4(args.bind_ip, "--bind-ip")
    active = running_dune_containers()
    if active and not args.allow_running:
        raise ConfigError(
            "Dune containers are running. Stop the stack before changing its network identity, "
            "or pass --allow-running to stage changes only. Running: " + ", ".join(active)
        )
    updates = profile_env(profile, public_ip, bind_ip)
    if args.dry_run:
        print("DRY RUN - no files will be changed.")
        print_profile(profile)
        print("\n.env updates:")
        for key, value in updates.items():
            print(f"{key}={value}")
        print("\nAuthoritative UserEngine updates:")
        print(f"IGWPort={profile.igw}")
        print(f"Port={profile.client}")
        print("\nGlobal collision validation: PASS")
        return 0
    backup_dir = make_backup()
    upsert_env(ENV_PATH, updates)
    # IGW first avoids transient Port-vs-IGW overlap when moving away from defaults.
    usersettings_run("engine-set", "igw_port", str(profile.igw))
    usersettings_run("engine-set", "port", str(profile.client))
    usersettings_run("materialize-current")
    print(f"Applied multi-server profile for instance {profile.instance}.")
    print(f"Backup: {backup_dir.relative_to(ROOT)}")
    print_profile(profile)
    print("\nConfigure public NAT/port forwarding:")
    for line in nat_lines(profile, bind_ip):
        print(f"  {line}")
    print("\nNo containers were restarted. Restart after NAT/firewall changes, then run verify and dune doctor.")
    return 0


def compare_value(failures: list[str], actual: str | None, expected: str, label: str) -> None:
    if actual != expected:
        failures.append(f"{label}: expected {expected}, found {actual!r}")


def command_verify(args: argparse.Namespace, defaults: Defaults) -> int:
    validate_instance_capacity(args.instance, defaults)
    profile = profile_for(args.instance, defaults)
    env = env_values(ENV_PATH)
    engine = usersettings_engine_values()
    failures: list[str] = []
    expected_env = {
        "POSTGRES_PORT": str(profile.postgres),
        "RMQ_ADMIN_PORT": str(profile.rmq_admin),
        "RMQ_GAME_PORT": str(profile.rmq_game),
        "RMQ_GAME_HTTP_PORT": str(profile.rmq_game_http),
        "TEXT_ROUTER_PORT": str(profile.text_router),
        "DIRECTOR_PORT": str(profile.director),
        "ADMIN_BIND_PORT": str(profile.admin_web),
        "ADMIN_WEB_PORT": str(profile.admin_web),
        "CLIENT_PORT_BASE": str(profile.client),
        "IGW_PORT_BASE": str(profile.igw),
    }
    for key, expected in expected_env.items():
        compare_value(failures, env.get(key), expected, f".env {key}")
    compare_value(failures, engine.get("port"), str(profile.client), "UserEngine Port")
    compare_value(failures, engine.get("igw_port"), str(profile.igw), "UserEngine IGWPort")
    if args.public_ip:
        compare_value(failures, env.get("SERVER_IP"), validate_ipv4(args.public_ip, "--public-ip"), ".env SERVER_IP")
    if args.bind_ip:
        compare_value(failures, env.get("SERVER_BIND_IP"), validate_ipv4(args.bind_ip, "--bind-ip"), ".env SERVER_BIND_IP")
    payload = {"ok": not failures, "instance": profile.instance, "expected": asdict(profile), "failures": failures}
    if args.json:
        print(json.dumps(payload, indent=2))
    elif failures:
        print("VERIFY: FAILED")
        for failure in failures:
            print(f"  - {failure}")
    else:
        print("VERIFY: configuration matches expected profile.")
        print_profile(profile)
        print("Global collision validation: PASS")
    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan, apply, and verify globally non-overlapping multi-server port profiles."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="Show profiles for several isolated VMs.")
    plan.add_argument("--instances", type=int, default=2)
    plan.add_argument("--json", action="store_true")
    apply = sub.add_parser("apply", help="Apply one profile to the current VM checkout.")
    apply.add_argument("--instance", type=int, required=True)
    apply.add_argument("--public-ip", required=True)
    apply.add_argument("--bind-ip", required=True)
    apply.add_argument("--dry-run", action="store_true")
    apply.add_argument("--allow-running", action="store_true", help="Stage changes while containers run; restart is still required.")
    verify = sub.add_parser("verify", help="Verify current config against one profile.")
    verify.add_argument("--instance", type=int, required=True)
    verify.add_argument("--public-ip")
    verify.add_argument("--bind-ip")
    verify.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    os.chdir(ROOT)
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        defaults = load_defaults()
        if args.command == "plan":
            if args.instances < 1:
                raise ConfigError("--instances must be 1 or greater.")
            return command_plan(args, defaults)
        if args.command == "apply":
            return command_apply(args, defaults)
        if args.command == "verify":
            return command_verify(args, defaults)
        raise ConfigError(f"Unknown command: {args.command}")
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: command failed: {' '.join(exc.cmd)}", file=sys.stderr)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
