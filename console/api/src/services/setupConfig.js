export const SETUP_CONFIG_KEYS = Object.freeze([
  "SERVER_IP",
  "SERVER_IP_MODE",
  "SERVER_TITLE",
  "SERVER_REGION",
  "HOST_DATACENTER_ID",
  "SERVER_PROVIDER",
  "STEAM_APP_ID",
  "BATTLEGROUP_ID"
]);

const HOST_DATACENTER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function validHostDatacenterId(value) {
  const normalized = String(value ?? "");
  return normalized.length >= 1
    && normalized.length <= 253
    && HOST_DATACENTER_ID_PATTERN.test(normalized);
}
