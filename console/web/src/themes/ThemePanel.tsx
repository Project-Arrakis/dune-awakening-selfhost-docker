import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Palette, X } from "lucide-react";
import { DEFAULT_THEME_ID, THEMES, loadSelectedTheme, saveSelectedTheme } from "./themeEngine";

const SWATCH_TOKENS = ["--bg", "--panel", "--text", "--accent", "--success-text", "--danger-text"] as const;
const DEFAULT_SWATCHES = ["#0d0f12", "#171a1d", "#f3efe7", "#c68b4a", "#9be6bd", "#ffb4a8"];

export function ThemePanel({ onClose = () => {} }: { onClose?: () => void }) {
  const [selected, setSelected] = useState(loadSelectedTheme);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function choose(id: string) {
    saveSelectedTheme(id);
    setSelected(id);
  }
  const options = [
    { id: DEFAULT_THEME_ID, name: "Default", description: "The standard console look.", appearance: "dark", swatches: DEFAULT_SWATCHES },
    ...THEMES.map((theme) => ({ id: theme.id, name: theme.name, description: theme.description, appearance: theme.appearance, swatches: SWATCH_TOKENS.map((token) => theme.tokens[token]) })),
  ];
  return createPortal(
    <div className="modal-overlay theme-picker-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={modal}
        className="confirm-modal theme-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-picker-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}
      >
        <header className="theme-picker-heading">
          <div><Palette size={22} aria-hidden="true" /><h2 id="theme-picker-title">Console Theme</h2></div>
          <button type="button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>
        <p className="theme-picker-note">Applies to this browser only.</p>
        <div className="theme-grid" role="radiogroup" aria-label="Console theme">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected === option.id}
              className={`theme-card${selected === option.id ? " selected" : ""}`}
              title={option.description}
              onClick={() => choose(option.id)}
            >
              <span className="theme-swatches" aria-hidden="true">
                {option.swatches.map((color, index) => <i key={index} style={{ background: color }} />)}
              </span>
              <span className="theme-card-name">{option.name}{selected === option.id && <Check size={15} aria-hidden="true" />}</span>
            </button>
          ))}
        </div>
        <p className="theme-picker-credit">Palettes: Fedaykin Dune Themes and Tabr (MIT).</p>
      </div>
    </div>,
    document.body,
  );
}
