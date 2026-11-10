import { describe, expect, it } from "vitest";
import { CITIES } from "../../src/simulator/cities.js";
import { generateWorld } from "../../src/simulator/world-gen.js";
import { TEST_HOTEL } from "../helpers.js";

describe("generateWorld", () => {
  it("is deterministic: same seed, same world", () => {
    expect(generateWorld({ seed: 4217 })).toEqual(generateWorld({ seed: 4217 }));
  });

  it("different seeds produce different worlds", () => {
    expect(generateWorld({ seed: 1 })).not.toEqual(generateWorld({ seed: 2 }));
  });

  it("generates hotels_per_city hotels for every city by default", () => {
    const w = generateWorld({ seed: 5, hotels_per_city: 4 });
    expect(w.hotels).toHaveLength(CITIES.length * 4);
    for (const c of CITIES) expect(w.hotels.filter((h) => h.city === c.code)).toHaveLength(4);
  });

  it("keeps one city stable when other cities are added (forked streams)", () => {
    const a = generateWorld({ seed: 8, generate_cities: ["LIS"] }).hotels;
    const b = generateWorld({ seed: 8, generate_cities: ["PAR", "LIS"] }).hotels.filter((h) => h.city === "LIS");
    expect(b).toEqual(a);
  });

  it("produces well-formed catalog data", () => {
    const w = generateWorld({ seed: 99 });
    const planIds = new Set<string>();
    for (const h of w.hotels) {
      expect(h.id).toMatch(/^H-[A-Z]{3}-\d{3}$/);
      expect(h.stars).toBeGreaterThanOrEqual(2);
      expect(h.stars).toBeLessThanOrEqual(5);
      expect(h.rooms.length).toBeGreaterThanOrEqual(2);
      for (const r of h.rooms) {
        expect(r.id.startsWith(`${h.id}-R`)).toBe(true);
        expect(r.plans.some((p) => p.code === "FLEX")).toBe(true);
        for (const p of r.plans) {
          expect(Number.isInteger(p.nightlyNetMinor)).toBe(true);
          expect(p.nightlyNetMinor).toBeGreaterThan(0);
          expect(p.refundable).toBe(p.freeCancelDaysBefore !== null);
          planIds.add(p.id);
        }
      }
    }
    expect(planIds.size).toBe(w.hotels.flatMap((h) => h.rooms.flatMap((r) => r.plans)).length);
  });

  it("adds hand-written hotels and prefixes their ids", () => {
    const w = generateWorld({ seed: 1, generate_cities: ["LIS"], hotels: [TEST_HOTEL] });
    const h = w.hotels.find((x) => x.id === "H-T-001")!;
    expect(h.currency).toBe("EUR");
    expect(h.taxPercent).toBe(6);
    expect(h.rooms[0]!.plans.map((p) => p.id)).toEqual(["H-T-001-R1-FLEX", "H-T-001-R1-NR"]);
    expect(h.rooms[0]!.plans[1]!.freeCancelDaysBefore).toBeNull();
  });

  it("lets hand-written hotels replace generated ones with the same id", () => {
    const w = generateWorld({ seed: 1, generate_cities: ["LIS"], hotels: [{ ...TEST_HOTEL, id: "H-LIS-001" }] });
    expect(w.hotels.filter((h) => h.id === "H-LIS-001")).toHaveLength(1);
    expect(w.hotels.find((h) => h.id === "H-LIS-001")!.name).toBe("Hotel Test Lisbon");
  });

  it("rejects unknown cities", () => {
    expect(() => generateWorld({ seed: 1, generate_cities: ["XXX"] })).toThrow(/unknown city/);
  });
});
