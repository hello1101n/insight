-- depends_on: {{ ref('jira__task_field_kind') }}
{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    query_settings={
        'query_plan_join_swap_table': 'false',
    },
    tags=['staging', 'jira', 'silver:class_task_field_current_text']
) }}

-- The current body of each long-text field of an issue, as the issue JSON holds
-- it (`adf_json`): a reference into `jira__task_field_text`. The history's newest
-- reference is Jira's changelog rendering once the field has changed, so this is
-- the only way to the exact current document. An empty field has no row.
--
-- MEMORY. The issue JSON streams on the left of every join, and the planner
-- may not swap it to the build side (#4370); the dedup is an `IN` filter.

WITH long_text_fields AS (
    SELECT tenant_id, insight_source_id, field_id
    FROM {{ ref('jira__task_field_kind') }}
    WHERE field_kind = 'long_text'
),

current_bodies AS (
    SELECT
        i.tenant_id                                       AS tenant_id,
        CAST(i.source_id AS String)                       AS insight_source_id,
        CAST(i.jira_id AS String)                         AS issue_id,
        kv.1                                              AS field_id,
        kv.2                                              AS content
    FROM {{ source('bronze_jira', 'jira_issue') }} AS i
    ARRAY JOIN JSONExtractKeysAndValuesRaw(COALESCE(i.custom_fields_json, '{}')) AS kv
    INNER JOIN long_text_fields AS f
        ON f.tenant_id = i.tenant_id
       AND f.insight_source_id = CAST(i.source_id AS String)
       AND f.field_id = kv.1
    WHERE kv.2 NOT IN ('', 'null', '""', '{}')
      -- Read-time dedup by the issue's stable key within a tenant's source.
      AND i._airbyte_raw_id IN (
          SELECT argMax(_airbyte_raw_id, _airbyte_extracted_at)
          FROM {{ source('bronze_jira', 'jira_issue') }}
          GROUP BY tenant_id, source_id, jira_id
      )
)

SELECT
    concat(ifNull(tenant_id, ''), '-', insight_source_id, '-jira-', issue_id, '-', field_id) AS unique_key,
    ifNull(tenant_id, '')                                 AS tenant_id,
    insight_source_id,
    CAST('jira' AS String)                                AS data_source,
    issue_id,
    field_id,
    {{ task_text_id('content') }}                         AS text_id,
    toUInt64(toUnixTimestamp64Milli(now64(3)))            AS _version
FROM current_bodies
