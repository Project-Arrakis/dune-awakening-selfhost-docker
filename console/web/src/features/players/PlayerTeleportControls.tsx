import { useEffect, useRef, useState } from "react";
import { playersApi } from "../../api/players";
import { setupApi } from "../../api/setup";
import { InlineActionResult } from "../../components/common/InlineActionResult";

type DestinationPlayer = { id: string; name: string; online_status: string; map: string; partition_id: number };
type DestinationBase = { id: string; name: string; owner_name: string; map: string; partition_id: number; is_own: boolean };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;

export function PlayerTeleportControls({ playerId, playerName, isOnline, confirmAction, onRefresh, onActionLog }: {
  playerId: string;
  playerName: string;
  isOnline: boolean;
  confirmAction: ConfirmAction;
  onRefresh: () => void;
  onActionLog: (actionType: string, target: string, amount: string, notes: string) => void;
}) {
  const [mode, setMode] = useState<"coordinates" | "player" | "base">("coordinates");
  const [coords, setCoords] = useState({ x: "", y: "", z: "" });
  const [players, setPlayers] = useState<DestinationPlayer[]>([]);
  const [bases, setBases] = useState<DestinationBase[]>([]);
  const [destinationId, setDestinationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean } | null>(null);
  const resultTimer = useRef<number | null>(null);

  function showResult(text: string, tone: "success" | "danger" | "neutral", pending = false) {
    setResult({ key: "teleport", text, tone, pending });
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = pending ? null : window.setTimeout(() => setResult(null), 8000);
  }

  async function loadDestinations() {
    if (!playerId) return;
    setLoading(true);
    try {
      const response = await playersApi.teleportDestinations(playerId);
      setPlayers(response.players || []);
      setBases(response.bases || []);
    } catch (error) {
      showResult(error instanceof Error ? error.message : "Teleport destinations could not be loaded.", "danger");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDestinations();
    return () => { if (resultTimer.current) window.clearTimeout(resultTimer.current); };
  }, [playerId]);

  useEffect(() => {
    const rows = mode === "player" ? players : mode === "base" ? bases : [];
    setDestinationId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id || "");
  }, [mode, players, bases]);

  async function useCurrentPosition() {
    showResult(`Loading ${playerName}'s position…`, "neutral", true);
    try {
      const response = await playersApi.position(playerId);
      const position = response.position as Record<string, unknown> | undefined;
      if (!position) throw new Error("No saved player position was found.");
      setCoords({ x: String(position.x ?? ""), y: String(position.y ?? ""), z: String(position.z ?? "") });
      showResult("Position loaded. Edit the coordinates before teleporting if needed.", "success");
    } catch (error) {
      showResult(error instanceof Error ? error.message : "The saved position could not be loaded.", "danger");
    }
  }

  async function teleport() {
    const selectedPlayer = players.find((row) => row.id === destinationId);
    const selectedBase = bases.find((row) => row.id === destinationId);
    const destinationLabel = mode === "player"
      ? selectedPlayer?.name || "the selected player"
      : mode === "base"
        ? `${selectedBase?.name || "the selected base"}${selectedBase?.owner_name ? ` (${selectedBase.owner_name})` : ""}`
        : `X=${coords.x} Y=${coords.y} Z=${coords.z}`;
    if (!(await confirmAction(`Teleport ${playerName} to ${destinationLabel}?`, {
      title: "Teleport Player",
      confirmLabel: "Teleport",
      details: [
        { label: "Player", value: playerName, tone: "accent" },
        { label: "Destination", value: destinationLabel, tone: "success" }
      ]
    }))) return;
    showResult(`Teleporting ${playerName}…`, "neutral", true);
    try {
      const payload = mode === "coordinates"
        ? { mode, x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) }
        : { mode, destinationId };
      const response = await playersApi.teleport(playerId, payload);
      let task = response.task;
      for (let attempt = 0; attempt < 30 && !["succeeded", "failed", "cancelled"].includes(task.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        task = (await setupApi.task(task.id)).task;
      }
      if (task.status !== "succeeded") throw new Error(task.errorMessage || task.progressMessage || "The live teleport command failed.");
      showResult(response.message || `${playerName} was teleported.`, "success");
      onActionLog("Teleport", playerName, destinationLabel, "Succeeded");
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Teleport failed.";
      showResult(message, "danger");
      onActionLog("Teleport", playerName, destinationLabel, `Failed: ${message}`);
    }
  }

  const ownBases = bases.filter((base) => base.is_own);
  const otherBases = bases.filter((base) => !base.is_own);
  const validCoords = [coords.x, coords.y, coords.z].every((value) => value.trim() !== "" && Number.isFinite(Number(value)));
  const canTeleport = Boolean(playerId) && isOnline && !loading && (mode === "coordinates" ? validCoords : Boolean(destinationId));

  return <div className="playerAdmin_teleportPanel">
    <div className="playerAdmin_actionRow playerAdmin_teleportModeRow">
      <span>Teleport To</span>
      <select aria-label="Teleport destination type" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="coordinates">Coordinates</option>
        <option value="player">Another Player</option>
        <option value="base">Player Base</option>
      </select>
      {mode === "player" && <select className="playerAdmin_destinationPlayerSelect" aria-label="Destination player" value={destinationId} onChange={(event) => setDestinationId(event.target.value)} disabled={loading || players.length === 0}>
        {players.length === 0 && <option value="">No Players Available</option>}
        {players.map((player) => <option key={player.id} value={player.id}>{player.name} · {player.map || "Unknown Map"} · {player.online_status}</option>)}
      </select>}
      {mode === "base" && <select className="playerAdmin_destinationBaseSelect" aria-label="Destination base" value={destinationId} onChange={(event) => setDestinationId(event.target.value)} disabled={loading || bases.length === 0}>
        {bases.length === 0 && <option value="">No Bases Available</option>}
        {ownBases.length > 0 && <optgroup label={`${playerName}'s Bases`}>{ownBases.map((base) => <option key={base.id} value={base.id}>{base.name} · {base.map || "Unknown Map"}</option>)}</optgroup>}
        {otherBases.length > 0 && <optgroup label="Other Players' Bases">{otherBases.map((base) => <option key={base.id} value={base.id}>{base.name} · {base.owner_name || "Unknown Owner"} · {base.map || "Unknown Map"}</option>)}</optgroup>}
      </select>}
      {mode === "coordinates" && <div className="playerAdmin_coordinateInputs">
        <input value={coords.x} onChange={(event) => setCoords({ ...coords, x: event.target.value })} placeholder="X" aria-label="Teleport X coordinate" />
        <input value={coords.y} onChange={(event) => setCoords({ ...coords, y: event.target.value })} placeholder="Y" aria-label="Teleport Y coordinate" />
        <input value={coords.z} onChange={(event) => setCoords({ ...coords, z: event.target.value })} placeholder="Z" aria-label="Teleport Z coordinate" />
        <button disabled={!playerId || loading} onClick={() => void useCurrentPosition()}>Use Current Position</button>
      </div>}
      <button disabled={!canTeleport || Boolean(result?.pending)} onClick={() => void teleport()}>Teleport</button>
      <button className="secondary" disabled={loading || !playerId} onClick={() => void loadDestinations()}>{loading ? "Loading…" : "Reload"}</button>
    </div>
    <p className={!isOnline ? "action-help-note warning" : "action-help-note"}>{isOnline
      ? "Player and base destinations use a safe offset from the character or fief console."
      : "The player must be online to use live teleport."}</p>
    <InlineActionResult result={result} resultKey="teleport" />
  </div>;
}
