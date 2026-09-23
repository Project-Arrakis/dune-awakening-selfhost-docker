// Internal HTTP client for the Discord write bridge's Hop B loopback
// (issue #215, docs/rw-architecture.md section 3.1). write/execute uses
// this to invoke Core's own real mutation route over the Unix socket,
// reusing the real route handler completely unchanged -- never
// reimplementing mutation logic.
import { request as httpRequest } from "node:http";
import {
  getWriteBridgeToken,
  WRITE_BRIDGE_TOKEN_HEADER,
  WRITE_BRIDGE_ACTION_HEADER,
  WRITE_BRIDGE_TIER_HEADER,
  WRITE_BRIDGE_ACTOR_USER_ID_HEADER,
  WRITE_BRIDGE_ACTOR_USERNAME_HEADER
} from "./writeBridgeCredential.js";

// [Layer 3 integration audit fix, HIGH, issue #1033] routes.js's
// writeExecuteRoute consumes the write nonce (irreversible, single-use)
// immediately before awaiting this call -- with no timeout, a hung target
// route handler (slow DB/RMQ round-trip) left the confirmation spent with
// no bound and no retry path. Bounded and env-overridable like every other
// timeout in this codebase (see DUNE_OPS_QUERY_TIMEOUT_MS in routes.js,
// ADMIN_DB_QUERY_TIMEOUT_MS in db.js) -- mutation routes can legitimately
// run longer than a read query, so the default is generous, not tight.
const DEFAULT_TIMEOUT_MS = 15_000;
function boundedTimeoutMs() {
  const value = Number(process.env.DUNE_DISCORD_WRITE_BRIDGE_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 1000 && value <= 60_000 ? value : DEFAULT_TIMEOUT_MS;
}

// Real internal HTTP request over the Unix socket. `body` is whatever the
// real target route expects on its own request body (confirmPhrase,
// params, etc. -- see WRITE_ACTION_ROUTES); the write-bridge's own
// metadata (token, action, tier, actor identity) rides entirely in
// dedicated headers, kept separate from the target route's own body shape
// so this client never has to know or care what any individual target
// route reads from its body.
export function callWriteBridgeInternalRoute({
  socketPath,
  method,
  path,
  action,
  tier,
  discordUserId,
  discordUsername,
  body,
  timeoutMs = boundedTimeoutMs(),
  requestImpl = httpRequest
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = requestImpl(
      {
        socketPath,
        path,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          [WRITE_BRIDGE_TOKEN_HEADER]: getWriteBridgeToken(),
          [WRITE_BRIDGE_ACTION_HEADER]: action,
          [WRITE_BRIDGE_TIER_HEADER]: tier,
          [WRITE_BRIDGE_ACTOR_USER_ID_HEADER]: discordUserId,
          // discordUsername is HMAC-integrity-protected (part of the signed
          // actor payload) but not shape-validated -- Discord display names
          // are user-settable content. Node's http.request already throws on
          // CR/LF in a header value, but relying on that as the only guard
          // (issue #1022, Security LOW) means a malformed username surfaces
          // as an opaque connection-error 503 instead of an honest rejection
          // at the point the bad value actually originated.
          [WRITE_BRIDGE_ACTOR_USERNAME_HEADER]: (discordUsername || "").replace(/[\r\n]/g, "")
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            // A non-JSON response from the real target route is treated as
            // an opaque body, not a client-side error -- the caller decides
            // what to do with a response it can't parse.
          }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    // [issue #1033] req.setTimeout only starts a timer -- it does not itself
    // abort anything, so it must be paired with an explicit destroy() on
    // fire or the socket (and the pending write's already-consumed nonce)
    // would hang forever with no bound.
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      const timeoutError = new Error(`write bridge internal request timed out after ${timeoutMs}ms`);
      req.destroy(timeoutError);
      reject(timeoutError);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end(payload);
  });
}
