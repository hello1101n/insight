{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_tickets']
) }}

-- HubSpot knows only open and closed: a stage is closed when its ticket state
-- is CLOSED. The pipeline stage id is the vendor status.

WITH tickets AS (
    SELECT
        {{ hubspot_support_scope('insight_source_id') }},
        source_ticket_id                               AS ticket_id,
        status_canonical,
        priority_canonical,
        type_canonical,
        source_type,
        requester_source_id,
        org_source_id,
        assignee_source_id,
        group_source_id,
        created_at,
        solved_at,
        stage_id,
        is_deleted,
        properties,
        collected_at
    FROM {{ ref('hubspot__crm_tickets') }} FINAL
),

stages AS (
    SELECT
        {{ hubspot_support_scope() }},
        stage_id,
        if(ticket_state = 'CLOSED' OR is_closed = 1, 'closed', 'open') AS stage_status
    FROM {{ ref('hubspot__crm_pipeline_stages') }} FINAL
    WHERE object_type = 'tickets'
),

merge_targets AS (
    SELECT insight_tenant_id, insight_source_id, merged_id, any(ticket_id) AS merged_into_id
    FROM tickets
    ARRAY JOIN splitByChar(';', properties['hs_merged_object_ids']) AS merged_id
    WHERE merged_id != ''
    GROUP BY insight_tenant_id, insight_source_id, merged_id
),

custom_properties AS (
    SELECT
        {{ hubspot_support_scope() }},
        groupArray(name)                               AS names
    FROM {{ ref('hubspot__crm_property_definitions') }} FINAL
    WHERE object_type = 'tickets' AND is_custom = 1 AND name IS NOT NULL
    GROUP BY insight_tenant_id, insight_source_id
)

SELECT
    {{ hubspot_support_key(['t.ticket_id']) }}         AS unique_key,
    t.insight_tenant_id                                        AS insight_tenant_id,
    t.insight_source_id                                AS insight_source_id,
    'hubspot'                                          AS data_source,
    t.ticket_id                                        AS ticket_id,
    'agent'                                            AS support_type,
    coalesce(t.stage_id, '')                           AS status_raw,
    coalesce(nullIf(s.stage_status, ''), t.status_canonical, 'open') AS status,
    nullIf(t.priority_canonical, '')                   AS priority,
    nullIf(t.type_canonical, '')                       AS type,
    lower(coalesce(t.source_type, ''))                 AS channel,
    CAST(NULL AS Nullable(String))                     AS brand_id,
    CAST(NULL AS Nullable(String))                     AS form_id,
    t.requester_source_id                              AS requester_id,
    t.org_source_id                                    AS organization_id,
    t.assignee_source_id                               AS assignee_id,
    t.group_source_id                                  AS group_id,
    {{ hubspot_support_time('t.created_at') }}         AS created_at,
    {{ hubspot_support_time('t.solved_at') }}          AS solved_at,
    {{ hubspot_support_time("if(status = 'closed', t.solved_at, NULL)") }} AS closed_at,
    multiIf(
        m.merged_id != '', 'merged',
        t.is_deleted = 1, 'deleted',
        'present'
    )                                                  AS availability,
    nullIf(m.merged_into_id, '')                       AS merged_into_id,
    -- The custom keys first, then their values: mapFilter with has(c.names, k) copies the names
    -- array for every map entry and ran past 14 GiB on dev. Keys come out sorted.
    toJSONString(mapFromArrays(
        arraySort(arrayIntersect(mapKeys(t.properties), c.names)) AS custom_keys,
        arrayMap(k -> t.properties[k], custom_keys)
    ))                                                 AS custom_attrs,
    CAST(t.collected_at AS DateTime64(3))              AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM tickets AS t
LEFT JOIN stages AS s
    ON s.insight_tenant_id = t.insight_tenant_id AND s.insight_source_id = t.insight_source_id AND s.stage_id = t.stage_id
LEFT JOIN merge_targets AS m
    ON m.insight_tenant_id = t.insight_tenant_id AND m.insight_source_id = t.insight_source_id AND m.merged_id = t.ticket_id
LEFT JOIN custom_properties AS c
    ON c.insight_tenant_id = t.insight_tenant_id AND c.insight_source_id = t.insight_source_id
