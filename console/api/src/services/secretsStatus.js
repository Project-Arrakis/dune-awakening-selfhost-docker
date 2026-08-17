import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

// The exact same 2 secrets Stage 2 (issue #318) wires -- deliberately
// hardcoded, never derived from request input or configuration, matching
// the same allow-list discipline runtime/scripts/secrets-cli.sh already
// applies (_dune_secrets_require_stage2_name). If a future stage wires
// more secrets, extend this list deliberately, not by making it dynamic.
const WIRED_SECRETS = ["server-login-password-secret", "username-server-login-secret"];

function isReadable(path) {
  // This try/catch is security-load-bearing, not just a convenience: a
  // raised ENOENT/EACCES error's own .message embeds the full absolute
  // filesystem path being checked, and redact()'s pattern list (see
  // console/api/src/redact.js) is credential-shaped (tokens/passwords),
  // not path-shaped -- it would NOT strip a leaked path if this catch
  // were ever removed and the error allowed to propagate to
  // apiErrorPayload's outer handler. Do not remove this try/catch during
  // a future refactor without adding an equivalent safeguard.
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Mirrors runtime/scripts/secrets-cli.sh's _dune_secrets_stage2_state()
// exactly -- same 4 states, same precedence order:
//   1. backend not configured (env vars unset) -> "backend-not-configured"
//   2. .enc file OR marker file independently readable -> "migrated"
//   3. .enc file OR marker file exists but neither is readable -> "broken"
//   4. neither exists -> "not-migrated"
// This is a DISPLAY-ONLY reimplementation of a filesystem-existence/
// readability check (see docs/design/secrets-status-panel-l1-design-2026-08-17.md
// §2 for why this specific, narrow duplication is accepted) -- it must
// NEVER be extended to reimplement decryption or any write path. If
// _dune_secrets_stage2_state() in secrets-cli.sh ever changes its
// precedence order or adds a new state, this function must be updated to
// match, and runtime/tests/test-secrets-status-panel-parity.sh (the
// cross-language drift-detection test) must be re-run to confirm parity.
export function secretState(repoRoot, name) {
  const kekConfigured = Boolean(process.env.DUNE_KEK_FILE) && Boolean(process.env.DUNE_AGE_IDENTITY_FILE);
  if (!kekConfigured) return "backend-not-configured";

  const encPath = join(repoRoot, "runtime", "secrets", `${name}.enc`);
  const markerPath = join(repoRoot, "runtime", "generated", ".secrets-migrated", `${name}.done`);

  if (isReadable(encPath)) return "migrated";
  if (isReadable(markerPath)) return "migrated";
  if (existsSync(encPath) || existsSync(markerPath)) return "broken";
  return "not-migrated";
}

export function allSecretStates(repoRoot) {
  return WIRED_SECRETS.map((name) => ({ name, state: secretState(repoRoot, name) }));
}
