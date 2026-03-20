import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AthenaCredentials } from "./athena.js";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── MCP endpoint ─────────────────────────────────────────────────────────────
app.post("/mcp", async (req: Request, res: Response) => {
  // 1. Extract and validate credentials from headers
  const accessKeyId = req.headers["x-aws-access-key-id"];
  const secretAccessKey = req.headers["x-aws-secret-access-key"];
  const s3OutputPath = req.headers["x-s3-output-path"];

  if (
    typeof accessKeyId !== "string" ||
    !accessKeyId ||
    typeof secretAccessKey !== "string" ||
    !secretAccessKey ||
    typeof s3OutputPath !== "string" ||
    !s3OutputPath
  ) {
    res.status(401).json({
      error:
        "Missing required headers: x-aws-access-key-id, x-aws-secret-access-key, x-s3-output-path",
    });
    return;
  }

  const region =
    typeof req.headers["x-aws-region"] === "string" && req.headers["x-aws-region"]
      ? req.headers["x-aws-region"]
      : "us-east-1";

  const workgroup =
    typeof req.headers["x-athena-workgroup"] === "string" && req.headers["x-athena-workgroup"]
      ? req.headers["x-athena-workgroup"]
      : "primary";

  const sessionToken =
    typeof req.headers["x-aws-session-token"] === "string" &&
    req.headers["x-aws-session-token"]
      ? req.headers["x-aws-session-token"]
      : undefined;

  const creds: AthenaCredentials = {
    accessKeyId,
    secretAccessKey,
    region,
    sessionToken,
    workgroup,
    s3OutputPath,
  };

  // 2. Build a fresh MCP server for this request (stateless)
  const server = new McpServer({
    name: "athena-mcp-server",
    version: "1.0.0",
  });

  // Pass creds via closure — getCreds() is called at tool execution time
  registerTools(server, () => creds);

  // 3. Handle via StreamableHTTP transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no sessions
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // Surface errors without leaking credential values
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  } finally {
    // Ensure cleanup even if response was already sent
    await server.close().catch(() => {});
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Athena MCP server listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});
