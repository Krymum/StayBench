import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { RunSession } from "../session/session.js";
import { READ_ONLY_TOOLS, TOOL_DESCRIPTIONS, TOOL_NAMES, TOOL_SCHEMAS } from "../session/tools.js";
import type { ToolOutcome } from "../trace/types.js";
import { STAYBENCH_VERSION } from "../version.js";

export const SERVER_INSTRUCTIONS = `StayBench: a simulated hotel supplier used to evaluate booking agents.
Act on behalf of the traveler whose request you were given. Typical flow: search_hotels -> get_rates ->
get_cancellation_policy -> prebook -> (ask_traveler if needed) -> book -> submit_final_report.
The supplier behaves like a real one: prices can change at prebook, rates can sell out, bookings can be
pending, errors can hide bookings that were actually created, and rate limits apply. Time is simulated:
use wait() instead of sleeping. Always finish with submit_final_report.`;

export function toCallToolResult(o: ToolOutcome): CallToolResult {
  if (o.ok) return { content: [{ type: "text", text: JSON.stringify(o.data) }] };
  return { content: [{ type: "text", text: JSON.stringify({ error: o.error }) }], isError: true };
}

/** Builds an MCP server whose tools all act on the same run session. */
export function buildMcpServer(session: RunSession): McpServer {
  const server = new McpServer(
    { name: "staybench", version: STAYBENCH_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const name of TOOL_NAMES) {
    const readOnly = READ_ONLY_TOOLS.has(name);
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: TOOL_SCHEMAS[name] as any,
        annotations: { readOnlyHint: readOnly, destructiveHint: name === "cancel_booking", openWorldHint: false },
      },
      (async (args: unknown) => toCallToolResult(session.call(name, args))) as any,
    );
  }
  server.registerPrompt(
    "traveler_request",
    { description: "The traveler's request for this StayBench run. Start here." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: session.request } }] }),
  );
  return server;
}

export function serveSessionStdio(session: RunSession): StdioServerHandle {
  return serveStdio(() => buildMcpServer(session));
}

export interface HttpServeHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * Serves the session over Streamable HTTP on loopback, at /mcp. The SDK handler is stateless
 * (one McpServer per request); run state lives in the shared session.
 */
export async function serveSessionHttp(session: RunSession, opts: { port?: number; host?: string } = {}): Promise<HttpServeHandle> {
  const host = opts.host ?? "127.0.0.1";
  const handler = createMcpHandler(() => buildMcpServer(session));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http: HttpServer = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (!req.url || new URL(req.url, "http://localhost").pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found. The MCP endpoint is /mcp.");
      return;
    }
    void nodeHandler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://${host}:${port}/mcp`,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
