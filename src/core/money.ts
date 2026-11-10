/**
 * Money is stored as integer minor units (cents) to avoid floating point drift.
 * Only 2-decimal currencies are supported (see DECISIONS.md).
 */
export const CURRENCIES = ["EUR", "GBP", "USD", "CHF"] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  /** Integer minor units (e.g. cents). */
  minor: number;
  currency: Currency;
}

export function money(major: number, currency: Currency): Money {
  return { minor: Math.round(major * 100), currency };
}

/** Converts minor units to a decimal number with 2 decimals, as exposed to agents. */
export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}

/** Round half away from zero, on integers. */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Applies a percentage change (e.g. +18 or -6) and rounds to the nearest minor unit. */
export function applyPercent(minor: number, percent: number): number {
  return roundHalfUp(minor * (1 + percent / 100));
}

/** Percentage of an amount, rounded to the nearest minor unit. */
export function percentOf(minor: number, percent: number): number {
  return roundHalfUp((minor * percent) / 100);
}

/** Relative change in percent, rounded to 1 decimal. */
export function percentChange(fromMinor: number, toMinor: number): number {
  if (fromMinor === 0) return 0;
  return Math.round(((toMinor - fromMinor) / fromMinor) * 1000) / 10;
}
