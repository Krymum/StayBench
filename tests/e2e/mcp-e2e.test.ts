import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/agents/run-local.js";
import { ScriptedBadAgent } from "../../src/agents/scripted-bad.js";
import { ScriptedGoodAgent } from "../../src/agents/scripted-good.js";
import { mcpCaller, type Agent } from "../../src/agents/types.js";
import { explain, gradeTrace } from "../../src/grader/grade.js";
import { serveSessionHttp } from "../../src/mcp/server.js";
import { loadScenarios } from "../../src/scenarios/loader.js";
import type { Scenario } from "../../src/scenarios/schema.js";
import type { RunSession } from "../../src/session/session.js";
import { parseTrace, serializeTrace } from "../../src/trace/io.js";

/** Runs an agent against a real Streamable HTTP MCP server, then grades the recorded trace. */
async function runOverMcp(agent: Agent, scenario: Scenario) {
  const session = await runAgent(agent, scenario, {
    caller: async (s: RunSession) => {
      const http = await serveSessionHttp(s, { port: 0 });
      const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
      return {
        call: mcpCaller(client),
        close: async () => {
          await client.close();
          await http.close();
        },
      };
    },
  });
  const trace = parseTrace(serializeTrace({ header: session.header, calls: session.calls, end: session.end }));
  return gradeTrace(scenario, trace);
}

describe("end to end: scripted agent -> MCP (Streamable HTTP) -> trace -> replay -> grader", () => {
  for (const scenario of loadScenarios()) {
    it(`good agent passes ${scenario.id}`, { timeout: 20_000 }, async () => {
      const g = await runOverMcp(new ScriptedGoodAgent(), scenario);
      expect(g.mismatches).toEqual([]);
      expect(g.score, explain(g)).toBe(100);
    });
  }

  it("bad agent fails over MCP too", { timeout: 20_000 }, async () => {
    const g = await runOverMcp(new ScriptedBadAgent(), loadScenarios().find((s) => s.id === "timeout-ghost-booking")!);
    expect(g.mismatches).toEqual([]);
    expect(g.passed).toBe(false);
    expect(g.caps.map((c) => c.id)).toContain("duplicate_bookings");
  });
});
