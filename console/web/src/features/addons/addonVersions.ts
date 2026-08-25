import type { CommunityAddonSummary, InstalledAddon } from "../../api/addons";

export function hasAddonUpdates(catalog: CommunityAddonSummary[], installed: InstalledAddon[]) {
  const catalogById = new Map(catalog.map((addon) => [addon.id, addon]));
  return installed.some((addon) => {
    const catalogAddon = catalogById.get(addon.id);
    return Boolean(catalogAddon && catalogAddon.lifecycle !== "removed" && addonUpdateAvailable(addon.version, catalogAddon.version));
  });
}

export function addonUpdateAvailable(installedVersion: string, catalogVersion: string) {
  try {
    return compareAddonVersions(catalogVersion, installedVersion) > 0;
  } catch {
    return false;
  }
}

export function compareAddonVersions(leftValue: string, rightValue: string) {
  const parse = (value: string) => {
    const match = String(value || "").trim().match(/^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
    if (!match) throw new Error("Invalid addon version");
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease: match[4] ? match[4].split(".") : [] };
  };
  const left = parse(leftValue);
  const right = parse(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart) > 0 ? 1 : -1;
  }
  return 0;
}
