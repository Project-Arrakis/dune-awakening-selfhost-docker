import { useState } from "react";
import { api } from "../../api/client";
import type { PolicyStatement } from "./iamTypes";
import { errorText } from "./iamTypes";

// Fixes the pre-existing, non-functional "Test" tab (found during this
// design's own research: the frontend POSTed {statements} and expected
// {results}, but the shipped route expected {action, tier} and returned
// {action, tier, allowed} -- every click either errored or silently did
// nothing). Extended into a real two-mode Policy Simulator matching real
// AWS IAM's own simulator, per design §4.5:
//   - "draft": test an unsaved statement set in isolation.
//   - "tier": test a real tier's actual, current, fully-aggregated
//     permissions (inline + every attached policy's default version) --
//     the new capability this design adds, since testing only a tier's
//     inline document gives an incomplete answer once any policy is
//     attached to it.

type Props = {
  mode: "draft" | "tier";
  draftStatements?: PolicyStatement[];
  tier?: string;
};

export function IamPolicySimulator({ mode, draftStatements, tier }: Props) {
  const [results, setResults] = useState<Record<string, boolean> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function runTest() {
    setRunning(true);
    setError("");
    try {
      const body = mode === "tier" ? { mode: "tier", tier } : { mode: "draft", statements: draftStatements || [] };
      const res = await api<{ results: Record<string, boolean> }>("/api/settings/iam/policy/test", { method: "POST", body: JSON.stringify(body) });
      setResults(res.results);
    } catch (e) {
      setError(errorText(e, "Failed to run the policy simulator."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="iam-test-panel">
      {error && <p className="iam-json-error">{error}</p>}
      {!results && (
        <button className="stable-action-button" onClick={runTest} disabled={running}>
          {running ? "Running..." : "Run test"}
        </button>
      )}
      {results && (
        <>
          <div className="iam-test-summary">
            <span className="test-count-allowed">{Object.values(results).filter(Boolean).length} allowed</span>
            <span className="test-count-denied">{Object.values(results).filter(v => !v).length} denied</span>
          </div>
          <div className="iam-test-table">
            {Object.entries(results).sort(([, a], [, b]) => (a === b ? 0 : a ? -1 : 1)).map(([action, allowed]) => (
              <div key={action} className={`iam-test-row ${allowed ? "test-allowed" : "test-denied"}`}>
                <span className={`test-indicator ${allowed ? "" : "test-blocked"}`}>{allowed ? "✓" : "✗"}</span>
                <span className="test-action-name">{action}</span>
              </div>
            ))}
          </div>
          <button className="stable-action-button" onClick={runTest} disabled={running} style={{ marginTop: "0.75rem" }}>
            {running ? "Running..." : "Re-run test"}
          </button>
        </>
      )}
    </div>
  );
}
