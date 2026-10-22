import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { formatCell, formatDisplayValue, normalizeStatus } from "../../lib/display";

export function KeyValueGrid({ items }: { items: [string, unknown][] }) {
  const visible = items.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length) return <div className="empty">No summary values available.</div>;
  return <div className="key-value-grid">{visible.map(([key, value]) => <div className="key-value-item" key={key}>
    <span>{key}</span>
    <strong>{isValidElement(value) ? value : formatCell(value)}</strong>
  </div>)}</div>;
}

export function StatusPill({ value }: { value: unknown }) {
  const text = formatDisplayValue(value || "Unknown");
  const normalized = normalizeStatus(text);
  return <span className={`badge badge-${normalized}`}>{text}</span>;
}

export function TechnicalDetails({ text, title = "Technical details", className = "", open = false }: { text: string; title?: string; className?: string; open?: boolean }) {
  return <details className={`technical-details ${className}`.trim()} open={open}><summary>{title}</summary><pre className="mini-output">{text}</pre></details>;
}

export function OutputPanel({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel"><h2>{title}</h2><button onClick={onAction}>{action}</button><TechnicalDetails text={text} /></section>;
}

export function PlayerStatusCell({ value }: { value: unknown }) {
  const status = String(value || "").toLowerCase();
  const online = status === "online";
  const banned = status === "banned";
  return <span className={`player-status-cell ${banned ? "banned" : online ? "online" : "offline"}`}>{online && <span className="player-status-dot" />}<span>{banned ? "Banned" : online ? "Online" : "Offline"}</span></span>;
}

// A small (i) button next to a toggle that opens a custom popover on hover,
// focus, or click. Originally local to MapsPanel.tsx (Host Memory Protection,
// Memory Balancer, Memory Swap); moved here so other feature panels can reuse
// it without importing across two independently lazy-loaded panel chunks.
export function InfoTooltip({ id, label, children, portal = false }: { id: string; label: string; children: string; portal?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!portal || !open) return;
    const placeTooltip = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const margin = 14;
      const width = Math.min(310, window.innerWidth - margin * 2);
      const height = Math.min(box.height, window.innerHeight - margin * 2);
      const below = anchor.bottom + 8;
      setPosition({ position: "fixed", width, maxHeight: window.innerHeight - margin * 2,
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)),
        top: Math.max(margin, below + height <= window.innerHeight - margin ? below : anchor.top - height - 8),
        right: "auto", bottom: "auto" });
    };
    placeTooltip();
    window.addEventListener("resize", placeTooltip);
    window.addEventListener("scroll", placeTooltip, true);
    return () => {
      window.removeEventListener("resize", placeTooltip);
      window.removeEventListener("scroll", placeTooltip, true);
    };
  }, [portal, open, children]);
  function openTooltip() {
    window.dispatchEvent(new CustomEvent("memory-info-open", { detail: id }));
    setOpen(true);
  }
  useEffect(() => {
    const closeOtherTooltip = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener("memory-info-open", closeOtherTooltip);
    return () => window.removeEventListener("memory-info-open", closeOtherTooltip);
  }, [id]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);
  const box = <span ref={boxRef} id={id} role="tooltip" className={`memory-info-box ${portal && open ? "open" : ""}`} style={portal ? position : undefined}>{children}</span>;
  return <span ref={rootRef} className={`memory-info-tooltip ${open ? "open" : ""}`} onPointerEnter={event => { if (event.pointerType !== "touch") openTooltip(); }} onPointerLeave={event => { if (event.pointerType !== "touch") setOpen(false); }}>
    <button type="button" className="memory-info-button" aria-label={label} aria-expanded={open} aria-describedby={id} onClick={openTooltip} onFocus={openTooltip}><Info size={15} aria-hidden="true" /></button>
    {portal ? createPortal(box, document.body) : box}
  </span>;
}
