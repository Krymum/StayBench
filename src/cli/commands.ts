import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildLeaderboard, submissionMetaSchema, type SubmissionMeta } from "../leaderboard/verify.js";
import { STAYBENCH_VERSION } from "../version.js";
import { OpenAICompatibleAgent } from "../agents/openai-compatible.js";
import { runAgent } from "../agents/run-local.js";
import { ScriptedBadAgent } from "../agents/scripted-bad.js";
import { ScriptedGoodAgent } from "../agents/scripted-good.js";
import type { Agent } from "../agents/types.js";
import { explain, gradeSession, gradeTrace, type GradeResult } from "../grader/grade.js";
import { serveSessionHttp, serveSessionStdio } from "../mcp/server.js";
import { findScenario, loadScenarios, toRunConfig } from "../scenarios/loader.js";
import type { Scenario } from "../scenarios/schema.js";
import { RunSession } from "../session/session.js";
import { readTrace } from "../trace/io.js";

/** Output sinks, injectable for tests. stdout carries results; stderr carries human logs. */
export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export function defaultTracePath(scenarioId: string, agent: string, dir = "runs"): string {
  return join(dir, scenarioId, `${agent}-${stamp()}.jsonl`);
}

// ---------------------------------------------------------------------------

export function cmdList(opts: { json?: boolean; scenariosDir?: string }, io: Io = defaultIo): number {
  const scenarios = loadScenarios(opts.scenariosDir);
  if (opts.json) {
    io.out(JSON.stringify(scenarios.map((s) => ({ id: s.id, version: s.version, title: s.title, difficulty: s.difficulty, tags: s.tags, focus: s.expected.focus })), null, 2));
    return 0;
  }
  const w = Math.max(...scenarios.map((s) => s.id.length));
  for (const s of scenarios) {
    io.out(`${s.id.padEnd(w)}  v${s.version}  ${s.difficulty.padEnd(6)}  ${s.title}`);
  }
  io.out(`\n${scenarios.length} scenarios. Start one with: staybench serve --scenario <id>`);
  return 0;
}

// ---------------------------------------------------------------------------

export interface ServeOptions {
  scenario: string;
  transport: "stdio" | "http";
  port: number;
  trace?: string;
  scenariosDir?: string;
}

/** Starts the MCP server for one run. Resolves when the server is up; it runs until killed. */
export async function cmdServe(opts: ServeOptions, io: Io = defaultIo): Promise<{ session: RunSession; close(): Promise<void> }> {
  const scenario = findScenario(opts.scenario, opts.scenariosDir);
  const tracePath = opts.trace ?? defaultTracePath(scenario.id, "mcp");
  const session = new RunSession(toRunConfig(scenario), {
    tracePath,
    agent: { name: "mcp-client", transport: opts.transport },
    onEnd: (s) => {
      io.err("\n=== Run finished ===");
      io.err(explain({ ...gradeSession(scenario, s), mismatches: [] }));
      io.err(`Trace: ${tracePath}  (re-grade with: staybench grade ${tracePath})`);
    },
  });

  // Logs go to stderr: with stdio, stdout is the MCP channel.
  io.err(`StayBench - scenario "${scenario.id}" v${scenario.version}: ${scenario.title}`);
  io.err(`Trace: ${tracePath}`);
  io.err("\nGive this request to your agent (also available as the MCP prompt \"traveler_request\"):\n");
  io.err(`${session.request.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}\n`);

  let close: () => Promise<void>;
  if (opts.transport === "http") {
    const http = await serveSessionHttp(session, { port: opts.port });
    io.err(`MCP endpoint (Streamable HTTP): ${http.url}`);
    io.err("Press Ctrl+C to stop.");
    close = () => http.close();
  } else {
    const handle = serveSessionStdio(session);
    io.err("Serving MCP over stdio.");
    close = () => handle.close();
  }
  return {
    session,
    close: async () => {
      session.close();
      await close();
    },
  };
}

// ---------------------------------------------------------------------------

export function cmdGrade(opts: { trace: string; json?: boolean; scenariosDir?: string }, io: Io = defaultIo): number {
  if (!existsSync(opts.trace)) {
    io.err(`Trace not found: ${opts.trace}`);
    return 1;
  }
  const trace = readTrace(opts.trace);
  const scenario = findScenario(trace.header.run.scenario_id, opts.scenariosDir);
  const g = gradeTrace(scenario, trace);
  io.out(opts.json ? JSON.stringify(g, null, 2) : explain(g));
  return g.mismatches.length > 0 ? 2 : 0;
}

// ---------------------------------------------------------------------------

export interface RunOptions {
  agent: string;
  scenario?: string;
  all?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTurns?: number;
  out: string;
  /** When set, also writes <out>/meta.json so the output directory is a leaderboard submission. */
  submitter?: string;
  displayName?: string;
  json?: boolean;
  scenariosDir?: string;
}

export const AGENTS = ["local-openai", "scripted-good", "scripted-bad"] as const;

function makeAgent(opts: RunOptions, io: Io): Agent & { info?: Record<string, unknown> } {
  switch (opts.agent) {
    case "scripted-good":
      return new ScriptedGoodAgent();
    case "scripted-bad":
      return new ScriptedBadAgent();
    case "local-openai":
      if (!opts.baseUrl || !opts.model) throw new Error("--agent local-openai requires --base-url and --model (e.g. --base-url http://localhost:11434/v1 --model qwen3:8b)");
      return new OpenAICompatibleAgent({
        baseUrl: opts.baseUrl,
        model: opts.model,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
        log: (l) => io.err(`    ${l}`),
      });
    default:
      throw new Error(`Unknown agent "${opts.agent}". Available: ${AGENTS.join(", ")}`);
  }
}

/** Runs an agent on one or all scenarios, writes traces, prints scores. */
export async function cmdRun(opts: RunOptions, io: Io = defaultIo): Promise<{ results: Array<GradeResult & { trace: string }>; code: number }> {
  if (!opts.scenario && !opts.all) throw new Error("Pass --scenario <id> or --all");
  const agent = makeAgent(opts, io);
  const scenarios: Scenario[] = opts.all ? loadScenarios(opts.scenariosDir) : [findScenario(opts.scenario!, opts.scenariosDir)];
  const results: Array<GradeResult & { trace: string }> = [];
  for (const s of scenarios) {
    const trace = defaultTracePath(s.id, agent.name, opts.out);
    io.err(`> ${s.id} (${agent.name})`);
    const session = await runAgent(agent, s, { tracePath: trace, ...(agent.info ? { agent: agent.info } : {}) });
    const g = { ...gradeSession(s, session), mismatches: [], trace };
    results.push(g);
    if (!opts.json) io.out(explain(g));
  }
  if (opts.submitter) {
    const info = agent.info ?? {};
    writeSubmissionMeta(opts.out, {
      submitter: opts.submitter,
      agent: {
        name: opts.displayName ?? (typeof info.model === "string" ? info.model : agent.name),
        ...(typeof info.model === "string" ? { model: info.model } : {}),
        client: `staybench run --agent ${agent.name}`,
      },
      date: new Date().toISOString().slice(0, 10),
      staybench_version: STAYBENCH_VERSION,
    });
  }
  if (opts.json) io.out(JSON.stringify(results, null, 2));
  else if (results.length > 1) {
    const avg = results.reduce((a, r) => a + r.score, 0) / results.length;
    io.out(`\nAverage: ${avg.toFixed(1)}/100, passed ${results.filter((r) => r.passed).length}/${results.length}`);
  }
  return { results, code: 0 };
}

// ---------------------------------------------------------------------------

export function cmdVerify(opts: { results: string; out?: string; json?: boolean; allowInvalid?: boolean; scenariosDir?: string }, io: Io = defaultIo): number {
  const lb = buildLeaderboard(opts.results, opts.scenariosDir);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(lb, null, 2)}\n`);
  }
  if (opts.json) io.out(JSON.stringify(lb, null, 2));
  else {
    if (lb.entries.length === 0) io.out(`No submissions found under ${opts.results}`);
    for (const e of lb.entries) {
      io.out(`${e.status.toUpperCase().padEnd(10)} ${e.score.toFixed(1).padStart(5)}  ${String(e.passed).padStart(2)}/${lb.scenarios.length} passed  ${e.id}  (${e.meta.agent.name})`);
      for (const err of e.errors) io.out(`           ! ${err}`);
    }
    if (opts.out) io.out(`\nWrote ${opts.out}`);
  }
  return !opts.allowInvalid && lb.entries.some((e) => e.status === "invalid") ? 1 : 0;
}

/** Writes the meta.json of a submission directory. */
export function writeSubmissionMeta(dir: string, meta: SubmissionMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(submissionMetaSchema.parse(meta), null, 2)}\n`);
}
