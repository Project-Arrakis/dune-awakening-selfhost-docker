import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { playersApi, type DeletedCharacterAsset, type DeletedCharacterAssetsResult, type DeletedCharacterEntry } from "../../api/players";
import { DataTable } from "../../components/common/DataTable";
import { formatAbsoluteDateTime } from "../../lib/display";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Same style as Active players' Last Online one toggle away -- notably "Last
// seen" here is the very same field (last_avatar_activity) that view renders.
function formatTimestamp(value: string | null) {
  return formatAbsoluteDateTime(value, "Unknown");
}

// dune.account_removal_log stores the game's own wording. "new char in fls"
// means the player deleted this character and immediately made another one on
// the same Funcom account, which is a very different situation for an admin
// than an outright deletion -- the account is still active, just under a new
// character.
export function deletionLabel(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "new char in fls") return "Recreated character";
  if (normalized === "deleted in fls") return "Deleted in FLS";
  if (!normalized) return "Reason unrecorded";
  return reason.trim();
}

function coordinateSummary(asset: DeletedCharacterAsset) {
  if (asset.x === null || asset.y === null) return "";
  return `${Math.round(asset.x)}, ${Math.round(asset.y)}`;
}

function locationLabel(asset: DeletedCharacterAsset) {
  return asset.partitionLabel || asset.map || "Unknown";
}

function assetRows(assets: DeletedCharacterAsset[]) {
  return assets.map((asset) => ({
    id: asset.id,
    name: asset.name || "Unnamed",
    asset_type: asset.assetType || "Unknown",
    location: locationLabel(asset),
    size: asset.kind === "base"
      ? asset.pieceCount === null ? "" : `${asset.pieceCount.toLocaleString()} pieces`
      : asset.moduleCount === null ? "" : `${asset.moduleCount.toLocaleString()} modules`,
    coordinates: coordinateSummary(asset),
    matched_by: asset.matchedBy || "No respawn record"
  }));
}

const BASE_COLUMNS = ["id", "name", "asset_type", "location", "size", "coordinates", "matched_by"];
const VEHICLE_COLUMNS = ["id", "name", "asset_type", "location", "size", "coordinates", "matched_by"];

// Label and value carry different neutral steps inside the pill so the four
// chips read as four facts rather than one run-on line. Both are neutrals, not
// further amber steps -- another warm tone here blends into the panel.
function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="deleted-character-chip">
      <span className="deleted-character-chip-label">{label}</span>
      <span className="deleted-character-chip-value">{value}</span>
    </span>
  );
}

type AssetTableProps = {
  title: string;
  assets: DeletedCharacterAsset[];
  emptyMessage: string;
  columns: string[];
  columnLabels: Record<string, string>;
  onOpen?: (id: string) => void;
};

function AssetTable({ title, assets, emptyMessage, columns, columnLabels, onOpen }: AssetTableProps) {
  return (
    <div className="deleted-character-assets-group">
      <h5 className="deleted-character-assets-subtitle">{title}</h5>
      <DataTable
        rows={assetRows(assets)}
        columns={columns}
        columnLabels={columnLabels}
        tableClassName="deleted-character-assets-table"
        wrapClassName="deleted-character-table-wrap"
        rowKey={(row) => String(row.id)}
        emptyMessage={emptyMessage}
        action={onOpen ? (row) => (
          <button type="button" onClick={() => onOpen(String(row.id))}>Open</button>
        ) : undefined}
      />
    </div>
  );
}

type DeletedCharacterAssetsProps = {
  onOpenBase?: (baseId: string) => void;
  onOpenVehicle?: (vehicleId: string) => void;
};

export function DeletedCharacterAssets({ onOpenBase, onOpenVehicle }: DeletedCharacterAssetsProps) {
  const [result, setResult] = useState<DeletedCharacterAssetsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [message, setMessage] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setMessage("");
    try {
      const next = await playersApi.deletedCharacters();
      if (requestIdRef.current !== requestId) return;
      const isSupported = next.capabilities?.deletedCharacters !== false;
      setSupported(isSupported);
      setResult(isSupported ? next : null);
      setMessage(isSupported ? "" : next.reason || "");
      setExpandedId((current) => (current && (next.characters || []).some(
        (character) => character.characterStateId === current) ? current : ""));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setResult(null);
      setSupported(true);
      setMessage(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  const characters = result?.characters || [];
  const totals = result?.totals;
  const unattributed = result?.unattributed || { bases: [], vehicles: [] };
  const unattributedCount = unattributed.bases.length + unattributed.vehicles.length;

  const assetsOf = (character: DeletedCharacterEntry) => ({
    bases: Array.isArray(character.bases) ? character.bases : [],
    vehicles: Array.isArray(character.vehicles) ? character.vehicles : []
  });
  const characterRows = characters.map((character) => {
    const { bases, vehicles } = assetsOf(character);
    return {
      character_state_id: character.characterStateId,
      character_name: character.characterName,
      status: deletionLabel(character.removalReason),
      deleted_at: formatTimestamp(character.deletedAt),
      replacement: character.replacementCharacterName || "None",
      assets: `${bases.length} ${bases.length === 1 ? "base" : "bases"} · ${vehicles.length} ${vehicles.length === 1 ? "vehicle" : "vehicles"}`
    };
  });
  const byId = new Map<string, DeletedCharacterEntry>(characters.map((character) => [character.characterStateId, character]));
  // Refresh keeps the previous result on screen. Tearing the whole tree down for
  // the spinner collapsed the section from ~918px to ~71px and back on every
  // click; only the very first load, with nothing to show yet, gets the panel.
  const showInitialLoading = loading && !result && !message;

  function toggleExpanded(id: string) {
    setExpandedId((current) => (current === id ? "" : id));
  }

  return (
    <section className="deleted-character-assets" aria-busy={loading}>
      <div className="panel-title">
        <div>
          <p className="action-help-note">
            Characters deleted from this server that still hold bases or vehicles. Deleting a character removes its
            ownership rows, so assets are matched back through the respawn points the character had set.
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>Refresh</button>
      </div>

      {showInitialLoading && <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Deleted Characters</strong></div>}

      {!loading && message && <p className={`playerAdmin_note${supported ? " danger" : ""}`}>{message}</p>}

      {!showInitialLoading && !message && totals && <>
        <p className="action-help-note deleted-character-summary">
          {totals.deletedCharactersHoldingAssets.toLocaleString()} deleted {totals.deletedCharactersHoldingAssets === 1 ? "character holds" : "characters hold"} {totals.attributedBases.toLocaleString()} {totals.attributedBases === 1 ? "base" : "bases"} and {totals.attributedVehicles.toLocaleString()} {totals.attributedVehicles === 1 ? "vehicle" : "vehicles"}.
          {totals.deletedCharactersWithoutAssets > 0 && ` ${totals.deletedCharactersWithoutAssets.toLocaleString()} other deleted ${totals.deletedCharactersWithoutAssets === 1 ? "character holds" : "characters hold"} none.`}
        </p>

        {result?.truncated && <p className="danger-note">Results were capped. Some deleted characters or orphaned assets are not shown.</p>}

        <DataTable
          rows={characterRows}
          columns={["character_name", "status", "deleted_at", "replacement", "assets"]}
          columnLabels={{
            character_name: "Character",
            deleted_at: "Deleted",
            replacement: "Replacement Character",
            assets: "Holds"
          }}
          tableClassName="deleted-character-table"
          wrapClassName="deleted-character-table-wrap"
          rowKey={(row) => String(row.character_state_id)}
          emptyMessage="No deleted characters are holding bases or vehicles."
          secondaryActionPosition="start"
          secondaryActionLabel=""
          secondaryActionClassName="deleted-character-expand-column"
          // The expanded row is the only place the per-asset Open buttons live,
          // so row-click alone would put them out of reach of a keyboard. Bases
          // and Vehicles pair their expandable rows with this same button.
          secondaryAction={(row) => {
            const id = String(row.character_state_id);
            const isExpanded = id === expandedId;
            const label = `${isExpanded ? "Collapse" : "Show"} assets held by ${String(row.character_name) || `character ${id}`}`;
            return <button
              className="deleted-character-expand-button"
              title={label}
              aria-label={label}
              aria-expanded={isExpanded}
              onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}
            >{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>;
          }}
          onRowClick={(row) => toggleExpanded(String(row.character_state_id))}
          isRowExpanded={(row) => String(row.character_state_id) === expandedId}
          renderExpandedRow={(row) => {
            const character = byId.get(String(row.character_state_id));
            if (!character) return null;
            return (
              <div className="deleted-character-detail">
                <div className="deleted-character-meta">
                  <MetaChip label="Account" value={character.accountId || "Unknown"} />
                  <MetaChip label="Character state" value={character.characterStateId} />
                  {character.flsId && <MetaChip label="FLS" value={character.flsId} />}
                  <MetaChip label="Last seen" value={formatTimestamp(character.lastAvatarActivity || character.lastLoginTime)} />
                </div>
                <AssetTable
                  title="Bases"
                  assets={assetsOf(character).bases}
                  emptyMessage="No bases."
                  columns={BASE_COLUMNS}
                  columnLabels={{ id: "Base ID", asset_type: "Type", size: "Size", matched_by: "Matched By" }}
                  onOpen={onOpenBase}
                />
                <AssetTable
                  title="Vehicles"
                  assets={assetsOf(character).vehicles}
                  emptyMessage="No vehicles."
                  columns={VEHICLE_COLUMNS}
                  columnLabels={{ id: "Vehicle ID", asset_type: "Type", size: "Fitted", matched_by: "Matched By" }}
                  onOpen={onOpenVehicle}
                />
              </div>
            );
          }}
        />

        <section className="deleted-character-unattributed">
          <div className="panel-title">
            <h4>Unattributed Orphans</h4>
            <span className="muted">{unattributedCount.toLocaleString()} {unattributedCount === 1 ? "asset" : "assets"}</span>
          </div>
          <p className="action-help-note">
            Claimed once but held by no living character, with no respawn record tying them to a specific deleted one.
            A character who never set a respawn point at a base or vehicle leaves it here rather than under their name.
          </p>
          <AssetTable
            title="Bases"
            assets={unattributed.bases}
            emptyMessage="No unattributed bases."
            columns={BASE_COLUMNS}
            columnLabels={{ id: "Base ID", asset_type: "Type", size: "Size", matched_by: "Matched By" }}
            onOpen={onOpenBase}
          />
          <AssetTable
            title="Vehicles"
            assets={unattributed.vehicles}
            emptyMessage="No unattributed vehicles."
            columns={VEHICLE_COLUMNS}
            columnLabels={{ id: "Vehicle ID", asset_type: "Type", size: "Fitted", matched_by: "Matched By" }}
            onOpen={onOpenVehicle}
          />
        </section>
      </>}
    </section>
  );
}
