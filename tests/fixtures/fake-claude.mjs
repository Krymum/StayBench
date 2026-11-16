// Stands in for the Claude Code CLI in tests: answers --version, otherwise connects to the
// MCP server listed in ./mcp.json, records what it received, and declines in its final report.
import { readFileSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("9.9.9 (Fake Claude Code)");
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const config = JSON.parse(readFileSync("mcp.json", "utf8"));
const client = new Client({ name: "fake-claude", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.staybench.url)));
const tools = (await client.listTools()).tools.map((t) => t.name);
await client.callTool({
  name: "submit_final_report",
  arguments: { booking_id: null, total_price: null, currency: null, refundable: null, free_cancellation_deadline: null, decline_reason: "fake" },
});
await client.close();

if (process.env.FAKE_CLAUDE_RECORD) writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, prompt, tools, cwd: process.cwd() }));
console.log("fake agent done");
