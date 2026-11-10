import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { FaultSpec } from "../faults/types.js";
import type { HotelSpec } from "../simulator/types.js";
import type { RunConfig } from "../trace/types.js";
import { scenarioSchema, type Scenario } from "./schema.js";

/** Directory of the bundled scenarios (works from src/ with tsx and from dist/). */
export const SCENARIOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../scenarios");

/** Canonical JSON: sorted keys, so hashes do not depend on key order or line endings. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function scenarioHash(s: Scenario): string {
  return createHash("sha256").update(canonicalJson(s)).digest("hex");
}

export function parseScenario(text: string, source = "<inline>"): Scenario {
  const raw = parseYaml(text);
  const res = scenarioSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid scenario ${source}:\n${issues}`);
  }
  const s = res.data;
  const c = s.traveler.constraints;
  if (c.check_out <= c.check_in) throw new Error(`Invalid scenario ${source}: check_out must be after check_in`);
  if (Date.parse(`${c.check_in}T00:00:00Z`) < Date.parse(s.start_time)) {
    throw new Error(`Invalid scenario ${source}: check_in is before start_time`);
  }
  return s;
}

export function loadScenarioFile(file: string): Scenario {
  const s = parseScenario(readFileSync(file, "utf8"), file);
  const expected = basename(file).replace(/^\d+-/, "").replace(/\.ya?ml$/, "");
  if (expected !== s.id) throw new Error(`Scenario file ${file} must be named after its id "${s.id}"`);
  return s;
}

/** Loads every scenario of a directory, sorted by file name (NN-id.yaml). */
export function loadScenarios(dir = SCENARIOS_DIR): Scenario[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const scenarios = files.map((f) => loadScenarioFile(join(dir, f)));
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`Duplicate scenario id "${s.id}"`);
    ids.add(s.id);
  }
  return scenarios;
}

export function findScenario(id: string, dir = SCENARIOS_DIR): Scenario {
  const s = loadScenarios(dir).find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}". Run "staybench list" to see available scenarios.`);
  return s;
}

/** The exact run configuration derived from a scenario. Embedded in trace headers. */
export function toRunConfig(s: Scenario): RunConfig {
  return {
    scenario_id: s.id,
    scenario_version: s.version,
    scenario_hash: scenarioHash(s),
    start_time: s.start_time,
    tick_s: s.tick_s,
    world: {
      seed: s.world.seed,
      ...(s.world.generate_cities ? { generate_cities: s.world.generate_cities } : {}),
      ...(s.world.hotels_per_city !== undefined ? { hotels_per_city: s.world.hotels_per_city } : {}),
      hotels: s.world.hotels as HotelSpec[],
    },
    faults: s.faults as FaultSpec[],
    traveler: {
      request: s.traveler.request,
      replies: s.traveler.replies,
      ...(s.traveler.default_reply ? { default_reply: s.traveler.default_reply } : {}),
    },
  };
}
