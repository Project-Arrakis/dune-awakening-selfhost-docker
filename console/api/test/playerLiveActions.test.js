import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPlayerForLiveAction, playerIsOnlineForLiveAction } from "../src/playerLiveActions.js";

const players = [
  {
    action_player_id: "FLS_ONLINE",
    funcom_id: "Online#1234",
    actor_id: "101",
    actual_online_status: "Online",
    online_status: "Online"
  },
  {
    action_player_id: "FLS_OFFLINE",
    funcom_id: "Offline#1234",
    actor_id: "202",
    actual_online_status: "Offline",
    online_status: "Offline"
  }
];

test("live actions resolve every supported player identifier case-insensitively", () => {
  assert.equal(findPlayerForLiveAction(players, "fls_online"), players[0]);
  assert.equal(findPlayerForLiveAction(players, "ONLINE#1234"), players[0]);
  assert.equal(findPlayerForLiveAction(players, "101"), players[0]);
});

test("skill live-action eligibility requires an explicitly online player", () => {
  assert.equal(playerIsOnlineForLiveAction(findPlayerForLiveAction(players, "FLS_ONLINE")), true);
  assert.equal(playerIsOnlineForLiveAction(findPlayerForLiveAction(players, "FLS_OFFLINE")), false);
  assert.equal(playerIsOnlineForLiveAction(findPlayerForLiveAction(players, "missing")), false);
});

test("the terminal wrapper also requires players to be online for skill grants", () => {
  const script = readFileSync(new URL("../../../runtime/scripts/admin-tools.sh", import.meta.url), "utf8");
  assert.match(script, /AwardXP\|SkillsSetUnspentSkillPoints\|SkillsSetModuleLevel\|UpdateAllWaterFillables\|SpawnVehicleAt\) require_online=1/);
});
