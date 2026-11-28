{%- set members = adapter.get_relation(database=none, schema='bronze_slack', identifier='users') -%}

{{ config(
    tags=['connector_quality', 'slack'],
    severity='warn',
    store_failures=true,
    meta={
        'title': 'Slack members whose activity resolves to no person',
        'domain': 'collab',
        'category': 'coverage',
        'tier': 'warn',
        'remediation': 'problem=unmapped_member: a member (is_guest false, not a bot) whose Slack account has no identity binding. One row per tenant, source and member; days is the number of Activity days. The account resolves only by its email, if another bound account carries the same email. Bind the account to a person in identity resolution, or to the excluded person for a service account. problem=unresolved_null_guest: a row with a NULL is_guest whose member resolves to no person, neither by an account binding nor by its email. Staging keeps the row, and the analytics runtime counts it only after the member resolves. Bind the Slack account to a person, or to the excluded person if it is a guest.'
    }
) }}
-- INVARIANT: the bot filter is the one in slack__collab_chat_activity. A bot sends no
-- identity input, so it has no binding and must not be reported.
SELECT
    'unmapped_member' AS problem,
    any(u.unique_key) AS unique_key,
    u.insight_tenant_id,
    u.insight_source_id,
    u.user_id,
    max(u.date) AS date,
    count() AS days
FROM {{ source('bronze_slack', 'users_details') }} AS u FINAL
WHERE nullIf(u.user_id, '') IS NOT NULL
  AND parseDateTimeBestEffortOrNull(u.date) IS NOT NULL
  AND u.messages_posted_count IS NOT NULL
  AND u.channel_messages_posted_count IS NOT NULL
  AND u.is_guest = false
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
      SELECT insight_source_id, account_id
      FROM ({{ resolve_person_id_by_account() }})
      WHERE source_type = 'slack'
  )
GROUP BY u.insight_tenant_id, u.insight_source_id, u.user_id

UNION ALL

-- INVARIANT: same resolution order as the analytics runtime. A bound account
-- decides, also when it is bound to the excluded person; the email applies only to an unbound account.
SELECT
    'unresolved_null_guest' AS problem,
    u.unique_key,
    u.insight_tenant_id,
    u.insight_source_id,
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
      SELECT insight_source_id, account_id
      FROM ({{ resolve_person_id_by_account() }})
      WHERE source_type = 'slack'
  )
  AND lower(trimBoth(coalesce(u.email_address, ''))) NOT IN (
      SELECT email
      FROM ({{ resolve_person_id() }})
  )
