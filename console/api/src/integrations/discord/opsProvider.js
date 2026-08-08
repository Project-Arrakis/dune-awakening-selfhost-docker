// OPS Bridge Providers — maps Discord adapter routes to OPS observability data.
// Four providers (activity, combat, resources, economy) are wired to real
// duneDb aggregate queries. The remaining five (inventory, location, soc,
// prometheus, dashboard-aggregator) return "planned" placeholders until
// their corresponding backend queries or integrations are implemented.

import {
  addonOpsActivitySummary,
  addonOpsCombatDeaths,
  addonOpsResourcesSummary,
  addonOpsEconomySummary,
} from "../../duneDb.js";

export async function opsActivityProvider(config, db) {
  const result = await addonOpsActivitySummary(db);
  return { ok: true, result };
}

export async function opsCombatProvider(config, db) {
  const result = await addonOpsCombatDeaths(db);
  return { ok: true, result };
}

export async function opsResourcesProvider(config, db) {
  const result = await addonOpsResourcesSummary(db, config);
  // Compute top-level totalValueRemaining so the bot's statsPusher
  // fetchAggregate can populate spice_fields without needing to
  // understand the internal deepDesert/haggaBasin instance structure.
  let totalValueRemaining = 0;
  for (const section of [result.deepDesert, result.haggaBasin]) {
    if (!section || !Array.isArray(section.instances)) continue;
    for (const inst of section.instances) {
      if (typeof inst.totalValueRemaining === "number") {
        totalValueRemaining += inst.totalValueRemaining;
      }
    }
  }
  return { ok: true, result: { ...result, totalValueRemaining } };
}

export async function opsEconomyProvider(config, db) {
  const result = await addonOpsEconomySummary(db);
  return { ok: true, result };
}

export async function opsInventoryProvider() {
  return opsPlaceholder("inventory");
}

export async function opsLocationProvider() {
  return opsPlaceholder("location");
}

export async function opsSocProvider() {
  return opsPlaceholder("soc");
}

export async function opsPrometheusProvider() {
  return opsPlaceholder("prometheus");
}

export async function opsDashboardProvider(config, db) {
  const results = await Promise.allSettled([
    opsActivityProvider(config, db), opsCombatProvider(config, db),
    opsResourcesProvider(config, db), opsEconomyProvider(config, db),
    opsInventoryProvider(), opsLocationProvider(),
    opsSocProvider(), opsPrometheusProvider(),
  ]);
  const data = {};
  results.forEach((r, i) => {
    const keys = ["activity","combat","resources","economy","inventory","location","soc","prometheus"];
    data[keys[i]] = r.status === "fulfilled" ? r.value : { error: r.reason?.message || "failed" };
  });
  return { ok: true, dashboard: data };
}

function opsPlaceholder(domain) {
  return {
    ok: true,
    status: "planned",
    domain,
    message: `OPS ${domain} bridge integration pending.`,
    summary: {}
  };
}
