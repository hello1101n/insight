{{ config(
    materialized='incremental',
    unique_key='unique_key',
    incremental_strategy='delete+insert',
    on_schema_change='append_new_columns',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['slack', 'silver:class_collab_chat_activity']
) }}

{%- set members = adapter.get_relation(database=none, schema='bronze_slack', identifier='users') -%}

-- Slack daily chat activity per user, sourced from admin.analytics.getFile?type=member.
-- Bronze row is already one per (user, date); we simply reshape to the shared
-- class_collab_chat_activity schema. The analytics endpoint reports
-- `messages_posted_count` (every message the user sent) and
-- `channel_messages_posted_count` (the channel slice) but does NOT break out
-- DMs from MPIMs from channel-thread replies.
--
-- direct_messages / group_chat_messages stay NULL — true DM/MPIM separation
-- needs the message-stream content connector + `*:history` scopes.
--
-- direct_and_group_messages (#266): the analytics endpoint's
-- `total - channel` residual is exactly "everything the user posted outside
-- channels" = DMs + MPIMs (and counts as the natural Slack mirror of
-- m365's `privateChatMessageCount` plus group chats — except Slack DOES
-- surface group chats inside this residual, where m365 does not). Cross-
-- vendor comparison caveats are documented in silver/collaboration/schema.yml.
-- `greatest(0, …)` guards against any Slack analytics off-by-one that would
-- otherwise produce a negative residual.

SELECT
    u.insight_tenant_id AS insight_tenant_id,
    u.insight_source_id,
    MD5(concat(
        u.insight_tenant_id, '-',
        u.insight_source_id, '-',
        coalesce(u.user_id, ''), '-',
        toString(toDate(parseDateTimeBestEffortOrNull(u.date)))
    )) AS unique_key,
    u.user_id,
    toNullable(coalesce(u.email_address, '')) AS user_name,
    toNullable(coalesce(u.email_address, '')) AS email,
    if(coalesce(u.email_address, '') != '',
       lower(u.email_address),
       lower(u.user_id)) AS person_key,
    toDate(parseDateTimeBestEffortOrNull(u.date)) AS date,
    CAST(NULL AS Nullable(Int64)) AS direct_messages,
    CAST(NULL AS Nullable(Int64)) AS group_chat_messages,
    -- #266: total - channel = DMs + MPIMs (everything posted outside channels).
    toNullable(toInt64(greatest(
        assumeNotNull(u.messages_posted_count) - assumeNotNull(u.channel_messages_posted_count),
        0
    ))) AS direct_and_group_messages,
    assumeNotNull(u.messages_posted_count) AS total_chat_messages,
    u.channel_messages_posted_count AS channel_posts,
    CAST(NULL AS Nullable(Int64)) AS channel_replies,
    CAST(NULL AS Nullable(Int64)) AS urgent_messages,
    CAST(NULL AS Nullable(String)) AS report_period,
    toDateTime(u._airbyte_extracted_at) AS collected_at,
    'insight_slack' AS data_source,
    'slack' AS account_source_type,
    coalesce(u.insight_source_id, '') AS account_source_id,
    coalesce(u.user_id, '') AS account_id,
    toUnixTimestamp64Milli(now64()) AS _version
FROM {{ source('bronze_slack', 'users_details') }} AS u FINAL
WHERE u.user_id IS NOT NULL
  AND u.user_id != ''
  AND parseDateTimeBestEffortOrNull(u.date) IS NOT NULL
  -- Bronze columns are all Nullable (the destination NULLs what it cannot coerce),
  -- but Slack sends both counters on every row: a NULL is a broken row, not zero
  -- messages. Dropped here, reported by assert_slack_bronze_rows_reach_metrics.
  AND u.messages_posted_count IS NOT NULL
  AND u.channel_messages_posted_count IS NOT NULL
  -- INVARIANT: the class holds workspace members only — a proven guest is dropped,
  -- an unknown flag keeps the row. The analytics runtime counts that row only when
  -- the member resolves to a person; assert_slack_members_resolve reports
  -- a member that does not. `is_active` and `is_billable_seat` derive from
  -- activity (the latter is unreliable off invoiced plans): never filter on them.
  AND NOT coalesce(u.is_guest, false)
  -- INVARIANT: bots are never counted. Slackbot is USLACKBOT; the Members stream flags the others.
  AND u.user_id != 'USLACKBOT'
{%- if members %}
  AND (u.insight_tenant_id, u.insight_source_id, u.user_id) NOT IN (
      SELECT insight_tenant_id, insight_source_id, user_id
      FROM {{ source('bronze_slack', 'users') }} FINAL
      WHERE coalesce(is_bot, false)
  )
{%- endif %}
{% if is_incremental() %}
  -- INVARIANT: the window starts at the newest extract this model has already built for
  -- the source instance, so days extracted while runs failed are built on the next run.
  AND toDate(parseDateTimeBestEffortOrNull(u.date)) IN (
    SELECT DISTINCT toDate(parseDateTimeBestEffortOrNull(date))
    FROM {{ source('bronze_slack', 'users_details') }}
    WHERE _airbyte_extracted_at
          > {{ instance_incremental_watermark('collected_at', ['insight_tenant_id', 'insight_source_id'], ['insight_tenant_id', 'insight_source_id'], '3 DAY') }}
  )
{% endif %}
-- INVARIANT: one row per key in the batch; delete+insert keeps one row per key across runs.
ORDER BY u._airbyte_extracted_at DESC
LIMIT 1 BY unique_key
