import type { Currency } from "../core/money.js";

export interface CityInfo {
  code: string;
  name: string;
  currency: Currency;
  taxPercent: number;
  districts: string[];
}

/** Fictional-but-plausible tax rates; not a statement about real-world taxation. */
export const CITIES: readonly CityInfo[] = [
  { code: "LIS", name: "Lisbon", currency: "EUR", taxPercent: 6, districts: ["Baixa", "Chiado", "Alfama", "Avenida", "Belem"] },
  { code: "PAR", name: "Paris", currency: "EUR", taxPercent: 10, districts: ["Marais", "Opera", "Montmartre", "Bastille", "Saint-Germain"] },
  { code: "BCN", name: "Barcelona", currency: "EUR", taxPercent: 10, districts: ["Eixample", "Gracia", "Born", "Barceloneta", "Raval"] },
  { code: "ROM", name: "Rome", currency: "EUR", taxPercent: 10, districts: ["Trastevere", "Monti", "Prati", "Termini", "Centro Storico"] },
  { code: "BER", name: "Berlin", currency: "EUR", taxPercent: 7, districts: ["Mitte", "Kreuzberg", "Prenzlauer Berg", "Charlottenburg"] },
  { code: "LON", name: "London", currency: "GBP", taxPercent: 20, districts: ["Soho", "Kensington", "Shoreditch", "Southwark", "Camden"] },
  { code: "NYC", name: "New York", currency: "USD", taxPercent: 14.75, districts: ["Midtown", "SoHo", "Chelsea", "Upper West Side"] },
  { code: "ZRH", name: "Zurich", currency: "CHF", taxPercent: 8, districts: ["Altstadt", "Enge", "Seefeld", "Kreis 5"] },
];

export function cityInfo(code: string): CityInfo | undefined {
  return CITIES.find((c) => c.code === code);
}
