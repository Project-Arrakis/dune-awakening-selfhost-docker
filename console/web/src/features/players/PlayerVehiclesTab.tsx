import { useCallback, useEffect, useRef, useState } from "react";
import { vehiclesApi, type VehicleRow } from "../../api/vehicles";
import type { PlayerAccessFilter } from "../../api/bases";
import { VehicleTable } from "../vehicles/VehicleTable";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type PlayerVehiclesTabProps = {
  playerId: string;
  playerName: string;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

export function PlayerVehiclesTab({ playerId, playerName, confirmAction }: PlayerVehiclesTabProps) {
  const [rows, setRows] = useState<VehicleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [canEditPermissions, setCanEditPermissions] = useState(false);
  const [storageSupported, setStorageSupported] = useState(false);
  const [message, setMessage] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [access, setAccess] = useState<PlayerAccessFilter>("owner");
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setMessage("");
    try {
      const result = await vehiclesApi.forPlayer(playerId, { access });
      if (requestIdRef.current !== requestId) return;
      // The server applies the access filter; re-checking here also covers an
      // older API that ignores the parameter.
      const wanted = access === "owner" ? "Owner" : access === "coowner" ? "Co-Owner" : "";
      setRows((result.rows || []).filter((row) => !wanted || row.relationship === wanted));
      setSupported(result.capabilities?.vehicles !== false);
      setCanEditPermissions(result.capabilities?.vehiclePermissions === true);
      setStorageSupported(result.capabilities?.vehicleStorage === true);
      setMessage(result.reason || "");
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setRows([]);
      setSupported(true);
      setCanEditPermissions(false);
      setStorageSupported(false);
      setMessage(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [playerId, access]);

  useEffect(() => {
    if (playerId) void load();
    return () => { requestIdRef.current += 1; };
  }, [load, playerId]);

  return (
    <div className="playerAdmin_content">
      <section className="playerAdmin_box player-vehicles-panel">
        <div className="panel-title">
          <div>
            <h4>Vehicles</h4>
            <p className="playerAdmin_note">{access === "owner" ? `Vehicles owned by ${playerName}.` : access === "coowner" ? `Vehicles ${playerName} co-owns.` : `Vehicles ${playerName} owns or has owner, co-owner or associate access to (guild and public access are not listed).`} Select a row to inspect its fitted components.</p>
          </div>
          <div className="action-row">
            <label className="inline-filter-label">
              Access
              <select value={access} onChange={(event) => setAccess(event.target.value as PlayerAccessFilter)}>
                <option value="owner">Owned</option>
                <option value="coowner">Co-owner</option>
                <option value="all">All (owner, co-owner, associate)</option>
              </select>
            </label>
            <button type="button" disabled={loading || !playerId} onClick={() => void load()}>Refresh</button>
          </div>
        </div>
        {loading
          ? <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Vehicles</strong></div>
          : message
            ? <p className={`playerAdmin_note${supported ? " danger" : ""}`}>{message}</p>
            : <>
                <div className="player-vehicles-summary" aria-label="Player vehicle totals">
                  <span><strong>{rows.length}</strong> {access === "owner" ? "Owned" : access === "coowner" ? "Co-owned" : "Total"}</span>
                </div>
                {truncated && <p className="playerAdmin_note danger">This player has more vehicles than can be listed here; some owned vehicles may be missing.</p>}
                <VehicleTable
                  rows={rows}
                  context="player"
                  showAccessColumns={access === "all"}
                  emptyMessage={`${playerName} has no ${access === "owner" ? "owned " : access === "coowner" ? "co-owned " : ""}vehicles.`}
                  canEditPermissions={canEditPermissions}
                  storageSupported={storageSupported}
                  confirmAction={confirmAction}
                  // Rows are filtered on row.relationship, which shifts after a
                  // rank change -- refetch so the list stays in sync with what
                  // was just saved.
                  onPermissionsSaved={() => void load()}
                />
              </>}
      </section>
    </div>
  );
}
