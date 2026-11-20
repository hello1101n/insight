# SQL query API

`POST /api/sql/query` executes SQL without saving a query. It uses the same
read-only ClickHouse account, grants, SQL validation, and per-pod concurrency
budget as MCP. Saved-query endpoints and MCP OAuth are unchanged.

## Enable

Create two operator-managed Kubernetes Secrets in the release namespace:

- `insight-mcp-creds`, key `clickhouse-password`: the existing SQL explorer
  ClickHouse password. Reuse this Secret if MCP is already configured.
- `insight-sql-api-creds`, key `token`: a separate, cryptographically random
  instance token. Generate at least 32 random bytes, for example with
  `openssl rand -hex 32`, and store it in your secret manager. Never commit
  plaintext credentials; SealedSecrets can carry them in GitOps.

Token strength is the operator's responsibility. Startup checks length and
character validity, not randomness; never use a memorable phrase or repeated
characters as the token. Rate limiting is not a substitute for a random secret.

Enable the endpoint in Helm values:

```yaml
global:
  sqlApi:
    enabled: true
analytics:
  sqlApi:
    tokenSecret: insight-sql-api-creds
    tokenKey: token
```

MCP does not need to be enabled. The existing `analytics.mcp` values configure
the shared listener, ClickHouse credentials, and concurrency budget. When either
feature is enabled, database provisioning creates the read-only explorer access.
Leave `global.mcp.enabled` and `global.mcp.publicUrl` unchanged.

Inherit gateway route defaults. A custom `gateway.gateway.routes` list replaces
the complete default list and must explicitly include `/api/sql/query` with
`auth: instance_token`, upstream `http://{{ .Release.Name }}-analytics:8086`,
`timeoutMs: 40000`, and `sqlApiOnly: true`.

For Docker Compose, set `SQL_API_ENABLED=true`, `SQL_API_TOKEN`, and
`CLICKHOUSE_MCP_PASSWORD` in your untracked environment file. Restart analytics
after changing the token. In Kubernetes, update the token Secret and roll the
analytics Deployment: environment-injected secrets are read only at startup.
During a rolling rotation, old and new pods may temporarily accept different tokens.

## Personal tokens

To create a personal token, an admin does these steps:

1. Open **Manage → People & access → SQL API tokens**.
2. Select **Create token**.
3. Pick the person. Analytics refuses a person who is not in the tenant roster
   with 400.
4. Give the token a label.
5. Copy the token from the dialog. The dialog shows it once.

Analytics stores only the token's SHA-256 in MariaDB. A personal token opens
this endpoint only, not MCP. It works until an admin removes it. The next
request with a removed token gets 401. The instance token keeps working beside
personal tokens.

Each query made with a personal token logs `person_id` and `token_label` on its
`SQL explorer query completed` or `SQL explorer query failed` line.

## Query

With `INSIGHT_SQL_TOKEN` supplied by your secret manager:

```bash
curl --fail-with-body https://insight.example.com/api/sql/query \
  -H "Authorization: Bearer ${INSIGHT_SQL_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"sql":"SELECT 1 AS answer"}'
```

```json
{
  "columns": [{"name": "answer", "type": "UInt8"}],
  "rows": [{"answer": 1}],
  "row_count": 1,
  "truncated": false
}
```

Discover available relations through `system.databases`, `system.tables`, and
`system.columns`. The same grants cover bronze, staging, silver, the configured
gold database, identity, and config. No new grants are introduced by this API.

Only one SELECT/WITH statement is accepted. Multiple CTEs, subqueries, joins,
and unions are allowed. Query SETTINGS/FORMAT and external table functions are
rejected. SQL is capped at 64 KiB and the request body at 128 KiB. The shared
executor caps ClickHouse response bytes at 5 MiB. Shared API and MCP database
limits allow scanning 10 million rows / 1 GiB and returning 5,000 rows / 5 MiB,
with 512 MiB query memory, two threads, and a 30-second execution timeout.
The scan limits apply when database provisioning runs, including on upgrades.
Exceeding a limit fails the query;
results are not silently truncated.

Errors use canonical problem JSON:

- 400: an invalid request or invalid SQL.
- 401: a missing or invalid token. The reason is `INVALID_INSTANCE_TOKEN` for a
  refused instance token and for a refused personal token.
- 413: a body or SQL over its size limit.
- 429: a query capacity, result-size, or database resource limit.
- 504: a query timeout.
- 500: any other backend failure, including a failed personal-token lookup.

Recognized database exceptions are classified
using [ClickHouse's numeric error codes](https://github.com/ClickHouse/ClickHouse/blob/master/src/Common/ErrorCodes.cpp);
unrecognized exceptions remain generic backend failures. Responses are marked `Cache-Control:
no-store`. Database details and the token are not returned in errors.

## Access scope

Every token grants all SQL explorer access. A personal token names its holder
but adds no role checks or tenant-row filters. Distribute tokens only to people
authorized to access the entire allowed dataset, and require HTTPS. Remove a
personal token to revoke one holder; revoke the instance token by rotating it
or disabling `global.sqlApi.enabled`.
