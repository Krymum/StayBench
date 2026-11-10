import type { Currency } from "../core/money.js";

export type BedType = "single" | "double" | "twin" | "king";
export type Board = "room_only" | "breakfast";

export interface RatePlan {
  /** Full id, e.g. "H-LIS-003-R2-FLEX". */
  id: string;
  code: string;
  board: Board;
  /** Net nightly price per room, before taxes, in minor units. */
  nightlyNetMinor: number;
  /** True cancellation terms. `get_cancellation_policy` always tells the truth. */
  refundable: boolean;
  /** Free cancellation until N days before check-in (midnight UTC). Null when non-refundable. */
  freeCancelDaysBefore: number | null;
}

export interface Room {
  /** Full id, e.g. "H-LIS-003-R2". */
  id: string;
  name: string;
  bedType: BedType;
  maxOccupancy: number;
  plans: RatePlan[];
}

export interface Hotel {
  id: string;
  name: string;
  city: string;
  district: string;
  stars: number;
  currency: Currency;
  /** Taxes as a percentage of the net price. */
  taxPercent: number;
  rooms: Room[];
}

export interface World {
  seed: number;
  hotels: Hotel[];
}

/** Hand-written hotel in a scenario. Room ids and plan codes are local and get prefixed. */
export interface HotelSpec {
  id: string;
  name: string;
  city: string;
  district?: string;
  stars: number;
  currency?: Currency;
  tax_percent?: number;
  rooms: Array<{
    id: string;
    name: string;
    bed_type: BedType;
    max_occupancy: number;
    plans: Array<{
      code: string;
      board?: Board;
      /** Net nightly price in major units (e.g. 180.00). */
      nightly_net: number;
      refundable: boolean;
      free_cancel_days_before?: number;
    }>;
  }>;
}

export interface WorldSpec {
  seed: number;
  /** Cities to fill with generated hotels. Defaults to every known city. */
  generate_cities?: string[];
  /** Generated hotels per city. Default 6. Use 0 for fully hand-written worlds. */
  hotels_per_city?: number;
  /** Hand-written hotels. They replace generated hotels with the same id. */
  hotels?: HotelSpec[];
}

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_ERROR",
  "SOLD_OUT",
  "PREBOOK_EXPIRED",
  "PREBOOK_ALREADY_USED",
  "DUPLICATE_CLIENT_REFERENCE",
  "ALREADY_CANCELLED",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProviderError {
  code: ErrorCode;
  message: string;
  retry_after_s?: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ProviderError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(code: ErrorCode, message: string, extra?: Partial<ProviderError>): Result<T> {
  return { ok: false, error: { code, message, ...extra } };
}
