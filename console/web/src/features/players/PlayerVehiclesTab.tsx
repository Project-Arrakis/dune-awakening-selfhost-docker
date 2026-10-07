import { useCallback, useEffect, useRef, useState } from "react";
import { vehiclesApi, type VehicleRow } from "../../api/vehicles";
import { PlayerAccessSelect } from "../../components/common/PlayerAccessSelect";
import { PLAYER_ACCESS_DEFAULT, accessCountLabel, accessEmptyAdjective, describePlayerAccess, filterRowsByAccess, type PlayerAccessFilter } from "../../lib/playerAccess";
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
  const [access, setAccess] = useState<PlayerAccessFilter>(PLAYER_ACCESS_DEFAULT);
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
      setRows(filterRowsByAccess(result.rows || [], access));
      setTruncated(Number(result.totalCount || 0) > (result.rows || []).length);
      setSupported(result.capabilities?.vehicles !== false);
      setCanEditPermissions(result.capabilities?.vehiclePermissions === true);
      setStorageSupported(result.capabilities?.vehicleStorage === true);
      setMessage(result.reason || "");
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setRows([]);
      setTruncated(false);
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
            <p className="playerAdmin_note">{describePlayerAccess("Vehicles", playerName, access)} Select a row to inspect its fitted components.</p>
          </div>
          <div className="action-row players-filter-row">
            <PlayerAccessSelect value={access} onChange={setAccess} />
            <button type="button" disabled={loading || !playerId} onClick={() => void load()}>Refresh</button>
          </div>
        </div>
        {loading
          ? <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Vehicles</strong></div>
          : message
            ? <p className={`playerAdmin_note${supported ? " danger" : ""}`}>{message}</p>
            : <>
                <div className="player-vehicles-summary" aria-label="Player vehicle totals">
                  <span><strong>{rows.length}</strong> {accessCountLabel(access)}</span>
                </div>
                {truncated && <p className="playerAdmin_note danger">This player has more vehicles than can be listed here; some vehicles may be missing.</p>}
                <VehicleTable
                  rows={rows}
                  context="player"
                  showAccessColumns={access === "all"}
                  showOwnerColumn={access === "coowner"}
                  emptyMessage={`${playerName} has no ${accessEmptyAdjective(access)}vehicles.${access === "all" ? "" : " Try another Permission level."}`}
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
