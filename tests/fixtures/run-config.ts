import type { RunConfig } from "../../src/trace/types.js";
import { START, TEST_HOTEL } from "../helpers.js";

/** Small run: price of the double room jumps 18% at prebook; traveler accepts up to 230 EUR. */
export function testRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    scenario_id: "test-price-jump",
    scenario_version: 1,
    start_time: START,
    tick_s: 2,
    world: { seed: 1, hotels_per_city: 0, hotels: [TEST_HOTEL] },
    faults: [{ id: "jump", type: "price_change", where: { room_id: "H-T-001-R1" }, percent: 18 }],
    traveler: {
      request: "Double room in Lisbon, 2026-03-12 to 2026-03-14, 2 adults. Max 230 EUR total, refundable.",
      replies: [
        {
          intent: "price_consent",
          match: ["$price"],
          consent: { max_total: 230, accept: "Yes, go ahead.", refuse: "No, that's above 230 EUR." },
        },
        { intent: "bed_type", match: ["bed", "lit", "twin"], reply: "A double bed, please." },
      ],
    },
    ...overrides,
  };
}
