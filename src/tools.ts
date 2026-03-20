import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QueryExecutionState } from "@aws-sdk/client-athena";
import type { AthenaCredentials, QueryResult } from "./athena.js";
import {
  startQuery,
  getQueryStatus,
  getQueryResults,
  waitForQuery,
  listNamedQueries,
  getNamedQuery,
} from "./athena.js";

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;

type TextResult = { content: [{ type: "text"; text: string }] };

function text(t: string): TextResult {
  return { content: [{ type: "text", text: t }] };
}

function formatResults(result: QueryResult): string {
  if (result.rowCount === 0) return "Query returned no rows.";
  const lines = result.rows.map((row) =>
    result.columns.map((col) => `${col}: ${row[col]}`).join(", ")
  );
  return `${result.rowCount} row(s) returned:\n\n${lines.join("\n")}`;
}

function formatStatus(status: Awaited<ReturnType<typeof getQueryStatus>>): string {
  return [
    `State: ${status.state}`,
    status.stateChangeReason ? `Reason: ${status.stateChangeReason}` : null,
    status.submissionDateTime
      ? `Submitted: ${status.submissionDateTime.toISOString()}`
      : null,
    status.completionDateTime
      ? `Completed: ${status.completionDateTime.toISOString()}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const RUNNING_STATES = new Set<string>([QueryExecutionState.RUNNING, QueryExecutionState.QUEUED]);

function stillRunning(state: string, qid: string): TextResult {
  return text(
    `Query is still running (state: ${state}). Use get_status or get_result with queryExecutionId: ${qid}`
  );
}

function raiseQueryError(status: { state: string; stateChangeReason?: string }): never {
  throw new Error(
    `Query ${status.state}${status.stateChangeReason ? `: ${status.stateChangeReason}` : ""}`
  );
}

/**
 * Type-safe wrapper around McpServer.registerTool that avoids the TS2589
 * "excessively deep" error produced by MCP SDK v1.27+ when TypeScript tries
 * to evaluate ShapeOutput<ZodObject<...>> across multiple tool registrations.
 * The cast to `unknown` breaks the inference chain; schema/handler types are
 * still verified by TypeScript at the call site.
 */
function addTool<T>(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodType<T>,
  handler: (args: T) => Promise<TextResult>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as unknown as any).registerTool(
    name,
    { description, inputSchema: schema },
    handler as unknown
  );
}

export function registerTools(server: McpServer, getCreds: () => AthenaCredentials): void {
  // ── run_query ────────────────────────────────────────────────────────────────
  addTool(
    server,
    "run_query",
    "Execute a SQL query against AWS Athena. Returns full results if the query finishes within the timeout, otherwise returns a queryExecutionId for polling.",
    z.object({
      database: z.string().describe("Athena database (schema) to query"),
      query: z.string().describe("SQL query to execute"),
      maxRows: z.number().optional().describe("Max rows to return (default 1000)"),
      timeoutMs: z.number().optional().describe("Timeout in ms (default 60000)"),
    }),
    async ({ database, query, maxRows, timeoutMs }): Promise<TextResult> => {
      const creds = getCreds();
      const qid = await startQuery(creds, database, query);
      const status = await waitForQuery(creds, qid, timeoutMs ?? DEFAULT_TIMEOUT_MS);

      if (status.state === QueryExecutionState.SUCCEEDED) {
        const results = await getQueryResults(creds, qid, maxRows ?? DEFAULT_MAX_ROWS);
        return text(formatResults(results));
      }
      if (RUNNING_STATES.has(status.state)) return stillRunning(status.state, qid);
      return raiseQueryError(status);
    }
  );

  // ── get_status ───────────────────────────────────────────────────────────────
  addTool(
    server,
    "get_status",
    "Check the execution status of an Athena query.",
    z.object({
      queryExecutionId: z.string().describe("Athena query execution ID"),
    }),
    async ({ queryExecutionId }): Promise<TextResult> => {
      const status = await getQueryStatus(getCreds(), queryExecutionId);
      return text(formatStatus(status));
    }
  );

  // ── get_result ───────────────────────────────────────────────────────────────
  addTool(
    server,
    "get_result",
    "Retrieve results of a completed Athena query.",
    z.object({
      queryExecutionId: z.string().describe("Athena query execution ID"),
      maxRows: z.number().optional().describe("Max rows to return (default 1000)"),
    }),
    async ({ queryExecutionId, maxRows }): Promise<TextResult> => {
      const creds = getCreds();
      const status = await getQueryStatus(creds, queryExecutionId);
      if (status.state !== QueryExecutionState.SUCCEEDED) {
        return text(
          `Query is not yet complete. Current state: ${status.state}${
            status.stateChangeReason ? ` — ${status.stateChangeReason}` : ""
          }`
        );
      }
      const results = await getQueryResults(creds, queryExecutionId, maxRows ?? DEFAULT_MAX_ROWS);
      return text(formatResults(results));
    }
  );

  // ── list_saved_queries ───────────────────────────────────────────────────────
  addTool(
    server,
    "list_saved_queries",
    "List all saved (named) queries in the Athena workgroup.",
    z.object({}),
    async (): Promise<TextResult> => {
      const queries = await listNamedQueries(getCreds());
      if (queries.length === 0) return text("No saved queries found.");
      const lines = queries.map(
        (q) =>
          `ID: ${q.namedQueryId}\nName: ${q.name}\nDatabase: ${q.database}${
            q.description ? `\nDescription: ${q.description}` : ""
          }`
      );
      return text(`${queries.length} saved query(s):\n\n${lines.join("\n\n")}`);
    }
  );

  // ── run_saved_query ──────────────────────────────────────────────────────────
  addTool(
    server,
    "run_saved_query",
    "Execute a saved (named) Athena query by its ID.",
    z.object({
      namedQueryId: z.string().describe("ID of the saved query to execute"),
      databaseOverride: z
        .string()
        .optional()
        .describe("Override the database from the saved query"),
      maxRows: z.number().optional().describe("Max rows to return (default 1000)"),
      timeoutMs: z.number().optional().describe("Timeout in ms (default 60000)"),
    }),
    async ({ namedQueryId, databaseOverride, maxRows, timeoutMs }): Promise<TextResult> => {
      const creds = getCreds();
      const namedQuery = await getNamedQuery(creds, namedQueryId);
      const database = databaseOverride ?? namedQuery.database;

      const qid = await startQuery(creds, database, namedQuery.queryString);
      const status = await waitForQuery(creds, qid, timeoutMs ?? DEFAULT_TIMEOUT_MS);

      if (status.state === QueryExecutionState.SUCCEEDED) {
        const results = await getQueryResults(creds, qid, maxRows ?? DEFAULT_MAX_ROWS);
        return text(formatResults(results));
      }
      if (RUNNING_STATES.has(status.state)) return stillRunning(status.state, qid);
      return raiseQueryError(status);
    }
  );
}
