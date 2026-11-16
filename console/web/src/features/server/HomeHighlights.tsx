import { Sparkles } from "lucide-react";

export function HomeHighlights() {
  return <aside className="panel home-highlights" aria-labelledby="home-highlights-title">
    <div className="home-highlight-art">
      <img src="/images/features/regis-tank.jpg" alt="Regis Tanks in Hagga Basin" width={1672} height={941} />
    </div>
    <div className="home-highlight-content">
    <div className="home-highlights-heading">
      <h2 id="home-highlights-title"><Sparkles size={18} aria-hidden="true" />Highlights</h2>
      <span className="home-highlight-tag">Experimental</span>
    </div>
    <h3 className="home-highlight-title">Regis Tanks <span>Six Tier 6 Presets · Hagga Basin</span></h3>
    <ol className="home-highlight-steps">
      <li><span className="home-highlight-step-number" aria-hidden="true">1</span><div><strong>Enable Regis Tanks</strong><p>Settings → Experimental Features → Regis Tanks. Enable and wait for Hagga to finish restarting.</p></div></li>
      <li><span className="home-highlight-step-number" aria-hidden="true">2</span><div><strong>Spawn Your Tank</strong><p>Players → Player → Admin → Spawn Vehicle. Choose Regis Tank and a preset. The player must be online in Hagga.</p></div></li>
    </ol>
    </div>
  </aside>;
}
