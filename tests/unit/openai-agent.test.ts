import { describe, expect, it } from "vitest";
import { OpenAICompatibleAgent, openAITools } from "../../src/agents/openai-compatible.js";
import { runAgent } from "../../src/agents/run-local.js";
import { gradeSession } from "../../src/grader/grade.js";
import { findScenario } from "../../src/scenarios/loader.js";

type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };

/**
 * Fake OpenAI-compatible endpoint: a deterministic "model" that plays the happy path,
 * reading previous tool results from the conversation like a real model would.
 */
function fakeModel(opts: { objectArgs?: boolean; silent?: boolean } = {}) {
  const requests: Array<{ model: string; messages: Msg[]; tools: Array<{ function: { name: string } }> }> = [];
  const lastTool = (messages: Msg[]) => JSON.parse([...messages].reverse().find((m) => m.role === "tool")!.content!);
  const steps: Array<(m: Msg[]) => [string, Record<string, unknown>]> = [
    () => ["search_hotels", { city: "LIS", check_in: "2026-03-12", check_out: "2026-03-14", adults: 2 }],
    () => ["get_rates", { hotel_id: "H-LIS-101", check_in: "2026-03-12", check_out: "2026-03-14", adults: 2 }],
    () => ["get_cancellation_policy", { rate_id: "H-LIS-101-R1-FLEX~2026-03-12~2026-03-14~2" }],
    () => ["prebook", { rate_id: "H-LIS-101-R1-FLEX~2026-03-12~2026-03-14~2" }],
    (m) => ["book", { prebook_id: lastTool(m).prebook_id, client_reference: "llm-1", guest_name: "Ana Silva" }],
    (m) => {
      const b = lastTool(m);
      return ["submit_final_report", {
        booking_id: b.booking_id, total_price: b.total_price, currency: b.currency,
        refundable: b.refundable, free_cancellation_deadline: b.free_cancellation_until,
      }];
    },
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const turn = requests.length - 1;
    const step = opts.silent ? undefined : steps[turn];
    const message = step
      ? (() => {
          const [name, args] = step(body.messages);
          return { role: "assistant", content: null, tool_calls: [{ id: `c${turn}`, type: "function", function: { name, arguments: opts.objectArgs ? args : JSON.stringify(args) } }] };
        })()
      : { role: "assistant", content: "I think I am done." };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const happy = findScenario("happy-path");

describe("OpenAICompatibleAgent", () => {
  it("exposes the 10 tools as Chat Completions functions", () => {
    const tools = openAITools();
    expect(tools).toHaveLength(10);
    const book = tools.find((t) => t.function.name === "book")!;
    expect(book.function.parameters).toMatchObject({ type: "object", required: ["prebook_id", "client_reference", "guest_name"] });
    expect(book.function.parameters).not.toHaveProperty("$schema");
  });

  it("drives a full run through tool calls and gets graded", async () => {
    const { fetchImpl, requests } = fakeModel();
    const agent = new OpenAICompatibleAgent({ baseUrl: "http://localhost:11434/v1/", model: "fake", fetch: fetchImpl });
    const session = await runAgent(agent, happy, { agent: agent.info });
    expect(gradeSession(happy, session).score).toBe(100);
    expect(requests).toHaveLength(6);
    expect(requests[0]!.model).toBe("fake");
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(requests[0]!.messages[1]!.content).toBe(`Today's date: 2026-02-01.

${happy.traveler.request.trim()}`);
    expect(requests[0]!.messages[0]!.content).toContain("Today's date in this simulation is 2026-02-01");
    // The model never sees the structured constraints.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("refundable_required");
    expect(requests[5]!.messages.filter((m) => m.role === "tool")).toHaveLength(5);
    expect(session.header.agent).toEqual({ name: "local-openai", model: "fake", base_url: "http://localhost:11434/v1/" });
  });

  it("accepts arguments given as objects (Ollama style)", async () => {
    const { fetchImpl } = fakeModel({ objectArgs: true });
    const session = await runAgent(new OpenAICompatibleAgent({ baseUrl: "http://x/v1", model: "m", fetch: fetchImpl }), happy);
    expect(session.finished).toBe(true);
  });

  it("nudges a model that stops talking, then gives up without a report", async () => {
    const { fetchImpl, requests } = fakeModel({ silent: true });
    const session = await runAgent(new OpenAICompatibleAgent({ baseUrl: "http://x/v1", model: "m", fetch: fetchImpl }), happy);
    expect(requests).toHaveLength(3);
    expect(session.report).toBeNull();
    expect(gradeSession(happy, session).caps.map((c) => c.id)).toContain("no_report");
  });

  it("reports HTTP errors from the endpoint", async () => {
    const failing = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    await expect(runAgent(new OpenAICompatibleAgent({ baseUrl: "http://x/v1", model: "m", fetch: failing }), happy)).rejects.toThrow(/HTTP 404/);
  });
});
