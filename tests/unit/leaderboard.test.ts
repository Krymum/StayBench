import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cmdRun, cmdVerify, type Io } from "../../src/cli/commands.js";
import { buildLeaderboard, sameMinor } from "../../src/leaderboard/verify.js";
import { STAYBENCH_VERSION } from "../../src/version.js";
import { loadScenarios } from "../../src/scenarios/loader.js";

const N = loadScenarios().length;

const quiet: Io = { out: () => {}, err: () => {} };
let root: string;
let good: string;

function tracesOf(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) if (name.endsWith(".jsonl")) out.push(join(dir, name));
  return out.sort();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "staybench-lb-"));
  good = join(root, "alice", "good");
  await cmdRun({ agent: "scripted-good", all: true, out: good, submitter: "alice", displayName: "Good agent" }, quiet);
}, 60_000);

function copyAs(name: string): string {
  const dir = join(root, "bob", name);
  cpSync(good, dir, { recursive: true });
  return dir;
}

describe("leaderboard verification", () => {
  it("verifies a complete submission written by `run --submitter`", () => {
    const meta = JSON.parse(readFileSync(join(good, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ submitter: "alice", agent: { name: "Good agent" }, staybench_version: STAYBENCH_VERSION });
    const lb = buildLeaderboard(join(root, "alice"));
    expect(lb.scenarios).toHaveLength(N);
    expect(lb.entries).toHaveLength(1);
    expect(lb.entries[0]).toMatchObject({ id: "good", status: "verified", score: 100, passed: N, coverage: N, errors: [] });
  });

  it("flags tampered traces, duplicates and missing meta; counts missing scenarios as 0", () => {
    const tampered = copyAs("tampered");
    const happyTrace = tracesOf(tampered).find((t) => t.includes("happy-path"))!;
    const original = readFileSync(happyTrace, "utf8");
    const edited = original.replace('"total_price":318', '"total_price":200');
    expect(edited).not.toBe(original);
    writeFileSync(happyTrace, edited);

    const partial = copyAs("partial");
    for (const t of tracesOf(partial).slice(0, 5)) rmSync(t);

    const dup = copyAs("dup");
    const t0 = tracesOf(dup)[0]!;
    writeFileSync(t0.replace(".jsonl", "-copy.jsonl"), readFileSync(t0));

    const nometa = copyAs("nometa");
    rmSync(join(nometa, "meta.json"));
    mkdirSync(join(nometa, "x"));
    writeFileSync(join(nometa, "x", "meta.json"), "{ not json");

    const lb = buildLeaderboard(join(root, "bob"));
    const byId = Object.fromEntries(lb.entries.map((e) => [e.id, e]));
    expect(byId["tampered"]).toMatchObject({ status: "invalid", coverage: N - 1 });
    expect(byId["tampered"]!.errors[0]).toMatch(/happy-path\/.*: replay mismatch at call \d+ \(get_rates, result\)/);
    expect(byId["partial"]).toMatchObject({ status: "incomplete", coverage: N - 5, score: Math.round(((N - 5) / N) * 1000) / 10 });
    expect(byId["dup"]!.errors[0]).toMatch(/more than one trace/);
    expect(byId["nometa/x"]!.errors).toContain("meta.json is not valid JSON");
    // Ranking: verified first, then incomplete, then invalid.
    expect(lb.entries.map((e) => e.status)).toEqual(["incomplete", "invalid", "invalid", "invalid"]);
  });

  it("refuses traces recorded on an older scenario version", () => {
    const dir = copyAs("old");
    const t = tracesOf(dir)[0]!;
    writeFileSync(t, readFileSync(t, "utf8").replace('"scenario_version":1', '"scenario_version":0'));
    const e = buildLeaderboard(join(root, "bob")).entries.find((x) => x.id === "old")!;
    expect(e.errors[0]).toMatch(/recorded on .* v0, current is v1/);
  });

  it("refuses traces recorded with another minor version of StayBench", () => {
    expect(sameMinor("0.2.0", "0.2.5")).toBe(true);
    expect(sameMinor("0.1.0", "0.2.0")).toBe(false);
    const dir = copyAs("oldversion");
    const t = tracesOf(dir)[0]!;
    writeFileSync(t, readFileSync(t, "utf8").replace(`"staybench_version":"${STAYBENCH_VERSION}"`, '"staybench_version":"0.0.9"'));
    const e = buildLeaderboard(join(root, "bob")).entries.find((x) => x.id === "oldversion")!;
    expect(e.errors[0]).toMatch(/recorded with StayBench 0.0.9, current is .*; re-run it/);
  });

  it("verify exits 1 on invalid submissions unless --allow-invalid, and writes the JSON", () => {
    const out = join(root, "lb.json");
    expect(cmdVerify({ results: join(root, "bob") }, quiet)).toBe(1);
    expect(cmdVerify({ results: join(root, "bob"), allowInvalid: true, out }, quiet)).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).entries.length).toBeGreaterThan(0);
  });

  it("the committed results/ directory verifies", () => {
    const lb = buildLeaderboard("results");
    expect(lb.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of lb.entries) expect(e.errors, e.id).toEqual([]);
    expect(lb.entries.find((e) => e.id === "staybench/scripted-good")?.score).toBe(100);
  });
});
