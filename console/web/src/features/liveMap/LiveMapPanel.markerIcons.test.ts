import { Car, Gem, Home, Landmark, MapPin, Package, Sparkles, Users, Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";
import { liveMapMarkerIcon } from "./LiveMapPanel";
import { CaveIcon, EcolabIcon, FlourSandIcon, ShipwreckIcon, TaxiServiceIcon } from "./resourceIcons";

describe("live map marker icons", () => {
  it("maps every known marker category to a distinct icon", () => {
    expect(liveMapMarkerIcon("player")).toBe(Users);
    expect(liveMapMarkerIcon("vehicle")).toBe(Car);
    expect(liveMapMarkerIcon("base")).toBe(Home);
    expect(liveMapMarkerIcon("storage")).toBe(Package);
    expect(liveMapMarkerIcon("service")).toBe(Wrench);
    expect(liveMapMarkerIcon("poi")).toBe(Landmark);
    expect(liveMapMarkerIcon("resource")).toBe(Gem);
  });

  it("is case-insensitive on the marker category", () => {
    expect(liveMapMarkerIcon("Player")).toBe(Users);
    expect(liveMapMarkerIcon("STORAGE")).toBe(Package);
  });

  it("falls back to a generic pin for any category not yet mapped", () => {
    expect(liveMapMarkerIcon("spice")).toBe(MapPin);
    expect(liveMapMarkerIcon("")).toBe(MapPin);
  });

  // Confirmed live on Deep Desert (dune-dev): before this, every poi and
  // every resource pin rendered with the same one or two category icons
  // above, because marker.name was never consulted. These are Deep
  // Desert's actual real marker names (issue #462). Cave/Ecolab/Shipwreck/
  // TaxiService/Flour Sand use real game-icons.net icons (CC-BY 3.0, see
  // NOTICE); Spice keeps the generic lucide Sparkles (no game-icons.net
  // equivalent worth forcing a fit for).
  it("distinguishes specific poi/resource kinds by name instead of sharing one icon per category", () => {
    expect(liveMapMarkerIcon("poi", "Cave")).toBe(CaveIcon);
    expect(liveMapMarkerIcon("poi", "Ecolab")).toBe(EcolabIcon);
    expect(liveMapMarkerIcon("poi", "Shipwreck")).toBe(ShipwreckIcon);
    expect(liveMapMarkerIcon("poi", "TaxiService")).toBe(TaxiServiceIcon);
    expect(liveMapMarkerIcon("resource", "Spice")).toBe(Sparkles);
    expect(liveMapMarkerIcon("resource", "Flour Sand")).toBe(FlourSandIcon);
  });

  it("is case-insensitive on the marker name", () => {
    expect(liveMapMarkerIcon("poi", "cave")).toBe(CaveIcon);
    expect(liveMapMarkerIcon("resource", "FLOUR SAND")).toBe(FlourSandIcon);
  });

  it("falls back to the category icon for a poi/resource name it doesn't recognize", () => {
    expect(liveMapMarkerIcon("poi", "SomeFutureStructure")).toBe(Landmark);
    expect(liveMapMarkerIcon("resource", "SomeFutureOre")).toBe(Gem);
  });
});
