import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  ListNamedQueriesCommand,
  GetNamedQueryCommand,
  QueryExecutionState,
  type Row,
} from "@aws-sdk/client-athena";

export interface AthenaCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
  workgroup: string;
  s3OutputPath: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

export interface QueryStatus {
  state: string;
  stateChangeReason?: string;
  submissionDateTime?: Date;
  completionDateTime?: Date;
}

export interface NamedQuery {
  namedQueryId: string;
  name: string;
  description?: string;
  database: string;
  queryString: string;
}

function createClient(creds: AthenaCredentials): AthenaClient {
  return new AthenaClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });
}

export async function startQuery(
  creds: AthenaCredentials,
  database: string,
  query: string
): Promise<string> {
  const client = createClient(creds);
  const command = new StartQueryExecutionCommand({
    QueryString: query,
    QueryExecutionContext: { Database: database },
    WorkGroup: creds.workgroup,
    ResultConfiguration: { OutputLocation: creds.s3OutputPath },
  });
  const response = await client.send(command);
  if (!response.QueryExecutionId) {
    throw new Error("Athena did not return a QueryExecutionId");
  }
  return response.QueryExecutionId;
}

export async function getQueryStatus(
  creds: AthenaCredentials,
  queryExecutionId: string
): Promise<QueryStatus> {
  const client = createClient(creds);
  const command = new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId });
  const response = await client.send(command);
  const execution = response.QueryExecution;
  if (!execution?.Status) {
    throw new Error(`No status found for query ${queryExecutionId}`);
  }
  return {
    state: execution.Status.State ?? "UNKNOWN",
    stateChangeReason: execution.Status.StateChangeReason,
    submissionDateTime: execution.Status.SubmissionDateTime,
    completionDateTime: execution.Status.CompletionDateTime,
  };
}

export async function getQueryResults(
  creds: AthenaCredentials,
  queryExecutionId: string,
  maxRows: number
): Promise<QueryResult> {
  const client = createClient(creds);

  let columns: string[] = [];
  const dataRows: Record<string, string>[] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;

  do {
    const command = new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId,
      NextToken: nextToken,
      MaxResults: Math.min(maxRows - dataRows.length + 1, 1000), // +1 to account for header row
    });
    const response = await client.send(command);
    const resultSet = response.ResultSet;
    if (!resultSet?.Rows) break;

    const rawRows: Row[] = resultSet.Rows;

    if (isFirstPage) {
      // First row is the column header
      columns = rawRows[0]?.Data?.map((d) => d.VarCharValue ?? "") ?? [];
      for (let i = 1; i < rawRows.length; i++) {
        if (dataRows.length >= maxRows) break;
        dataRows.push(rowToRecord(rawRows[i], columns));
      }
      isFirstPage = false;
    } else {
      for (const row of rawRows) {
        if (dataRows.length >= maxRows) break;
        dataRows.push(rowToRecord(row, columns));
      }
    }

    nextToken = response.NextToken;
  } while (nextToken && dataRows.length < maxRows);

  return { columns, rows: dataRows, rowCount: dataRows.length };
}

function rowToRecord(row: Row, columns: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  columns.forEach((col, idx) => {
    record[col] = row.Data?.[idx]?.VarCharValue ?? "";
  });
  return record;
}

export async function waitForQuery(
  creds: AthenaCredentials,
  queryExecutionId: string,
  timeoutMs: number
): Promise<QueryStatus> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 500;

  while (Date.now() < deadline) {
    const status = await getQueryStatus(creds, queryExecutionId);
    const terminal: string[] = [
      QueryExecutionState.SUCCEEDED,
      QueryExecutionState.FAILED,
      QueryExecutionState.CANCELLED,
    ];
    if (terminal.includes(status.state)) {
      return status;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  }

  // Timeout — return current status without throwing; caller decides what to do
  return getQueryStatus(creds, queryExecutionId);
}

export async function listNamedQueries(creds: AthenaCredentials): Promise<NamedQuery[]> {
  const client = createClient(creds);
  const ids: string[] = [];
  let nextToken: string | undefined;

  do {
    const command = new ListNamedQueriesCommand({
      WorkGroup: creds.workgroup,
      NextToken: nextToken,
    });
    const response = await client.send(command);
    ids.push(...(response.NamedQueryIds ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  if (ids.length === 0) return [];

  const queries = await Promise.all(
    ids.map(async (id) => {
      const command = new GetNamedQueryCommand({ NamedQueryId: id });
      const response = await client.send(command);
      const q = response.NamedQuery;
      if (!q?.NamedQueryId || !q.Name || !q.Database || !q.QueryString) {
        return null;
      }
      return {
        namedQueryId: q.NamedQueryId,
        name: q.Name,
        description: q.Description,
        database: q.Database,
        queryString: q.QueryString,
      };
    })
  );

  return queries.filter((q): q is NonNullable<(typeof queries)[number]> => q !== null);
}

export async function getNamedQuery(
  creds: AthenaCredentials,
  namedQueryId: string
): Promise<NamedQuery> {
  const client = createClient(creds);
  const command = new GetNamedQueryCommand({ NamedQueryId: namedQueryId });
  const response = await client.send(command);
  const q = response.NamedQuery;
  if (!q?.NamedQueryId || !q.Name || !q.Database || !q.QueryString) {
    throw new Error(`Named query ${namedQueryId} not found or incomplete`);
  }
  return {
    namedQueryId: q.NamedQueryId,
    name: q.Name,
    description: q.Description,
    database: q.Database,
    queryString: q.QueryString,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
