import { PLAYER_ACCESS_OPTIONS, type PlayerAccessFilter } from "../../lib/playerAccess";

export function PlayerAccessSelect({ value, onChange, disabled = false }: { value: PlayerAccessFilter; onChange: (next: PlayerAccessFilter) => void; disabled?: boolean }) {
  return (
    <label className="inline-filter-label players-filter-label">
      Permission
      <select className="players-filter-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as PlayerAccessFilter)}>
        {PLAYER_ACCESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
