import { describe, expect, it } from "vitest";
import { changedKeys, isModifiedFromDefault, modifiedSettingsFields, valuesForDirtyFields } from "./MapsPanel";
import type { UserSettingField } from "../../api/maps";

function field(id: string, type: UserSettingField["type"], defaultValue: string): UserSettingField {
  return { scope: "engine", id, section: "ConsoleVariables", key: id, default: defaultValue, type, clientFile: "", category: "", description: "" };
}

// Hydration.SunExposureEnabled renders as a True/False select but persists as 1/0,
// so the raw string compare used to flag it dirty on every interaction -- and
// saving UserEngine restarts the maps.
const sunExposure = field("sun_exposure_enabled", "boolean", "1");
const bloodDoors = field("blood_doors_enabled", "boolean", "True");
const dangerZones = field("sandworm_danger_zones_enabled", "boolean", "true");
const maxVehicles = field("vehicle_max_per_player", "integer", "10");

describe("settings dirty tracking", () => {
  it("does not flag a numeric-boolean field when the select re-emits the value it already has", () => {
    // stored "1", user re-picks "True" (or toggles to False and back)
    expect(changedKeys({ sun_exposure_enabled: "1" }, { sun_exposure_enabled: "True" }, [sunExposure])).toEqual([]);
    expect(changedKeys({ sun_exposure_enabled: "0" }, { sun_exposure_enabled: "False" }, [sunExposure])).toEqual([]);
  });

  it("still flags a real change to a numeric-boolean field", () => {
    expect(changedKeys({ sun_exposure_enabled: "1" }, { sun_exposure_enabled: "False" }, [sunExposure])).toEqual(["sun_exposure_enabled"]);
    expect(changedKeys({ sun_exposure_enabled: "0" }, { sun_exposure_enabled: "True" }, [sunExposure])).toEqual(["sun_exposure_enabled"]);
  });

  it("ignores case differences for lowercase-persisted booleans", () => {
    expect(changedKeys({ sandworm_danger_zones_enabled: "true" }, { sandworm_danger_zones_enabled: "True" }, [dangerZones])).toEqual([]);
    expect(changedKeys({ sandworm_danger_zones_enabled: "true" }, { sandworm_danger_zones_enabled: "False" }, [dangerZones])).toEqual(["sandworm_danger_zones_enabled"]);
  });

  it("treats an unset value as a change once the user picks one", () => {
    expect(changedKeys({}, { blood_doors_enabled: "False" }, [bloodDoors])).toEqual(["blood_doors_enabled"]);
  });

  it("leaves non-boolean fields on an exact string compare", () => {
    expect(changedKeys({ vehicle_max_per_player: "10" }, { vehicle_max_per_player: "10" }, [maxVehicles])).toEqual([]);
    expect(changedKeys({ vehicle_max_per_player: "10" }, { vehicle_max_per_player: "25" }, [maxVehicles])).toEqual(["vehicle_max_per_player"]);
  });

  it("keeps the save payload in sync with the dirty check", () => {
    expect(valuesForDirtyFields({ sun_exposure_enabled: "1" }, { sun_exposure_enabled: "True" }, [sunExposure])).toEqual({});
    expect(valuesForDirtyFields({ sun_exposure_enabled: "1" }, { sun_exposure_enabled: "False" }, [sunExposure])).toEqual({ sun_exposure_enabled: "False" });
  });
});

describe("Modified badge", () => {
  it("flags a value that differs from the schema default", () => {
    expect(isModifiedFromDefault(maxVehicles, "25")).toBe(true);
    expect(isModifiedFromDefault(sunExposure, "False")).toBe(true);
    expect(isModifiedFromDefault(sunExposure, "0")).toBe(true);
  });

  it("does not flag a value equal to the default", () => {
    expect(isModifiedFromDefault(maxVehicles, "10")).toBe(false);
    expect(isModifiedFromDefault(bloodDoors, "True")).toBe(false);
  });

  it("does not flag a numeric-boolean default shown through the True/False select", () => {
    // default "1" rendered as "True" must not read as modified
    expect(isModifiedFromDefault(sunExposure, "True")).toBe(false);
    expect(isModifiedFromDefault(dangerZones, "True")).toBe(false);
  });
});

describe("Modified category", () => {
  const fields = [maxVehicles, sunExposure, bloodDoors];

  it("is empty when every value matches its default", () => {
    expect(modifiedSettingsFields(fields, {}, {})).toEqual([]);
    expect(modifiedSettingsFields(fields, { vehicle_max_per_player: "10" }, { vehicle_max_per_player: "10" })).toEqual([]);
  });

  it("lists saved overrides and unsaved draft changes together", () => {
    const saved = { vehicle_max_per_player: "25" };
    const draft = { vehicle_max_per_player: "25", blood_doors_enabled: "False" };
    expect(modifiedSettingsFields(fields, saved, draft).map((field) => field.id)).toEqual(["vehicle_max_per_player", "blood_doors_enabled"]);
  });

  it("keeps a saved override listed while it is being edited back to the default", () => {
    // Typing "10" over "25" passes through the default on the last keystroke; the
    // row must not disappear out from under the cursor.
    const saved = { vehicle_max_per_player: "25" };
    expect(modifiedSettingsFields(fields, saved, { vehicle_max_per_player: "10" }).map((field) => field.id)).toEqual(["vehicle_max_per_player"]);
    // ...but a save settles it back out of the category.
    expect(modifiedSettingsFields(fields, { vehicle_max_per_player: "10" }, { vehicle_max_per_player: "10" })).toEqual([]);
  });

  it("does not list a numeric-boolean default rendered through the True/False select", () => {
    expect(modifiedSettingsFields(fields, { sun_exposure_enabled: "1" }, { sun_exposure_enabled: "True" })).toEqual([]);
    expect(modifiedSettingsFields(fields, { sun_exposure_enabled: "1" }, { sun_exposure_enabled: "False" }).map((field) => field.id)).toEqual(["sun_exposure_enabled"]);
  });
});
