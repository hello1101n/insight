{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_ticket_field_history']
) }}

-- Values are JSON. A multi-select arrives as one space-separated string of its
-- whole set (DESIGN.md §4) and is split into an array; `tags` already is one.

WITH custom_cardinality AS (
    SELECT tenant_id, insight_source_id, field_id, field_cardinality
    FROM {{ ref('zendesk__support_field_definitions') }}
),

field_changes AS (
    SELECT
        i.tenant_id                                    AS tenant_id,
        i.insight_source_id                            AS insight_source_id,
        i.ticket_id                                    AS ticket_id,
        i.audit_id                                     AS event_id,
        coalesce(i.child_id, toString(i.child_index))  AS child_key,
        i.child_index                                  AS child_index,
        if(i.child_event_type = 'Create', 'initial', 'change') AS event_kind,
        i.field_key                                    AS field_id,
        multiIf(i.field_key = 'tags', 'multi', i.is_custom_field, coalesce(d.field_cardinality, 'single'), 'single')
                                                       AS field_cardinality,
        i.value_raw                                    AS value_raw,
        i.previous_value_raw                           AS previous_value_raw,
        i.event_at                                     AS event_at,
        i.updater_id                                   AS actor_id,
        i.audit_via                                    AS channel,
        i.collected_at                                 AS collected_at
    FROM {{ ref('zendesk__ticket_event_items') }} AS i
    LEFT JOIN custom_cardinality AS d
        ON d.tenant_id = i.tenant_id
       AND d.insight_source_id = i.insight_source_id
       AND d.field_id = i.field_key
    WHERE i.child_event_type IN ('Create', 'Change')
),

merges AS (
    SELECT
        tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        {{ zendesk_id('payload', "'id'") }}            AS event_id,
        'availability'                                 AS child_key,
        toUInt32(0)                                    AS child_index,
        'availability'                                 AS event_kind,
        'availability'                                 AS field_id,
        'single'                                       AS field_cardinality,
        '"merged"'                                     AS value_raw,
        '"present"'                                    AS previous_value_raw,
        {{ zendesk_time('payload', "'created_at'") }}  AS event_at,
        {{ zendesk_id('payload', "'author_id'") }}     AS actor_id,
        'Merge'                                        AS channel,
        collected_at
    FROM {{ zendesk_bronze('zendesk_merge_audits') }}
),

deletions AS (
    SELECT
        tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS ticket_id,
        concat('deleted-', {{ zendesk_id('payload', "'id'") }}) AS event_id,
        'availability'                                 AS child_key,
        toUInt32(0)                                    AS child_index,
        'availability'                                 AS event_kind,
        'availability'                                 AS field_id,
        'single'                                       AS field_cardinality,
        '"deleted"'                                    AS value_raw,
        '"present"'                                    AS previous_value_raw,
        {{ zendesk_time('payload', "'deleted_at'") }}  AS event_at,
        {{ zendesk_id("JSONExtractRaw(payload, 'actor')", "'id'") }} AS actor_id,
        'Delete'                                       AS channel,
        collected_at
    FROM {{ zendesk_bronze('zendesk_deleted_tickets') }}
),

events AS (
    SELECT * FROM field_changes
    UNION ALL
    SELECT * FROM merges
    UNION ALL
    SELECT * FROM deletions
)

SELECT
    {{ zendesk_key(['e.ticket_id', 'e.field_id', 'e.event_id', 'e.child_key']) }} AS unique_key,
    e.tenant_id                                        AS tenant_id,
    e.insight_source_id                                AS insight_source_id,
    'zendesk'                                          AS data_source,
    e.ticket_id                                        AS ticket_id,
    e.event_id                                         AS event_id,
    e.event_kind                                       AS event_kind,
    e.field_id                                         AS field_id,
    e.field_cardinality                                AS field_cardinality,
    if(e.field_cardinality = 'multi' AND JSONType(e.value_raw) = 'String',
       toJSONString(splitByChar(' ', JSONExtractString(e.value_raw))),
       e.value_raw)                                    AS value,
    if(e.field_cardinality = 'multi' AND JSONType(e.previous_value_raw) = 'String',
       toJSONString(splitByChar(' ', JSONExtractString(e.previous_value_raw))),
       nullIf(e.previous_value_raw, ''))               AS previous_value,
    e.event_at                                         AS event_at,
    toInt64(row_number() OVER (
        PARTITION BY e.tenant_id, e.insight_source_id, e.ticket_id
        ORDER BY e.event_at, toUInt64OrZero(e.event_id), e.child_index, e.field_id
    ))                                                 AS event_order,
    e.actor_id                                         AS actor_id,
    if(e.actor_id = '-1', 'system', coalesce(k.author_kind, 'system')) AS actor_kind,
    e.channel                                          AS channel,
    e.collected_at                                     AS collected_at,
    {{ zendesk_version() }}                            AS _version
FROM events AS e
LEFT JOIN {{ ref('zendesk__user_kinds') }} AS k
    ON k.tenant_id = e.tenant_id
   AND k.insight_source_id = e.insight_source_id
   AND k.user_id = e.actor_id
