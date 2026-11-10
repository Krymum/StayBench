import { Rng } from "../core/rng.js";
import { CITIES, cityInfo, type CityInfo } from "./cities.js";
import type { BedType, Board, Hotel, HotelSpec, RatePlan, Room, World, WorldSpec } from "./types.js";

const NAME_PREFIX = ["Hotel", "Grand", "Casa", "The", "Maison", "Palazzo", "Residence", "Urban"];
const NAME_CORE = ["Aurora", "Riverside", "Central", "Lumen", "Harbor", "Meridian", "Olive", "Atlas", "Verde", "Solstice", "Belvedere", "Quartz"];

const ROOM_TEMPLATES: ReadonlyArray<{ name: string; bed: BedType; occ: number; factor: number }> = [
  { name: "Single Room", bed: "single", occ: 1, factor: 0.75 },
  { name: "Standard Double Room", bed: "double", occ: 2, factor: 1 },
  { name: "Standard Twin Room", bed: "twin", occ: 2, factor: 1 },
  { name: "Superior King Room", bed: "king", occ: 2, factor: 1.25 },
  { name: "Deluxe Double Room, City View", bed: "double", occ: 2, factor: 1.4 },
  { name: "Family Room", bed: "double", occ: 4, factor: 1.6 },
  { name: "Junior Suite", bed: "king", occ: 3, factor: 2 },
];

/** Nightly net price range in major units, by star rating. */
const BASE_BY_STARS: Record<number, [number, number]> = {
  2: [55, 85],
  3: [85, 135],
  4: [135, 220],
  5: [250, 420],
};

function genPlans(rng: Rng, roomId: string, baseMinor: number): RatePlan[] {
  const plans: RatePlan[] = [
    {
      id: `${roomId}-FLEX`,
      code: "FLEX",
      board: "room_only",
      nightlyNetMinor: baseMinor,
      refundable: true,
      freeCancelDaysBefore: rng.int(1, 7),
    },
  ];
  if (rng.chance(0.8)) {
    plans.push({
      id: `${roomId}-NR`,
      code: "NR",
      board: "room_only",
      nightlyNetMinor: Math.round(baseMinor * (1 - rng.int(10, 20) / 100)),
      refundable: false,
      freeCancelDaysBefore: null,
    });
  }
  if (rng.chance(0.5)) {
    plans.push({
      id: `${roomId}-BB`,
      code: "BB",
      board: "breakfast",
      nightlyNetMinor: baseMinor + rng.int(12, 30) * 100,
      refundable: true,
      freeCancelDaysBefore: rng.int(1, 3),
    });
  }
  return plans;
}

function genHotel(rng: Rng, city: CityInfo, index: number): Hotel {
  const id = `H-${city.code}-${String(index).padStart(3, "0")}`;
  const stars = rng.int(2, 5);
  const [lo, hi] = BASE_BY_STARS[stars] as [number, number];
  const base = rng.int(lo, hi);
  const templates = rng.shuffle(ROOM_TEMPLATES).slice(0, rng.int(2, 4));
  const rooms: Room[] = templates.map((t, i) => {
    const roomId = `${id}-R${i + 1}`;
    return {
      id: roomId,
      name: t.name,
      bedType: t.bed,
      maxOccupancy: t.occ,
      plans: genPlans(rng, roomId, Math.round(base * t.factor) * 100),
    };
  });
  return {
    id,
    name: `${rng.pick(NAME_PREFIX)} ${rng.pick(NAME_CORE)} ${city.name}`,
    city: city.code,
    district: rng.pick(city.districts),
    stars,
    currency: city.currency,
    taxPercent: city.taxPercent,
    rooms,
  };
}

export function hotelFromSpec(spec: HotelSpec): Hotel {
  const city = cityInfo(spec.city);
  const currency = spec.currency ?? city?.currency;
  if (!currency) throw new Error(`Hotel ${spec.id}: unknown city "${spec.city}" and no currency given`);
  return {
    id: spec.id,
    name: spec.name,
    city: spec.city,
    district: spec.district ?? city?.districts[0] ?? "Center",
    stars: spec.stars,
    currency,
    taxPercent: spec.tax_percent ?? city?.taxPercent ?? 0,
    rooms: spec.rooms.map((r) => {
      const roomId = `${spec.id}-${r.id}`;
      return {
        id: roomId,
        name: r.name,
        bedType: r.bed_type,
        maxOccupancy: r.max_occupancy,
        plans: r.plans.map((p) => ({
          id: `${roomId}-${p.code}`,
          code: p.code,
          board: (p.board ?? "room_only") as Board,
          nightlyNetMinor: Math.round(p.nightly_net * 100),
          refundable: p.refundable,
          freeCancelDaysBefore: p.refundable ? (p.free_cancel_days_before ?? 1) : null,
          ...(p.available_rooms !== undefined ? { availableRooms: p.available_rooms } : {}),
        })),
      };
    }),
  };
}

/**
 * Builds the world from a spec. Each city draws from its own RNG stream forked from the
 * seed, so changing one city's settings never reshuffles another city.
 */
export function generateWorld(spec: WorldSpec): World {
  const root = new Rng(spec.seed);
  const perCity = spec.hotels_per_city ?? 6;
  const cities = spec.generate_cities
    ? spec.generate_cities.map((code) => {
        const c = cityInfo(code);
        if (!c) throw new Error(`generateWorld: unknown city "${code}"`);
        return c;
      })
    : CITIES;

  const byId = new Map<string, Hotel>();
  for (const city of cities) {
    const rng = root.fork(`city:${city.code}`);
    for (let i = 1; i <= perCity; i++) {
      const h = genHotel(rng, city, i);
      byId.set(h.id, h);
    }
  }
  for (const hotelSpec of spec.hotels ?? []) {
    byId.set(hotelSpec.id, hotelFromSpec(hotelSpec));
  }

  const hotels = [...byId.values()];
  const planIds = new Set<string>();
  for (const h of hotels) {
    for (const r of h.rooms) {
      for (const p of r.plans) {
        if (planIds.has(p.id)) throw new Error(`generateWorld: duplicate rate plan id "${p.id}"`);
        planIds.add(p.id);
      }
    }
  }
  return { seed: spec.seed, hotels };
}
