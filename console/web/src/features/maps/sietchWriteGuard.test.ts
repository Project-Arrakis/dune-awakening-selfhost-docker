import { describe, expect, it } from "vitest";
import { blockedSietchEdits, isSietchWriteTarget, parseSietchRows, sietchDraftChanges } from "./sietchRows";

// Real `dune sietches dimensions Survival_1 --active-only` output. The real
// partitions are 1, 31 and 55 -- deliberately not equal to their dimension
// indices, which is what makes the fallback dangerous.
const SURVIVAL_TABLE = [
  "DIMENSION  DISPLAY NAME                     PASSWORD",
  "0          Hagga Basin                      (unset)",
  "1          Sietch Abbir                     (set)",
  "2          The Kulon Show                   (unset)"
].join("\n");

const IDS_READ = "1\n31\n55\n";
// `sietches dimensions --ids` is a separate CLI invocation from the one that
// prints the table, and the API answers 200 with empty stdout when it fails.
const IDS_UNREADABLE = "";
// The realistic middle case: the --ids output is short, so the rows it covers
// carry real partition ids and the rest fall back to their dimension index.
const IDS_PARTIAL = "1\n31\n";

function draftsFor(rows: ReturnType<typeof parseSietchRows>, overrides: Record<string, Partial<{ displayName: string; password: string }>> = {}) {
  return Object.fromEntries(rows.map((row) => [
    row.partitionId,
    { displayName: row.displayName, password: row.password, ...overrides[row.partitionId] }
  ]));
}

describe("blockedSietchEdits", () => {
  // Case 1: only the name is dirty. survivalSietchActions skips the row, so
  // without this the bulk Save built zero actions and returned silently --
  // the operator saw nothing happen and no reason why.
  it("reports an edited row whose partition id fell back to a dimension index", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_UNREADABLE);
    const drafts = draftsFor(rows, { "1": { displayName: "Renamed Sietch" } });

    expect(blockedSietchEdits(rows, drafts, {}).map((row) => row.displayName)).toEqual(["Sietch Abbir"]);
  });

  // Case 2: the edit sits alongside changes that *are* writable. The bulk Save
  // must refuse the whole thing rather than apply the writable ones and drop
  // this row, which would report success while discarding the edit.
  it("reports the edited row even when other pending changes could be written", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_UNREADABLE);
    const drafts = draftsFor(rows, {
      "1": { displayName: "Renamed Sietch" },
      "2": { displayName: "Also Renamed" }
    });

    expect(blockedSietchEdits(rows, drafts, {})).toHaveLength(2);
  });

  // The guard must not over-block: with the ids unreadable but nothing edited,
  // an active-sietch-count save is still legitimate and must go through.
  it("reports nothing when the unwritable rows were left alone", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_UNREADABLE);

    expect(blockedSietchEdits(rows, draftsFor(rows), {})).toEqual([]);
    expect(blockedSietchEdits(rows, {}, {})).toEqual([]);
  });

  it("reports a touched password as an edit", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_UNREADABLE);
    const drafts = draftsFor(rows, { "2": { password: "new-secret" } });

    // Untouched, the masked/blank draft is not an edit.
    expect(blockedSietchEdits(rows, drafts, {})).toEqual([]);
    expect(blockedSietchEdits(rows, drafts, { "2": true }).map((row) => row.displayName)).toEqual(["The Kulon Show"]);
  });

  it("reports nothing once the partition ids are readable", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_READ);
    const drafts = draftsFor(rows, { "31": { displayName: "Renamed Sietch" } });

    expect(rows.every((row) => row.partitionIdFromIds)).toBe(true);
    expect(blockedSietchEdits(rows, drafts, {})).toEqual([]);
  });

  // Partial ids are the realistic failure: one map's rows split between
  // verified and fallen-back. Editing a fallback row must not quietly ride
  // along with a save aimed at a verified one, and the edit must survive that
  // save so it is still on screen to be dealt with.
  it("keeps a fallback row's edit out of a verified row's save, and does not discard it", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_PARTIAL);
    // Two real ids, then a row that fell back to its dimension index.
    expect(rows.map((row) => [row.partitionId, isSietchWriteTarget(row)]))
      .toEqual([["1", true], ["31", true], ["2", false]]);

    const drafts = draftsFor(rows, {
      "2": { displayName: "Renamed Fallback" },
      "31": { displayName: "Renamed Verified" }
    });

    // Saving the verified row is scoped to it, so the unwritable edit elsewhere
    // neither blocks it nor gets written by it.
    expect(blockedSietchEdits(rows, drafts, {}, "31")).toEqual([]);
    // The fallback row's own Save is refused instead -- isSietchWriteTarget is
    // what saveSietchSettings and restartSietch check before writing.
    expect(isSietchWriteTarget(rows[2])).toBe(false);
    expect(blockedSietchEdits(rows, drafts, {}, "2").map((row) => row.displayName)).toEqual(["The Kulon Show"]);

    // Nothing here mutates drafts, so the fallback edit is still pending and
    // still rendered after the verified row is saved.
    expect(drafts["2"].displayName).toBe("Renamed Fallback");
    expect(sietchDraftChanges(rows[2], drafts, {}).nameChanged).toBe(true);
  });

  // saveSelectedMapSettings carries only the primary sietch's fields, so it
  // asks about that partition alone.
  it("scopes to one partition when asked", () => {
    const rows = parseSietchRows(SURVIVAL_TABLE, IDS_UNREADABLE);
    const drafts = draftsFor(rows, { "1": { displayName: "Renamed Sietch" } });

    expect(blockedSietchEdits(rows, drafts, {}, "1")).toHaveLength(1);
    expect(blockedSietchEdits(rows, drafts, {}, "0")).toEqual([]);
  });
});

describe("sietchDraftChanges", () => {
  // The action builder and the guard share this, so they cannot disagree about
  // what counts as an edit.
  it("falls back to the row's own values when no draft exists", () => {
    const [row] = parseSietchRows("0          Hagga Basin                      (unset)", "1\n");
    const changes = sietchDraftChanges(row, {}, {});

    expect(changes.draft).toEqual({ displayName: "Hagga Basin", password: "" });
    expect(changes.nameChanged).toBe(false);
    expect(changes.passwordChanged).toBe(false);
  });

  it("separates a name change from a password change", () => {
    const [row] = parseSietchRows("0          Hagga Basin                      (unset)", "1\n");
    const drafts = { "1": { displayName: "Renamed", password: "hunter2" } };

    expect(sietchDraftChanges(row, drafts, {}).nameChanged).toBe(true);
    expect(sietchDraftChanges(row, drafts, {}).passwordChanged).toBe(false);
    expect(sietchDraftChanges(row, drafts, { "1": true }).passwordChanged).toBe(true);
  });
});
