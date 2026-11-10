import { toRunConfig } from "../scenarios/loader.js";
import type { Scenario } from "../scenarios/schema.js";
import { RunSession, type SessionOptions } from "../session/session.js";
import { sessionCaller, type Agent, type ToolCaller } from "./types.js";

/**
 * Runs an agent on a scenario in-process. Pass `caller` to route calls through a transport
 * (e.g. an MCP client bound to the same session).
 */
export async function runAgent(
  agent: Agent,
  scenario: Scenario,
  opts: SessionOptions & { caller?: (session: RunSession) => Promise<{ call: ToolCaller; close(): Promise<void> }> } = {},
): Promise<RunSession> {
  const session = new RunSession(toRunConfig(scenario), { ...opts, agent: { name: agent.name, ...opts.agent } });
  const transport = opts.caller ? await opts.caller(session) : { call: sessionCaller(session), close: async () => {} };
  try {
    await agent.run(transport.call, { request: scenario.traveler.request, constraints: scenario.traveler.constraints });
  } finally {
    await transport.close();
    session.close();
  }
  return session;
}
