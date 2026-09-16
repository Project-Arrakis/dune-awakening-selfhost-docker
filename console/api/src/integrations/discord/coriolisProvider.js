import { resolveCoriolisCycle } from "../../services/coriolisSeed.js";

// coriolisProvider.js: public-tier farm-wide Coriolis storm seed + next-cycle
// timestamp (mentat#370, issue #942). Thin wrapper around the existing
// resolveCoriolisCycle() -- already used by the general (non-Discord)
// /api/map/markers and /api/map/spice routes, including its own 30s cache
// (see coriolisSeed.js's own comment) -- reused here rather than
// reimplemented, so both surfaces stay in agreement.
//
// "HaggaBasin" is this deployment's one persistent world (confirmed real via
// `dune sietches list` earlier this session) -- resolveCoriolisCycle's own
// comment notes every running container reports the identical farm-wide
// seed/cycle regardless of which one is asked, so a fixed default map is
// correct here, not a limitation.
export async function coriolisCycleProvider({ resolveCycle = resolveCoriolisCycle } = {}) {
  const { seed, nextCycleAt } = await resolveCycle({ map: "HaggaBasin" });
  return {
    ok: true,
    seed: seed || null,
    nextCycleAt: nextCycleAt || null
  };
}
