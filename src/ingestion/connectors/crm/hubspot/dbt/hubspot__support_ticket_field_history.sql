{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_ticket_field_history']
) }}

-- HubSpot keeps history only for the properties in tickets_property_history.
-- A stage change also yields a `status` row whenever the stage moves the
-- ticket between open and closed, so the contract's status field stays
-- vendor-neutral. One update is all changes of one user at one instant.

WITH owners AS (
    SELECT
        {{ hubspot_support_scope() }},
        hs_user_id,
        user_id
    FROM {{ ref('hubspot__crm_users') }} FINAL
    WHERE hs_user_id IS NOT NULL
),

stages AS (
    SELECT
        {{ hubspot_support_scope() }},
        stage_id,
        if(ticket_state = 'CLOSED' OR is_closed = 1, 'closed', 'open') AS stage_status
    FROM {{ ref('hubspot__crm_pipeline_stages') }} FINAL
    WHERE object_type = 'tickets'
),

property_changes AS (
    SELECT
        {{ hubspot_support_scope() }},
        object_id                                      AS ticket_id,
        unique_key                                     AS change_key,
        field                                          AS property,
        nullIf(value, '')                              AS raw_value,
        {{ hubspot_support_time('changed_at') }}       AS event_at,
        change_source_type,
        changed_by_user_id,
        _version
    FROM {{ ref('hubspot__crm_field_history') }} FINAL
    WHERE object_type = 'tickets'
      AND field IN ('hs_pipeline_stage', 'hs_pipeline', 'hubspot_owner_id', 'hs_ticket_priority')
),

attributed AS (
    SELECT
        c.insight_tenant_id                                    AS insight_tenant_id,
        c.insight_source_id                            AS insight_source_id,
        c.ticket_id                                    AS ticket_id,
        c.change_key                                   AS change_key,
        c.property                                     AS property,
        multiIf(
            c.property = 'hs_ticket_priority' AND lower(c.raw_value) = 'medium', 'normal',
            c.property = 'hs_ticket_priority', lower(c.raw_value),
            c.raw_value
        )                                              AS property_value,
        if(c.property = 'hs_pipeline_stage', nullIf(s.stage_status, ''), NULL) AS stage_status,
        c.event_at                                     AS event_at,
        concat(c.ticket_id, '-', toString(toUnixTimestamp64Milli(c.event_at)), '-', coalesce(c.changed_by_user_id, ''))
                                                       AS event_id,
        o.user_id                                      AS actor_id,
        coalesce(c.change_source_type, '')             AS channel,
        c._version                                     AS source_version
    FROM property_changes AS c
    LEFT JOIN owners AS o
        ON o.insight_tenant_id = c.insight_tenant_id AND o.insight_source_id = c.insight_source_id AND o.hs_user_id = c.changed_by_user_id
    LEFT JOIN stages AS s
        ON s.insight_tenant_id = c.insight_tenant_id AND s.insight_source_id = c.insight_source_id AND s.stage_id = c.raw_value
),

sequenced AS (
    SELECT
        *,
        (row_number() OVER by_property) = 1            AS is_first,
        lagInFrame(property_value) OVER by_property    AS previous_property_value,
        lagInFrame(stage_status) OVER by_property      AS previous_stage_status
    FROM attributed
    WINDOW by_property AS (
        PARTITION BY insight_tenant_id, insight_source_id, ticket_id, property
        ORDER BY event_at, change_key
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
),

property_rows AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        ticket_id,
        event_id,
        property                                       AS child_key,
        if(is_first, 'initial', 'change')              AS event_kind,
        multiIf(property = 'hubspot_owner_id', 'assignee_id', property = 'hs_ticket_priority', 'priority', property)
                                                       AS field_id,
        if(property_value IS NULL, 'null', toJSONString(property_value)) AS value,
        if(is_first, NULL, if(previous_property_value IS NULL, 'null', toJSONString(previous_property_value)))
                                                       AS previous_value,
        event_at,
        actor_id,
        channel,
        source_version
    FROM sequenced
),

status_rows AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        ticket_id,
        event_id,
        'status'                                       AS child_key,
        if(is_first, 'initial', 'change')              AS event_kind,
        'status'                                       AS field_id,
        toJSONString(stage_status)                     AS value,
        if(is_first, NULL, toJSONString(previous_stage_status)) AS previous_value,
        event_at,
        actor_id,
        channel,
        source_version
    FROM sequenced
    WHERE property = 'hs_pipeline_stage'
      AND stage_status IS NOT NULL
      AND (is_first OR previous_stage_status IS NULL OR stage_status != previous_stage_status)
),

tickets AS (
    SELECT
        {{ hubspot_support_scope('insight_source_id') }},
        source_ticket_id                               AS ticket_id,
        is_deleted,
        deleted_at,
        properties['hs_merged_object_ids']             AS merged_object_ids,
        _version
    FROM {{ ref('hubspot__crm_tickets') }} FINAL
),

merged_away AS (
    SELECT DISTINCT insight_tenant_id, insight_source_id, merged_id AS ticket_id
    FROM tickets
    ARRAY JOIN splitByChar(';', merged_object_ids) AS merged_id
    WHERE merged_id != ''
),

availability_rows AS (
    SELECT
        t.insight_tenant_id                                    AS insight_tenant_id,
        t.insight_source_id                            AS insight_source_id,
        t.ticket_id                                    AS ticket_id,
        concat(if(m.ticket_id != '', 'merged-', 'deleted-'), t.ticket_id) AS event_id,
        'availability'                                 AS child_key,
        'availability'                                 AS event_kind,
        'availability'                                 AS field_id,
        if(m.ticket_id != '', '"merged"', '"deleted"') AS value,
        CAST('"present"' AS Nullable(String))          AS previous_value,
        {{ hubspot_support_time('t.deleted_at') }}     AS event_at,
        CAST(NULL AS Nullable(String))                 AS actor_id,
        if(m.ticket_id != '', 'Merge', 'Delete')       AS channel,
        t._version                                     AS source_version
    FROM tickets AS t
    LEFT JOIN merged_away AS m
        ON m.insight_tenant_id = t.insight_tenant_id AND m.insight_source_id = t.insight_source_id AND m.ticket_id = t.ticket_id
    WHERE t.is_deleted = 1
),

events AS (
    SELECT * FROM property_rows
    UNION ALL
    SELECT * FROM status_rows
    UNION ALL
    SELECT * FROM availability_rows
)

SELECT
    {{ hubspot_support_key(['ticket_id', 'field_id', 'event_id', 'child_key']) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    CAST(ticket_id AS Nullable(String))                AS ticket_id,
    CAST(event_id AS Nullable(String))                 AS event_id,
    event_kind,
    coalesce(field_id, '')                             AS field_id,
    'single'                                           AS field_cardinality,
    coalesce(value, 'null')                            AS value,
    CAST(previous_value AS Nullable(String))           AS previous_value,
    event_at,
    toInt64(row_number() OVER (
        PARTITION BY insight_tenant_id, insight_source_id, ticket_id
        ORDER BY event_at, event_id, field_id
    ))                                                 AS event_order,
    CAST(actor_id AS Nullable(String))                 AS actor_id,
    if(actor_id IS NULL, 'system', 'agent')            AS actor_kind,
    channel,
    {{ hubspot_collected_at('source_version') }}       AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM events
