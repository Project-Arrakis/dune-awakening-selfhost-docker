import { describe, expect, it } from "vitest";
import { PLAYER_ADMIN_SKILL_TREES } from "./CharacterAdminUI";
import catalog from "../../../../../runtime/data/admin-skill-modules.json";

// The Skills tab has two sources of truth for how many ranks a skill has: the
// admin catalog the API serves (runtime/data/admin-skill-modules.json) and the
// hardcoded tree layout this component falls back to. The catalog wins at
// runtime, so drift between them is silent -- both sat at 1 rank for Weirding
// Step after the game made it a 3-rank skill. Pin them together instead.
const normalize = (value: string) => value.toLowerCase().replace(/^ability:\s*/, "").replace(/[^a-z0-9]/g, "");
const catalogByKey = new Map(catalog.map((row) => [`${normalize(row.category)}:${normalize(row.name)}`, row]));

const cards = Object.entries(PLAYER_ADMIN_SKILL_TREES).flatMap(([school, trees]) =>
  trees.flatMap((tree) => tree.cards.map((card) => ({ school, tree: tree.tree, card })))
);

describe("skill tree cards match the admin skill module catalog", () => {
  it("has cards to check", () => {
    expect(cards.length).toBeGreaterThan(0);
  });

  it.each(cards)("$school / $tree / $card.name", ({ school, card }) => {
    const row = catalogByKey.get(`${normalize(school)}:${normalize(card.name)}`);
    expect(row, `no catalog entry for "${card.name}" in ${school}`).toBeDefined();
    expect(Number(card.rank), `rank for "${card.name}" (${row?.id})`).toBe(Number(row?.maxLevel));
  });
});
