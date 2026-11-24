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
`auth: api_token`, upstream `http://{{ .Release.Name }}-analytics:8086`,
`timeoutMs: 40000`, and `sqlApiOnly: true`. It must also keep `/api/authenticator`
with `stripPrefix: true`.

For Docker Compose, set `SQL_API_ENABLED=true`, `SQL_API_TOKEN`, and
`CLICKHOUSE_MCP_PASSWORD` in your untracked environment file. Restart analytics
after changing the token. In Kubernetes, update the token Secret and roll the
analytics Deployment: environment-injected secrets are read only at startup.
During a rolling rotation, old and new pods may temporarily accept different tokens.

## Personal tokens

The authenticator service stores and manages personal tokens. It needs its
`database_url`; when it is empty, the token API answers 503.

An admin creates a token in **Manage → People & access → API tokens** for a
person in the tenant roster, with a label and a lifetime of 30 days, 90 days,
1 year (the default) or 2 years. The dialog shows the token once.

The admin API is `GET`, `POST` and `DELETE` on
`/api/authenticator/v1/api-tokens` with a session. Only an admin can call it.
`docs/components/backend/authenticator/openapi.json` has its contract.

The authenticator stores only the token's SHA-256 in MariaDB. A personal token
works until it expires or an admin removes it.

The gateway limits personal token lookups per client address. Behind an
ingress, set `gateway.gateway.setRealIpFrom` to the ingress address range, or
all clients share one limit.

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

Responses use canonical problem JSON for errors: 400 for invalid requests/SQL,
401 for missing or invalid tokens, 413 for oversized bodies or SQL, 429 for
query capacity, result-size, or database resource limits, 504 for query timeouts,
and 500 for other backend failures. Recognized database exceptions are classified
using [ClickHouse's numeric error codes](https://github.com/ClickHouse/ClickHouse/blob/master/src/Common/ErrorCodes.cpp);
unrecognized exceptions remain generic backend failures. Responses are marked `Cache-Control:
no-store`. Database details and the token are not returned in errors.

## Access scope

The instance token grants all SQL explorer access, not access on behalf of an
individual user. A personal token names its holder but adds no role checks or
tenant-row filters. Distribute tokens only to people authorized to access the
entire allowed dataset, and require HTTPS. Remove a personal token to revoke one
holder; revoke the instance token by rotating it or disabling
`global.sqlApi.enabled`.
