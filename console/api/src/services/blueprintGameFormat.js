const GRID_SIZE = 512;

const LEGACY_HEADINGS = Object.freeze({
  MTX_Neut_DesertMechanic_Foundation_Wedge: 180,
  MTX_Neut_DesertMechanic_Rooftop: 180,
  MTX_Neut_DesertMechanic_Rooftop_Corner: 90,
  MTX_Neut_DesertMechanic_Staircase: 180
});
const ATREIDES_HEADINGS = Object.freeze({
  Atreides_Outpost_Ramp: 180,
  Atreides_Outpost_Roof_Half: 180,
  Atreides_Outpost_Roof_Corner_Half: 180,
  Atreides_Outpost_Stairs: 180,
  Atreides_Outpost_Stairs_Half: 180
});
const ATREIDES_V6_HEADINGS = Object.freeze({
  ...ATREIDES_HEADINGS,
  Atreides_Outpost_Railing_Round_Corner: 180
});
const VERIFIED_V7_HEADINGS = Object.freeze({
  Atreides_Outpost_Ramp: 180,
  Atreides_Outpost_Roof_Half: 180,
  Atreides_Outpost_Stairs: 180,
  Atreides_Outpost_Stairs_Half: 180,
  Choam_Level2_Ramp_Half: 180
});

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isWedge(type) {
  const value = String(type || "");
  return /wedge/i.test(value) && /(foundation|floor|roof)/i.test(value);
}

function conventionVersion(value) {
  return Number(String(value).match(/^studio-v([1-8])$/)?.[1] || 8);
}

function nativeHeading(type, version) {
  if (version >= 8) return isWedge(type) ? 180 : 0;
  if (version === 7) return VERIFIED_V7_HEADINGS[type] || (isWedge(type) ? 180 : 0);
  if (version === 6) return ATREIDES_V6_HEADINGS[type] || (isWedge(type) ? 180 : 0);
  if (version >= 5) return isWedge(type) ? 180 : 0;
  if (version >= 4 && ATREIDES_HEADINGS[type]) return ATREIDES_HEADINGS[type];
  if (version === 2) return [
    "MTX_Neut_DesertMechanic_Foundation_Wedge",
    "MTX_Neut_DesertMechanic_Rooftop",
    "MTX_Neut_DesertMechanic_Rooftop_Corner"
  ].includes(type) ? 180 : 0;
  return LEGACY_HEADINGS[type] || 0;
}

function convertStructure(piece, version, originalConvention) {
  const offset = originalConvention === "studio-v1" ? 0 : nativeHeading(piece.building_type, version);
  const displayRotation = number(piece.rotation);
  const wedge = isWedge(piece.building_type);
  const gameYaw = wedge ? 180 - displayRotation : -displayRotation;
  if (wedge) {
    const angle = gameYaw * Math.PI / 180;
    const pivotOffset = GRID_SIZE * Math.sqrt(3) / 6;
    piece.x = number(piece.x) - Math.sin(angle) * pivotOffset;
    piece.y = number(piece.y) + Math.cos(angle) * pivotOffset;
  }
  piece.rotation = (wedge ? 180 - displayRotation : -displayRotation) - offset;
}

function repairLegacyPlaceableAxes(blueprint) {
  const rows = Array.isArray(blueprint.placeables) ? blueprint.placeables : [];
  const zero = value => Math.abs(number(value)) < 0.0001;
  const designer = blueprint.designer || {};
  const eligible = designer.imported === true || designer.coordinateConvention === "game-v1";
  if (eligible && designer.placeableRotationConvention !== "native-yaw-y" && rows.length
      && rows.every(piece => zero(piece.rx) && zero(piece.ry) && zero(piece.rotation))
      && rows.some(piece => !zero(piece.rz))) {
    for (const piece of rows) {
      piece.ry = number(piece.rz);
      piece.rz = 0;
      piece.rotation = piece.ry;
    }
  }
}

function reflectLegacyV9(blueprint) {
  for (const piece of blueprint.instances || []) {
    piece.y = -number(piece.y) || 0;
    piece.rotation = -number(piece.rotation) || 0;
  }
  for (const piece of blueprint.placeables || []) {
    piece.y = -number(piece.y) || 0;
    piece.rx = -number(piece.rx) || 0;
    piece.ry = -number(piece.ry ?? piece.rotation) || 0;
    piece.rotation = piece.ry;
  }
}

export function blueprintForGameDownload(source) {
  const blueprint = structuredClone(source || {});
  blueprint.instances = Array.isArray(blueprint.instances) ? blueprint.instances : [];
  blueprint.placeables = Array.isArray(blueprint.placeables) ? blueprint.placeables : [];
  const convention = blueprint.designer?.coordinateConvention;

  repairLegacyPlaceableAxes(blueprint);
  if (/^studio-v(?:[1-9]|10)$/.test(String(convention || ""))) {
    const version = conventionVersion(convention);
    for (const piece of blueprint.instances) convertStructure(piece, version, convention);
    if (convention === "studio-v9" && blueprint.designer?.imported === true) reflectLegacyV9(blueprint);
  }

  blueprint.designer = {
    ...(blueprint.designer || {}),
    coordinateConvention: "game-v1",
    placeableRotationConvention: "native-yaw-y"
  };
  return blueprint;
}
