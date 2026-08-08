import { describe, expect, it } from "vitest";
import { parseSietchRows } from "./sietchRows";

describe("parseSietchRows", () => {
  // Verbatim `dune sietches dimensions DeepDesert_1` output and its --ids
  // companion, captured from the live server.
  it("pairs each dimension with the partition id at the same index", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Deep Desert PvP                  (unset)",
      "1          Deep Desert PvE                  (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "8\n59\n").map((row) => [row.partitionId, row.displayName])).toEqual([
      ["8", "Deep Desert PvP"],
      ["59", "Deep Desert PvE"]
    ]);
  });

  // Display names are whatever the operator typed. Nothing here may assume a
  // "Sietch " prefix, ASCII, single spacing, or that the name is not itself a
  // number -- every one of these is a name a server owner could set.
  it("preserves arbitrary operator-chosen names", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Awesome Map                      (unset)",
      "1          The Kulon Show                   (set)",
      "2          12345                            (unset)",
      "3          Bob's (unset) Palace             (unset)",
      "4          Sietch   double  spaces          (unset)",
      "5          Ünïcôdé Sïétch                   (unset)",
      "6          a                                (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "1\n31\n55\n7\n8\n9\n10\n").map((row) => row.displayName)).toEqual([
      "Awesome Map",
      "The Kulon Show",
      "12345",
      // The (unset) marker is anchored to end-of-line, so a name containing
      // one of its own survives intact.
      "Bob's (unset) Palace",
      "Sietch   double  spaces",
      "Ünïcôdé Sïétch",
      "a"
    ]);
  });

  it("reads the password flag per row", () => {
    const table = [
      "DIMENSION  DISPLAY NAME                     PASSWORD",
      "0          Locked Sietch                    (set)",
      "1          Open Sietch                      (unset)"
    ].join("\n");

    expect(parseSietchRows(table, "1\n2\n").map((row) => row.passwordSet)).toEqual([true, false]);
  });

  it("falls back to the dimension when no partition ids are supplied", () => {
    const table = "0          Solo Sietch                      (unset)";
    expect(parseSietchRows(table)).toEqual([
      { partitionId: "0", dimension: "0", displayName: "Solo Sietch", password: "", passwordSet: false, active: true }
    ]);
  });
});
