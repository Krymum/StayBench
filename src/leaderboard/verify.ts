import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as z from "zod/v4";
import { gradeTrace, type GradeResult } from "../grader/grade.js";
import { loadScenarios } from "../scenarios/loader.js";
import type { Scenario } from "../scenarios/schema.js";
import { readTrace } from "../trace/io.js";
import { STAYBENCH_VERSION } from "../version.js";

/** meta.json of a submission: results/<submitter>/<name>/meta.json */
export const submissionMetaSchema = z.strictObject({
  submitter: z.string().min(1).describe("GitHub handle or organisation"),
  agent: z.strictObject({
    name: z.string().min(1).describe("Display name, e.g. 'Qwen3 8B via Ollama'"),
    model: z.string().optional(),
    client: z.string().optional().describe("Agent framework or MCP client used"),
    url: z.string().url().optional(),
  }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staybench_version: z.string(),
  notes: z.string().optional(),
});
export type SubmissionMeta = z.infer<typeof submissionMetaSchema>;

export interface ScenarioResult {
  scenario_id: string;
  scenario_version: number;
  trace: string;
  score: number;
  passed: boolean;
  criteria: GradeResult["criteria"];
  caps: GradeResult["caps"];
  stats: GradeResult["stats"];
}

export interface LeaderboardEntry {
  id: string;
  meta: SubmissionMeta;
  status: "verified" | "incomplete" | "invalid";
  /** Average over ALL current scenarios; a missing scenario counts as 0. */
  score: number;
  passed: number;
  coverage: number;
  results: ScenarioResult[];
  errors: string[];
}

export interface Leaderboard {
  staybench_version: string;
  scenarios: Array<{
    id: string; version: number; title: string; description: string; difficulty: string;
    tags: string[]; focus: string[]; rationale: string; faults: string[];
  }>;
  entries: LeaderboardEntry[];
}

/**
 * Simulator behaviour may change between minor versions (0.1 -> 0.2), so a trace only
 * replays on the same major.minor. Patch releases keep behaviour identical.
 */
export function sameMinor(a: string, b: string): boolean {
  const mm = (v: string) => v.split(".").slice(0, 2).join(".");
  return mm(a) === mm(b);
}

function listTraces(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTraces(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Verifies one submission directory: meta, one trace per scenario, replay + regrade. */
export function verifySubmission(dir: string, scenarios: Scenario[], root = dir): LeaderboardEntry {
  const id = relative(root, dir).replace(/\\/g, "/") || ".";
  const errors: string[] = [];
  let meta: SubmissionMeta = {
    submitter: "?", agent: { name: id }, date: "1970-01-01", staybench_version: "?",
  };
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) errors.push("missing meta.json");
  else {
    try {
      const parsed = submissionMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, "utf8")));
      if (parsed.success) meta = parsed.data;
      else errors.push(`invalid meta.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    } catch {
      errors.push("meta.json is not valid JSON");
    }
  }

  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const results: ScenarioResult[] = [];
  for (const file of listTraces(dir)) {
    const rel = relative(dir, file).replace(/\\/g, "/");
    try {
      const trace = readTrace(file);
      const sid = trace.header.run.scenario_id;
      const scenario = byId.get(sid);
      if (!scenario) {
        errors.push(`${rel}: unknown scenario "${sid}"`);
        continue;
      }
      if (trace.header.run.scenario_version !== scenario.version) {
        errors.push(`${rel}: recorded on ${sid} v${trace.header.run.scenario_version}, current is v${scenario.version}`);
        continue;
      }
      if (!sameMinor(trace.header.staybench_version, STAYBENCH_VERSION)) {
        errors.push(`${rel}: recorded with StayBench ${trace.header.staybench_version}, current is ${STAYBENCH_VERSION}; re-run it`);
        continue;
      }
      if (results.some((r) => r.scenario_id === sid)) {
        errors.push(`${rel}: more than one trace for scenario "${sid}"`);
        continue;
      }
      const g = gradeTrace(scenario, trace);
      if (g.mismatches.length > 0) {
        const m = g.mismatches[0]!;
        errors.push(`${rel}: replay mismatch at call ${m.seq} (${m.tool}, ${m.field}) and ${g.mismatches.length - 1} more`);
        continue;
      }
      if (!trace.end) errors.push(`${rel}: trace has no end line (run interrupted)`);
      results.push({
        scenario_id: sid, scenario_version: scenario.version, trace: rel, score: g.score, passed: g.passed,
        criteria: g.criteria, caps: g.caps, stats: g.stats,
      });
    } catch (e) {
      errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  results.sort((a, b) => scenarios.findIndex((s) => s.id === a.scenario_id) - scenarios.findIndex((s) => s.id === b.scenario_id));

  const score = Math.round((results.reduce((s, r) => s + r.score, 0) / scenarios.length) * 10) / 10;
  const status = errors.length > 0 ? "invalid" : results.length < scenarios.length ? "incomplete" : "verified";
  return { id, meta, status, score, passed: results.filter((r) => r.passed).length, coverage: results.length, results, errors };
}

/** Finds submissions: every directory containing a meta.json, under the results root. */
export function findSubmissions(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, "meta.json"))) {
      out.push(dir);
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

export function buildLeaderboard(root: string, scenariosDir?: string): Leaderboard {
  const scenarios = loadScenarios(scenariosDir);
  const entries = findSubmissions(root).map((d) => verifySubmission(d, scenarios, root));
  const rank = { verified: 0, incomplete: 1, invalid: 2 } as const;
  entries.sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score || a.id.localeCompare(b.id));
  return {
    staybench_version: STAYBENCH_VERSION,
    scenarios: scenarios.map((s) => ({
      id: s.id, version: s.version, title: s.title, description: s.description.trim(), difficulty: s.difficulty,
      tags: s.tags, focus: s.expected.focus, rationale: s.expected.rationale.trim(),
      faults: [...new Set(s.faults.map((f) => f.type))],
    })),
    entries,
  };
}
