import { useEffect, useRef, useState } from "react";
import { secretsApi } from "../../api/secrets";
import type { SecretState, SecretStatusEntry } from "../../api/secrets";
import { KeyValueGrid } from "../../components/common/DisplayPrimitives";

// Stage 2 Secrets Status Panel (issue #318/#320). Read-only migration-state
// display for exactly the 2 secrets Stage 2 wires -- server-login-password-secret
// and username-server-login-secret. Deliberately no migrate/verify/cleanup
// action buttons here; see docs/design/secrets-status-panel-l1-design-2026-08-17.md
// §1/§5 for the explicit scope boundary this panel does not cross (matches
// the same "no decrypt/restore through the browser" precedent issue #276
// already established for dune db backup-system).

// Explicit small-enum-to-tone lookup, not the free-text normalizeStatus()
// regex path -- matches PlayerStatusCell's own precedent for a small,
// closed enum. See the design doc's [R2] Finding UI-1 for why the naive
// free-text approach would have silently produced zero visual
// differentiation between "migrated" and "broken".
const SECRET_STATE_DISPLAY: Record<SecretState, { label: string; tone: "pass" | "fail" | "warn" | "info" }> = {
  "migrated": { label: "Migrated (encrypted)", tone: "pass" },
  "broken": { label: "Migrated but currently unreadable/broken", tone: "fail" },
  "not-migrated": { label: "Not migrated (legacy plaintext)", tone: "warn" },
  "backend-not-configured": { label: "Backend not configured", tone: "info" }
};

function friendlySecretName(name: string) {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function SecretsStatusPanel() {
  const [secrets, setSecrets] = useState<SecretStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshRef = useRef<Promise<void> | null>(null);

  async function refresh() {
    if (refreshRef.current) return refreshRef.current;
    setLoading(true);
    refreshRef.current = (async () => {
      try {
        const result = await secretsApi.status();
        setSecrets(result.secrets);
        setError("");
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    })().finally(() => {
      refreshRef.current = null;
      setLoading(false);
    });
    return refreshRef.current;
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Secrets Status</h2>
        <button onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
      </div>
      {error && <div className="danger-note">{error}</div>}
      {!error && (
        <KeyValueGrid
          items={secrets.map((entry) => {
            const display = SECRET_STATE_DISPLAY[entry.state];
            return [
              friendlySecretName(entry.name),
              <span className={`badge badge-${display.tone}`} key={entry.name}>{display.label}</span>
            ];
          })}
        />
      )}
    </section>
  );
}
