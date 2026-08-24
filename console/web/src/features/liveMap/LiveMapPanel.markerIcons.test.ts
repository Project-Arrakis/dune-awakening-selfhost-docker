import { Car, Gem, Home, Landmark, MapPin, Package, Users, Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";
import { liveMapMarkerIcon } from "./LiveMapPanel";

describe("live map marker icons", () => {
  it("maps every known marker type to a distinct icon", () => {
    expect(liveMapMarkerIcon("player")).toBe(Users);
    expect(liveMapMarkerIcon("vehicle")).toBe(Car);
    expect(liveMapMarkerIcon("base")).toBe(Home);
    expect(liveMapMarkerIcon("storage")).toBe(Package);
    expect(liveMapMarkerIcon("service")).toBe(Wrench);
    expect(liveMapMarkerIcon("poi")).toBe(Landmark);
    expect(liveMapMarkerIcon("resource")).toBe(Gem);
  });

  it("is case-insensitive on the marker type", () => {
    expect(liveMapMarkerIcon("Player")).toBe(Users);
    expect(liveMapMarkerIcon("STORAGE")).toBe(Package);
  });

  it("falls back to a generic pin for any type not yet mapped (e.g. before issue #462 lands new backend types)", () => {
    expect(liveMapMarkerIcon("spice")).toBe(MapPin);
    expect(liveMapMarkerIcon("")).toBe(MapPin);
  });
});
