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
4. Ticket links to Jira issues come from the Zendesk Jira integration. An
   account without the integration gets empty link streams. For the Jira
   integration V2, copy its external ID from Admin Center → Apps and
   integrations → Integrations → Jira → Edit into `zendesk_jira_external_id`.

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
  zendesk_jira_external_id: ""
```

| Field | Required | Description |
|---|---|---|
| `zendesk_subdomain` | yes | `{subdomain}` of `{subdomain}.zendesk.com` |
| `zendesk_client_id` | yes | The OAuth client's identifier |
| `zendesk_secret` | yes | The OAuth client's secret |
| `zendesk_start_date` | no | Earliest day to read, `YYYY-MM-DD`. Empty reads the whole account, so every ticket keeps its `Create` event |
| `zendesk_jira_external_id` | no | External ID of the Jira integration V2. Empty skips the V2 links |

`insight_tenant_id`, `insight_source_id` and `unique_key` are added to every record
(`{insight_tenant_id}-{insight_source_id}-{id}`); do not put them in the Secret.

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
| `zendesk_jira_links` | `jira/links`, links of the original Jira integration | full refresh |
| `zendesk_jira_links_v2` | `integrations/jira/{external_id}/links`, links of the Jira integration V2 | full refresh |
| `zendesk_groups`, `zendesk_group_memberships`, `zendesk_ticket_fields`, `zendesk_ticket_forms`, `zendesk_custom_statuses`, `zendesk_brands`, `zendesk_sla_policies`, `zendesk_schedules`, `zendesk_deleted_tickets` | list endpoints | full refresh |

The incremental exports share one budget of 10 requests a minute per account;
a 429 waits for `Retry-After`. Every export re-reads one day behind its state,
and bronze deduplicates on `unique_key`.

## Silver targets

Staging parses `payload_json` into one model per class; each is tagged
`silver:class_support_*` and unioned into `silver/support/`.

| Class | Built from |
|---|---|
| `class_support_ticket_field_history` | ticket events (one row per field set), merge audits, deleted tickets |
| `class_support_tickets` | ticket snapshot, merge audits, deletions, the history's last `closed` |
| `class_support_interactions` | comment events |
| `class_support_sla_events`, `class_support_sla_policies` | ticket metric events, SLA policies |
| `class_support_satisfaction` | legacy ratings and survey responses in one score vocabulary |
| `class_support_agents`, `class_support_customers` | users by role, organizations |
| `class_support_groups`, `class_support_group_memberships` | groups, memberships |
| `class_support_field_definitions`, `class_support_schedules`, `class_support_kb_articles` | ticket fields, schedules, Help Center articles |
| `class_support_ticket_issue_links` | links of both Jira integration versions |

`zendesk__ticket_event_items` is the shared parse of the event export: one row
per field an update set, or per comment it added.
