{{ config(
    materialized='incremental',
    unique_key='unique_key',
    incremental_strategy='delete+insert',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['hubspot', 'silver:class_support_activity']
) }}

-- INVARIANT: column order and types follow zendesk__support_activity; union_by_tag is a positional UNION ALL.
WITH ticket_changes AS (
    SELECT
        tenant_id,
        source_id,
        object_id,
        field,
        value,
        changed_at,
        changed_by_user_id,
        change_source_type,
        _version,
        min(changed_at) OVER (PARTITION BY tenant_id, source_id, object_id, field) AS first_changed_at
    FROM {{ ref('hubspot__crm_field_history') }} FINAL
    WHERE object_type = 'tickets'
),

actors AS (
    SELECT
        tenant_id,
        source_id,
        hs_user_id,
        argMax({{ normalized_email('email') }}, _version) AS person_key
    FROM {{ ref('hubspot__crm_users') }} FINAL
    WHERE hs_user_id IS NOT NULL
    GROUP BY tenant_id, source_id, hs_user_id
),

closed_stages AS (
    SELECT DISTINCT
        tenant_id,
        source_id,
        stage_id
    FROM {{ ref('hubspot__crm_pipeline_stages') }} FINAL
    WHERE object_type = 'tickets'
      AND (is_closed = 1 OR ticket_state = 'CLOSED')
),

-- The first value of a property is the value the ticket was created with, not an edit.
edits AS (
    SELECT
        c.tenant_id,
        c.source_id,
        a.person_key,
        toDate(c.changed_at)                        AS date,
        c.object_id,
        c.changed_at,
        c.field = 'hs_pipeline_stage'
            AND (c.tenant_id, c.source_id, c.value) IN (SELECT tenant_id, source_id, stage_id FROM closed_stages) AS closes_ticket
    FROM ticket_changes AS c
    INNER JOIN actors AS a
        ON a.tenant_id = c.tenant_id
       AND a.source_id = c.source_id
       AND a.hs_user_id = c.changed_by_user_id
    WHERE c.changed_at > c.first_changed_at
      AND coalesce(c.change_source_type, '') != 'IMPORT'
      AND a.person_key != ''
)

SELECT
    tenant_id,
    source_id                                       AS insight_source_id,
    MD5(concat(tenant_id, '-', source_id, '-hubspot-', person_key, '-', toString(date))) AS unique_key,
    'hubspot'                                       AS data_source,
    person_key,
    person_key                                      AS email,
    date,
    -- One edit is every property one user changed on one ticket at one instant.
    uniqExactIf((object_id, changed_at), NOT closes_ticket) AS updates,
    CAST(NULL AS Nullable(UInt64))                  AS public_comments,
    CAST(NULL AS Nullable(UInt64))                  AS private_comments,
    uniqExactIf(object_id, closes_ticket)           AS solved,
    CAST(NULL AS Nullable(UInt32))                  AS kb_articles_created,
    CAST(NULL AS Nullable(UInt64))                  AS csat_good,
    CAST(NULL AS Nullable(UInt64))                  AS csat_total,
    now()                                           AS collected_at,
    toUnixTimestamp64Milli(now64())                 AS _version
FROM edits
{% if is_incremental() %}
WHERE (tenant_id, source_id, date) IN (
    SELECT tenant_id, source_id, toDate(changed_at)
    FROM ticket_changes
    WHERE fromUnixTimestamp64Milli(toInt64(_version)) > {{ instance_incremental_watermark('collected_at', ['tenant_id', 'source_id'], ['tenant_id', 'insight_source_id'], '3 DAY') }}
)
{% endif %}
GROUP BY tenant_id, source_id, person_key, date
