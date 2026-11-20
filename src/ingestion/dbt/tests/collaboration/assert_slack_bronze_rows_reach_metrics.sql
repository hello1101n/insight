{%- set members = adapter.get_relation(database=none, schema='bronze_slack', identifier='users') -%}

{{ config(
    tags=['connector_quality', 'slack'],
    severity='warn',
    store_failures=true,
    meta={
        'title': 'Slack bronze rows the pipeline drops on the way to metrics',
        'domain': 'collab',
        'category': 'source_integrity',
        'tier': 'error',
        'remediation': 'problem=refused_day_row: a row with no user_id or no parseable date. The declarative connector (before the Python CDK rewrite) stored a day Slack refused with {"ok": false} this way; slack__collab_chat_activity drops it. Read the failing sync for the Slack error code, then delete the row from bronze_slack.users_details. The check reports the row on each sync until it is deleted. problem=missing_counter: Slack sent a member row without messages_posted_count or channel_messages_posted_count (or the destination NULLed it, see _airbyte_meta.changes); staging drops the row rather than read it as 0 messages, so that member-day is missing from metrics.'
    }
) }}
SELECT
    'refused_day_row' AS problem,
    unique_key,
    insight_tenant_id,
    insight_source_id,
    user_id,
    date
FROM {{ source('bronze_slack', 'users_details') }} FINAL
WHERE nullIf(user_id, '') IS NULL
   OR parseDateTimeBestEffortOrNull(date) IS NULL

UNION ALL

-- INVARIANT: same guest and bot filter as slack__collab_chat_activity. Staging drops
-- a guest or bot row anyway, so its counters do not matter.
SELECT
    'missing_counter' AS problem,
    u.unique_key,
    u.insight_tenant_id,
    u.insight_source_id,
    u.user_id,
    u.date
FROM {{ source('bronze_slack', 'users_details') }} AS u FINAL
WHERE nullIf(u.user_id, '') IS NOT NULL
  AND parseDateTimeBestEffortOrNull(u.date) IS NOT NULL
  AND (u.messages_posted_count IS NULL OR u.channel_messages_posted_count IS NULL)
  AND NOT coalesce(u.is_guest, false)
  AND u.user_id != 'USLACKBOT'
{%- if members %}
  AND (u.insight_tenant_id, u.insight_source_id, u.user_id) NOT IN (
      SELECT insight_tenant_id, insight_source_id, user_id
      FROM {{ source('bronze_slack', 'users') }} FINAL
      WHERE coalesce(is_bot, false)
  )
{%- endif %}
