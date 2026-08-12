import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { RestartMessageTemplate, RestartMessages } from "../../api/server";

type MessageTab = "battlegroup" | "map";

const TAB_LABELS: Record<MessageTab, string> = { battlegroup: "Battlegroup Restart", map: "Map Restart" };
const TAB_PLACEHOLDER_HELP: Record<MessageTab, string> = {
  battlegroup: "Available placeholders: {minutes} — the countdown remaining, e.g. “15 minutes” or “1 minute”.",
  map: "Available placeholders: {minutes} — the countdown remaining; {mapLabel} — the map or Sietch name, e.g. “Hagga Basin”."
};
const PREVIEW_VARS = { minutes: "15 minutes", mapLabel: "Hagga Basin" };
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 500;

// Mirrors restartQueue.js's renderTemplate exactly (a `{token}` not present in
// vars is left as-is) so the preview matches what will actually be broadcast.
function renderPreview(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

function templateError(template: RestartMessageTemplate) {
  const title = template.title.trim();
  const body = template.body.trim();
  if (!title) return "Title is required.";
  if (title.length > MAX_TITLE_LENGTH) return `Title must be ${MAX_TITLE_LENGTH} characters or fewer.`;
  if (!body) return "Body is required.";
  if (body.length > MAX_BODY_LENGTH) return `Body must be ${MAX_BODY_LENGTH} characters or fewer.`;
  return "";
}

export function RestartMessagesModal({ messages, defaults, saving, error, onSave, onClose }: {
  messages: RestartMessages;
  defaults: RestartMessages;
  saving: boolean;
  error: string;
  onSave: (next: RestartMessages) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<MessageTab>("battlegroup");
  const [draft, setDraft] = useState<RestartMessages>(messages);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function updateTab(nextTab: MessageTab, patch: Partial<RestartMessageTemplate>) {
    setDraft((current) => ({ ...current, [nextTab]: { ...current[nextTab], ...patch } }));
  }

  function resetTab(nextTab: MessageTab) {
    setDraft((current) => ({ ...current, [nextTab]: { ...defaults[nextTab] } }));
  }

  const battlegroundError = templateError(draft.battlegroup);
  const mapError = templateError(draft.map);
  const activeTemplate = draft[tab];
  const activeError = tab === "battlegroup" ? battlegroundError : mapError;
  const canSave = !battlegroundError && !mapError && !saving;

  return <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
    <section className="confirm-modal restart-messages-modal" role="dialog" aria-modal="true" aria-labelledby="restart-messages-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="confirm-modal-title">
        <h3 id="restart-messages-title">Restart Broadcast Messages</h3>
        <button ref={closeButtonRef} className="icon-action" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="playerAdmin_tabs" role="tablist" aria-label="Message type">
        {(["battlegroup", "map"] as const).map((key) => <button
          key={key}
          role="tab"
          aria-selected={tab === key}
          className={tab === key ? "active" : ""}
          onClick={() => setTab(key)}
        >{TAB_LABELS[key]}{templateError(draft[key]) ? <span className="restart-messages-tab-flag" aria-hidden="true">!</span> : null}</button>)}
      </div>
      <div className="restart-messages-field">
        <label>Title<input
          value={activeTemplate.title}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(event) => updateTab(tab, { title: event.target.value })}
        /></label>
        <span className="restart-messages-counter">{activeTemplate.title.length} / {MAX_TITLE_LENGTH}</span>
      </div>
      <div className="restart-messages-field">
        <label>Body<textarea
          rows={3}
          value={activeTemplate.body}
          maxLength={MAX_BODY_LENGTH}
          onChange={(event) => updateTab(tab, { body: event.target.value })}
        /></label>
        <span className="restart-messages-counter">{activeTemplate.body.length} / {MAX_BODY_LENGTH}</span>
      </div>
      <p className="muted restart-messages-help">{TAB_PLACEHOLDER_HELP[tab]}</p>
      <div className="restart-messages-preview">
        <span className="restart-messages-preview-label">Preview</span>
        <strong>{renderPreview(activeTemplate.title, PREVIEW_VARS) || "—"}</strong>
        <p>{renderPreview(activeTemplate.body, PREVIEW_VARS) || "—"}</p>
      </div>
      {activeError && <p className="danger-note" role="alert">{activeError}</p>}
      {error && <p className="danger-note" role="alert">{error}</p>}
      <div className="confirm-modal-actions">
        <button disabled={saving} title={`Reset the ${TAB_LABELS[tab]} template to its default`} onClick={() => resetTab(tab)}>Reset to Default</button>
        <button disabled={saving} onClick={onClose}>Cancel</button>
        <button className="success" disabled={!canSave} onClick={() => onSave(draft)}>{saving ? "Saving..." : "Save Messages"}</button>
      </div>
    </section>
  </div>;
}
