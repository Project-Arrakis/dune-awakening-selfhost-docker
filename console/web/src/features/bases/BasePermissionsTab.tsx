import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  basesApi,
  type BasePermissionCandidate,
  type BasePermissionEntry,
  type BasePermissionRank
} from "../../api/bases";

type BasePermissionsTabProps = {
  baseId: string;
  baseName: string;
  onSaved: () => void;
};

const OWNER_RANK: BasePermissionRank = 1;
const CO_OWNER_RANK: BasePermissionRank = 2;
const ASSOCIATE_RANK: BasePermissionRank = 3;

const RANK_LABELS: Record<BasePermissionRank, string> = {
  1: "Owner",
  2: "Co-Owner",
  3: "Associate"
};

const RANK_OPTIONS: BasePermissionRank[] = [OWNER_RANK, CO_OWNER_RANK, ASSOCIATE_RANK];

type DraftEntry = { playerId: string; name: string; rank: BasePermissionRank; canonical: boolean };

function toDraft(entries: BasePermissionEntry[]): DraftEntry[] {
  return entries.map((entry) => ({
    playerId: entry.playerId,
    name: entry.name,
    rank: entry.rank,
    canonical: entry.canonical
  }));
}

function sortDraft(entries: DraftEntry[]) {
  return [...entries].sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
}

function sameRoster(left: DraftEntry[], right: DraftEntry[]) {
  if (left.length !== right.length) return false;
  const rightByPlayer = new Map(right.map((entry) => [entry.playerId, entry.rank]));
  return left.every((entry) => rightByPlayer.get(entry.playerId) === entry.rank);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function BasePermissionsTab({ baseId, baseName, onSaved }: BasePermissionsTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved] = useState<DraftEntry[]>([]);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "fail">("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<BasePermissionCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [addRank, setAddRank] = useState<BasePermissionRank>(ASSOCIATE_RANK);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await basesApi.permissions(baseId);
      const entries = toDraft(result.entries || []);
      setSaved(entries);
      setDraft(entries);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  const dirty = !sameRoster(saved, draft);
  const owner = draft.find((entry) => entry.rank === OWNER_RANK);

  // Promoting to Owner demotes whoever currently holds it, in the same local
  // edit. The server enforces the one-owner rule too, but doing it here means
  // the invariant can never be broken on screen -- there is no intermediate
  // state showing two Owners for the user to try to save.
  function changeRank(playerId: string, nextRank: BasePermissionRank) {
    setDraft((current) => current.map((entry) => {
      if (entry.playerId === playerId) return { ...entry, rank: nextRank };
      if (nextRank === OWNER_RANK && entry.rank === OWNER_RANK) return { ...entry, rank: CO_OWNER_RANK };
      return entry;
    }));
  }

  function removeEntry(playerId: string) {
    setDraft((current) => current.filter((entry) => entry.playerId !== playerId));
  }

  function addCandidate(candidate: BasePermissionCandidate) {
    setDraft((current) => {
      if (current.some((entry) => entry.playerId === candidate.playerId)) return current;
      const next = [...current, { playerId: candidate.playerId, name: candidate.name, rank: addRank, canonical: true }];
      // Adding straight to Owner has to demote the incumbent for the same
      // reason changeRank does.
      if (addRank !== OWNER_RANK) return next;
      return next.map((entry) => entry.playerId === candidate.playerId || entry.rank !== OWNER_RANK
        ? entry
        : { ...entry, rank: CO_OWNER_RANK });
    });
  }

  // Explicit submit rather than search-as-you-type: this queries the server, and
  // a debounced field would fire a request per keystroke.
  async function submitCandidateSearch() {
    setSearching(true);
    try {
      const result = await basesApi.permissionCandidates(candidateQuery);
      setCandidates(result.rows || []);
      setSearched(true);
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSearching(false);
    }
  }

  function clearCandidateSearch() {
    setCandidateQuery("");
    setCandidates([]);
    setSearched(false);
  }

  async function save() {
    if (!owner) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.setPermissions(baseId, draft.map((entry) => ({ playerId: entry.playerId, rank: entry.rank })));
      setSaved(draft);
      setStatus(response.result?.message || "Permissions were updated.");
      setStatusKind("ok");
      onSaved();
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="muted" role="status">Loading permissions…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }

  const alreadyOnRoster = new Set(draft.map((entry) => entry.playerId));

  return (
    <div className="bases-permissions" onClick={(event) => event.stopPropagation()}>
      <p className="action-help-note">
        Exactly one Owner. Promoting a player demotes the current Owner to Co-Owner. Changes apply to the running map immediately.
      </p>

      <div className="bases-permissions-roster">
        {sortDraft(draft).map((entry) => {
          const isOwner = entry.rank === OWNER_RANK;
          return (
            <div className={`bases-permissions-row${isOwner ? " bases-permissions-row-owner" : ""}`} key={entry.playerId}>
              <span className="bases-permissions-name" title={entry.name || entry.playerId}>
                {entry.name || `Player ${entry.playerId}`}
                {!entry.canonical && <span className="bases-permissions-orphan" title="This entry does not match a known player character, so the game ignores it. Removing it is safe.">
                  <TriangleAlert size={13} aria-label="Ignored by the game" />
                </span>}
              </span>
              <select
                value={String(entry.rank)}
                disabled={saving}
                aria-label={`Rank for ${entry.name || entry.playerId}`}
                onChange={(event) => changeRank(entry.playerId, Number(event.target.value) as BasePermissionRank)}
              >
                {RANK_OPTIONS.map((rank) => <option key={rank} value={rank}>{RANK_LABELS[rank]}</option>)}
              </select>
              <button
                className="icon-toggle-button bases-permissions-remove"
                // Removing the Owner would leave the base ownerless, which the
                // server rejects. Promote a replacement first -- that demotes
                // this one automatically and frees the button.
                disabled={isOwner || saving}
                title={isOwner ? "Promote another player to Owner before removing this one" : `Remove ${entry.name || entry.playerId}`}
                aria-label={`Remove ${entry.name || entry.playerId}`}
                onClick={() => removeEntry(entry.playerId)}
              ><Trash2 size={15} /></button>
            </div>
          );
        })}
        {!draft.length && <p className="muted">This base has no permission entries.</p>}
      </div>

      <div className="bases-permissions-add">
        <div className="action-row bases-permissions-search-row">
          <input
            value={candidateQuery}
            placeholder="Search a player to add"
            disabled={saving}
            onChange={(event) => setCandidateQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitCandidateSearch(); }}
          />
          <button disabled={searching || saving} onClick={() => void submitCandidateSearch()}>Search</button>
          <button disabled={!candidateQuery && !searched} onClick={clearCandidateSearch}>Clear</button>
          <label className="compact-select">
            Add as
            <select value={String(addRank)} disabled={saving} onChange={(event) => setAddRank(Number(event.target.value) as BasePermissionRank)}>
              {RANK_OPTIONS.map((rank) => <option key={rank} value={rank}>{RANK_LABELS[rank]}</option>)}
            </select>
          </label>
        </div>
        {searched && !candidates.length && <p className="muted">No players matched that search.</p>}
        {candidates.length > 0 && <ul className="bases-permissions-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.playerId}>
              <span>{candidate.name}</span>
              <button
                className="icon-toggle-button"
                disabled={alreadyOnRoster.has(candidate.playerId) || saving}
                title={alreadyOnRoster.has(candidate.playerId) ? "Already on this base" : `Add ${candidate.name} as ${RANK_LABELS[addRank]}`}
                aria-label={`Add ${candidate.name}`}
                onClick={() => addCandidate(candidate)}
              ><Plus size={15} /></button>
            </li>
          ))}
        </ul>}
      </div>

      {dirty && <p className="confirm-modal-warning bases-permissions-warning" role="status">
        Saving writes to the live database and notifies the running map server. An online player may need to reopen the base's panel to see the change.
      </p>}
      {!owner && <p className="bases-permissions-error" role="alert">
        This base has no Owner. Set one before saving.
      </p>}
      {status && <p className={`inline-task-result${statusKind ? ` result-${statusKind}` : ""}`} role={statusKind === "fail" ? "alert" : "status"}>
        <strong>{status}</strong>
      </p>}

      <div className="bases-permissions-actions">
        <span className="muted">{dirty ? "Unsaved changes" : ""}</span>
        <button disabled={!dirty || saving} onClick={() => setDraft(saved)}>Revert</button>
        <button
          className="update-action"
          disabled={!dirty || !owner || saving}
          title={`Save permissions for ${baseName}`}
          onClick={() => void save()}
        >{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </div>
  );
}
