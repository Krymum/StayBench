import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { ScriptedGoodAgent } from "../../src/agents/scripted-good.js";
import { mcpCaller } from "../../src/agents/types.js";
import { cmdGrade, cmdList, cmdRun, type Io } from "../../src/cli/commands.js";
import { findScenario, loadScenarios } from "../../src/scenarios/loader.js";

const N = loadScenarios().length;

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const tmp = () => mkdtempSync(join(tmpdir(), "staybench-cli-"));
const CLI = ["--import", "tsx", "src/cli/index.ts"];

describe("CLI commands (in-process)", () => {
  it("list prints the catalog, as text or JSON", () => {
    const io = capture();
    expect(cmdList({}, io)).toBe(0);
    expect(io.stdout[0]).toMatch(/^happy-path\s+v1\s+easy\s+Plain refundable booking/);
    const j = capture();
    cmdList({ json: true }, j);
    expect(JSON.parse(j.stdout[0]!)).toHaveLength(N);
  });

  it("run writes a trace that grade replays to the same score", async () => {
    const out = tmp();
    const io = capture();
    const { results } = await cmdRun({ agent: "scripted-bad", scenario: "taxes-excluded-budget", out }, io);
    expect(results[0]!.score).toBe(31.8);
    const trace = results[0]!.trace;
    expect(trace.startsWith(join(out, "taxes-excluded-budget", "scripted-bad-"))).toBe(true);

    const g = capture();
    expect(cmdGrade({ trace, json: true }, g)).toBe(0);
    const graded = JSON.parse(g.stdout[0]!);
    expect(graded.score).toBe(31.8);
    expect(graded.mismatches).toEqual([]);
  });

  it("grade returns exit code 2 on a tampered trace", async () => {
    const io = capture();
    const { results } = await cmdRun({ agent: "scripted-good", scenario: "happy-path", out: tmp() }, io);
    const file = results[0]!.trace;
    writeFileSync(file, readFileSync(file, "utf8").replace('"total_price":318', '"total_price":300'));
    const g = capture();
    expect(cmdGrade({ trace: file }, g)).toBe(2);
    expect(g.stdout[0]).toMatch(/trace inconsistent/);
  });

  it("run --all summarizes the average", async () => {
    const io = capture();
    const { results } = await cmdRun({ agent: "scripted-good", all: true, out: tmp() }, io);
    expect(results).toHaveLength(N);
    expect(io.stdout.at(-1)).toBe(`\nAverage: 100.0/100, passed ${N}/${N}`);
  });

  it("validates agent options", async () => {
    await expect(cmdRun({ agent: "nope", scenario: "happy-path", out: tmp() }, capture())).rejects.toThrow(/Unknown agent/);
    await expect(cmdRun({ agent: "local-openai", scenario: "happy-path", out: tmp() }, capture())).rejects.toThrow(/--base-url/);
    await expect(cmdRun({ agent: "scripted-good", out: tmp() }, capture())).rejects.toThrow(/--scenario/);
  });
});

describe("CLI binary", () => {
  it("staybench serve (stdio): an MCP client plays the scenario, the trace grades to 100", async () => {
    const dir = tmp();
    const trace = join(dir, "run.jsonl");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...CLI, "serve", "--scenario", "happy-path", "--trace", trace],
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
    const client = new Client({ name: "cli-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    const scenario = findScenario("happy-path");
    await new ScriptedGoodAgent().run(mcpCaller(client), { request: scenario.traveler.request, today: scenario.start_time.slice(0, 10), constraints: scenario.traveler.constraints });
    await client.close();

    expect(stderr.join("")).toContain("Give this request to your agent");
    const io = capture();
    expect(cmdGrade({ trace }, io)).toBe(0);
    expect(io.stdout[0]).toMatch(/^happy-path v1: 100\/100 PASS/);
  }, 30_000);

  it("staybench serve --transport http prints the endpoint and serves it", async () => {
    const dir = tmp();
    const child = spawn(process.execPath, [...CLI, "serve", "--scenario", "rate-limit-429", "--transport", "http", "--port", "0", "--trace", join(dir, "t.jsonl")], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        child.stderr.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = buf.match(/MCP endpoint \(Streamable HTTP\): (\S+)/);
          if (m) resolve(m[1]!);
        });
        child.on("exit", (code) => reject(new Error(`serve exited with ${code}: ${buf}`)));
      });
      const client = new Client({ name: "cli-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const s = findScenario("rate-limit-429");
      await new ScriptedGoodAgent().run(mcpCaller(client), { request: s.traveler.request, today: s.start_time.slice(0, 10), constraints: s.traveler.constraints });
      await client.close();
      expect(readdirSync(dir)).toEqual(["t.jsonl"]);
      const io = capture();
      expect(cmdGrade({ trace: join(dir, "t.jsonl") }, io)).toBe(0);
      expect(io.stdout[0]).toMatch(/100\/100 PASS/);
    } finally {
      child.kill();
    }
  }, 30_000);

  it("prints help and fails on unknown commands", async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const c = spawn(process.execPath, [...CLI, ...args]);
        let out = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.stderr.on("data", (d: Buffer) => (out += d.toString()));
        c.on("exit", (code) => resolve({ code, out }));
      });
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("staybench serve --scenario <id>");
    const bad = await run(["frobnicate"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('Unknown command "frobnicate"');
  }, 30_000);
});
