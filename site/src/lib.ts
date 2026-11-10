import data from "./data/leaderboard.json";

export type Leaderboard = typeof data;
export type Entry = Leaderboard["entries"][number];
export type ScenarioInfo = Leaderboard["scenarios"][number];

export const leaderboard = data as Leaderboard;

export const REPO_URL = "https://github.com/Krymum/StayBench";

/** Joins the configured base path and a site path. */
export function url(path = ""): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

/** Score band used for colour coding. */
export function band(score: number | null | undefined): "none" | "low" | "mid" | "high" | "full" {
  if (score === null || score === undefined) return "none";
  if (score >= 100) return "full";
  if (score >= 80) return "high";
  if (score >= 50) return "mid";
  return "low";
}

export function resultFor(e: Entry, scenarioId: string) {
  return e.results.find((r) => r.scenario_id === scenarioId);
}
