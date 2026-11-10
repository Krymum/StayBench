/** Calendar helpers on ISO dates ("YYYY-MM-DD"), always in UTC. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((dateToMs(checkOut) - dateToMs(checkIn)) / DAY_MS);
}

/** Midnight UTC of the check-in date, minus N days, as an ISO timestamp. */
export function daysBefore(date: string, days: number): string {
  return new Date(dateToMs(date) - days * DAY_MS).toISOString();
}
