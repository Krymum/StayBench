import type { Clock } from "../core/clock.js";
import { daysBefore, isIsoDate, nightsBetween } from "../core/dates.js";
import { applyPercent, percentOf, toMajor, type Currency } from "../core/money.js";
import { FaultEngine } from "../faults/engine.js";
import type { FaultSpec, ProviderTool, Target } from "../faults/types.js";
import { fail, ok, type BedType, type Board, type Hotel, type RatePlan, type Result, type Room, type World } from "./types.js";

export const PREBOOK_TTL_S = 900;
export const MAX_NIGHTS = 30;
export const MAX_ROOMS = 4;

// ---------------------------------------------------------------------------
// Agent-facing payloads (snake_case, decimal amounts)
// ---------------------------------------------------------------------------

export interface StayQuery {
  check_in: string;
  check_out: string;
  /** Adults per room. */
  adults: number;
  /** Number of identical rooms. Default 1. */
  rooms?: number;
}

export interface SearchHotelsArgs extends StayQuery {
  city: string;
}

export interface GetRatesArgs extends StayQuery {
  hotel_id: string;
}

export interface HotelSummary {
  hotel_id: string;
  name: string;
  city: string;
  district: string;
  stars: number;
  from_price: number;
  currency: Currency;
  taxes_included: boolean;
}

export interface RateView {
  rate_id: string;
  board: Board;
  total_price: number;
  currency: Currency;
  taxes_included: boolean;
  /** Label as shown by the provider. May be wrong; see get_cancellation_policy. */
  refundable: boolean;
  /** Rooms still available at this rate, only when the supplier limits them. */
  rooms_left?: number;
}

export interface RoomView {
  room_id: string;
  name: string;
  bed_type: BedType;
  max_occupancy: number;
  rates: RateView[];
}

export interface RatesView {
  hotel_id: string;
  hotel_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  currency: Currency;
  /** Number of rooms the prices are for, only when more than 1. */
  rooms_requested?: number;
  rooms: RoomView[];
}

export interface PolicyView {
  rate_id: string;
  refundable: boolean;
  free_cancellation_until: string | null;
  penalty: string;
}

export interface PrebookView {
  prebook_id: string;
  rate_id: string;
  hotel_id: string;
  room_id: string;
  total_price: number;
  taxes: number;
  currency: Currency;
  taxes_included: true;
  price_changed: boolean;
  previous_price?: number;
  expires_at: string;
  /** Number of rooms, only when more than 1. */
  rooms?: number;
  /** Present only when the cancellation terms changed at prebook. */
  policy_changed?: true;
  refundable?: boolean;
  free_cancellation_until?: string | null;
  /** Mandatory fees paid at the hotel, not included in total_price. Present only when > 0. */
  pay_at_property?: PayAtProperty;
}

export interface PayAtProperty {
  amount: number;
  currency: Currency;
  description: string;
}

export type BookingStatus = "confirmed" | "pending" | "rejected" | "cancelled";

export interface BookingView {
  booking_id: string;
  client_reference: string;
  status: BookingStatus;
  hotel_id: string;
  hotel_name: string;
  room_id: string;
  room_name: string;
  rate_id: string;
  check_in: string;
  check_out: string;
  adults: number;
  /** Number of rooms, only when more than 1. */
  rooms?: number;
  guest_name: string;
  total_price: number;
  /** Mandatory fees paid at the hotel, not included in total_price. Present only when > 0. */
  pay_at_property?: PayAtProperty;
  currency: Currency;
  refundable: boolean;
  free_cancellation_until: string | null;
  created_at: string;
}

export interface BookArgs {
  prebook_id: string;
  client_reference: string;
  guest_name: string;
}

export interface GetBookingArgs {
  booking_id?: string;
  client_reference?: string;
}

export interface CancelView {
  booking_id: string;
  status: "cancelled";
  refund_amount: number;
  currency: Currency;
}

// ---------------------------------------------------------------------------
// Internal records (ground truth for the grader)
// ---------------------------------------------------------------------------

interface ResolvedRate {
  rateId: string;
  hotel: Hotel;
  room: Room;
  plan: RatePlan;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  nights: number;
}

export interface PrebookRecord {
  prebook_id: string;
  rate_id: string;
  created_at: string;
  expires_at_ms: number;
  /** Total (incl. taxes) before any price change. */
  original_total_minor: number;
  total_minor: number;
  taxes_minor: number;
  currency: Currency;
  used: boolean;
}

export interface BookingRecord {
  booking_id: string;
  client_reference: string;
  status: BookingStatus;
  prebook_id: string;
  rate_id: string;
  hotel_id: string;
  room_id: string;
  plan_id: string;
  check_in: string;
  check_out: string;
  adults: number;
  rooms: number;
  guest_name: string;
  total_minor: number;
  /** Mandatory fees paid at the hotel, in minor units (0 when none). */
  pay_at_property_minor: number;
  currency: Currency;
  refundable: boolean;
  free_cancellation_until: string | null;
  created_at: string;
  /** Set when the booking was created although the agent received an error (ghost booking). */
  created_despite_error?: string;
  /** Pending resolution, for on-request bookings. */
  resolve_at_ms?: number;
  resolve_outcome?: "confirmed" | "rejected";
  cancelled_at?: string;
  refund_minor?: number;
}

export interface ProviderOptions {
  /** Build it with generateWorld(spec). */
  world: World;
  faults?: readonly FaultSpec[];
  clock: Clock;
}

const RATE_SEP = "~";

/** Stay-specific rate id. The rooms suffix only appears for more than one room, so single-room ids never change. */
export function makeRateId(planId: string, q: StayQuery): string {
  const parts = [planId, q.check_in, q.check_out, String(q.adults)];
  if ((q.rooms ?? 1) > 1) parts.push(String(q.rooms));
  return parts.join(RATE_SEP);
}

/**
 * In-memory fake hotel supplier. Deterministic: given the same world, faults and call
 * sequence (with the same clock), it returns exactly the same responses.
 */
export class HotelProvider {
  readonly world: World;
  readonly faults: FaultEngine;
  private readonly clock: Clock;
  private readonly hotels = new Map<string, Hotel>();
  private readonly plans = new Map<string, { hotel: Hotel; room: Room; plan: RatePlan }>();
  private readonly prebooks = new Map<string, PrebookRecord>();
  private readonly bookings = new Map<string, BookingRecord>();
  /** Sticky state set by faults, keyed by rate id. */
  private readonly priceChanges = new Map<string, number[]>();
  private readonly soldOut = new Set<string>();
  /** Rate ids whose cancellation terms changed to non-refundable at prebook. */
  private readonly policyChanged = new Set<string>();
  private prebookSeq = 0;
  private bookingSeq = 0;

  constructor(opts: ProviderOptions) {
    this.world = opts.world;
    this.clock = opts.clock;
    this.faults = new FaultEngine(opts.faults ?? [], opts.clock);
    for (const h of this.world.hotels) {
      this.hotels.set(h.id, h);
      for (const r of h.rooms) for (const p of r.plans) this.plans.set(p.id, { hotel: h, room: r, plan: p });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private today(): string {
    return this.clock.nowIso().slice(0, 10);
  }

  private validateStay(q: StayQuery): Result<number> {
    if (!isIsoDate(q.check_in) || !isIsoDate(q.check_out)) {
      return fail("INVALID_REQUEST", "check_in and check_out must be valid dates (YYYY-MM-DD).");
    }
    const nights = nightsBetween(q.check_in, q.check_out);
    if (nights < 1) return fail("INVALID_REQUEST", "check_out must be after check_in.");
    if (nights > MAX_NIGHTS) return fail("INVALID_REQUEST", `Stays longer than ${MAX_NIGHTS} nights are not supported.`);
    if (q.check_in < this.today()) return fail("INVALID_REQUEST", `check_in is in the past (today is ${this.today()}).`);
    if (!Number.isInteger(q.adults) || q.adults < 1 || q.adults > 8) {
      return fail("INVALID_REQUEST", "adults must be an integer between 1 and 8.");
    }
    const rooms = q.rooms ?? 1;
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS) {
      return fail("INVALID_REQUEST", "rooms must be an integer between 1 and " + MAX_ROOMS + ".");
    }
    return ok(nights);
  }

  private resolveRate(rateId: string): Result<ResolvedRate> {
    const parts = rateId.split(RATE_SEP);
    if (parts.length !== 4 && parts.length !== 5) return fail("NOT_FOUND", `Unknown rate_id "${rateId}".`);
    const [planId, checkIn, checkOut, adultsStr, roomsStr] = parts as [string, string, string, string, string?];
    const entry = this.plans.get(planId);
    const isInt = (v: string) => /^\d+$/.test(v);
    // Canonical form only: a rooms suffix must be present for 2+ rooms and absent for 1.
    if (!entry || !isInt(adultsStr) || (roomsStr !== undefined && (!isInt(roomsStr) || Number(roomsStr) < 2))) {
      return fail("NOT_FOUND", `Unknown rate_id "${rateId}".`);
    }
    const q = { check_in: checkIn, check_out: checkOut, adults: Number(adultsStr), rooms: roomsStr === undefined ? 1 : Number(roomsStr) };
    const stay = this.validateStay(q);
    if (!stay.ok) return stay;
    if (q.adults > entry.room.maxOccupancy) return fail("NOT_FOUND", `Unknown rate_id "${rateId}".`);
    return ok({ rateId, ...entry, checkIn, checkOut, adults: q.adults, rooms: q.rooms, nights: stay.data });
  }

  private target(r: { hotel: Hotel; room?: Room; plan?: RatePlan }): Target {
    return { hotel_id: r.hotel.id, room_id: r.room?.id, plan_id: r.plan?.id };
  }

  /** Price for a stay, in minor units. `adjusted` applies sticky price changes. */
  private price(r: ResolvedRate, adjusted: boolean): { net: number; taxes: number; total: number } {
    let net = r.plan.nightlyNetMinor * r.nights * r.rooms;
    if (adjusted) for (const pct of this.priceChanges.get(r.rateId) ?? []) net = applyPercent(net, pct);
    const taxes = percentOf(net, r.hotel.taxPercent);
    return { net, taxes, total: net + taxes };
  }

  /** What search/get_rates display. Stale by design: ignores price changes discovered at prebook. */
  private displayed(r: ResolvedRate): { amount: number; taxesIncluded: boolean } {
    const p = this.price(r, false);
    const excluded = this.faults.active("taxes_excluded", this.target(r)) !== undefined;
    return excluded ? { amount: p.net, taxesIncluded: false } : { amount: p.total, taxesIncluded: true };
  }

  /** Rooms still available for a plan, or undefined when the supplier does not limit them. */
  private roomsLeft(plan: RatePlan): number | undefined {
    if (plan.availableRooms === undefined) return undefined;
    let used = 0;
    for (const b of this.bookings.values()) {
      if (b.plan_id === plan.id && (b.status === "confirmed" || b.status === "pending")) used += b.rooms;
    }
    return Math.max(0, plan.availableRooms - used);
  }

  private notEnoughRooms(r: ResolvedRate): Result<never> | undefined {
    const left = this.roomsLeft(r.plan);
    if (left !== undefined && r.rooms > left) {
      return fail("NOT_ENOUGH_ROOMS", "Only " + left + " room(s) left at this rate, " + r.rooms + " requested.");
    }
    return undefined;
  }

  private deadline(plan: RatePlan, checkIn: string): string | null {
    return plan.refundable && plan.freeCancelDaysBefore !== null ? daysBefore(checkIn, plan.freeCancelDaysBefore) : null;
  }

  /** Current cancellation terms of a rate, including changes made at prebook. */
  private terms(r: ResolvedRate): { refundable: boolean; until: string | null } {
    if (this.policyChanged.has(r.rateId)) return { refundable: false, until: null };
    return { refundable: r.plan.refundable, until: this.deadline(r.plan, r.checkIn) };
  }

  private payAtPropertyMinor(r: ResolvedRate): number {
    return (r.plan.payAtPropertyPerNightMinor ?? 0) * r.nights * r.rooms;
  }

  private payAtPropertyView(minor: number, currency: Currency): PayAtProperty {
    return { amount: toMajor(minor), currency, description: "Mandatory city tax, paid at the hotel. Not included in total_price." };
  }

  private gate(tool: ProviderTool): Result<void> {
    const wait = this.faults.rateLimit(tool);
    if (wait !== undefined) {
      return fail("RATE_LIMITED", `Too many requests. Retry after ${wait} seconds.`, { retry_after_s: wait });
    }
    return ok(undefined);
  }

  private injectedError(tool: ProviderTool, target: Target) {
    return this.faults.fire("error", tool, target, (f) => f.on === tool, (f) => ({ code: f.code }));
  }

  private resolvePending(): void {
    const now = this.clock.now();
    for (const b of this.bookings.values()) {
      if (b.status === "pending" && b.resolve_at_ms !== undefined && now >= b.resolve_at_ms) {
        b.status = b.resolve_outcome ?? "confirmed";
      }
    }
  }

  private bookingView(b: BookingRecord): BookingView {
    const entry = this.plans.get(b.plan_id)!;
    return {
      booking_id: b.booking_id,
      client_reference: b.client_reference,
      status: b.status,
      hotel_id: b.hotel_id,
      hotel_name: entry.hotel.name,
      room_id: b.room_id,
      room_name: entry.room.name,
      rate_id: b.rate_id,
      check_in: b.check_in,
      check_out: b.check_out,
      adults: b.adults,
      ...(b.rooms > 1 ? { rooms: b.rooms } : {}),
      guest_name: b.guest_name,
      total_price: toMajor(b.total_minor),
      ...(b.pay_at_property_minor > 0 ? { pay_at_property: this.payAtPropertyView(b.pay_at_property_minor, b.currency) } : {}),
      currency: b.currency,
      refundable: b.refundable,
      free_cancellation_until: b.free_cancellation_until,
      created_at: b.created_at,
    };
  }

  // -------------------------------------------------------------------------
  // Provider operations
  // -------------------------------------------------------------------------

  searchHotels(args: SearchHotelsArgs): Result<{ hotels: HotelSummary[] }> {
    this.resolvePending();
    const g = this.gate("search_hotels");
    if (!g.ok) return g;
    const err = this.injectedError("search_hotels", {});
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    const stay = this.validateStay(args);
    if (!stay.ok) return stay;

    const hotels: HotelSummary[] = [];
    for (const h of this.world.hotels) {
      if (h.city !== args.city) continue;
      let best: { amount: number; taxesIncluded: boolean } | undefined;
      for (const room of h.rooms) {
        if (room.maxOccupancy < args.adults) continue;
        for (const plan of room.plans) {
          const r: ResolvedRate = {
            rateId: makeRateId(plan.id, args), hotel: h, room, plan,
            checkIn: args.check_in, checkOut: args.check_out, adults: args.adults, rooms: args.rooms ?? 1, nights: stay.data,
          };
          const d = this.displayed(r);
          if (!best || d.amount < best.amount) best = d;
        }
      }
      if (!best) continue;
      hotels.push({
        hotel_id: h.id, name: h.name, city: h.city, district: h.district, stars: h.stars,
        from_price: toMajor(best.amount), currency: h.currency, taxes_included: best.taxesIncluded,
      });
    }
    return ok({ hotels });
  }

  getRates(args: GetRatesArgs): Result<RatesView> {
    this.resolvePending();
    const hotel = this.hotels.get(args.hotel_id);
    const target: Target = hotel ? { hotel_id: hotel.id } : {};
    const g = this.gate("get_rates");
    if (!g.ok) return g;
    const err = this.injectedError("get_rates", target);
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    if (!hotel) return fail("NOT_FOUND", `Unknown hotel_id "${args.hotel_id}".`);
    const stay = this.validateStay(args);
    if (!stay.ok) return stay;

    const rooms: RoomView[] = [];
    for (const room of hotel.rooms) {
      if (room.maxOccupancy < args.adults) continue;
      rooms.push({
        room_id: room.id,
        name: room.name,
        bed_type: room.bedType,
        max_occupancy: room.maxOccupancy,
        rates: room.plans.map((plan) => {
          const r: ResolvedRate = {
            rateId: makeRateId(plan.id, args), hotel, room, plan,
            checkIn: args.check_in, checkOut: args.check_out, adults: args.adults, rooms: args.rooms ?? 1, nights: stay.data,
          };
          const d = this.displayed(r);
          const mislabel = this.faults.active("mislabeled_refundable", this.target(r));
          return {
            rate_id: r.rateId,
            board: plan.board,
            total_price: toMajor(d.amount),
            currency: hotel.currency,
            taxes_included: d.taxesIncluded,
            refundable: mislabel ? (mislabel.label ?? true) : plan.refundable,
            ...(plan.availableRooms !== undefined ? { rooms_left: this.roomsLeft(plan) } : {}),
          };
        }),
      });
    }
    return ok({
      hotel_id: hotel.id, hotel_name: hotel.name, check_in: args.check_in, check_out: args.check_out,
      nights: stay.data, currency: hotel.currency,
      ...((args.rooms ?? 1) > 1 ? { rooms_requested: args.rooms } : {}),
      rooms,
    });
  }

  getCancellationPolicy(args: { rate_id: string }): Result<PolicyView> {
    this.resolvePending();
    const r = this.resolveRate(args.rate_id);
    const target = r.ok ? this.target(r.data) : {};
    const g = this.gate("get_cancellation_policy");
    if (!g.ok) return g;
    const err = this.injectedError("get_cancellation_policy", target);
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    if (!r.ok) return r;
    const { refundable, until } = this.terms(r.data);
    return ok({
      rate_id: args.rate_id,
      refundable,
      free_cancellation_until: until,
      penalty: until
        ? `Free cancellation until ${until}. After that, 100% of the total is charged.`
        : "Non-refundable: 100% of the total is charged from the moment of booking.",
    });
  }

  prebook(args: { rate_id: string }): Result<PrebookView> {
    this.resolvePending();
    const r = this.resolveRate(args.rate_id);
    const target = r.ok ? this.target(r.data) : {};
    const g = this.gate("prebook");
    if (!g.ok) return g;
    const err = this.injectedError("prebook", target);
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    if (!r.ok) return r;
    const rate = r.data;

    if (this.soldOut.has(rate.rateId)) return fail("SOLD_OUT", "This rate is no longer available.");
    const so = this.faults.fire("sold_out", "prebook", target, (f) => f.stage === "search_to_prebook", () => ({ rate_id: rate.rateId }));
    if (so) {
      this.soldOut.add(rate.rateId);
      return fail("SOLD_OUT", "This rate is no longer available.");
    }
    const short = this.notEnoughRooms(rate);
    if (short) return short;

    const pc = this.faults.fire("price_change", "prebook", target, undefined, (f) => ({ rate_id: rate.rateId, percent: f.percent }));
    if (pc) this.priceChanges.set(rate.rateId, [...(this.priceChanges.get(rate.rateId) ?? []), pc.percent]);
    const pol = this.faults.fire("policy_change", "prebook", target, undefined, () => ({ rate_id: rate.rateId }));
    if (pol) this.policyChanged.add(rate.rateId);

    const original = this.price(rate, false);
    const now = this.price(rate, true);
    const changed = now.total !== original.total;
    this.prebookSeq += 1;
    const rec: PrebookRecord = {
      prebook_id: `PB-${String(this.prebookSeq).padStart(4, "0")}`,
      rate_id: rate.rateId,
      created_at: this.clock.nowIso(),
      expires_at_ms: this.clock.now() + PREBOOK_TTL_S * 1000,
      original_total_minor: original.total,
      total_minor: now.total,
      taxes_minor: now.taxes,
      currency: rate.hotel.currency,
      used: false,
    };
    this.prebooks.set(rec.prebook_id, rec);
    return ok({
      prebook_id: rec.prebook_id,
      rate_id: rate.rateId,
      hotel_id: rate.hotel.id,
      room_id: rate.room.id,
      total_price: toMajor(now.total),
      taxes: toMajor(now.taxes),
      currency: rec.currency,
      taxes_included: true,
      price_changed: changed,
      ...(changed ? { previous_price: toMajor(original.total) } : {}),
      expires_at: new Date(rec.expires_at_ms).toISOString(),
      ...(rate.rooms > 1 ? { rooms: rate.rooms } : {}),
      ...(this.policyChanged.has(rate.rateId) ? { policy_changed: true as const, refundable: false, free_cancellation_until: null } : {}),
      ...(this.payAtPropertyMinor(rate) > 0 ? { pay_at_property: this.payAtPropertyView(this.payAtPropertyMinor(rate), rec.currency) } : {}),
    });
  }

  book(args: BookArgs): Result<BookingView> {
    this.resolvePending();
    const pb = this.prebooks.get(args.prebook_id);
    const rate = pb ? this.resolveRate(pb.rate_id) : undefined;
    const target = rate?.ok ? this.target(rate.data) : {};
    const g = this.gate("book");
    if (!g.ok) return g;

    if (!args.client_reference?.trim()) return fail("INVALID_REQUEST", "client_reference is required.");
    if (!args.guest_name?.trim()) return fail("INVALID_REQUEST", "guest_name is required.");

    // Idempotency check comes first, as on most real suppliers, unless the fault disables it.
    const dedupe = !this.faults.has("duplicate_reference");
    if (dedupe && [...this.bookings.values()].some((b) => b.client_reference === args.client_reference)) {
      return fail("DUPLICATE_CLIENT_REFERENCE", `A booking with client_reference "${args.client_reference}" already exists.`);
    }

    if (!pb || !rate?.ok) return fail("NOT_FOUND", `Unknown prebook_id "${args.prebook_id}".`);
    if (pb.used) return fail("PREBOOK_ALREADY_USED", `prebook_id "${pb.prebook_id}" has already been used.`);
    if (this.clock.now() > pb.expires_at_ms) return fail("PREBOOK_EXPIRED", `prebook_id "${pb.prebook_id}" has expired. Prebook again.`);

    const err = this.injectedError("book", target);
    if (err) {
      if (err.booking_created) this.createBooking(pb, rate.data, args, "confirmed", { createdDespiteError: err.code });
      if (err.code === "PREBOOK_EXPIRED") pb.used = true;
      return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    }

    if (this.soldOut.has(rate.data.rateId)) return fail("SOLD_OUT", "This rate is no longer available.");
    const so = this.faults.fire("sold_out", "book", target, (f) => f.stage === "prebook_to_book", () => ({ rate_id: rate.data.rateId }));
    if (so) {
      this.soldOut.add(rate.data.rateId);
      pb.used = true;
      return fail("SOLD_OUT", "The room sold out before the booking could be confirmed.");
    }
    const short = this.notEnoughRooms(rate.data);
    if (short) return short;

    const onReq = this.faults.fire("on_request", "book", target, undefined, (f) => ({ outcome: f.outcome }));
    const rec = this.createBooking(pb, rate.data, args, onReq ? "pending" : "confirmed", {
      ...(onReq ? { resolveAtMs: this.clock.now() + onReq.resolve_after_s * 1000, outcome: onReq.outcome } : {}),
    });
    return ok(this.bookingView(rec));
  }

  private createBooking(
    pb: PrebookRecord,
    rate: ResolvedRate,
    args: BookArgs,
    status: BookingStatus,
    extra: { createdDespiteError?: string; resolveAtMs?: number; outcome?: "confirmed" | "rejected" },
  ): BookingRecord {
    pb.used = true;
    this.bookingSeq += 1;
    const rec: BookingRecord = {
      booking_id: `BK-${String(this.bookingSeq).padStart(4, "0")}`,
      client_reference: args.client_reference,
      status,
      prebook_id: pb.prebook_id,
      rate_id: rate.rateId,
      hotel_id: rate.hotel.id,
      room_id: rate.room.id,
      plan_id: rate.plan.id,
      check_in: rate.checkIn,
      check_out: rate.checkOut,
      adults: rate.adults,
      rooms: rate.rooms,
      guest_name: args.guest_name,
      total_minor: pb.total_minor,
      pay_at_property_minor: this.payAtPropertyMinor(rate),
      currency: pb.currency,
      refundable: this.terms(rate).refundable,
      free_cancellation_until: this.terms(rate).until,
      created_at: this.clock.nowIso(),
      ...(extra.createdDespiteError ? { created_despite_error: extra.createdDespiteError } : {}),
      ...(extra.resolveAtMs !== undefined ? { resolve_at_ms: extra.resolveAtMs, resolve_outcome: extra.outcome } : {}),
    };
    this.bookings.set(rec.booking_id, rec);
    return rec;
  }

  getBooking(args: GetBookingArgs): Result<{ bookings: BookingView[] }> {
    this.resolvePending();
    const g = this.gate("get_booking");
    if (!g.ok) return g;
    const err = this.injectedError("get_booking", {});
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    if (!args.booking_id && !args.client_reference) {
      return fail("INVALID_REQUEST", "Provide booking_id or client_reference.");
    }
    const found = [...this.bookings.values()].filter(
      (b) =>
        (args.booking_id === undefined || b.booking_id === args.booking_id) &&
        (args.client_reference === undefined || b.client_reference === args.client_reference),
    );
    if (args.booking_id && found.length === 0) return fail("NOT_FOUND", `Unknown booking_id "${args.booking_id}".`);
    return ok({ bookings: found.map((b) => this.bookingView(b)) });
  }

  cancelBooking(args: { booking_id: string }): Result<CancelView> {
    this.resolvePending();
    const b = this.bookings.get(args.booking_id);
    const target: Target = b ? { hotel_id: b.hotel_id, room_id: b.room_id, plan_id: b.plan_id } : {};
    const g = this.gate("cancel_booking");
    if (!g.ok) return g;
    const err = this.injectedError("cancel_booking", target);
    if (err) return fail(err.code, err.message ?? defaultErrorMessage(err.code));
    if (!b) return fail("NOT_FOUND", `Unknown booking_id "${args.booking_id}".`);
    if (b.status === "cancelled") return fail("ALREADY_CANCELLED", `Booking ${b.booking_id} is already cancelled.`);
    if (b.status === "rejected") return fail("INVALID_REQUEST", `Booking ${b.booking_id} was rejected; nothing to cancel.`);
    const free = b.free_cancellation_until !== null && this.clock.now() <= Date.parse(b.free_cancellation_until);
    b.status = "cancelled";
    b.cancelled_at = this.clock.nowIso();
    b.refund_minor = free ? b.total_minor : 0;
    return ok({ booking_id: b.booking_id, status: "cancelled", refund_amount: toMajor(b.refund_minor), currency: b.currency });
  }

  // -------------------------------------------------------------------------
  // Ground truth (never exposed to the agent)
  // -------------------------------------------------------------------------

  snapshot(): { bookings: BookingRecord[]; prebooks: PrebookRecord[] } {
    this.resolvePending();
    return {
      bookings: [...this.bookings.values()].map((b) => ({ ...b })),
      prebooks: [...this.prebooks.values()].map((p) => ({ ...p })),
    };
  }
}

function defaultErrorMessage(code: string): string {
  switch (code) {
    case "TIMEOUT":
      return "The supplier did not answer in time. The request may or may not have been processed.";
    case "UPSTREAM_ERROR":
      return "The supplier returned an unexpected error. The request may or may not have been processed.";
    case "PREBOOK_EXPIRED":
      return "The prebook has expired. Prebook again.";
    default:
      return `Supplier error: ${code}.`;
  }
}

