import type { Ref } from "react";
import { PLAYER_ACCESS_OPTIONS, type PlayerAccessFilter } from "../../lib/playerAccess";

export function PlayerAccessSelect({ value, onChange, disabled = false, selectRef }: { value: PlayerAccessFilter; onChange: (next: PlayerAccessFilter) => void; disabled?: boolean; selectRef?: Ref<HTMLSelectElement> }) {
  return (
    <label className="inline-filter-label players-filter-label">
      Permission
      <select ref={selectRef} className="players-filter-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as PlayerAccessFilter)}>
        {PLAYER_ACCESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
