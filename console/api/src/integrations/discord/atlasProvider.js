import { buildSietchAtlas } from "../../services/sietchAtlas.js";

// atlasProvider.js: public-tier per-sietch/per-Deep-Desert-instance summary
// (#the-atlas, dune-awakening-selfhost-docker#938, mentat#376). Thin wrapper
// around the existing buildSietchAtlas() -- reused, not reimplemented, so
// this stays in agreement with the general (non-Discord) combat-state/
// Coriolis/sandstorm services it's built from.
export async function sietchAtlasProvider(config, db, { buildAtlas = buildSietchAtlas } = {}) {
  const atlas = await buildAtlas(config, db);
  return { ok: true, ...atlas };
}
