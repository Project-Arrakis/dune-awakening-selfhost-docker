import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretState, allSecretStates } from "../src/services/secretsStatus.js";

const NAME = "server-login-password-secret";

function withEnv(env, fn) {
  const original = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-secrets-status-"));
  mkdirSync(join(repoRoot, "runtime", "secrets"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime", "generated", ".secrets-migrated"), { recursive: true });
  return repoRoot;
}

test("secretState: backend not configured when either env var is missing", () => {
  const repoRoot = makeRepoRoot();
  try {
    withEnv({ DUNE_KEK_FILE: undefined, DUNE_AGE_IDENTITY_FILE: undefined }, () => {
      assert.equal(secretState(repoRoot, NAME), "backend-not-configured");
    });
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: undefined }, () => {
      assert.equal(secretState(repoRoot, NAME), "backend-not-configured");
    });
    withEnv({ DUNE_KEK_FILE: undefined, DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "backend-not-configured");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("secretState: not-migrated when backend configured but neither .enc nor marker exists", () => {
  const repoRoot = makeRepoRoot();
  try {
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "not-migrated");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("secretState: migrated when the .enc file exists and is readable", () => {
  const repoRoot = makeRepoRoot();
  try {
    writeFileSync(join(repoRoot, "runtime", "secrets", `${NAME}.enc`), "enc:v2:1:fake:fake");
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "migrated");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("secretState: migrated when only the marker file exists and is readable (no .enc file at all)", () => {
  const repoRoot = makeRepoRoot();
  try {
    writeFileSync(join(repoRoot, "runtime", "generated", ".secrets-migrated", `${NAME}.done`), "2026-08-17T00:00:00Z");
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "migrated");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// This is the specific adversarial case named by the Requirement 20 Layer 1
// audit (QA/Test hat, Finding QA-2): both the .enc file and the marker
// exist, but the .enc file is UNREADABLE while the marker IS readable.
// Per the documented precedence (either independently-readable signal is
// sufficient), the correct answer is "migrated" -- a subtly-wrong
// implementation that required BOTH signals to be readable simultaneously
// would instead incorrectly return "broken". This is precisely the shape
// of Stage 2's own past CRITICAL bug (the marker-check-not-threaded-through
// regression, resolved in runtime/scripts/lib/secrets.sh's
// dune_secrets_read_secret()), just in this display-layer reimplementation
// instead. Skipped when running as root, matching the same, already-
// accepted constraint test-secrets-lib.sh's own Test 8 and
// test-secrets-stage2.sh's own Test 7b use -- root bypasses chmod
// readability restrictions entirely, so this simulation only works for a
// genuinely unprivileged process. Exercised for real in CI (GitHub Actions
// runs as a non-root user).
test("secretState: migrated when the marker is readable even though the .enc file exists but is NOT readable (adversarial precedence case)", { skip: process.getuid && process.getuid() === 0 ? "running as root -- chmod 000 does not block root from reading" : false }, () => {
  const repoRoot = makeRepoRoot();
  try {
    const encPath = join(repoRoot, "runtime", "secrets", `${NAME}.enc`);
    writeFileSync(encPath, "enc:v2:1:fake:fake");
    chmodSync(encPath, 0o000);
    writeFileSync(join(repoRoot, "runtime", "generated", ".secrets-migrated", `${NAME}.done`), "2026-08-17T00:00:00Z");
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "migrated");
    });
  } finally {
    chmodSync(join(repoRoot, "runtime", "secrets", `${NAME}.enc`), 0o600);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("secretState: broken when the .enc file exists but is unreadable and no marker exists", { skip: process.getuid && process.getuid() === 0 ? "running as root -- chmod 000 does not block root from reading" : false }, () => {
  const repoRoot = makeRepoRoot();
  try {
    const encPath = join(repoRoot, "runtime", "secrets", `${NAME}.enc`);
    writeFileSync(encPath, "enc:v2:1:fake:fake");
    chmodSync(encPath, 0o000);
    withEnv({ DUNE_KEK_FILE: "/some/kek.age", DUNE_AGE_IDENTITY_FILE: "/some/identity.txt" }, () => {
      assert.equal(secretState(repoRoot, NAME), "broken");
    });
  } finally {
    chmodSync(join(repoRoot, "runtime", "secrets", `${NAME}.enc`), 0o600);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("allSecretStates: returns exactly the 2 Stage 2 wired secrets, in a stable order", () => {
  const repoRoot = makeRepoRoot();
  try {
    withEnv({ DUNE_KEK_FILE: undefined, DUNE_AGE_IDENTITY_FILE: undefined }, () => {
      const states = allSecretStates(repoRoot);
      assert.equal(states.length, 2);
      assert.deepEqual(states.map((s) => s.name), ["server-login-password-secret", "username-server-login-secret"]);
      assert.ok(states.every((s) => s.state === "backend-not-configured"));
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("secretState never includes the secret's own name in a way that could be confused with a value, and never touches out-of-scope names", () => {
  const repoRoot = makeRepoRoot();
  try {
    withEnv({ DUNE_KEK_FILE: undefined, DUNE_AGE_IDENTITY_FILE: undefined }, () => {
      // Confirms the function is generic over `name` (used internally by
      // allSecretStates' hardcoded list) but does not itself impose scope
      // restriction -- that responsibility belongs to the CLI's own
      // allow-list (_dune_secrets_require_stage2_name in secrets-cli.sh).
      // This is intentional: secretState() is a pure path-existence check,
      // not a policy-enforcement point (the actual IAM secrets:read gate
      // and the hardcoded WIRED_SECRETS list in allSecretStates are what
      // scope this to exactly the 2 Stage 2 secrets in practice).
      assert.equal(secretState(repoRoot, "postgres-password"), "backend-not-configured");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
