import { useCallback, useEffect, useRef, useState } from "react";
import { vehiclesApi, type VehicleRow } from "../../api/vehicles";
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
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setMessage("");
    try {
      const result = await vehiclesApi.forPlayer(playerId);
      if (requestIdRef.current !== requestId) return;
      // Only vehicles the player owns; ones merely shared with them are
      // managed from their owner's page.
      setTruncated(Number(result.totalCount || 0) > (result.rows || []).length);
      setRows((result.rows || []).filter((row) => row.relationship === "Owner"));
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
  }, [playerId]);

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
            <p className="playerAdmin_note">Vehicles owned by {playerName}. Select a row to inspect its fitted components.</p>
          </div>
          <button type="button" disabled={loading || !playerId} onClick={() => void load()}>Refresh</button>
        </div>
        {loading
          ? <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Vehicles</strong></div>
          : message
            ? <p className={`playerAdmin_note${supported ? " danger" : ""}`}>{message}</p>
            : <>
                <div className="player-vehicles-summary" aria-label="Player vehicle totals">
                  <span><strong>{rows.length}</strong> Owned</span>
                </div>
                {truncated && <p className="playerAdmin_note danger">This player has more vehicles than can be listed here; some owned vehicles may be missing.</p>}
                <VehicleTable
                  rows={rows}
                  context="player"
                  emptyMessage={`${playerName} has no owned vehicles.`}
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
