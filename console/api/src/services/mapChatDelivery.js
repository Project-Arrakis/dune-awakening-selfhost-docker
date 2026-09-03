import { ensureCarePackageServerPersona } from "../carePackage.js";
import { publishMapChat } from "../rmq.js";

const MOCK_SERVER_PERSONA = Object.freeze({
  funcomId: "Server#4242",
  hexFlsId: "5E121CE000000001"
});

export async function deliverMapChatToRecipients(config, fields, context = {}) {
  const queues = [...new Set((fields.recipients || [])
    .map((recipient) => String(recipient?.queue || recipient || "").trim())
    .filter(Boolean))];
  if (!queues.length) throw new Error("No online players are currently subscribed to that map.");

  const mockMode = context.mockMode === true || config.mockMode === true;
  const persona = context.persona || (mockMode ? MOCK_SERVER_PERSONA : await ensureCarePackageServerPersona(context.db));
  const publisher = context.publishMapChat || publishMapChat;
  const results = [];
  for (const recipientQueue of queues) {
    results.push(mockMode
      ? { code: 0, stdout: "mock map chat\n", stderr: "", args: [] }
      : await publisher(config, {
          mapName: fields.mapName,
          dimension: fields.dimension,
          message: fields.message,
          senderFuncomId: persona.funcomId,
          senderHexFlsId: persona.hexFlsId,
          recipientQueue
        }));
  }
  return {
    code: 0,
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
    recipients: results.length
  };
}
