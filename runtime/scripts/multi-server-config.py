#!/usr/bin/env python3
"""Plan, apply, and verify globally non-overlapping multi-server port profiles.

This helper is designed for dune-awakening-selfhost-docker deployments where
multiple isolated VMs share one public IPv4 address. It derives stock host-port
defaults from the checked-out repository and applies one uniform instance stride
to every managed host port and port-range base.

Global invariant:
    No numeric host port assigned to any managed service on any generated
    instance may overlap any other managed host port or range, regardless of
    protocol.

Container-internal-only ports are outside this collision domain. For example,
PostgreSQL may still listen on container port 5432 while its VM host mapping is
15432/16432/etc. The shared public/VM host namespace is what this tool allocates.

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
RABBITMQ_START = ROOT / "runtime" / "scripts" / "start-rabbitmq.sh"
ENV_EXAMPLE = ROOT / ".env.example"
METRICS_COMPOSE = ROOT / "docker-compose.metrics.yml"
ENV_PATH = ROOT / ".env"
GENERATED_DIR = ROOT / "runtime" / "generated"
BACKUP_ROOT = ROOT / "runtime" / "backups"

# Always-on management/tooling containers that never hold a host-facing port
# this tool rewrites (confirmed directly against docker-compose.yml,
# docker-compose.web.yml, and docker-compose.public-probe.yml -- none of the
# three publish any port at all). apply()'s running-container safety check
# exists to prevent changing a host's network identity while something is
# actively using the OLD ports; these three do not use any port apply()
# changes, so leaving them running is never actually unsafe. Excluding them
# here matters in practice, not just in theory: the console itself is what
# an operator almost always uses to reach a shell on this host in the first
# place, so without this exclusion the documented "stop the stack, then
# apply" procedure fails every single time (confirmed via a live,
# reproduced test against a real deployment -- see issue #283).
NON_BLOCKING_MANAGEMENT_CONTAINERS = frozenset({
    "dune-orchestrator",
    "redblink-dune-docker-console",
    "dune-public-probe",
})

# A single stride for every host port/base is intentional. It makes allocations
# easy to audit and prevents cross-instance Game/IGW/service collisions.
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
    rmq_game_local_http: int
    text_router: int
    director: int
    admin_web: int
    prometheus: int


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
    rmq_game_local_http: int
    text_router: int
    director: int
    admin_web: int
    prometheus: int


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


def parse_prometheus_default() -> int:
    text = read_text(METRICS_COMPOSE)
    match = re.search(r"METRICS_PROMETHEUS_PORT:-([0-9]+)", text)
    if not match:
        raise ConfigError(f"Could not derive METRICS_PROMETHEUS_PORT from {METRICS_COMPOSE}.")
    return int(match.group(1))


def parse_rmq_game_local_http_default() -> int:
    text = read_text(RABBITMQ_START)
    match = re.search(
        r"port_env_value\s+RMQ_GAME_LOCAL_HTTP_PORT\s+([0-9]+)", text
    )
    if not match:
        raise ConfigError(
            f"Could not derive RMQ_GAME_LOCAL_HTTP_PORT from {RABBITMQ_START}."
        )
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
        rmq_game_local_http=parse_rmq_game_local_http_default(),
        text_router=service["text_router"],
        director=service["director"],
        admin_web=parse_admin_default(),
        prometheus=parse_prometheus_default(),
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
        rmq_game_local_http=defaults.rmq_game_local_http + offset,
        text_router=defaults.text_router + offset,
        director=defaults.director + offset,
        admin_web=defaults.admin_web + offset,
        prometheus=defaults.prometheus + offset,
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
        Allocation(
            profile.instance,
            "RMQ Game Local HTTP TCP",
            profile.rmq_game_local_http,
            profile.rmq_game_local_http,
        ),
        Allocation(profile.instance, "Text Router TCP", profile.text_router, profile.text_router),
        Allocation(profile.instance, "Director TCP", profile.director, profile.director),
        Allocation(profile.instance, "Admin Web TCP", profile.admin_web, profile.admin_web),
        Allocation(profile.instance, "Prometheus TCP", profile.prometheus, profile.prometheus),
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

    # Deliberately ignore protocol. For this community profile, a numeric host
    # port belongs to exactly one managed endpoint anywhere in the multi-VM plan.
    ordered = sorted(rows, key=lambda row: (row.start, row.end, row.instance, row.name))
    for index, left in enumerate(ordered):
        for right in ordered[index + 1 :]:
            if right.start > left.end:
                break
            if ranges_overlap(left.start, left.end, right.start, right.end):
                raise ConfigError(
                    "Global port collision detected: "
                    f"{left.label} overlaps {right.label}. "
                    "Every managed host port across every VM must be numerically unique."
                )


def validate_profile(profile: Profile) -> None:
    validate_allocations(allocations(profile))


def validate_profiles(profiles: list[Profile]) -> None:
    rows: list[Allocation] = []
    for profile in profiles:
        rows.extend(allocations(profile))
    validate_allocations(rows)


def validate_instance_capacity(instance: int, defaults: Defaults) -> None:
    # Validate VM1 through the requested VM so a new instance cannot collide
    # with an earlier profile.
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
    lines = (
        path.read_text(encoding="utf-8", errors="replace").splitlines()
        if path.exists()
        else []
    )
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

    # Upstream review finding: this previously hardcoded mode 0o644,
    # bypassing atomic_write()'s own existing-mode-preservation logic
    # (see its `mode if mode is not None else (existing_mode or 0o644)`
    # above). .env can legitimately hold real secrets directly
    # (ADMIN_PASSWORD, DUNE_DB_PASSWORD, DUNE_COMMAND_AUTH_TOKEN,
    # DUNE_DISCORD_ADAPTER_TOKEN -- that's exactly why each has a
    # `_FILE` variant as the alternative), so an operator who has
    # manually tightened .env to 0600 must not have that silently
    # loosened back to 644 by this tool. Passing None here delegates to
    # atomic_write()'s existing preserve-mode behavior -- identical to
    # repair-host-runtime-permissions.sh's own `chmod --reference=.env`
    # pattern for the same file. A brand-new .env (no prior mode to
    # preserve) still defaults to 644, matching this project's existing,
    # already-established convention (see init.sh/manager.sh/memory.sh,
    # which all explicitly `chmod 644 .env`) -- this fix only stops an
    # existing, tighter permission from being overwritten, it does not
    # change the default for a fresh file.
    atomic_write(path, "\n".join(out).rstrip() + "\n", None)


def make_backup() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = BACKUP_ROOT / f"multi-server-config-{stamp}"
    suffix = 0
    while backup_dir.exists():
        suffix += 1
        backup_dir = BACKUP_ROOT / f"multi-server-config-{stamp}-{suffix}"
    backup_dir.mkdir(parents=True, exist_ok=False)

    for path in (
        ENV_PATH,
        GENERATED_DIR / "usersettings.json",
        GENERATED_DIR / "gameplay-profile.ini",
    ):
        if not path.exists():
            continue
        relative = path.relative_to(ROOT)
        target = backup_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    return backup_dir


def restore_backup(backup_dir: Path) -> None:
    """Restores .env/usersettings.json/gameplay-profile.ini from a backup
    directory created by make_backup(). Used by command_apply()'s
    automatic rollback (see upstream review finding above
    command_apply()) -- copies whatever make_backup() actually captured
    back over the live files, and removes a generated file that didn't
    exist yet at backup time (so a rollback after a fresh-install
    partial apply doesn't leave a newly-created file behind that wasn't
    there before this apply started)."""
    for path in (
        ENV_PATH,
        GENERATED_DIR / "usersettings.json",
        GENERATED_DIR / "gameplay-profile.ini",
    ):
        relative = path.relative_to(ROOT)
        backed_up = backup_dir / relative
        if backed_up.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backed_up, path)
        elif path.exists():
            path.unlink()


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
    # Upstream review finding: this previously treated ANY failure to
    # query Docker (daemon unreachable, permission denied on the socket,
    # `docker` not installed/not on PATH) identically to "nothing is
    # running," silently allowing command_apply() to proceed and rewrite
    # .env/UserEngine.ini while the stack may in fact still be fully
    # live -- a real, reachable misconfiguration-safety gap, not a
    # theoretical one, since a query failure here gives strictly less
    # information than a successful empty result, not more. This safety
    # check must fail closed: if Docker cannot be queried at all, treat
    # that the same as "yes, something might be running" and require
    # the operator to either fix the query problem or explicitly pass
    # --allow-running, rather than silently trusting an unverifiable
    # "nothing is running" conclusion.
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            cwd=ROOT,
            text=True,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ConfigError(
            "Could not query Docker to check for running Dune containers "
            f"(fail-closed safety check): {exc}. Verify Docker is running and "
            "this user has permission to query it (e.g. `docker ps`), or pass "
            "--allow-running to proceed anyway once you have manually confirmed "
            "the stack is stopped."
        ) from exc
    return [
        name.strip()
        for name in result.stdout.splitlines()
        if (
            name.strip().startswith("dune-")
            or name.strip() == "redblink-dune-docker-console"
        )
        and name.strip() not in NON_BLOCKING_MANAGEMENT_CONTAINERS
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
        "RMQ_GAME_LOCAL_HTTP_PORT": str(profile.rmq_game_local_http),
        "TEXT_ROUTER_PORT": str(profile.text_router),
        "DIRECTOR_PORT": str(profile.director),
        "ADMIN_BIND_PORT": str(profile.admin_web),
        "ADMIN_WEB_PORT": str(profile.admin_web),
        "METRICS_PROMETHEUS_PORT": str(profile.prometheus),
        # Retained for console/documentation compatibility. UserEngine remains
        # authoritative for the game and IGW bases.
        "CLIENT_PORT_BASE": str(profile.client),
        "IGW_PORT_BASE": str(profile.igw),
    }


def print_profile(profile: Profile) -> None:
    print(f"Instance {profile.instance}")
    print(f"  Player/game UDP     : {profile.client}-{profile.client_end}")
    print(f"  IGW UDP             : {profile.igw}-{profile.igw_end}")
    print(f"  PostgreSQL TCP      : {profile.postgres}")
    print(f"  RMQ Admin TCP       : {profile.rmq_admin}")
    print(f"  RMQ Game TCP        : {profile.rmq_game}")
    print(f"  RMQ Game HTTP       : {profile.rmq_game_http}")
    print(f"  RMQ Local HTTP TCP  : {profile.rmq_game_local_http}")
    print(f"  Text Router TCP     : {profile.text_router}")
    print(f"  Director TCP        : {profile.director}")
    print(f"  Admin Web TCP       : {profile.admin_web}")
    print(f"  Prometheus TCP      : {profile.prometheus}")


def nat_lines(profile: Profile, bind_ip: str = "<VM_LAN_IP>") -> list[str]:
    # Upstream review finding: this previously listed the IGW range
    # alongside the genuinely-forwarded ranges under the "Public NAT /
    # port-forward plan" heading (see command_plan()), directly
    # contradicting this project's own documented decision that IGW is
    # internal map-to-map traffic and must NOT be forwarded publicly
    # (see docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md's NAT plan
    # section, and the live multi-VM testing comment on this PR that
    # confirmed IGW is intentionally never publicly forwarded on either
    # test VM). Printing it here under a "port-forward plan" heading
    # told operators to do the opposite of what the guide says. IGW is
    # listed as informational only, clearly labeled as such and
    # deliberately not aimed at the LAN bind_ip the way a real
    # port-forward target line is, so it can't be copy-pasted directly
    # into a router's NAT rule table by mistake.
    return [
        f"UDP {profile.client}-{profile.client_end} -> {bind_ip}:{profile.client}-{profile.client_end}  # Player/Game",
        f"TCP {profile.rmq_game} -> {bind_ip}:{profile.rmq_game}  # RMQ Game",
        f"TCP {profile.rmq_game_http} -> {bind_ip}:{profile.rmq_game_http}  # RMQ Game HTTP",
        f"TCP {profile.admin_web} -> {bind_ip}:{profile.admin_web}  # only if exposing Web Console",
        f"(informational, do NOT forward) IGW UDP {profile.igw}-{profile.igw_end} is internal map-to-map traffic only",
    ]


def command_plan(args: argparse.Namespace, defaults: Defaults) -> int:
    profiles = [profile_for(i, defaults) for i in range(1, args.instances + 1)]
    validate_profiles(profiles)
    if args.json:
        print(
            json.dumps(
                {
                    "stride": INSTANCE_PORT_STRIDE,
                    "defaults": asdict(defaults),
                    "profiles": [asdict(profile) for profile in profiles],
                },
                indent=2,
            )
        )
        return 0

    print(f"Global instance port stride: +{INSTANCE_PORT_STRIDE}")
    print("Policy: no numeric host port may overlap another managed host port across any VM.\n")
    print("Derived repository defaults:")
    print(json.dumps(asdict(defaults), indent=2))
    print()
    for profile in profiles:
        print_profile(profile)
        print("  Public NAT / port-forward plan:")
        for line in nat_lines(profile):
            print(f"    {line}")
        print()
    print("VALIDATION: all generated managed host ports are globally non-overlapping.")
    return 0


def command_apply(args: argparse.Namespace, defaults: Defaults) -> int:
    validate_instance_capacity(args.instance, defaults)
    profile = profile_for(args.instance, defaults)
    public_ip = validate_ipv4(args.public_ip, "--public-ip")
    bind_ip = validate_ipv4(args.bind_ip, "--bind-ip")
    # Only query Docker when the safety check can actually gate anything --
    # if --allow-running is already set, the operator has explicitly
    # accepted responsibility for verifying the stack is stopped
    # themselves, so a Docker query failure here (fail-closed above)
    # must not block the one escape hatch meant to handle exactly that
    # case.
    if not args.allow_running:
        active = running_dune_containers()
        if active:
            raise ConfigError(
                "Dune containers are running. Stop the stack before changing its "
                "network identity, or pass --allow-running to stage the changes only. "
                "Running: " + ", ".join(active)
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
    # Upstream review finding: this write sequence was not transactional
    # -- if .env was updated and a LATER usersettings.py call failed
    # (e.g. igw_port succeeds but port fails, or materialize-current
    # fails after both engine-set calls succeed), the host was left in a
    # real, reachable mixed state: .env pointing at the new profile
    # while gameplay-profile.ini/usersettings.json still reflected the
    # old one (or a half-updated one), with no automatic recovery and
    # only the manually-invoked `dune db restore`-style backup directory
    # as a recovery path. The existing --allow-running idempotent-retry
    # story (see the PR's own live-testing evidence: a deliberately
    # broken engine-set call, followed by a clean retry that repairs the
    # half-applied state) does show retrying eventually converges, but
    # an operator has no way to know that's true or safe to do without
    # already knowing this codebase in detail -- automatic rollback to
    # the pre-apply backup gives a much stronger, self-explanatory
    # guarantee: either this command's net effect is the full new
    # profile, or it's back to exactly what was there before, never
    # something in between left for the operator to discover later.
    try:
        upsert_env(ENV_PATH, updates)

        # Move IGW first so no transient Port-vs-IGW overlap is introduced while
        # changing away from stock values.
        usersettings_run("engine-set", "igw_port", str(profile.igw))
        usersettings_run("engine-set", "port", str(profile.client))
        usersettings_run("materialize-current")
    except Exception as exc:
        restore_backup(backup_dir)
        raise ConfigError(
            f"Apply failed partway through and was rolled back to the pre-apply "
            f"state (backup: {backup_dir.relative_to(ROOT)}). No partial changes "
            f"were left in place. Original error: {exc}"
        ) from exc

    print(f"Applied multi-server profile for instance {profile.instance}.")
    print(f"Backup: {backup_dir.relative_to(ROOT)}")
    print_profile(profile)
    print("\nConfigure public NAT / port forwarding:")
    for line in nat_lines(profile, bind_ip):
        print(f"  {line}")
    print(
        "\nNo containers were restarted. Restart after network/firewall/NAT "
        "changes, then run verify and dune doctor."
    )
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
        "RMQ_GAME_LOCAL_HTTP_PORT": str(profile.rmq_game_local_http),
        "TEXT_ROUTER_PORT": str(profile.text_router),
        "DIRECTOR_PORT": str(profile.director),
        "ADMIN_BIND_PORT": str(profile.admin_web),
        "ADMIN_WEB_PORT": str(profile.admin_web),
        "METRICS_PROMETHEUS_PORT": str(profile.prometheus),
        "CLIENT_PORT_BASE": str(profile.client),
        "IGW_PORT_BASE": str(profile.igw),
    }
    for key, expected in expected_env.items():
        compare_value(failures, env.get(key), expected, f".env {key}")

    compare_value(failures, engine.get("port"), str(profile.client), "UserEngine Port")
    compare_value(
        failures, engine.get("igw_port"), str(profile.igw), "UserEngine IGWPort"
    )

    if args.public_ip:
        compare_value(
            failures,
            env.get("SERVER_IP"),
            validate_ipv4(args.public_ip, "--public-ip"),
            ".env SERVER_IP",
        )
    if args.bind_ip:
        compare_value(
            failures,
            env.get("SERVER_BIND_IP"),
            validate_ipv4(args.bind_ip, "--bind-ip"),
            ".env SERVER_BIND_IP",
        )

    payload = {
        "ok": not failures,
        "instance": profile.instance,
        "expected": asdict(profile),
        "failures": failures,
    }
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
        description=(
            "Plan, apply, and verify globally non-overlapping multi-server "
            "host-port profiles."
        )
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
    apply.add_argument(
        "--allow-running",
        action="store_true",
        help="Stage changes while containers run; restart is still required.",
    )

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
