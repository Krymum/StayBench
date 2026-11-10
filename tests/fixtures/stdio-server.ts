// Spawned by the stdio test: serves the fixture run over stdio and writes its trace.
import { serveSessionStdio } from "../../src/mcp/server.js";
import { RunSession } from "../../src/session/session.js";
import { testRunConfig } from "./run-config.js";

const tracePath = process.argv[2];
const session = new RunSession(testRunConfig(), tracePath ? { tracePath } : {});
const handle = serveSessionStdio(session);
process.on("SIGTERM", () => void handle.close().then(() => process.exit(0)));
