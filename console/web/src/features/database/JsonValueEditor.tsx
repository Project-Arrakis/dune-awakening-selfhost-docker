import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type JsonValueEditorProps = {
  column: string;
  value: string;
  onApply: (value: string) => void;
  onClose: () => void;
};

function formattedJson(value: string) {
  if (/^NULL$/i.test(value.trim())) return "NULL";
  return JSON.stringify(JSON.parse(value), null, 2);
}

export function JsonValueEditor({ column, value, onApply, onClose }: JsonValueEditorProps) {
  const [draft, setDraft] = useState(value);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editorRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function format() {
    try {
      setDraft(formattedJson(draft));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invalid JSON");
    }
  }

  function apply() {
    try {
      const next = formattedJson(draft);
      setError("");
      onApply(next);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invalid JSON");
    }
  }

  function findNext() {
    const needle = search.trim().toLowerCase();
    const editor = editorRef.current;
    if (!needle || !editor) return;
    const start = Math.max(editor.selectionEnd, 0);
    const haystack = draft.toLowerCase();
    let index = haystack.indexOf(needle, start);
    if (index < 0) index = haystack.indexOf(needle);
    if (index < 0) {
      setError(`No match for “${search.trim()}”.`);
      return;
    }
    setError("");
    editor.focus();
    editor.setSelectionRange(index, index + needle.length);
  }

  return <div className="modal-overlay database-json-overlay" role="presentation" onMouseDown={onClose}>
    <section className="database-json-modal" role="dialog" aria-modal="true" aria-labelledby="database-json-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="confirm-modal-title">
        <div><h3 id="database-json-title">Edit JSON</h3><code>{column}</code></div>
        <button className="icon-action" aria-label="Close JSON editor" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="database-json-search">
        <Search size={17} aria-hidden="true" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") findNext(); }} placeholder="Find in JSON" aria-label="Find in JSON" />
        <button onClick={findNext}>Find Next</button>
      </div>
      <textarea ref={editorRef} value={draft} onChange={(event) => { setDraft(event.target.value); setError(""); }} spellCheck={false} aria-label={`JSON value for ${column}`} />
      {error && <p className="danger-note database-json-error" role="alert">{error}</p>}
      <div className="confirm-modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button onClick={format}>Format JSON</button>
        <button className="success" onClick={apply}>Apply to Row</button>
      </div>
    </section>
  </div>;
}
