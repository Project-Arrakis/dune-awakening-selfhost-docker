import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  marketBotApi,
  type MarketAugmentPricing,
  type MarketBotStatus,
  type MarketCategoryMultipliers,
  type MarketExchange,
  type MarketPriceBasis,
  type MarketProbeResult
} from "../../api/marketBot";

// Console-managed NPC market bot (EDA Exchange Bot engine, first-class):
// seed the CHOAM exchange with NPC sell listings from the bundled plan, and
// buy back player listings priced at or below a percentage of a reference
// price. Schedules run inside the console API process (no page needs to stay
// open); every write is preceded by a database backup.

type MarketBotOverlayProps = {
  onClose: () => void;
  onError: (text: string) => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean }) => Promise<boolean>;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Per-category price multipliers (1-5x) layered on top of the base price
// multiplier. Rendered identically in the buyback and reseed sections; the
// aria labels are prefixed with the section so both stay addressable.
const CATEGORY_MULTIPLIER_FIELDS: Array<{ key: keyof MarketCategoryMultipliers; label: string }> = [
  { key: "augmentMultiplier", label: "Augment multiplier" },
  { key: "rankedArmorMultiplier", label: "Ranked armor multiplier" },
  { key: "rankedWeaponMultiplier", label: "Ranked weapon multiplier" }
];

function defaultCategoryMultipliers(): MarketCategoryMultipliers {
  return { augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1 };
}

function categoryMultipliersFrom(schedule: Partial<MarketCategoryMultipliers>): MarketCategoryMultipliers {
  return {
    augmentMultiplier: schedule.augmentMultiplier ?? 1,
    rankedArmorMultiplier: schedule.rankedArmorMultiplier ?? 1,
    rankedWeaponMultiplier: schedule.rankedWeaponMultiplier ?? 1
  };
}

type CategoryMultiplierInputsProps = {
  section: "Buyback" | "Seed";
  values: MarketCategoryMultipliers;
  onChange: (next: MarketCategoryMultipliers) => void;
};

function CategoryMultiplierInputs({ section, values, onChange }: CategoryMultiplierInputsProps) {
  return (
    <>
      {CATEGORY_MULTIPLIER_FIELDS.map(({ key, label }) => (
        <label key={key}>{label}
          <input
            aria-label={`${section} ${label.toLowerCase()}`}
            type="number"
            min={1}
            max={5}
            step={0.5}
            value={values[key]}
            onChange={(event) => onChange({ ...values, [key]: Number(event.target.value) })}
          />
        </label>
      ))}
    </>
  );
}

function exchangeLabel(exchange: MarketExchange) {
  const parts = [
    exchange.isGlobal ? `Global (ID ${exchange.exchangeId})` : `Exchange ${exchange.exchangeId}`,
    `${exchange.accessPoints} access point${exchange.accessPoints === 1 ? "" : "s"}`,
    `${exchange.botOrders} bot / ${exchange.playerOrders} player orders`
  ];
  return parts.join(" — ");
}

function runSummary(schedule: { lastRunAt: string; lastRunStatus: string; lastRunDetail: string; nextRunAt: string; enabled: boolean }) {
  const parts: string[] = [];
  if (schedule.enabled && schedule.nextRunAt) parts.push(`Next run ${new Date(schedule.nextRunAt).toLocaleString()}`);
  if (schedule.lastRunAt) parts.push(`Last run ${new Date(schedule.lastRunAt).toLocaleString()}${schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : ""}${schedule.lastRunDetail ? `: ${schedule.lastRunDetail}` : ""}`);
  return parts.length ? parts.join(" | ") : "No runs yet.";
}

export function MarketBotOverlay({ onClose, onError, confirmAction }: MarketBotOverlayProps) {
  const [status, setStatus] = useState<MarketBotStatus | null>(null);
  const [exchanges, setExchanges] = useState<MarketExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [probeResult, setProbeResult] = useState<MarketProbeResult | null>(null);

  const [exchangeId, setExchangeId] = useState("");
  const [buybackEnabled, setBuybackEnabled] = useState(false);
  const [buybackInterval, setBuybackInterval] = useState(30);
  const [buybackMultiplier, setBuybackMultiplier] = useState(5);
  const [buybackCategoryMultipliers, setBuybackCategoryMultipliers] = useState(defaultCategoryMultipliers);
  const [buybackPercent, setBuybackPercent] = useState(60);
  const [buybackBasis, setBuybackBasis] = useState<MarketPriceBasis>("seeded");
  const [maxBuys, setMaxBuys] = useState(500);
  const [seedEnabled, setSeedEnabled] = useState(false);
  const [seedInterval, setSeedInterval] = useState(15);
  const [seedMultiplier, setSeedMultiplier] = useState(5);
  const [seedCategoryMultipliers, setSeedCategoryMultipliers] = useState(defaultCategoryMultipliers);
  const [augmentPricing, setAugmentPricing] = useState<MarketAugmentPricing>("discounted");

  function applyStatus(next: MarketBotStatus, options: { populateForm?: boolean } = {}) {
    setStatus(next);
    if (options.populateForm) {
      setBuybackEnabled(Boolean(next.buyback.enabled));
      setBuybackInterval(next.buyback.intervalMinutes);
      setBuybackMultiplier(next.buyback.priceMultiplier);
      setBuybackCategoryMultipliers(categoryMultipliersFrom(next.buyback));
      setBuybackPercent(next.buyback.buybackPercent);
      setBuybackBasis(next.buyback.buybackPriceBasis || "seeded");
      setMaxBuys(next.buyback.maxBuys);
      setSeedEnabled(Boolean(next.seed.enabled));
      setSeedInterval(next.seed.intervalMinutes);
      setSeedMultiplier(next.seed.priceMultiplier);
      setSeedCategoryMultipliers(categoryMultipliersFrom(next.seed));
      setAugmentPricing(next.seed.augmentPricing === "original" ? "original" : "discounted");
      setExchangeId((current) => current || next.buyback.exchangeId || next.seed.exchangeId || "");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([marketBotApi.status(), marketBotApi.exchanges()])
      .then(([nextStatus, exchangeList]) => {
        if (cancelled) return;
        applyStatus(nextStatus, { populateForm: true });
        setExchanges(exchangeList.rows || []);
        setExchangeId((current) => current || exchangeList.rows?.[0]?.exchangeId || "");
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        onError(errorText(error));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [onError]);

  async function refreshStatus() {
    try {
      applyStatus(await marketBotApi.status());
    } catch {
      // Non-fatal: the action that triggered the refresh already reported.
    }
  }

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setNotice("");
    onError("");
    try {
      setNotice(await action());
      await refreshStatus();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy("");
    }
  }

  function saveBuyback() {
    return run("save-buyback", async () => {
      const saved = await marketBotApi.saveBuybackSchedule({
        enabled: buybackEnabled,
        intervalMinutes: buybackInterval,
        priceMultiplier: buybackMultiplier,
        ...buybackCategoryMultipliers,
        buybackPercent,
        buybackPriceBasis: buybackBasis,
        maxBuys,
        ...(exchangeId ? { exchangeId } : {})
      });
      return saved.enabled
        ? `Buyback schedule saved: every ${saved.intervalMinutes} min on exchange ${saved.exchangeId}. First run fires one full interval after enabling.`
        : "Buyback schedule saved (disabled).";
    });
  }

  function saveSeed() {
    return run("save-seed", async () => {
      const saved = await marketBotApi.saveSeedSchedule({
        enabled: seedEnabled,
        intervalMinutes: seedInterval,
        priceMultiplier: seedMultiplier,
        ...seedCategoryMultipliers,
        augmentPricing,
        ...(exchangeId ? { exchangeId } : {})
      });
      return saved.enabled
        ? `Reseed schedule saved: every ${saved.intervalMinutes} min on exchange ${saved.exchangeId}. Every run is backup, clear bot listings, seed.`
        : "Reseed schedule saved (disabled).";
    });
  }

  function probe() {
    return run("probe", async () => {
      const result = await marketBotApi.probeBuyback({
        ...(exchangeId ? { exchangeId } : {}),
        priceMultiplier: buybackMultiplier,
        ...buybackCategoryMultipliers,
        buybackPercent,
        buybackPriceBasis: buybackBasis,
        maxBuys
      });
      setProbeResult(result);
      return `${result.eligible.toLocaleString()} eligible player listing(s) on exchange ${result.exchangeId} at ${result.buybackPercent}% (read-only; no backup taken).`;
    });
  }

  async function runBuybackNow() {
    const confirmed = await confirmAction(
      "Run a buyback sweep now with the saved schedule settings? The console probes eligibility first and takes a database backup only when there is something to buy.",
      { title: "Run buyback sweep", confirmLabel: "Run sweep", danger: true }
    );
    if (!confirmed) return;
    await run("run-buyback", async () => {
      const result = await marketBotApi.runBuyback();
      if (result.status === "swept") {
        return `Sweep finished: bought ${result.purchased ?? 0} listing(s), ${result.totalUnits ?? "0"} units for ${result.totalSolari ?? "0"} Solari.`;
      }
      return result.detail || "Nothing eligible; no backup was taken.";
    });
  }

  async function runSeedNow() {
    const confirmed = await confirmAction(
      "Reseed the NPC sell market now with the saved schedule settings? The console takes a database backup, clears the bot's own listings on that exchange, then seeds fresh from the bundled plan. Player listings are never touched.",
      { title: "Run market reseed", confirmLabel: "Run reseed", danger: true }
    );
    if (!confirmed) return;
    await run("run-seed", async () => {
      const result = await marketBotApi.runSeed();
      return `Reseed finished: ${result.listingCount ?? "0"} listings on exchange ${result.exchangeId ?? "?"}.`;
    });
  }

  const supported = status?.capabilities.exchangeMarket !== false;
  const planReady = status?.plan.available === true;
  const savedBuybackExchange = status?.buyback.exchangeId || "";
  const savedSeedExchange = status?.seed.exchangeId || "";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Market bot settings" onClick={onClose}>
      <div className="confirm-modal exchange-config-modal market-bot-modal" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-modal-title">
          <h3>Market Bot</h3>
          <button className="exchange-config-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <p>
          Seeds NPC sell listings from the bundled Easy Dune Admin plan and buys back player listings at or below the
          buyback percentage of the chosen price basis. Schedules run inside the console — no page needs to stay open —
          and every database write is preceded by a backup.
        </p>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !supported && <p className="muted">{status?.reason || "The Market Bot is unsupported by the detected database schema."}</p>}
        {!loading && supported && !planReady && <p className="muted">The bundled market seed plan is missing. Repair or reinstall the console release.</p>}
        {!loading && supported && planReady && status && (
          <>
            <p className="muted">
              Seed plan: {status.plan.rows.toLocaleString()} rows
              {status.plan.panelVersion ? ` (v${status.plan.panelVersion})` : ""} from the bundled console copy.
            </p>
            <label className="compact-select market-bot-exchange">
              Exchange
              <select aria-label="Exchange" value={exchangeId} onChange={(event) => setExchangeId(event.target.value)}>
                {!exchanges.length && <option value="">No exchanges found</option>}
                {exchanges.map((exchange) => (
                  <option key={exchange.exchangeId} value={exchange.exchangeId}>{exchangeLabel(exchange)}</option>
                ))}
              </select>
            </label>
            <p className="action-help-note">Exchanges with access points come first — those are the ones players actually reach in-game. Saving a schedule binds it to the exchange selected here.</p>

            <div className="market-bot-section">
              <strong>Buyback sweeps</strong>
              <p className="action-help-note">Buys player sell listings whose per-unit ask is at or below the buyback percentage of the price basis (seeded NPC price at that grade, or live market average / lowest with seeded fallback). Whole listed stacks are bought in one pass. Every run probes eligibility read-only first and only backs up + sweeps when something qualifies. The category multipliers reprice the seeded basis the same way the reseed does — keep them matched with the reseed section so the buyback percentage tracks the real market prices.</p>
              <div className="market-bot-grid">
                <label>Interval (minutes)
                  <input aria-label="Buyback interval minutes" type="number" min={10} max={1440} value={buybackInterval} onChange={(event) => setBuybackInterval(Number(event.target.value))} />
                </label>
                <label>Price multiplier
                  <input aria-label="Buyback price multiplier" type="number" min={1} max={100} value={buybackMultiplier} onChange={(event) => setBuybackMultiplier(Number(event.target.value))} />
                </label>
                <CategoryMultiplierInputs section="Buyback" values={buybackCategoryMultipliers} onChange={setBuybackCategoryMultipliers} />
                <label>Buyback percent
                  <input aria-label="Buyback percent" type="number" min={1} max={100} value={buybackPercent} onChange={(event) => setBuybackPercent(Number(event.target.value))} />
                </label>
                <label>Price basis
                  <select aria-label="Buyback price basis" value={buybackBasis} onChange={(event) => setBuybackBasis(event.target.value as MarketPriceBasis)}>
                    <option value="seeded">Seeded NPC price</option>
                    <option value="average">Live market average</option>
                    <option value="lowest">Live market lowest</option>
                  </select>
                </label>
                <label>Max buys per sweep
                  <input aria-label="Max buys per sweep" type="number" min={1} max={5000} value={maxBuys} onChange={(event) => setMaxBuys(Number(event.target.value))} />
                </label>
              </div>
              <label className="market-bot-toggle">
                <input aria-label="Run buyback on a schedule" type="checkbox" checked={buybackEnabled} onChange={(event) => setBuybackEnabled(event.target.checked)} />
                Run buyback on a schedule (unattended)
              </label>
              <p className="muted">{runSummary(status.buyback)}{savedBuybackExchange ? ` | Saved exchange ${savedBuybackExchange}` : ""}</p>
              <div className="confirm-modal-actions market-bot-actions">
                <button onClick={() => void saveBuyback()} disabled={Boolean(busy)}>{busy === "save-buyback" ? "Saving…" : "Save buyback schedule"}</button>
                <button onClick={() => void probe()} disabled={Boolean(busy)}>{busy === "probe" ? "Probing…" : "Probe eligibility"}</button>
                <button className="danger" onClick={() => void runBuybackNow()} disabled={Boolean(busy) || !savedBuybackExchange}>{busy === "run-buyback" ? "Running…" : "Run sweep now"}</button>
              </div>
              {probeResult && (
                <div className="market-bot-diagnostics" aria-label="Buyback diagnostics">
                  <strong>Why listings were not bought</strong>
                  <p className="muted">Read-only probe for exchange {probeResult.exchangeId} at the {probeResult.buybackPercent}% threshold using the {probeResult.buybackPriceBasis} price basis.</p>
                  <dl>
                    <div><dt>Player listings checked</dt><dd>{probeResult.playerListings.toLocaleString()}</dd></div>
                    <div><dt>Recognized in seed plan</dt><dd>{probeResult.knownListings.toLocaleString()}</dd></div>
                    <div><dt>Eligible to buy</dt><dd>{probeResult.eligible.toLocaleString()}</dd></div>
                    <div><dt>Waiting beyond sweep limit</dt><dd>{Math.max(0, probeResult.eligible - probeResult.maxBuys).toLocaleString()}</dd></div>
                    <div><dt>Above price threshold</dt><dd>{probeResult.aboveThreshold.toLocaleString()}</dd></div>
                    <div><dt>Unknown template</dt><dd>{probeResult.unknownTemplate.toLocaleString()}</dd></div>
                    <div><dt>Invalid price or empty stack</dt><dd>{probeResult.invalidPriceOrStack.toLocaleString()}</dd></div>
                  </dl>
                </div>
              )}
            </div>

            <div className="market-bot-section">
              <strong>Market reseed</strong>
              <p className="action-help-note">Replaces the bot's own NPC sell listings from the seed plan at the chosen price multiplier. Every run is backup, clear bot listings on that exchange, seed. Player listings are never touched. Augment items always seed as bottom-of-range rolls; the augment pricing option chooses whether they undercut their schematics (half the pattern's price) or keep the plan's original prices.</p>
              <p className="action-help-note">Category multipliers (1-5x, 1 = no change) additionally scale the seeded prices of augments &amp; augment schematics, ranked (grade 1-5) armor including stillsuits, and ranked weapons — on top of the base price multiplier. Grade-0 stock and everything else keeps the base multiplier alone.</p>
              <div className="market-bot-grid">
                <label>Interval (minutes)
                  <input aria-label="Seed interval minutes" type="number" min={10} max={1440} value={seedInterval} onChange={(event) => setSeedInterval(Number(event.target.value))} />
                </label>
                <label>Price multiplier
                  <input aria-label="Seed price multiplier" type="number" min={1} max={100} value={seedMultiplier} onChange={(event) => setSeedMultiplier(Number(event.target.value))} />
                </label>
                <CategoryMultiplierInputs section="Seed" values={seedCategoryMultipliers} onChange={setSeedCategoryMultipliers} />
                <label>Augment pricing
                  <select aria-label="Augment pricing" value={augmentPricing} onChange={(event) => setAugmentPricing(event.target.value as MarketAugmentPricing)}>
                    <option value="discounted">Cheaper than patterns</option>
                    <option value="original">Original plan prices</option>
                  </select>
                </label>
              </div>
              <label className="market-bot-toggle">
                <input aria-label="Run reseed on a schedule" type="checkbox" checked={seedEnabled} onChange={(event) => setSeedEnabled(event.target.checked)} />
                Run market reseed on a schedule (unattended)
              </label>
              <p className="muted">{runSummary(status.seed)}{savedSeedExchange ? ` | Saved exchange ${savedSeedExchange}` : ""}</p>
              <div className="confirm-modal-actions market-bot-actions">
                <button onClick={() => void saveSeed()} disabled={Boolean(busy)}>{busy === "save-seed" ? "Saving…" : "Save reseed schedule"}</button>
                <button className="danger" onClick={() => void runSeedNow()} disabled={Boolean(busy) || !savedSeedExchange}>{busy === "run-seed" ? "Running…" : "Run reseed now"}</button>
              </div>
            </div>

            {notice && <p className="market-bot-notice" role="status">{notice}</p>}
          </>
        )}
        <div className="confirm-modal-actions">
          <button onClick={onClose} disabled={Boolean(busy)}>Close</button>
        </div>
      </div>
    </div>
  );
}
