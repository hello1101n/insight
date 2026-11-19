# Zendesk Connector

Reads Zendesk Support into `bronze_zendesk`: tickets, their full event history,
SLA metric events, both CSAT generations, users, organizations, dictionaries
and Help Center articles. Every record keeps the API object whole in
`payload_json`; staging parses it. Design and silver contract:
[DESIGN.md](../../../../../docs/domain/support/specs/DESIGN.md).

**API:** REST v2 at `https://{subdomain}.zendesk.com/api/v2/`.

**Auth:** OAuth client credentials. Zendesk no longer issues API tokens and
disables existing ones on 30 April 2027.

## Prerequisites

1. An administrator creates an OAuth client: Admin Center → Apps and
   integrations → APIs → OAuth clients → Add OAuth client.
   - **Client kind:** Confidential.
   - **Allowed scopes:** `read`.
   - Copy the secret when it is shown; it is shown once.
2. The client acts as the administrator who created it. The incremental
   exports, SLA policies and satisfaction data are admin-only, so a client
   created by an agent fails `check` with 403.
3. Survey CSAT and Help Center are optional products. An account without them
   gets empty streams, not an error.

## K8s Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: insight-zendesk-main
  namespace: insight
  labels:
    app.kubernetes.io/part-of: insight
  annotations:
    insight.cyberfabric.com/connector: zendesk
    insight.cyberfabric.com/source-id: zendesk-main
type: Opaque
stringData:
  zendesk_subdomain: "<your-subdomain>"
  zendesk_client_id: "<oauth-client-id>"
  zendesk_secret: "<oauth-client-secret>"
  zendesk_start_date: ""
```

| Field | Required | Description |
|---|---|---|
| `zendesk_subdomain` | yes | `{subdomain}` of `{subdomain}.zendesk.com` |
| `zendesk_client_id` | yes | The OAuth client's identifier |
| `zendesk_secret` | yes | The OAuth client's secret |
| `zendesk_start_date` | no | Earliest day to read, `YYYY-MM-DD`. Empty reads the whole account, so every ticket keeps its `Create` event |

`tenant_id`, `source_id` and `unique_key` are added to every record
(`{tenant_id}-{source_id}-{id}`); do not put them in the Secret.

Local development: copy `src/ingestion/secrets/connectors/zendesk.yaml.example`
to `zendesk.yaml` (gitignored), fill it in, run `./secrets/apply.sh`.

## Streams

| Stream | Endpoint | Sync |
|---|---|---|
| `zendesk_tickets` | `incremental/tickets/cursor.json`, with metric sets and AI-agent tickets | incremental on `updated_at` |
| `zendesk_ticket_events` | `incremental/ticket_events.json` with comments | incremental on `timestamp` |
| `zendesk_ticket_metric_events` | `incremental/ticket_metric_events.json` | incremental on `time` |
| `zendesk_users` | `incremental/users/cursor.json` | incremental on `updated_at` |
| `zendesk_organizations` | `incremental/organizations.json` | incremental on `updated_at` |
| `zendesk_csat_ratings` | `satisfaction_ratings` (legacy CSAT) | incremental on `created_at` |
| `zendesk_survey_responses` | `guide/survey_responses` (survey CSAT) | incremental on the latest answer |
| `zendesk_kb_articles` | `help_center/incremental/articles.json` | incremental on `updated_at` |
| `zendesk_merge_audits` | `tickets/{id}/audits.json` of tickets tagged `closed_by_merge`, merge audit only | incremental |
| `zendesk_groups`, `zendesk_group_memberships`, `zendesk_ticket_fields`, `zendesk_ticket_forms`, `zendesk_custom_statuses`, `zendesk_brands`, `zendesk_sla_policies`, `zendesk_schedules`, `zendesk_deleted_tickets` | list endpoints | full refresh |

The incremental exports share one budget of 10 requests a minute per account;
a 429 waits for `Retry-After`. Every export re-reads one day behind its state,
and bronze deduplicates on `unique_key`.

## Silver targets

None yet: the `class_support_*` contract of DESIGN.md §5 lands separately.
