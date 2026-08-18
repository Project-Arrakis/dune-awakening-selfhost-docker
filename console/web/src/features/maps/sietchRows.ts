export type SietchRow = {
  partitionId: string;
  // False when the `--ids` output ran out and partitionId fell back to the
  // dimension index. A dimension index is only unique *within one map*, so a
  // caller pooling rows from several maps (BasesPanel) must drop these rather
  // than key on them -- otherwise DeepDesert_1's dimension 1 answers to the
  // lookup for Survival_1's partition 1 and labels a Hagga Basin base
  // "Deep Desert PvE".
  partitionIdFromIds: boolean;
  dimension: string;
  displayName: string;
  password: string;
  passwordSet: boolean;
  active: boolean;
};

// Whether a row may be used as the target of a write (rename, set password,
// save settings, restart). Only rows whose partition id really came from the
// `--ids` output qualify: a row that fell back to its dimension index would
// send that index as a partition id and land on whichever partition happens to
// carry the same number, so renaming dimension 1 would rename partition 1.
// Reads are unaffected -- a fallback row still renders, it just cannot be
// written to.
export function isSietchWriteTarget(row: SietchRow) {
  return row.partitionIdFromIds;
}

export const SIETCH_PASSWORD_MASK = "********";

export function sietchPasswordDraftChanged(row: SietchRow, draft: { password: string }, touched = false) {
  if (!touched) return false;
  if (row.passwordSet) return draft.password !== SIETCH_PASSWORD_MASK;
  return Boolean(draft.password);
}

// The draft a row is being edited with, plus which of its fields differ from
// what the server reported. One definition, shared by the code that builds
// sietch write actions and the code that refuses to build them, so the two can
// never disagree about what "edited" means.
export function sietchDraftChanges(
  row: SietchRow,
  drafts: Record<string, { displayName: string; password: string }>,
  passwordTouched: Record<string, boolean> = {}
) {
  const draft = drafts[row.partitionId] || { displayName: row.displayName, password: row.password };
  return {
    draft,
    nameChanged: draft.displayName !== row.displayName,
    passwordChanged: sietchPasswordDraftChanged(row, draft, Boolean(passwordTouched[row.partitionId]))
  };
}

// Rows the operator has edited that cannot be written safely, because their
// partition id fell back to a dimension index (see isSietchWriteTarget).
//
// survivalSietchActions skips those rows when building actions. On its own that
// would make a bulk Save drop the edit without saying so: with nothing else
// dirty the Save does nothing at all, and with the active-sietch count also
// dirty that unrelated change still runs and the save reports success while the
// edited fields are discarded. Callers refuse the whole save instead, matching
// what the per-sietch Save and Restart already do.
export function blockedSietchEdits(
  rows: SietchRow[],
  drafts: Record<string, { displayName: string; password: string }>,
  passwordTouched: Record<string, boolean> = {},
  partitionId?: string
) {
  return rows.filter((row) => {
    if (isSietchWriteTarget(row)) return false;
    if (partitionId && row.partitionId !== partitionId) return false;
    const { nameChanged, passwordChanged } = sietchDraftChanges(row, drafts, passwordTouched);
    return nameChanged || passwordChanged;
  });
}

// The exact complement of blockedSietchEdits: rows a save will really write.
// Same three conditions, with the write-target test inverted.
//
// One definition for both, because two callers need to agree on it and used to
// derive it separately: the code that builds the write actions, and the code
// that decides which drafts the post-save refresh may discard. When those
// disagreed, a save for one partition reset every draft on the panel.
export function writableSietchEdits(
  rows: SietchRow[],
  drafts: Record<string, { displayName: string; password: string }>,
  passwordTouched: Record<string, boolean> = {},
  partitionId?: string
) {
  return rows.filter((row) => {
    if (!isSietchWriteTarget(row)) return false;
    if (partitionId && row.partitionId !== partitionId) return false;
    const { nameChanged, passwordChanged } = sietchDraftChanges(row, drafts, passwordTouched);
    return nameChanged || passwordChanged;
  });
}

// What the drafts should be after a save's refresh reloads the sietch rows.
//
// A save writes one partition, but the refresh reloads them all. Replacing
// every draft with the server's values therefore discarded pending edits on
// rows the save never touched -- including the fallback rows the write guard
// had just refused, so the guard's warning was followed by the edit silently
// disappearing.
//
// Written partitions take the server's values: that write landed, so the
// server is now the truth. Every other row keeps whatever is pending. Pass an
// empty writtenPartitionIds to keep everything, which is what a failed save
// wants.
//
// Split from reconcileSietchPasswordTouched below rather than returning both,
// so each depends on exactly one piece of React state and can be applied as a
// plain functional setState against the newest value. Combined, one of them
// would have had to read the other through a stale closure.
export function reconcileSietchDrafts(
  freshRows: SietchRow[],
  currentDrafts: Record<string, { displayName: string; password: string }>,
  writtenPartitionIds: string[]
) {
  const written = new Set(writtenPartitionIds);
  const drafts: Record<string, { displayName: string; password: string }> = {};
  for (const row of freshRows) {
    const pending = currentDrafts[row.partitionId];
    drafts[row.partitionId] = !written.has(row.partitionId) && pending
      ? pending
      : { displayName: row.displayName, password: row.password };
  }
  return drafts;
}

// A written partition's password now matches the server, so its touched flag
// goes; an untouched row never had one. Everything still pending keeps it,
// because sietchPasswordDraftChanged reads it to tell an edited password from
// the mask.
export function reconcileSietchPasswordTouched(
  currentTouched: Record<string, boolean>,
  writtenPartitionIds: string[]
) {
  const written = new Set(writtenPartitionIds);
  return Object.fromEntries(
    Object.entries(currentTouched).filter(([partitionId, touched]) => touched && !written.has(partitionId))
  );
}

// Parses the fixed-width table `dune sietches dimensions <map>` prints, pairing
// each row with the partition id at the same index from the `--ids` output:
//
//   DIMENSION  DISPLAY NAME      PASSWORD        ids
//   0          Deep Desert PvP   (unset)         8
//   1          Deep Desert PvE   (unset)         59
//
// Display names are operator-chosen and arbitrary -- "Awesome Map" and
// "The Kulon Show" are real -- so nothing here may assume a "Sietch " prefix.
// Lives in its own module rather than in MapsPanel so the Bases panel can label
// map instances without pulling that whole lazily-loaded chunk in with it.
export function parseSietchRows(text: string, idsText = ""): SietchRow[] {
  const rows: SietchRow[] = [];
  const ids = idsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  let dimensionIndex = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*DIMENSION\b/i.test(line)) continue;
    const tableMatch = line.match(/^\s*(\d+)\s+(.+?)\s+(\((?:un)?set\))\s*$/i);
    if (tableMatch) {
      const dimension = tableMatch[1];
      const partitionId = ids[dimensionIndex] || dimension;
      const displayName = tableMatch[2].trim();
      const passwordSet = /^\(set\)$/i.test(tableMatch[3]);
      rows.push({
        partitionId,
        partitionIdFromIds: Boolean(ids[dimensionIndex]),
        dimension,
        displayName,
        password: "",
        passwordSet,
        active: true
      });
      dimensionIndex += 1;
      continue;
    }
    const partitionMatch = line.match(/\b(?:partition|id)\s*[:=]?\s*(\d+)\b/i) || line.match(/^\s*(\d+)\s+/);
    if (!partitionMatch) continue;
    const dimension = partitionMatch[1];
    const partitionId = ids[dimensionIndex] || partitionMatch[1];
    const displayName = (line.match(/\b(?:display|name)\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\bSietch\s+([A-Za-z0-9 _-]+)/i)?.[0] || `Sietch ${partitionId}`).trim();
    const passwordValue = (line.match(/\bpassword\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\((?:un)?set\)\s*$/i)?.[0] || "").trim();
    const passwordSet = /\(set\)|\bset\b|true|yes/i.test(passwordValue) || /\(set\)\s*$/i.test(line);
    const password = /\(set\)|\(unset\)|\bset\b|\bunset\b/i.test(passwordValue) ? "" : passwordValue;
    const active = !/\binactive|disabled|stopped\b/i.test(line);
    rows.push({
      partitionId,
      partitionIdFromIds: Boolean(ids[dimensionIndex]),
      dimension,
      displayName,
      password,
      passwordSet: passwordSet || Boolean(password),
      active
    });
    dimensionIndex += 1;
  }
  // Deduplicated by partitionId because the whole draft layer is keyed by it
  // (sietchDrafts[partitionId], sietchPasswordTouched[partitionId]) -- two rows
  // sharing an id would share one draft, so an edit to either would show in
  // both. One of a colliding pair therefore has to go.
  //
  // Two rows collide when the `--ids` output is shorter than the table: a real
  // id from --ids equals a later row's dimension-index fallback, which is what
  // happens whenever partition 1 is in play. Keep the row whose id actually
  // came from --ids -- plain last-wins would drop the one sietch whose
  // partition is known and leave an unwritable row standing in its place.
  const unique = new globalThis.Map<string, SietchRow>();
  for (const row of rows) {
    const existing = unique.get(row.partitionId);
    if (existing?.partitionIdFromIds && !row.partitionIdFromIds) continue;
    unique.set(row.partitionId, row);
  }
  return [...unique.values()].sort((a, b) => Number(a.dimension) - Number(b.dimension));
}
