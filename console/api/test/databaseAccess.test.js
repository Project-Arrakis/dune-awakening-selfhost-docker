import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("PostgreSQL host access stays loopback-only for SSH tunneling", () => {
  const script = readFileSync(new URL("../../../runtime/scripts/start-postgres.sh", import.meta.url), "utf8");
  assert.match(script, /-p\s+"127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432"/);
  assert.doesNotMatch(script, /-p\s+"(?:0\.0\.0\.0|\[?::\]?):\$\{POSTGRES_PORT\}:5432"/);
});

test("all world server launchers use the configured database password", () => {
  const launchers = [
    "spawn-server.sh",
    "start-server-survival-1.sh",
    "start-server-overmap.sh"
  ];

  for (const launcher of launchers) {
    const script = readFileSync(new URL(`../../../runtime/scripts/${launcher}`, import.meta.url), "utf8");
    assert.match(script, /DUNE_DB_PASSWORD="\$\{DUNE_DB_PASSWORD:-dune\}"/,
      `${launcher} must resolve the configured password with the compatible default`);
    assert.match(script, /"-DatabasePassword=\$DUNE_DB_PASSWORD"/,
      `${launcher} must pass the configured password as one quoted argument`);
    assert.doesNotMatch(script, /(?:^|\s)-DatabasePassword=dune(?:\s|$)/m,
      `${launcher} must not hardcode the default password`);
  }
});

test("all world server launchers source and wire sietch-login-password-args.sh into their docker run invocation", () => {
  // GHSA-fc89-h24v-6j3x (issue #252): ServerLoginPassword/ServerPassword
  // were previously passed as `docker run` positional arguments (sourced
  // from sietches.sh's `runtime-args` output via SIETCH_RUNTIME_ARGS),
  // visible in plaintext via `ps aux`/`/proc/<pid>/cmdline` and
  // `docker inspect --format '{{json .Args}}'`. Confirmed via two live,
  // real-player join tests (2026-08-12) that the game binary accepts both
  // values via environment variable instead. Unlike DatabasePassword
  // (still argv-only -- see the test above, both env-var key names tried
  // and failed, tracked separately as issue #251), this fix is confirmed
  // working and must not regress back to the positional-argument form.
  //
  // The actual extraction/filter logic lives in the shared
  // sietch-login-password-args.sh helper (tested directly below, once, not
  // per-launcher) -- this test only confirms each launcher script sources
  // that helper and actually wires its output into the docker run call.
  const launchers = [
    "spawn-server.sh",
    "start-server-survival-1.sh",
    "start-server-overmap.sh"
  ];

  for (const launcher of launchers) {
    const script = readFileSync(new URL(`../../../runtime/scripts/${launcher}`, import.meta.url), "utf8");
    assert.match(script, /^source runtime\/scripts\/sietch-login-password-args\.sh$/m,
      `${launcher} must source the shared sietch-login-password-args.sh helper`);
    assert.match(script, /sietch_login_password_docker_args SIETCH_RUNTIME_ARGS SIETCH_LOGIN_PASSWORD_ARGS SIETCH_RUNTIME_ARGS_FILTERED/,
      `${launcher} must call the shared function with the expected array names`);
    assert.match(script, /SIETCH_RUNTIME_ARGS=\("\$\{SIETCH_RUNTIME_ARGS_FILTERED\[@\]\}"\)/,
      `${launcher} must replace SIETCH_RUNTIME_ARGS with the filtered (password-stripped) result`);

    // Per a Requirement 20 Layer 2 audit (Security Architect hat,
    // 2026-08-12): confirm SIETCH_LOGIN_PASSWORD_ARGS is actually
    // referenced inside the specific `docker run ... "$IMAGE"` invocation,
    // not just built and left unused elsewhere in the file. Verified by
    // deliberately removing this one line during the audit -- every other
    // assertion in this test file still passed, confirming this specific
    // check is the one that catches that exact failure mode.
    const dockerRunBlock = script.match(/docker run -d \\[\s\S]*?"\$IMAGE" \\/)?.[0];
    assert.ok(dockerRunBlock, `${launcher} must have a docker run ... "$IMAGE" invocation`);
    assert.match(dockerRunBlock, /"\$\{SIETCH_LOGIN_PASSWORD_ARGS\[@\]\}"/,
      `${launcher} must actually pass SIETCH_LOGIN_PASSWORD_ARGS to the docker run invocation, not just construct it`);
  }
});

test("sietch_login_password_docker_args behaves correctly when actually executed", () => {
  // Per a Requirement 20 Layer 2 audit (Security Architect + QA hats,
  // 2026-08-12): a pure text-pattern test would still pass if the shared
  // function's logic were broken (e.g. a typo in a case pattern that never
  // populates a variable). This test sources the real, shared
  // sietch-login-password-args.sh (not a reimplementation) and calls the
  // real function under real bash against three fixture inputs, asserting
  // on the actual resulting array contents -- matching the
  // extraction-and-execute pattern already established in
  // sietchRestartScript.test.js for this repo's other shell logic. Since
  // the logic is now consolidated into one shared file (see the Architect
  // hat's L2 finding on the prior triplicated version), this is tested
  // once here rather than once per launcher script.
  const helperPath = new URL("../../../runtime/scripts/sietch-login-password-args.sh", import.meta.url).pathname;

  function runHelper(sietchArgs) {
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `source "${helperPath}"`,
      `SIETCH_RUNTIME_ARGS=(${sietchArgs.map((a) => JSON.stringify(a)).join(" ")})`,
      "declare -a OUT_LOGIN_ARGS",
      "declare -a OUT_FILTERED_ARGS",
      "sietch_login_password_docker_args SIETCH_RUNTIME_ARGS OUT_LOGIN_ARGS OUT_FILTERED_ARGS",
      'printf "LOGIN_ARGS_COUNT=%s\\n" "${#OUT_LOGIN_ARGS[@]}"',
      'for a in "${OUT_LOGIN_ARGS[@]:-}"; do if [ -n "$a" ]; then printf "LOGIN_ARG=%s\\n" "$a"; fi; done',
      'printf "FILTERED_COUNT=%s\\n" "${#OUT_FILTERED_ARGS[@]}"',
      'for a in "${OUT_FILTERED_ARGS[@]:-}"; do if [ -n "$a" ]; then printf "FILTERED_ARG=%s\\n" "$a"; fi; done',
      "true"
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(result.status, 0, `helper script must exit 0 (stderr: ${result.stderr})`);
    return result.stdout;
  }

  // Case 1: a sietch WITH a password configured (matches this
  // deployment's actual Survival_1 shape at time of writing).
  const withPassword = runHelper([
    "-ServerDisplayName=Sietch Zahir",
    "-ServerLoginPassword=Example-Placeholder-123",
    "-ServerPassword=Example-Placeholder-123"
  ]);
  assert.match(withPassword, /LOGIN_ARGS_COUNT=8/,
    'expected 8 array elements (4x "-e KEY=value" pairs: bare+prefixed for each of the 2 secrets) when a password is configured');
  assert.match(withPassword, /LOGIN_ARG=-e\nLOGIN_ARG=ServerLoginPassword=Example-Placeholder-123/,
    "ServerLoginPassword must be extracted with its real value");
  assert.match(withPassword, /LOGIN_ARG=BackendLoginConfiguration__ServerLoginPassword=Example-Placeholder-123/,
    "BackendLoginConfiguration__ alias must carry the same value");
  assert.match(withPassword, /LOGIN_ARG=ServerPassword=Example-Placeholder-123/,
    "ServerPassword must be extracted with its real value");
  assert.doesNotMatch(withPassword, /FILTERED_ARG=-ServerLoginPassword=/,
    "the positional-argument form must be stripped from the filtered array");
  assert.doesNotMatch(withPassword, /FILTERED_ARG=-ServerPassword=/,
    "the positional-argument form must be stripped from the filtered array");
  assert.match(withPassword, /FILTERED_ARG=-ServerDisplayName=Sietch Zahir/,
    "unrelated positional args must survive the filter untouched");

  // Case 2: a sietch with NO password configured -- this is this
  // deployment's actual live shape for Overmap (`sietches.sh runtime-args
  // Overmap 2` returns only -ServerDisplayName=..., confirmed against the
  // real config at time of writing). The array-based -e construction must
  // produce zero arguments, not an empty-string argument, so it doesn't
  // inject a malformed flag into `docker run`.
  const noPassword = runHelper(["-ServerDisplayName=Sietch Overland"]);
  assert.match(noPassword, /LOGIN_ARGS_COUNT=0/,
    "no -e args should be added when no password is configured");
  assert.match(noPassword, /FILTERED_ARG=-ServerDisplayName=Sietch Overland/,
    "the display-name arg must survive unmodified when no password is present");

  // Case 3: completely empty SIETCH_RUNTIME_ARGS (defensive -- sietches.sh
  // runtime-args can return nothing at all if it errors, per its own
  // `2>/dev/null || true` fallback in the mapfile call).
  const empty = runHelper([]);
  assert.match(empty, /LOGIN_ARGS_COUNT=0/,
    "must not error or inject anything when SIETCH_RUNTIME_ARGS is entirely empty");
  assert.match(empty, /FILTERED_COUNT=0/,
    "filtered array must also remain empty");
});

test("sietch_login_password_docker_args rejects aliased array-name arguments instead of silently corrupting data", () => {
  // Per a Requirement 20 Layer 3 audit (Architect hat, 2026-08-12): this
  // function has three nameref parameters (one input, two output). If a
  // future caller ever passes the same variable name for two of the
  // three, bash would alias them to the same underlying array, and
  // because each output array is zeroed (`=()`) before being rebuilt, an
  // alias with the input array would silently wipe the source data before
  // it's fully read -- producing an empty result instead of a loud error.
  // No current call site does this (verified by the wiring test above),
  // but the function itself must fail loudly if it ever happens, rather
  // than silently dropping a password. This test proves the guard added
  // in response to that finding actually works, via real execution, not
  // just reading the code.
  const helperPath = new URL("../../../runtime/scripts/sietch-login-password-args.sh", import.meta.url).pathname;

  function runAliasedCall(arg1Name, arg2Name, arg3Name) {
    const script = [
      "#!/usr/bin/env bash",
      "set -uo pipefail", // deliberately no -e: we want to observe the non-zero exit, not abort the harness
      `source "${helperPath}"`,
      'SIETCH_RUNTIME_ARGS=("-ServerDisplayName=Sietch Zahir" "-ServerLoginPassword=Example-Placeholder-123")',
      "declare -a SIETCH_LOGIN_PASSWORD_ARGS",
      "declare -a SIETCH_RUNTIME_ARGS_FILTERED",
      `sietch_login_password_docker_args ${arg1Name} ${arg2Name} ${arg3Name}`,
      "exit $?"
    ].join("\n");
    return spawnSync("bash", ["-c", script], { encoding: "utf8" });
  }

  for (const [arg1, arg2, arg3, label] of [
    ["SIETCH_RUNTIME_ARGS", "SIETCH_RUNTIME_ARGS", "SIETCH_RUNTIME_ARGS_FILTERED", "arg1==arg2 (source aliased with login-args output)"],
    ["SIETCH_RUNTIME_ARGS", "SIETCH_LOGIN_PASSWORD_ARGS", "SIETCH_RUNTIME_ARGS", "arg1==arg3 (source aliased with filtered output)"],
    ["SIETCH_RUNTIME_ARGS", "SIETCH_LOGIN_PASSWORD_ARGS", "SIETCH_LOGIN_PASSWORD_ARGS", "arg2==arg3 (the two outputs aliased with each other)"]
  ]) {
    const result = runAliasedCall(arg1, arg2, arg3);
    assert.notEqual(result.status, 0, `${label} must fail loudly (non-zero exit), not silently succeed`);
    assert.match(result.stderr, /BUG: all three array-name arguments must be distinct/,
      `${label} must produce the specific guard error message`);
  }

  // Sanity check: three genuinely distinct names must still work
  // (the guard must not be overly broad and reject valid calls).
  const validResult = runAliasedCall("SIETCH_RUNTIME_ARGS", "SIETCH_LOGIN_PASSWORD_ARGS", "SIETCH_RUNTIME_ARGS_FILTERED");
  assert.equal(validResult.status, 0, `three distinct array names must still succeed (stderr: ${validResult.stderr})`);
});
