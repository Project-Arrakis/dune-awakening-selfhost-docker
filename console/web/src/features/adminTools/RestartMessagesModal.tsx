import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { RestartMessageTemplate, RestartMessages } from "../../api/server";

type MessageTab = "battlegroup" | "map";

const TAB_LABELS: Record<MessageTab, string> = { battlegroup: "Battlegroup Restart", map: "Map Restart" };
type PlaceholderInfo = { token: string; description: string };
const TAB_PLACEHOLDERS: Record<MessageTab, PlaceholderInfo[]> = {
  battlegroup: [
    { token: "{minutes}", description: "The countdown remaining, e.g. “15 minutes” or “1 minute”." }
  ],
  map: [
    { token: "{minutes}", description: "The countdown remaining, e.g. “15 minutes” or “1 minute”." },
    { token: "{mapLabel}", description: "The map or Sietch name, e.g. “Hagga Basin”." }
  ]
};
const PREVIEW_VARS = { minutes: "15 minutes", mapLabel: "Hagga Basin" };
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 500;
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 3600;

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

export function RestartMessagesModal({ messages, defaults, durationSec, defaultDurationSec, saving, error, onSave, onClose }: {
  messages: RestartMessages;
  defaults: RestartMessages;
  durationSec: number;
  defaultDurationSec: number;
  saving: boolean;
  error: string;
  onSave: (next: { messages: RestartMessages; broadcastDurationSec: number }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<MessageTab>("battlegroup");
  const [draft, setDraft] = useState<RestartMessages>(messages);
  // Shared across both message types -- the game shows whichever banner is
  // sent (battlegroup or map) for this long, there's no separate duration
  // per template -- so it's a text field, not a per-tab one.
  const [durationDraft, setDurationDraft] = useState(String(Math.round(durationSec)));
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

  const durationValue = Number(durationDraft);
  const durationError = !Number.isInteger(durationValue) || durationValue < MIN_DURATION_SEC || durationValue > MAX_DURATION_SEC
    ? `Duration must be a whole number of seconds, ${MIN_DURATION_SEC}-${MAX_DURATION_SEC}.`
    : "";
  const battlegroundError = templateError(draft.battlegroup);
  const mapError = templateError(draft.map);
  const activeTemplate = draft[tab];
  const activeError = tab === "battlegroup" ? battlegroundError : mapError;
  const canSave = !battlegroundError && !mapError && !durationError && !saving;

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
      <div className="restart-messages-field restart-messages-duration">
        <label>Display Duration (sec)<input
          type="number"
          min={MIN_DURATION_SEC}
          max={MAX_DURATION_SEC}
          step={1}
          value={durationDraft}
          onChange={(event) => setDurationDraft(event.target.value)}
        /></label>
        <button type="button" disabled={saving} title="Reset the display duration to its default" onClick={() => setDurationDraft(String(Math.round(defaultDurationSec)))}>Reset</button>
      </div>
      <p className="muted restart-messages-help">How long the banner stays on screen — applies to both message types.</p>
      {durationError && <p className="danger-note" role="alert">{durationError}</p>}
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
      <div className="restart-messages-help">
        <span className="muted restart-messages-help-label">Available placeholders:</span>
        <ul className="restart-messages-placeholder-list">
          {TAB_PLACEHOLDERS[tab].map((placeholder) => <li key={placeholder.token}><code>{placeholder.token}</code> <span className="muted">— {placeholder.description}</span></li>)}
        </ul>
      </div>
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
        <button className="success" disabled={!canSave} onClick={() => onSave({ messages: draft, broadcastDurationSec: durationValue })}>{saving ? "Saving..." : "Save Messages"}</button>
      </div>
    </section>
  </div>;
}
