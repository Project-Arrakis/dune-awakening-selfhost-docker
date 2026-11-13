// Armour dye swatches of the in-game Houses, from the community wiki data module
// https://awakening.wiki/Module:Swatches/data (colour values only). Four colours per House,
// in the game's own slot order. themeEngine derives a dark console palette from them.
export interface HouseSwatch { id: string; name: string; colors: readonly [string, string, string, string]; }

export const HOUSE_SWATCHES: readonly HouseSwatch[] = [
  { id: "house-atreides", name: "House Atreides", colors: ["#313f29", "#959595", "#849141", "#bcab95"] },
  { id: "house-harkonnen", name: "House Harkonnen", colors: ["#2b2b2b", "#3f3f3f", "#7c383d", "#2b2b2b"] },
  { id: "house-alexin", name: "House Alexin", colors: ["#593730", "#bcab95", "#d2a552", "#959595"] },
  { id: "house-argosaz", name: "House Argosaz", colors: ["#2b271d", "#896b36", "#c48642", "#896b36"] },
  { id: "house-dyvetz", name: "House Dyvetz", colors: ["#505522", "#3f3f3f", "#bc766c", "#5c707c"] },
  { id: "house-ecaz", name: "House Ecaz", colors: ["#364b2b", "#bcab95", "#d2a552", "#bcab95"] },
  { id: "house-hagal", name: "House Hagal", colors: ["#345259", "#6c5a57", "#004d59", "#2b2b2b"] },
  { id: "house-hurata", name: "House Hurata", colors: ["#534c43", "#2f3f26", "#a2aa50", "#2b2b2b"] },
  { id: "house-imota", name: "House Imota", colors: ["#591a19", "#591a19", "#7cb8c9", "#3f3f3f"] },
  { id: "house-kenola", name: "House Kenola", colors: ["#5c707c", "#706f7c", "#cccccc", "#959595"] },
  { id: "house-lindaren", name: "House Lindaren", colors: ["#303859", "#3f3f3f", "#303859", "#2b2b2b"] },
  { id: "house-maros", name: "House Maros", colors: ["#896b36", "#2b2b2b", "#2b2b2b", "#896b36"] },
  { id: "house-mikarrol", name: "House Mikarrol", colors: ["#959595", "#3f3f3f", "#bc6c91", "#6c5a57"] },
  { id: "house-moritani", name: "House Moritani", colors: ["#2b2b2b", "#3f3f3f", "#d2a552", "#a39964"] },
  { id: "house-mutelli", name: "House Mutelli", colors: ["#592626", "#3f3f3f", "#cccccc", "#d5a38d"] },
  { id: "house-novebruns", name: "House Novebruns", colors: ["#3f2632", "#2b2b2b", "#955c30", "#cccccc"] },
  { id: "house-richese", name: "House Richese", colors: ["#3f3f3f", "#959595", "#7cb8c9", "#d88746"] },
  { id: "house-sor", name: "House Sor", colors: ["#6c5a57", "#6c5a57", "#953030", "#592626"] },
  { id: "house-spinnette", name: "House Spinnette", colors: ["#4d2b0c", "#2b1604", "#cccccc", "#cccccc"] },
  { id: "house-taligari", name: "House Taligari", colors: ["#1d302d", "#bcab95", "#54958b", "#a39964"] },
  { id: "house-thorvald", name: "House Thorvald", colors: ["#c48642", "#d2a552", "#2b2b2b", "#4b4079"] },
  { id: "house-tseida", name: "House Tseida", colors: ["#7c5b20", "#6c5a57", "#d2a552", "#6c5a57"] },
  { id: "house-varota", name: "House Varota", colors: ["#4d2b0c", "#303859", "#303859", "#6c5a57"] },
  { id: "house-vernius", name: "House Vernius", colors: ["#45203a", "#955c30", "#5c507c", "#2b2b2b"] },
  { id: "house-wallach", name: "House Wallach", colors: ["#959595", "#593730", "#953030", "#303859"] },
  { id: "house-wayku", name: "House Wayku", colors: ["#29304d", "#959595", "#953030", "#cccccc"] },
  { id: "house-wydras", name: "House Wydras", colors: ["#546c5b", "#bcab95", "#507c50", "#2b2b2b"] },
];
