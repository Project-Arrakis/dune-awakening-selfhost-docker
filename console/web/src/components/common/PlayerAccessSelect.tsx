import { PLAYER_ACCESS_OPTIONS, type PlayerAccessFilter } from "../../lib/playerAccess";

export function PlayerAccessSelect({ value, onChange }: { value: PlayerAccessFilter; onChange: (next: PlayerAccessFilter) => void }) {
  return (
    <label className="inline-filter-label player-access-select">
      Permission
      <select value={value} onChange={(event) => onChange(event.target.value as PlayerAccessFilter)}>
        {PLAYER_ACCESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
