import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export type ConfirmDialogDetail = { label: string; value: string; tone?: "accent" | "success" | "danger" };

// "tertiary" is an optional third choice (e.g. the restart queue's "Restart
// Immediately" alongside "Queue Restart" and "Cancel"). "quaternary" is a
// fourth (e.g. "Restart later"). Dialogs without those labels only ever
// resolve "confirm" or "cancel".
export type ConfirmDialogOutcome = "confirm" | "cancel" | "tertiary" | "quaternary";

export type ConfirmDialogRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tertiaryLabel?: string;
  quaternaryLabel?: string;
  danger: boolean;
  details?: ConfirmDialogDetail[];
  warning?: string;
  resolve: (outcome: ConfirmDialogOutcome) => void;
};

export function ConfirmDialog({ request, onClose }: { request: ConfirmDialogRequest | null; onClose: (outcome: ConfirmDialogOutcome) => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return undefined;
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose("cancel");
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [request, onClose]);

  if (!request) return null;
  // A tertiary or quaternary button makes this a 3- or 4-button row (Cancel /
  // Restart Later / Restart Immediately / Queue Restart, etc.) that doesn't
  // fit the base modal's 440px width -- widen it the same way
  // RestartMessagesModal's action row does, for every dialog that ever adds
  // a third or fourth choice, not just this one caller.
  const modalClassName = ["confirm-modal", request.danger ? "danger" : "", (request.tertiaryLabel || request.quaternaryLabel) ? "confirm-modal-wide" : ""].filter(Boolean).join(" ");
  return <div className="modal-overlay" role="presentation" onMouseDown={() => onClose("cancel")}>
    <section className={modalClassName} role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="confirm-modal-title">
        <h3 id="confirm-modal-title">{request.title}</h3>
        <button ref={closeButtonRef} className="icon-action" aria-label="Close dialog" onClick={() => onClose("cancel")}><X size={18} /></button>
      </div>
      <p>{request.message}</p>
      {request.warning && <div className="confirm-modal-warning">
        {request.warning}
      </div>}
      {request.details?.length ? <dl className="confirm-modal-details">
        {request.details.map((detail) => <div key={`${detail.label}-${detail.value}`}><dt>{detail.label}</dt><dd className={detail.tone || "accent"}>{detail.value}</dd></div>)}
      </dl> : null}
      {request.quaternaryLabel ? (
        // A 4th choice splits into two clusters -- "not restarting now"
        // (Cancel, quaternary) vs "restarting soon" (tertiary, confirm) --
        // separated by a divider, so the grouping is visible rather than
        // four equal-weight buttons in a row.
        <div className="confirm-modal-actions confirm-modal-actions-grouped">
          <div className="confirm-modal-action-group">
            <button onClick={() => onClose("cancel")}>{request.cancelLabel}</button>
            <button onClick={() => onClose("quaternary")}>{request.quaternaryLabel}</button>
          </div>
          <div className="confirm-modal-action-divider" aria-hidden="true" />
          <div className="confirm-modal-action-group">
            {request.tertiaryLabel && <button onClick={() => onClose("tertiary")}>{request.tertiaryLabel}</button>}
            <button className={request.danger ? "danger" : "success"} onClick={() => onClose("confirm")}>{request.confirmLabel}</button>
          </div>
        </div>
      ) : (
        <div className="confirm-modal-actions">
          <button onClick={() => onClose("cancel")}>{request.cancelLabel}</button>
          {request.tertiaryLabel && <button onClick={() => onClose("tertiary")}>{request.tertiaryLabel}</button>}
          <button className={request.danger ? "danger" : "success"} onClick={() => onClose("confirm")}>{request.confirmLabel}</button>
        </div>
      )}
    </section>
  </div>;
}
