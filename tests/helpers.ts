import { VirtualClock } from "../src/core/clock.js";
import type { FaultSpec } from "../src/faults/types.js";
import { HotelProvider } from "../src/simulator/provider.js";
import type { HotelSpec } from "../src/simulator/types.js";
import { generateWorld } from "../src/simulator/world-gen.js";

export const START = "2026-02-01T09:00:00Z";
export const STAY = { check_in: "2026-03-12", check_out: "2026-03-14", adults: 2 } as const;

/** Small hand-written Lisbon hotel (tax 6%). FLEX double: 2 x 100 net = 200 + 12 tax = 212.00 EUR. */
export const TEST_HOTEL: HotelSpec = {
  id: "H-T-001",
  name: "Hotel Test Lisbon",
  city: "LIS",
  stars: 4,
  rooms: [
    {
      id: "R1",
      name: "Standard Double Room",
      bed_type: "double",
      max_occupancy: 2,
      plans: [
        { code: "FLEX", nightly_net: 100, refundable: true, free_cancel_days_before: 3 },
        { code: "NR", nightly_net: 85, refundable: false },
      ],
    },
    {
      id: "R2",
      name: "Standard Twin Room",
      bed_type: "twin",
      max_occupancy: 2,
      plans: [{ code: "FLEX", nightly_net: 110, refundable: true, free_cancel_days_before: 1 }],
    },
  ],
};

export const FLEX = "H-T-001-R1-FLEX~2026-03-12~2026-03-14~2";
export const NR = "H-T-001-R1-NR~2026-03-12~2026-03-14~2";
export const TWIN = "H-T-001-R2-FLEX~2026-03-12~2026-03-14~2";

export function setup(faults: FaultSpec[] = [], hotels: HotelSpec[] = [TEST_HOTEL]) {
  const clock = new VirtualClock(START);
  const world = generateWorld({ seed: 1, hotels_per_city: 0, hotels });
  const provider = new HotelProvider({ world, faults, clock });
  return { clock, provider };
}

/** Unwraps a successful result or throws with the error, for terse tests. */
export function must<T>(r: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data;
}

export function errCode(r: { ok: boolean; error?: { code: string } }): string | undefined {
  return r.ok ? undefined : r.error?.code;
}
