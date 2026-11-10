import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpServer, serveSessionHttp } from "../../src/mcp/server.js";
import { RunSession } from "../../src/session/session.js";
import { TOOL_NAMES } from "../../src/session/tools.js";
import { readTrace } from "../../src/trace/io.js";
import { testRunConfig } from "../fixtures/run-config.js";
import { FLEX, STAY, TWIN } from "../helpers.js";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function json(r: CallResult): any {
  const first = (r.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? "null");
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function inProcessClient(session: RunSession): Promise<Client> {
  const handler = createMcpHandler(() => buildMcpServer(session));
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });
  return client;
}

/** A short successful flow: price jumps above budget, agent asks, switches to the twin room. */
async function playFlow(client: Client) {
  const search = json(await client.callTool({ name: "search_hotels", arguments: { city: "LIS", ...STAY } }));
  expect(search.hotels[0].hotel_id).toBe("H-T-001");

  const pb = json(await client.callTool({ name: "prebook", arguments: { rate_id: FLEX } }));
  expect(pb).toMatchObject({ price_changed: true, total_price: 250.16 });
  const no = json(await client.callTool({ name: "ask_traveler", arguments: { question: "Price is now 250.16 EUR. OK?" } }));
  expect(no.answer).toMatch(/No/);

  const pb2 = json(await client.callTool({ name: "prebook", arguments: { rate_id: TWIN } }));
  const bk = json(await client.callTool({ name: "book", arguments: { prebook_id: pb2.prebook_id, client_reference: "c-1", guest_name: "Ana Silva" } }));
  expect(bk).toMatchObject({ status: "confirmed", total_price: 233.2 });

  const report = await client.callTool({
    name: "submit_final_report",
    arguments: {
      booking_id: bk.booking_id, total_price: bk.total_price, currency: bk.currency,
      refundable: bk.refundable, free_cancellation_deadline: bk.free_cancellation_until,
    },
  });
  expect(report.isError).toBeFalsy();
}

describe("MCP server (in-process, Streamable HTTP handler)", () => {
  it("lists the 10 tools with input schemas and the traveler prompt", async () => {
    const client = await inProcessClient(new RunSession(testRunConfig()));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const book = tools.find((t) => t.name === "book")!;
    expect(book.inputSchema.required).toEqual(["prebook_id", "client_reference", "guest_name"]);
    expect(tools.find((t) => t.name === "search_hotels")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/StayBench/);

    const prompt = await client.getPrompt({ name: "traveler_request" });
    expect(prompt.messages[0]!.content).toMatchObject({ type: "text", text: expect.stringMatching(/Lisbon/) });
  });

  it("returns provider errors as isError tool results", async () => {
    const client = await inProcessClient(new RunSession(testRunConfig()));
    const r = await client.callTool({ name: "get_rates", arguments: { hotel_id: "H-NOPE", ...STAY } });
    expect(r.isError).toBe(true);
    expect(json(r)).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String) } });
  });

  it("rejects schema-invalid arguments before they reach the session", async () => {
    const session = new RunSession(testRunConfig());
    const client = await inProcessClient(session);
    const r = await client.callTool({ name: "wait", arguments: { seconds: "ten" } });
    expect(r.isError).toBe(true);
    expect(session.calls).toHaveLength(0);
  });

  it("keeps one shared session across stateless requests", async () => {
    const session = new RunSession(testRunConfig());
    const client = await inProcessClient(session);
    await playFlow(client);
    expect(session.finished).toBe(true);
    expect(session.calls.map((c) => c.tool)).toEqual([
      "search_hotels", "prebook", "ask_traveler", "prebook", "book", "submit_final_report",
    ]);
    expect(session.provider.snapshot().bookings).toHaveLength(1);
  });
});

describe("MCP server over real transports", () => {
  it("serves Streamable HTTP on loopback at /mcp", async () => {
    const session = new RunSession(testRunConfig());
    const http = await serveSessionHttp(session, { port: 0 });
    cleanups.push(() => http.close());
    expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const notFound = await fetch(http.url.replace(/\/mcp$/, "/other"));
    expect(notFound.status).toBe(404);

    const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    cleanups.push(() => client.close());
    await playFlow(client);
    expect(session.finished).toBe(true);
  });

  it("serves stdio from a spawned process and writes the trace", async () => {
    const tracePath = join(mkdtempSync(join(tmpdir(), "staybench-")), "stdio.jsonl");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "tests/fixtures/stdio-server.ts", tracePath],
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    cleanups.push(() => client.close());
    await playFlow(client);
    const trace = readTrace(tracePath);
    expect(trace.calls).toHaveLength(6);
    expect(trace.end?.report).toMatchObject({ total_price: 233.2 });
  }, 30_000);
});
