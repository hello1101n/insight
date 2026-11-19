{%- set members = adapter.get_relation(database=none, schema='bronze_slack', identifier='users') -%}

{{ config(
    tags=['connector_quality', 'slack'],
    severity='warn',
    store_failures=true,
    meta={
        'title': 'Slack bronze rows the pipeline drops on the way to metrics',
        'domain': 'collab',
        'category': 'source_integrity',
        'tier': 'warn',
        'remediation': 'problem=refused_day_row: a row with no user_id or no parseable date. The declarative connector (before the Python CDK rewrite) stored a day Slack refused with {"ok": false} this way; slack__collab_chat_activity drops it. Read the failing sync for the Slack error code, then delete the row from bronze_slack.users_details. problem=missing_counter: Slack sent a member row without messages_posted_count or channel_messages_posted_count (or the destination NULLed it, see _airbyte_meta.changes); staging drops the row rather than read it as 0 messages, so that member-day is missing from metrics. problem=unresolved_null_guest: a row with a NULL is_guest whose member resolves to no person, neither by an account binding nor by its email. Staging keeps the row, and the analytics runtime counts it only after the member resolves. Bind the Slack account to a person, or to the excluded person if it is a guest.'
    }
) }}
SELECT
    'refused_day_row' AS problem,
    unique_key,
    user_id,
    date,
    1 AS days
FROM {{ source('bronze_slack', 'users_details') }} FINAL
WHERE nullIf(user_id, '') IS NULL
   OR parseDateTimeBestEffortOrNull(date) IS NULL

UNION ALL

SELECT
    'missing_counter' AS problem,
    unique_key,
    user_id,
    date,
    1 AS days
FROM {{ source('bronze_slack', 'users_details') }} FINAL
WHERE nullIf(user_id, '') IS NOT NULL
  AND parseDateTimeBestEffortOrNull(date) IS NOT NULL
  AND (messages_posted_count IS NULL OR channel_messages_posted_count IS NULL)

UNION ALL

-- INVARIANT: same resolution order as the analytics runtime. A bound account
-- decides, also when it is bound to the excluded person; the email applies only to an unbound account.
SELECT
    'unresolved_null_guest' AS problem,
    u.unique_key,
    u.user_id,
    u.date,
    1 AS days
FROM {{ source('bronze_slack', 'users_details') }} AS u FINAL
WHERE u.is_guest IS NULL
  AND nullIf(u.user_id, '') IS NOT NULL
  AND parseDateTimeBestEffortOrNull(u.date) IS NOT NULL
  AND u.messages_posted_count IS NOT NULL
  AND u.channel_messages_posted_count IS NOT NULL
  AND u.user_id != 'USLACKBOT'
{%- if members %}
  AND (u.insight_tenant_id, u.insight_source_id, u.user_id) NOT IN (
      SELECT insight_tenant_id, insight_source_id, user_id
      FROM {{ source('bronze_slack', 'users') }} FINAL
      WHERE coalesce(is_bot, false)
  )
{%- endif %}
  AND (
      toUUID(UUIDNumToString(sipHash128(coalesce(u.insight_source_id, '')))),
      lower(trimBoth(u.user_id))
  ) NOT IN (
      SELECT source_id, account_id
      FROM ({{ resolve_person_id_by_account() }})
      WHERE source_type = 'slack'
  )
  AND lower(trimBoth(coalesce(u.email_address, ''))) NOT IN (
      SELECT email
      FROM ({{ resolve_person_id() }})
  )
