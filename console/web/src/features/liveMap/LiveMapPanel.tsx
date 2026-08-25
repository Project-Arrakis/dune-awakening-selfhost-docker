import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Car, Gem, Home, Landmark, MapPin, Package, Users, Wrench, type LucideIcon } from "lucide-react";
import { liveMapApi, type LiveMapConfig, type LiveMapMarker, type LiveMapPartition } from "../../api/liveMap";
import type { Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, titleCase } from "../../lib/display";
import { friendlyInlineError } from "../players/playerAdminUtils";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "danger" | "success" | "accent" }[] }) => Promise<boolean>;
type LiveMapPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  waitForTask: (task: Task) => Promise<Task>;
  taskTechnicalDetails: (task: Task) => string;
};

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

function HomeTaskResultCard({ result }: { result: HomeTaskResult }) {
  const pending = result.status === "running";
  return <div className={`result-panel home-task-result result-${result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <strong className={pending ? "loading-dots" : ""}>{formatResultTitle(result.title, pending)}</strong>
    {result.message && <p>{formatResultMessage(result.message)}</p>}
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </div>;
}

export function LiveMapPanel({ onError, confirmAction, waitForTask, taskTechnicalDetails }: LiveMapPanelProps) {
  const [mapKey, setMapKey] = useState("HaggaBasin");
  const [mapConfig, setMapConfig] = useState<LiveMapConfig | null>(null);
  const [maps, setMaps] = useState<Record<string, LiveMapConfig>>({});
  const [partitions, setPartitions] = useState<LiveMapPartition[]>([]);
  const [partitionId, setPartitionId] = useState("");
  const [markers, setMarkers] = useState<LiveMapMarker[]>([]);
  const [overlays, setOverlays] = useState<Record<string, string>>({});
  const [sourceStatus, setSourceStatus] = useState<Record<string, { count: number; lastPolledAt: string | null }>>({});
  const [selected, setSelected] = useState<LiveMapMarker | null>(null);
  const [filters, setFilters] = useState<Record<string, boolean>>({ player: true, vehicle: true, base: true, storage: true });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.16);
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [playerDrag, setPlayerDrag] = useState<{ marker: LiveMapMarker; point: LiveMapPoint; startX: number; startY: number } | null>(null);
  const [playerTeleportPreview, setPlayerTeleportPreview] = useState<{ marker: LiveMapMarker; point: LiveMapPoint } | null>(null);
  const [teleportResult, setTeleportResult] = useState<HomeTaskResult | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<{ mapX: number; mapY: number; viewportX: number; viewportY: number } | null>(null);
  const liveMapDraggingPlayerRef = useRef(false);
  const pendingPlayerTeleportsRef = useRef<Record<string, { x: number; y: number; z: number; partitionId: number; expiresAt: number }>>({});
  async function load() {
    if (liveMapDraggingPlayerRef.current) return;
    onError("");
    setLoading(true);
    try {
      const result = await liveMapApi.markers(mapKey);
      const rows = applyPendingPlayerTeleports(result.rows || []);
      setMarkers(rows);
      setFilters((current) => mergeMarkerTypeFilters(current, rows));
      setOverlays(result.overlays || {});
      setSourceStatus(result.sourceStatus || {});
      setMapConfig(result.map || null);
      setMaps(result.maps || {});
      setPartitions(result.partitions || []);
      if (!partitionId && result.map?.defaultPartitionId) setPartitionId(String(result.map.defaultPartitionId));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [mapKey]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [autoRefresh, mapKey, partitionId]);
  const activeMap = mapConfig || maps[mapKey];
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    function handleWheel(event: WheelEvent) {
      const currentFrame = frameRef.current;
      const canvas = canvasRef.current;
      if (!currentFrame || !canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const isInsideCanvas =
        event.clientX >= canvasRect.left &&
        event.clientX <= canvasRect.right &&
        event.clientY >= canvasRect.top &&
        event.clientY <= canvasRect.bottom;
      if (!isInsideCanvas) return;
      event.preventDefault();
      setZoomAround(zoom * (event.deltaY < 0 ? 1.12 : 0.88), { clientX: event.clientX, clientY: event.clientY });
    }
    frame.addEventListener("wheel", handleWheel, { passive: false });
    return () => frame.removeEventListener("wheel", handleWheel);
  }, [zoom, activeMap?.key]);
  useEffect(() => {
    function syncMinimumZoom() {
      const min = liveMapMinimumZoom(activeMap, frameRef.current);
      setZoom((current) => current < min ? min : current);
    }
    const id = window.requestAnimationFrame(syncMinimumZoom);
    window.addEventListener("resize", syncMinimumZoom);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", syncMinimumZoom);
    };
  }, [activeMap?.key]);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const anchor = zoomAnchorRef.current;
    if (!frame) return;
    if (!anchor) return;
    frame.scrollLeft = anchor.mapX * zoom - anchor.viewportX;
    frame.scrollTop = anchor.mapY * zoom - anchor.viewportY;
    zoomAnchorRef.current = null;
  }, [zoom, activeMap?.key]);
  useEffect(() => {
    if (!activeMap) return undefined;
    return scheduleFitLiveMapView();
  }, [activeMap?.key]);
  const mapOptions = Object.values(maps);
  const partitionOptions = partitions.filter((row) => row.map === (activeMap?.actorMap || activeMap?.key));
  const visible = markers
    .filter((marker) => filters[String(marker.type)] !== false)
    .filter((marker) => isMarkerVisibleForPartition(marker, partitionId));
  const plotted = visible.filter((marker) => Number.isFinite(Number(marker.x)) && Number.isFinite(Number(marker.y)));
  const displayRows = visible.map((marker) => ({ ...marker, display_name: friendlyMarkerName(marker), raw_name: marker.name || marker.id }));
  const markerCounts = countMarkers(visible);
  const inBounds = activeMap ? plotted.map((marker) => ({ marker, point: worldToLiveMapPoint(marker, activeMap) })).filter((item) => item.point?.inBounds) as { marker: LiveMapMarker; point: LiveMapPoint }[] : [];
  const targetPoint = target && activeMap ? worldToLiveMapPoint({ x: target.x, y: target.y }, activeMap) : null;
  const minimumZoom = liveMapMinimumZoom(activeMap, frameRef.current);
  const zoomMinPercent = Math.round(minimumZoom * 100);
  const zoomValuePercent = Math.round(zoom * 100);
  const zoomProgressPercent = Math.max(0, Math.min(100, ((zoomValuePercent - zoomMinPercent) / Math.max(1, 100 - zoomMinPercent)) * 100));
  const zoomDisplayPercent = Math.round(zoomProgressPercent);
  function chooseMap(nextKey: string) {
    const nextMap = maps[nextKey];
    setMapKey(nextKey);
    setPartitionId(nextMap?.defaultPartitionId ? String(nextMap.defaultPartitionId) : "");
    setSelected(null);
    setTarget(null);
    setPlayerTeleportPreview(null);
    liveMapDraggingPlayerRef.current = false;
  }
  function centerMarker(marker: LiveMapMarker) {
    if (!activeMap || !frameRef.current) return;
    const point = worldToLiveMapPoint(marker, activeMap);
    if (!point) return;
    setSelected(marker);
    requestAnimationFrame(() => {
      if (!frameRef.current) return;
      frameRef.current.scrollLeft = Math.max(0, point.px * zoom - frameRef.current.clientWidth / 2);
      frameRef.current.scrollTop = Math.max(0, point.py * zoom - frameRef.current.clientHeight / 2);
    });
  }
  function centerLiveMapView(zoomForCenter = zoom) {
    const frame = frameRef.current;
    const map = activeMap;
    if (!frame || !map) return;
    const width = map.width * zoomForCenter;
    const height = map.height * zoomForCenter;
    frame.scrollLeft = Math.max(0, (width - frame.clientWidth) / 2);
    frame.scrollTop = Math.max(0, (height - frame.clientHeight) / 2);
  }
  function scheduleFitLiveMapView() {
    const handles: number[] = [];
    const run = (attempt = 0) => {
      const frame = frameRef.current;
      if (!activeMap || !frame) return;
      if ((frame.clientWidth === 0 || frame.clientHeight === 0) && attempt < 8) {
        handles.push(window.requestAnimationFrame(() => run(attempt + 1)));
        return;
      }
      const next = liveMapMinimumZoom(activeMap, frame);
      zoomAnchorRef.current = null;
      setZoom(next);
      handles.push(window.requestAnimationFrame(() => centerLiveMapView(next)));
      handles.push(window.setTimeout(() => centerLiveMapView(next), 80));
    };
    handles.push(window.requestAnimationFrame(() => run()));
    return () => {
      for (const handle of handles) {
        window.cancelAnimationFrame(handle);
        window.clearTimeout(handle);
      }
    };
  }
  function fitLiveMapView() {
    const next = liveMapMinimumZoom(activeMap, frameRef.current);
    zoomAnchorRef.current = null;
    setZoom(next);
    requestAnimationFrame(() => centerLiveMapView(next));
  }
  function handleMapDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!activeMap || !canvasRef.current) return;
    if ((event.target as HTMLElement).closest(".live-map-marker")) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) / zoom;
    const py = (event.clientY - rect.top) / zoom;
    const world = liveMapPixelsToWorld(px, py, activeMap);
    if (!world) return;
    setTarget(world);
  }
  function setZoomAround(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const oldZoom = zoom;
    const next = clampLiveMapZoom(nextZoom, liveMapMinimumZoom(activeMap, frame));
    if (!frame) {
      setZoom(next);
      return;
    }
    if (next === oldZoom) {
      zoomAnchorRef.current = null;
      return;
    }
    const canvasRect = canvas?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const anchorViewportX = anchor ? anchor.clientX - frameRect.left : frame.clientWidth / 2;
    const anchorViewportY = anchor ? anchor.clientY - frameRect.top : frame.clientHeight / 2;
    const anchorMapX = anchor && canvasRect ? (anchor.clientX - canvasRect.left) / oldZoom : (frame.scrollLeft + frame.clientWidth / 2) / oldZoom;
    const anchorMapY = anchor && canvasRect ? (anchor.clientY - canvasRect.top) / oldZoom : (frame.scrollTop + frame.clientHeight / 2) / oldZoom;
    zoomAnchorRef.current = { mapX: anchorMapX, mapY: anchorMapY, viewportX: anchorViewportX, viewportY: anchorViewportY };
    setZoom(next);
  }
  function playerMarkerId(marker: LiveMapMarker) {
    return String(firstDefined(marker.action_player_id, marker.fls_id, marker.funcom_id, marker.account_id, marker.id) || "");
  }
  function applyPendingPlayerTeleports(rows: LiveMapMarker[]) {
    const now = Date.now();
    return rows.map((marker) => {
      if (String(marker.type || "").toLowerCase() !== "player") return marker;
      const markerId = playerMarkerId(marker);
      const pending = markerId ? pendingPlayerTeleportsRef.current[markerId] : null;
      if (!pending) return marker;
      if (pending.expiresAt <= now) {
        delete pendingPlayerTeleportsRef.current[markerId];
        return marker;
      }
      const currentX = Number(marker.x);
      const currentY = Number(marker.y);
      const currentPartition = Number(marker.partition_id || 0);
      const caughtUp = Number.isFinite(currentX) && Number.isFinite(currentY) && Math.hypot(currentX - pending.x, currentY - pending.y) < 100 && (!pending.partitionId || currentPartition === pending.partitionId);
      if (caughtUp) delete pendingPlayerTeleportsRef.current[markerId];
      return {
        ...marker,
        x: pending.x,
        y: pending.y,
        z: pending.z,
        partition_id: pending.partitionId || marker.partition_id
      };
    });
  }
  function liveMapPointerPoint(event: MouseEvent | React.MouseEvent) {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      px: (event.clientX - rect.left) / zoom,
      py: (event.clientY - rect.top) / zoom,
      inBounds: true
    };
  }
  async function confirmPlayerDragTeleport(marker: LiveMapMarker, point: LiveMapPoint) {
    if (!activeMap) return;
    const world = liveMapPixelsToWorld(point.px, point.py, activeMap);
    const playerId = playerMarkerId(marker);
    if (!world || !playerId) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: "This player marker does not include a usable admin player ID." });
      return;
    }
    const online = liveMapPlayerStatus(marker) === "online";
    const playerName = friendlyMarkerName(marker);
    const confirmed = await confirmAction("Move this player to the selected map location?", {
      title: `Teleport ${playerName}?`,
      confirmLabel: "Teleport",
      details: [
        { label: "Player", value: playerName, tone: online ? "success" : "danger" },
        { label: "Status", value: online ? "Online" : "Offline", tone: online ? "success" : "danger" },
        { label: "Location", value: `X ${Math.round(world.x)}, Y ${Math.round(world.y)}, Z 5000`, tone: "accent" }
      ]
    });
    if (!confirmed) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      return;
    }
    setTeleportResult({ status: "running", title: "Teleporting Player" });
    try {
      const teleportPosition = { x: Math.round(world.x), y: Math.round(world.y), z: 5000, partitionId: Number(marker.partition_id || partitionId || 0) };
      const response = await liveMapApi.teleportPlayer({ playerId, ...teleportPosition, yaw: 0, online });
      if (response.task) {
        const final = await waitForTask(response.task);
        if (final.status !== "succeeded") throw new Error(taskTechnicalDetails(final) || final.errorMessage || final.progressMessage || "Teleport failed.");
        setTeleportResult({ status: "succeeded", title: "Teleport Sent", message: `${playerName} was teleported to the selected location.` });
      } else if (response.supported === false) {
        setPlayerTeleportPreview(null);
        liveMapDraggingPlayerRef.current = false;
        setTeleportResult({ status: "failed", title: "Offline Teleport Not Available", message: response.reason || "Offline teleport is not supported by this database." });
        return;
      } else {
        setTeleportResult({ status: "succeeded", title: "Respawn Location Saved", message: response.message || `${playerName}'s respawn location was saved.` });
      }
      pendingPlayerTeleportsRef.current[playerId] = { ...teleportPosition, expiresAt: Date.now() + 20000 };
      setMarkers((current) => applyPendingPlayerTeleports(current));
      setSelected((current) => current && playerMarkerId(current) === playerId ? applyPendingPlayerTeleports([current])[0] : current);
      liveMapDraggingPlayerRef.current = false;
      await load();
      setPlayerTeleportPreview(null);
    } catch (error) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: friendlyInlineError(error) });
    }
  }
  useEffect(() => {
    if (!playerDrag) return undefined;
    function move(event: MouseEvent) {
      const point = liveMapPointerPoint(event);
      if (!point) return;
      setPlayerDrag((current) => current ? { ...current, point } : current);
    }
    function up(event: MouseEvent) {
      const current = playerDrag;
      if (!current) return;
      liveMapDraggingPlayerRef.current = false;
      setPlayerDrag(null);
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const point = liveMapPointerPoint(event) || current.point;
      if (distance < 6) return;
      liveMapDraggingPlayerRef.current = true;
      setPlayerTeleportPreview({ marker: current.marker, point });
      void confirmPlayerDragTeleport(current.marker, point);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [playerDrag, zoom, activeMap?.key]);
  useEffect(() => {
    if (!teleportResult || teleportResult.status === "running") return;
    const id = window.setTimeout(() => setTeleportResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [teleportResult?.status, teleportResult?.title]);
  return <section className="panel">
    <div className="panel-title">
      <div><h2>Live Map</h2><p className="muted">Live world markers, player teleport, partition filtering, zoom, pan, and coordinate selection.</p></div>
      <div className="action-row"><button className={`switch-toggle live-map-auto-toggle ${autoRefresh ? "enabled" : "disabled"}`} onClick={() => setAutoRefresh(!autoRefresh)}><span className="switch-label">Auto-Refresh</span><strong className="switch-state">{autoRefresh ? "ON" : "OFF"}</strong></button></div>
    </div>
    <div className="live-map-layout">
      <aside className="live-map-sidebar">
        <section className="action-section">
          <h4>Map View</h4>
          <div className="live-map-map-buttons">{mapOptions.map((option) => <button key={option.key} className={option.key === mapKey ? "active" : ""} onClick={() => chooseMap(option.key)}>{option.label}</button>)}</div>
          <label className="compact-select">Partition<select value={partitionId} onChange={(event) => setPartitionId(event.target.value)}><option value="">All Partitions</option>{partitionOptions.map((row) => <option key={`${row.map}-${row.partition_id}`} value={String(row.partition_id)}>{row.name || `Partition ${row.partition_id}`} ({row.marker_count})</option>)}</select></label>
          <div className="key-value-grid live-map-stats">
            <div className="key-value-item"><span>Visible</span><strong>{visible.length}</strong></div>
            <div className="key-value-item"><span>In Bounds</span><strong>{inBounds.length}</strong></div>
            <div className="key-value-item"><span>Zoom</span><strong>{zoomDisplayPercent}%</strong></div>
          </div>
        </section>
        <section className="action-section">
          <h4>Layers</h4>
          <div className="live-map-layer-list">{Object.keys(filters).map((key) => {
            const Icon = liveMapMarkerIcon(key);
            return <label key={key} className="checkbox-row live-map-layer"><input type="checkbox" checked={filters[key]} onChange={() => setFilters({ ...filters, [key]: !filters[key] })} /><span>{friendlyMarkerType(key)}</span><span className="muted">{markerCounts[key] || 0}</span><span className={`live-map-legend-dot marker-${key}`}><Icon className="live-map-legend-icon" size={9} strokeWidth={2.5} /></span></label>;
          })}</div>
        </section>
        <section className="action-section">
          <h4>Coordinates</h4>
          {target ? <KeyValueGrid items={[["X", target.x.toFixed(0)], ["Y", target.y.toFixed(0)], ["Partition", partitionId || "All"]]} /> : <p className="muted">Double-click the map to pick world coordinates.</p>}
        </section>
      </aside>
      <div className="live-map-main">
        <div className="live-map-toolbar">
          <button onClick={() => setZoomAround(zoom * 1.18)}>Zoom In</button>
          <button onClick={() => setZoomAround(zoom * 0.84)}>Zoom Out</button>
          <button onClick={fitLiveMapView}>Fit Map</button>
          <label>Zoom<input className="live-map-zoom-range" type="range" min={zoomMinPercent} max="100" value={zoomValuePercent} style={{ "--zoom-progress": `${zoomProgressPercent}%` } as React.CSSProperties} onChange={(event) => setZoomAround(Number(event.target.value) / 100)} /></label>
          <span className="muted">Drag to Pan. Mouse Wheel Zooms.</span>
        </div>
        {teleportResult && <HomeTaskResultCard result={teleportResult} />}
        <div className={`live-map-frame ${drag ? "dragging" : ""} ${playerDrag ? "dragging-player" : ""}`} ref={frameRef}
          onDoubleClick={handleMapDoubleClick}
          onMouseDown={(event) => { if ((event.target as HTMLElement).closest(".live-map-marker")) return; setDrag({ x: event.clientX, y: event.clientY, left: frameRef.current?.scrollLeft || 0, top: frameRef.current?.scrollTop || 0 }); }}
          onMouseMove={(event) => { if (!drag || !frameRef.current) return; frameRef.current.scrollLeft = drag.left - (event.clientX - drag.x); frameRef.current.scrollTop = drag.top - (event.clientY - drag.y); }}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}>
          {activeMap ? <div className="live-map-canvas" ref={canvasRef} style={{ width: Math.floor(activeMap.width * zoom), height: Math.floor(activeMap.height * zoom) }}>
            {activeMap.image ? <img className="live-map-image" src={activeMap.image} alt={activeMap.label} draggable={false} /> : <div className="live-map-placeholder">{activeMap.label}</div>}
            <div className="live-map-marker-layer">
              {targetPoint && <span className="live-map-target" style={{ left: `${targetPoint.px * zoom}px`, top: `${targetPoint.py * zoom}px` }} />}
              {inBounds.map(({ marker, point }, index) => {
                const playerStatus = liveMapPlayerStatus(marker);
                const markerSelected = Boolean(selected && String(selected.type) === String(marker.type) && String(selected.id) === String(marker.id));
                const isPlayer = String(marker.type).toLowerCase() === "player";
                const isDraggingThisPlayer = Boolean(playerDrag && String(playerDrag.marker.id) === String(marker.id) && String(playerDrag.marker.type) === String(marker.type));
                const isPreviewingThisPlayer = Boolean(playerTeleportPreview && String(playerTeleportPreview.marker.id) === String(marker.id) && String(playerTeleportPreview.marker.type) === String(marker.type));
                const renderPoint = isDraggingThisPlayer ? playerDrag!.point : isPreviewingThisPlayer ? playerTeleportPreview!.point : point;
                const MarkerIcon = liveMapMarkerIcon(String(marker.type));
                return <button key={`${marker.type}-${marker.id}-${index}`} className={`live-map-marker marker-${marker.type} ${playerStatus} ${isDraggingThisPlayer ? "dragging" : ""} ${isPreviewingThisPlayer ? "teleport-preview" : ""}`} title={`${friendlyMarkerType(String(marker.type))}: ${friendlyMarkerName(marker)}`} onMouseDown={(event) => {
                  if (!isPlayer) return;
                  event.stopPropagation();
                  event.preventDefault();
                  liveMapDraggingPlayerRef.current = true;
                  setPlayerDrag({ marker, point, startX: event.clientX, startY: event.clientY });
                }} onClick={(event) => { event.stopPropagation(); setSelected(marker); }} style={{ left: `${renderPoint.px * zoom}px`, top: `${renderPoint.py * zoom}px` }}>
                  <MarkerIcon className="live-map-marker-icon" size={8} strokeWidth={3} />
                  {markerSelected && String(marker.type).toLowerCase() === "player" && <span className={`live-map-player-status ${playerStatus}`}>{playerStatus === "online" ? "Online" : "Offline"}</span>}
                </button>;
              })}
            </div>
          </div> : <div className="empty">Loading map configuration...</div>}
        </div>
      </div>
    </div>
    {Object.entries(overlays).filter(([, reason]) => reason).map(([key, reason]) => <p className="danger-note" key={key}>{key}: {reason}</p>)}
    {Object.entries(sourceStatus).filter(([key]) => !overlays[key]).map(([key, status]) => {
      const seconds = liveMapSecondsSince(status.lastPolledAt);
      if (seconds === null) return null;
      return <p className="muted live-map-source-status" key={key}>{friendlyMarkerType(key === "pois" ? "poi" : "resource")}: {status.count} known (updated {seconds}s ago)</p>;
    })}
    {selected && <section className="drawer"><div className="panel-title"><h3>{friendlyMarkerName(selected)}</h3><button onClick={() => setSelected(null)}>Close</button></div><KeyValueGrid items={[
      ["Type", selected.type],
      ["Name", friendlyMarkerName(selected)],
      ["ID", selected.id],
      ["Map", selected.map],
      ["Partition", selected.partition_id],
      ["X", selected.x],
      ["Y", selected.y],
      ["Z", selected.z]
    ]} /><TechnicalDetails title="Marker technical details" text={JSON.stringify(selected, null, 2)} /></section>}
    {displayRows.length > 0 && <DataTable rows={displayRows.map((row) => ({ ...row, type: friendlyMarkerType(String(row.type)) })) as Record<string, unknown>[]} columns={["type", "display_name", "map", "partition_id", "x", "y", "z"]} />}
  </section>;
}

type LiveMapPoint = { px: number; py: number; inBounds: boolean };

function worldToLiveMapPoint(marker: Pick<LiveMapMarker, "x" | "y">, config: LiveMapConfig): LiveMapPoint | null {
  const x = Number(marker.x);
  const y = Number(marker.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (config.maxX === config.minX || config.maxY === config.minY) return null;
  const px = ((x - config.minX) / (config.maxX - config.minX)) * config.width;
  let py = ((y - config.minY) / (config.maxY - config.minY)) * config.height;
  if (config.flipY) py = config.height - py;
  return {
    px,
    py,
    inBounds: px >= 0 && px <= config.width && py >= 0 && py <= config.height
  };
}

function liveMapPixelsToWorld(px: number, py: number, config: LiveMapConfig) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || config.width === 0 || config.height === 0) return null;
  let normalizedY = py / config.height;
  if (config.flipY) normalizedY = 1 - normalizedY;
  return {
    x: config.minX + (px / config.width) * (config.maxX - config.minX),
    y: config.minY + normalizedY * (config.maxY - config.minY)
  };
}

function liveMapMinimumZoom(config: LiveMapConfig | null | undefined, frame: HTMLElement | null) {
  if (!config || !frame) return 0.16;
  return Math.max(0.05, frame.clientWidth / config.width, frame.clientHeight / config.height);
}

function clampLiveMapZoom(value: number, minimum = 0.16) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(1, value));
}

// A marker type this app doesn't already know about (a POI/resource source
// added later, see issue #462) must still get a legend entry and toggle —
// filters was previously a fixed 4-key object, so any type outside that set
// rendered pins with no way to see or hide them (issue #469). New types
// default to visible; an operator's existing toggle choices are preserved.
export function mergeMarkerTypeFilters(current: Record<string, boolean>, markers: LiveMapMarker[]) {
  const missing = [...new Set(markers.map((marker) => String(marker.type)))].filter((type) => !(type in current));
  if (!missing.length) return current;
  const next = { ...current };
  for (const type of missing) next[type] = true;
  return next;
}

// partition_id 0 (this app's existing "no real partition" sentinel, see
// liveMapPartitions' own coalesce(partition_id, 0) > 0 pattern) means the
// marker is global to the map, not scoped to any one instance -- a POI like
// a fixed Cave exists identically in every partition, so it must stay
// visible no matter which specific partition is selected, not just hidden
// until "All Partitions" is chosen.
export function isMarkerVisibleForPartition(marker: Pick<LiveMapMarker, "partition_id">, partitionId: string) {
  return !partitionId || !marker.partition_id || String(marker.partition_id) === partitionId;
}

// Distinguishes "healthy, genuinely found nothing right now" (e.g.
// immediately after a Coriolis storm regenerates the map -- see #462/#470)
// from "broken" -- overlays already covers the broken case via `reason`.
export function liveMapSecondsSince(iso: string | null | undefined) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 1000));
}

function countMarkers(markers: LiveMapMarker[]) {
  return markers.reduce<Record<string, number>>((acc, marker) => {
    const key = String(marker.type || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function friendlyMarkerName(marker: LiveMapMarker) {
  const raw = String(marker.name || marker.id || marker.type || "Marker");
  const normalized = raw.toLowerCase();
  if (/ornithopter.*light|light.*ornithopter/.test(normalized)) return "Light Ornithopter";
  if (/ornithopter.*medium|medium.*ornithopter/.test(normalized)) return "Medium Ornithopter";
  if (/ornithopter.*transport|transport.*ornithopter/.test(normalized)) return "Transport Ornithopter";
  if (/sandbike/.test(normalized)) return "Sandbike";
  if (/buggy/.test(normalized)) return "Buggy";
  if (/tank/.test(normalized)) return "Tank";
  if (/sandcrawler/.test(normalized)) return "Sandcrawler";
  if (/treadwheel/.test(normalized)) return "Treadwheel";
  return raw.replace(/^\/Game\/.*\//, "").replace(/^BP_/, "").replace(/_C$/, "").replaceAll("_", " ");
}

function friendlyMarkerType(type: string) {
  return {
    player: "Player",
    vehicle: "Vehicle",
    base: "Base",
    storage: "Storage",
    service: "Service"
  }[type.toLowerCase()] || titleCase(type.replaceAll("_", " "));
}

// Known categories today; "poi" and "resource" are here ahead of any backend
// data (see issue #462) so a marker type introduced later renders with a
// sensible icon immediately instead of silently falling back to a bare pin.
const LIVE_MAP_MARKER_ICONS: Record<string, LucideIcon> = {
  player: Users,
  vehicle: Car,
  base: Home,
  storage: Package,
  service: Wrench,
  poi: Landmark,
  resource: Gem
};

export function liveMapMarkerIcon(type: string): LucideIcon {
  return LIVE_MAP_MARKER_ICONS[type.toLowerCase()] || MapPin;
}

function liveMapPlayerStatus(marker: LiveMapMarker) {
  if (String(marker.type || "").toLowerCase() !== "player") return String(marker.online_status || "").toLowerCase();
  return String(marker.online_status || "").toLowerCase() === "online" ? "online" : "offline";
}
