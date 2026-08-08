import { useState, useEffect } from "react";
import { api } from "../../api/client";

interface LinkedCharacter {
  player_controller_id: string;
  character_name: string;
}

export function PlayerLinkPrompt() {
  const [linked, setLinked] = useState<LinkedCharacter[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api<{ characters: LinkedCharacter[] }>("/api/auth/characters").then(d => {
      setLinked(d.characters || []);
    }).catch(() => setLinked([]));
  }, []);

  if (linked === null) return null;
  if (linked.length > 0) return null;
  if (dismissed) return null;

  return (
    <section className="link-prompt">
      <div className="link-prompt-card">
        <h2>Link Your Character</h2>
        <p>When you link your Discord account to your in-game character, your data views are scoped to only show your character, guild, bases, and storage.</p>
        <p className="link-prompt-instruction">
          In your Discord server, use <code>/dune player link YourCharacterName</code> to link, then refresh this page.
        </p>
        <p style={{fontSize:".8rem",color:"var(--text-muted,#888)",marginTop:".5rem"}}>Without linking, you can browse world-level data (maps, sietches, server status) but not personal player data.</p>
        <button className="btn" onClick={() => setDismissed(true)}>Continue without linking</button>
      </div>
    </section>
  );
}
