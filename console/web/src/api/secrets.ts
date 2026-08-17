import { api } from "./client";

// Stage 2 of the age-based secrets library rollout (issue #318). Exactly
// the 2 secrets that stage wires -- server-login-password-secret and
// username-server-login-secret. Mirrors runtime/scripts/secrets-cli.sh's
// own 4-state output exactly (see docs/design/secrets-status-panel-l1-design-2026-08-17.md).
export type SecretState = "backend-not-configured" | "not-migrated" | "migrated" | "broken";

export interface SecretStatusEntry {
  name: string;
  state: SecretState;
}

export const secretsApi = {
  status: () => api<{ secrets: SecretStatusEntry[] }>("/api/secrets/status")
};
