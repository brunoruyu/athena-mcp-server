# Athena MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server for AWS Athena, deployed as a Docker container.

Customers connect Claude Desktop (or any MCP client) directly to this server using their own AWS IAM credentials — **no local installation required**.

---

## Architecture

```
Claude Desktop  ──HTTP POST /mcp──►  athena-mcp-server  ──►  AWS Athena
                  (credentials in headers)
```

The server is **fully stateless**. Each request carries credentials in HTTP headers; no sessions, no credential caching.

---

## MCP Tools

| Tool | Description |
|---|---|
| `run_query` | Execute a SQL query (waits up to `timeoutMs`, returns results or polling ID) |
| `get_status` | Poll the status of a running query |
| `get_result` | Fetch results of a completed query |
| `list_saved_queries` | List named queries in the workgroup |
| `run_saved_query` | Execute a named query by ID |

---

## HTTP Headers

Every request to `POST /mcp` must include:

| Header | Required | Default | Description |
|---|---|---|---|
| `x-aws-access-key-id` | ✅ | — | AWS Access Key ID |
| `x-aws-secret-access-key` | ✅ | — | AWS Secret Access Key |
| `x-s3-output-path` | ✅ | — | S3 path for query results, e.g. `s3://bucket/prefix/` |
| `x-aws-region` | — | `us-east-1` | AWS region |
| `x-aws-session-token` | — | — | Session token (temporary credentials) |
| `x-athena-workgroup` | — | `primary` | Athena workgroup |

Missing required headers → `401 Unauthorized`.

---

## Running locally

### Prerequisites
- Docker + Docker Compose
- AWS credentials with the required IAM permissions (see below)

### Build and run

```bash
docker compose up --build
```

The server starts on `http://localhost:3000`.

### Smoke test

```bash
# Health check
curl http://localhost:3000/health
# → {"status":"ok"}

# Run a query
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "x-aws-access-key-id: AKIA..." \
  -H "x-aws-secret-access-key: ..." \
  -H "x-aws-region: us-east-1" \
  -H "x-s3-output-path: s3://my-bucket/athena-results/" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "run_query",
      "arguments": {
        "database": "default",
        "query": "SELECT 1 AS test"
      }
    }
  }'
```

---

## Configuring Claude Desktop

Add the following to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "teramot-athena": {
      "type": "http",
      "url": "https://athena-mcp.teramot.com/mcp",
      "headers": {
        "x-aws-access-key-id": "AKIA...",
        "x-aws-secret-access-key": "...",
        "x-aws-region": "us-east-1",
        "x-athena-workgroup": "primary",
        "x-s3-output-path": "s3://customer-bucket/athena-results/"
      }
    }
  }
}
```

Replace the URL with your deployed server URL and fill in the customer's credentials.

---

## Deploying to AWS ECS

### 1. Push the image to ECR

```bash
AWS_ACCOUNT_ID=123456789012
AWS_REGION=us-east-1
REPO=athena-mcp-server

aws ecr create-repository --repository-name $REPO --region $AWS_REGION

aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t $REPO .
docker tag $REPO:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:latest
```

### 2. Create an ECS task definition

- **CPU / Memory**: 256 CPU / 512 MB is sufficient for most workloads
- **Port mappings**: container port 3000
- **Environment variables**: none required (all config comes via headers)
- **Health check**: `CMD-SHELL wget -qO- http://localhost:3000/health || exit 1`

### 3. Create an ECS service

- Use **Fargate** launch type for zero infrastructure management
- Attach to an **Application Load Balancer** (ALB) on HTTPS port 443
- Enable **HTTPS** on the ALB listener with an ACM certificate
- Target group: HTTP, port 3000, health check path `/health`

### 4. (Optional) Custom domain

Create a Route 53 alias record pointing to the ALB, e.g. `athena-mcp.teramot.com`.

---

## Required IAM permissions

The customer's IAM credentials must have the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AthenaAccess",
      "Effect": "Allow",
      "Action": [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:ListNamedQueries",
        "athena:GetNamedQuery",
        "athena:ListWorkGroups"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3ResultsBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::customer-results-bucket",
        "arn:aws:s3:::customer-results-bucket/*"
      ]
    },
    {
      "Sid": "GlueMetastore",
      "Effect": "Allow",
      "Action": [
        "glue:GetDatabase",
        "glue:GetDatabases",
        "glue:GetTable",
        "glue:GetTables"
      ],
      "Resource": "*"
    }
  ]
}
```

Replace `customer-results-bucket` with the actual S3 bucket name.

---

## Development

```bash
npm install
npm run dev        # run with ts-node (hot-reload not included)
npm run build      # compile TypeScript → dist/
npm run typecheck  # type-check without emitting
```
