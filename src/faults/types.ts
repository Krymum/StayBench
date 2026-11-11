import type { ErrorCode } from "../simulator/types.js";

/** Tools exposed by the simulated provider (traveler/report tools are not provider tools). */
export const PROVIDER_TOOLS = [
  "search_hotels",
  "get_rates",
  "get_cancellation_policy",
  "prebook",
  "book",
  "get_booking",
  "cancel_booking",
] as const;
export type ProviderTool = (typeof PROVIDER_TOOLS)[number];

/** Narrows a fault to some part of the catalog. Every given field must match. */
export interface Where {
  hotel_id?: string;
  room_id?: string;
  plan_id?: string;
}

/**
 * Which matching calls trigger the fault:
 * - "first": only the first matching call
 * - "always": every matching call
 * - n (1-based): only the n-th matching call
 */
export type Occurrence = "first" | "always" | number;

interface FaultBase {
  /** Stable id used in traces and grader explanations. Defaults to "<type>#<index>". */
  id?: string;
}

/** Price changes at prebook. Sticky: once triggered, the rate keeps its new price. */
export interface PriceChangeFault extends FaultBase {
  type: "price_change";
  where?: Where;
  /** Signed percentage applied to the net price, e.g. 18 or -6. */
  percent: number;
  occurrence?: Occurrence;
}

/** Rate sells out. Sticky: once triggered, the rate stays sold out (search results stay stale). */
export interface SoldOutFault extends FaultBase {
  type: "sold_out";
  where?: Where;
  /** search_to_prebook: prebook fails. prebook_to_book: prebook succeeds, book fails. */
  stage: "search_to_prebook" | "prebook_to_book";
  occurrence?: Occurrence;
}

/** Booking is accepted as "pending" and resolves later (virtual time). */
export interface OnRequestFault extends FaultBase {
  type: "on_request";
  where?: Where;
  outcome: "confirmed" | "rejected";
  resolve_after_s: number;
  occurrence?: Occurrence;
}

/** Typed error on a tool. With booking_created, `book` still creates the booking (ghost booking). */
export interface ErrorFault extends FaultBase {
  type: "error";
  on: ProviderTool;
  where?: Where;
  code: ErrorCode;
  message?: string;
  booking_created?: boolean;
  occurrence?: Occurrence;
}

/** Provider does not deduplicate client references: re-sending one creates another booking. */
export interface DuplicateReferenceFault extends FaultBase {
  type: "duplicate_reference";
  mode: "accept";
}

/** 429 with Retry-After. Calls during the window are rejected again. */
export interface RateLimitFault extends FaultBase {
  type: "rate_limit";
  on: ProviderTool | "any";
  retry_after_s: number;
  occurrence?: Occurrence;
}

/** get_rates shows a misleading refundable label; get_cancellation_policy tells the truth. */
export interface MislabeledRefundableFault extends FaultBase {
  type: "mislabeled_refundable";
  where?: Where;
  /** Label shown in get_rates. Default true (a non-refundable rate shown as refundable). */
  label?: boolean;
}

/** Displayed prices (search, get_rates) exclude taxes; prebook reveals the full total. */
export interface TaxesExcludedFault extends FaultBase {
  type: "taxes_excluded";
  where?: Where;
}

/** At prebook, the rate's cancellation terms change to non-refundable. Sticky for the rate. */
export interface PolicyChangeFault extends FaultBase {
  type: "policy_change";
  where?: Where;
  occurrence?: Occurrence;
}

export type FaultSpec =
  | PriceChangeFault
  | SoldOutFault
  | OnRequestFault
  | ErrorFault
  | DuplicateReferenceFault
  | RateLimitFault
  | MislabeledRefundableFault
  | TaxesExcludedFault
  | PolicyChangeFault;

export type FaultType = FaultSpec["type"];

/** Catalog coordinates of the thing a call is about. */
export interface Target {
  hotel_id?: string;
  room_id?: string;
  plan_id?: string;
}

/** Logged every time a fault fires; consumed by the grader and shown in traces. */
export interface FaultEvent {
  fault_id: string;
  type: FaultType;
  tool: ProviderTool;
  at: string;
  detail?: Record<string, unknown>;
}
