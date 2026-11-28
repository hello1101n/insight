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
{%- set analytics = adapter.get_relation(database=none, schema='bronze_slack', identifier='users_details') -%}

-- Slack daily chat activity per user on Free and Pro, built from message history
-- (bronze_slack.messages). The columns and the measures are the same as in
-- slack__collab_chat_activity, which reads the analytics file on Business+ and Enterprise.

WITH posted AS (
    SELECT
        {{ bronze_tenant() }} AS insight_tenant_id,
        insight_source_id,
        user_id,
        toDate(parseDateTimeBestEffortOrNull(date)) AS day,
        channel_type,
        _airbyte_extracted_at
    FROM {{ source('bronze_slack', 'messages') }} FINAL
    WHERE user_id IS NOT NULL
      AND user_id != ''
      -- INVARIANT: bots are never counted. A bot message has bot_id; Slackbot is USLACKBOT.
      AND coalesce(bot_id, '') = ''
      AND user_id != 'USLACKBOT'
      -- INVARIANT: only a message a member wrote counts. Joins, leaves and topic changes have other subtypes.
      AND (subtype IS NULL OR subtype IN ('thread_broadcast', 'file_share', 'me_message'))
      AND parseDateTimeBestEffortOrNull(date) IS NOT NULL
{% if is_incremental() %}
      -- INVARIANT: the window starts at the newest extract this model has already built for
      -- the source instance, so days extracted while runs failed are built on the next run.
      AND toDate(parseDateTimeBestEffortOrNull(date)) IN (
          SELECT DISTINCT toDate(parseDateTimeBestEffortOrNull(date))
          FROM {{ source('bronze_slack', 'messages') }}
          WHERE _airbyte_extracted_at
                > {{ instance_incremental_watermark('collected_at', ['insight_tenant_id', 'insight_source_id'], ['insight_tenant_id', 'insight_source_id'], '3 DAY') }}
      )
{% endif %}
),

member_days AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        user_id,
        day,
        count() AS total_chat_messages,
        countIf(channel_type IN ('public_channel', 'private_channel')) AS channel_posts,
        countIf(channel_type IN ('im', 'mpim')) AS direct_and_group_messages,
        max(_airbyte_extracted_at) AS extracted_at
    FROM posted
    GROUP BY
        insight_tenant_id,
        insight_source_id,
        user_id,
        day
),

{% if members %}
member_flags AS (
    SELECT
        {{ bronze_tenant() }} AS insight_tenant_id,
        insight_source_id,
        user_id,
        email,
        is_bot,
        is_restricted OR is_ultra_restricted AS is_guest
    FROM {{ source('bronze_slack', 'users') }} FINAL
),
{% else %}
member_flags AS (
    SELECT
        '' AS insight_tenant_id,
        '' AS insight_source_id,
        '' AS user_id,
        CAST(NULL AS Nullable(String)) AS email,
        CAST(NULL AS Nullable(Bool)) AS is_bot,
        CAST(NULL AS Nullable(Bool)) AS is_guest
    WHERE 0
),
{% endif %}

counted_days AS (
    SELECT
        d.insight_tenant_id,
        d.insight_source_id,
        d.user_id,
        d.day,
        d.total_chat_messages,
        d.channel_posts,
        d.direct_and_group_messages,
        d.extracted_at,
        m.email
    FROM member_days AS d
    LEFT JOIN member_flags AS m
        ON m.insight_tenant_id = d.insight_tenant_id
       AND m.insight_source_id = d.insight_source_id
       AND m.user_id = d.user_id
    -- INVARIANT: a proven guest or bot is dropped; a member that the members list does not know is kept.
    WHERE NOT coalesce(m.is_bot, false)
      AND NOT coalesce(m.is_guest, false)
{%- if analytics %}
      -- INVARIANT: the analytics file wins. A day it reports for a member is not counted again.
      AND (d.insight_tenant_id, d.insight_source_id, d.user_id, d.day) NOT IN (
          SELECT
              {{ bronze_tenant() }},
              insight_source_id,
              user_id,
              toDate(parseDateTimeBestEffortOrNull(date))
          FROM {{ source('bronze_slack', 'users_details') }} FINAL
          WHERE insight_source_id IS NOT NULL
            AND user_id IS NOT NULL
            AND parseDateTimeBestEffortOrNull(date) IS NOT NULL
      )
{%- endif %}
)

SELECT
    insight_tenant_id,
    insight_source_id,
    MD5(concat(
        insight_tenant_id, '-',
        insight_source_id, '-',
        user_id, '-',
        toString(day)
    )) AS unique_key,
    user_id,
    toNullable(coalesce(email, '')) AS user_name,
    toNullable(coalesce(email, '')) AS email,
    if(coalesce(email, '') != '',
       lower(email),
       lower(user_id)) AS person_key,
    day AS date,
    CAST(NULL AS Nullable(Int64)) AS direct_messages,
    CAST(NULL AS Nullable(Int64)) AS group_chat_messages,
    toNullable(toInt64(direct_and_group_messages)) AS direct_and_group_messages,
    toInt64(total_chat_messages) AS total_chat_messages,
    toNullable(toInt64(channel_posts)) AS channel_posts,
    CAST(NULL AS Nullable(Int64)) AS channel_replies,
    CAST(NULL AS Nullable(Int64)) AS urgent_messages,
    CAST(NULL AS Nullable(String)) AS report_period,
    toDateTime(extracted_at) AS collected_at,
    'insight_slack' AS data_source,
    'slack' AS account_source_type,
    coalesce(insight_source_id, '') AS account_source_id,
    coalesce(user_id, '') AS account_id,
    toUnixTimestamp64Milli(now64()) AS _version
FROM counted_days
