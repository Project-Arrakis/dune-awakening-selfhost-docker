import type { PartitionCombatStateRow } from "../../api/maps";

export function CombatSettingsNotice({ row, hasUnsavedChanges = false }: { row?: PartitionCombatStateRow; hasUnsavedChanges?: boolean }) {
  const selection = row?.configuredState === "PVP" ? "PvP" : row?.configuredState === "PVE" ? "PvE" : row?.configuredState === "CONFLICT" ? "Overlapping Selections" : "Unknown";
  const writtenModeDiffers = row?.materializedCustomPvpMode != null && row.customPvpMode !== row.materializedCustomPvpMode;
  return <aside className="combat-settings-notice" aria-label="Combat Configuration">
    <strong>Combat Configuration</strong>
    <p>The map badge shows the saved UserGame selection, not a live combat check. Partition PvP and PvE select the same server instance; they do not control separate north and south zones.</p>
    {row && <dl>
      <div><dt>UserGame Selection</dt><dd>{selection}</dd></div>
      <div><dt>Custom PvP Mode</dt><dd>{row.customPvpMode || "Not Available"}{row.customPvpModeSource === "default" ? " (Default)" : ""}</dd></div>
    </dl>}
    <p>Custom Settings and legacy UserGame controls overlap. Their priority inside the game is not verified; avoid contradictory settings and check the result in game.</p>
    {row?.warnings.map(warning => <p className="attention-text" key={warning}>{warning}</p>)}
    {writtenModeDiffers && <p className="attention-text">The Custom PvP Mode written to disk is {row.materializedCustomPvpMode}; the saved value is {row.customPvpMode}. A file on disk does not confirm what a running map has loaded.</p>}
    {hasUnsavedChanges && <p className="muted">This summary excludes your unsaved edits below.</p>}
  </aside>;
}
