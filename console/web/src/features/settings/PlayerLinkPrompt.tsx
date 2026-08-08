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
        <p>To see your personal data (inventory, storage, guild, bases), link your Discord account to your in-game character.</p>
        <p className="link-prompt-instruction">
          In Discord, use <code>/dune player link &lt;name&gt;</code> to link your character, then refresh this page.
        </p>
        <button className="btn" onClick={() => setDismissed(true)}>Continue without linking</button>
      </div>
    </section>
  );
}
