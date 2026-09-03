import test from "node:test";
import assert from "node:assert/strict";
import { deliverMapChatToRecipients } from "../src/services/mapChatDelivery.js";

test("map chat uses the Server persona and delivers directly to each unique player queue", async () => {
  const calls = [];
  const result = await deliverMapChatToRecipients({}, {
    mapName: "Overland",
    dimension: 0,
    message: "The spice must flow.",
    recipients: [
      { queue: "AAAAAAAAAAAAAAAA_queue" },
      { queue: "BBBBBBBBBBBBBBBB_queue" },
      { queue: "AAAAAAAAAAAAAAAA_queue" }
    ]
  }, {
    persona: { funcomId: "Server#4242", hexFlsId: "5E121CE000000001" },
    publishMapChat: async (_config, fields) => {
      calls.push(fields);
      return { stdout: `publish=ok ${fields.recipientQueue}`, stderr: "" };
    }
  });

  assert.equal(result.recipients, 2);
  assert.deepEqual(calls.map((call) => call.recipientQueue), ["AAAAAAAAAAAAAAAA_queue", "BBBBBBBBBBBBBBBB_queue"]);
  assert.equal(calls.every((call) => call.senderFuncomId === "Server#4242"), true);
  assert.equal(calls.every((call) => call.senderHexFlsId === "5E121CE000000001"), true);
  assert.equal(calls.every((call) => call.mapName === "Overland" && call.dimension === 0), true);
});

test("map chat refuses delivery when no player queue is available", async () => {
  await assert.rejects(
    deliverMapChatToRecipients({}, { mapName: "Overland", dimension: 0, message: "Hello", recipients: [] }, {}),
    /No online players/
  );
});
