{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_tickets']
) }}

WITH tickets AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        payload,
        {{ zendesk_id('payload', "'id'") }}            AS ticket_id,
        JSONExtract(payload, 'tags', 'Array(String)')  AS tags,
        collected_at
    FROM {{ zendesk_bronze('zendesk_tickets') }}
),

merge_targets AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        argMax(
            {{ zendesk_id("JSONExtractRaw(payload, 'via', 'source', 'from')", "'ticket_id'") }},
            {{ zendesk_time('payload', "'created_at'") }}
        )                                              AS merged_into_id
    FROM {{ zendesk_bronze('zendesk_merge_audits') }}
    GROUP BY insight_tenant_id, insight_source_id, ticket_id
),

deleted AS (
    SELECT DISTINCT insight_tenant_id, insight_source_id, {{ zendesk_id('payload', "'id'") }} AS ticket_id
    FROM {{ zendesk_bronze('zendesk_deleted_tickets') }}
),

closed AS (
    SELECT insight_tenant_id, insight_source_id, ticket_id, max(event_at) AS closed_at
    FROM {{ ref('zendesk__support_ticket_field_history') }}
    WHERE field_id = 'status' AND value = '"closed"'
    GROUP BY insight_tenant_id, insight_source_id, ticket_id
)

SELECT
    {{ zendesk_key(['t.ticket_id']) }}                 AS unique_key,
    t.insight_tenant_id                                        AS insight_tenant_id,
    t.insight_source_id                                AS insight_source_id,
    'zendesk'                                          AS data_source,
    t.ticket_id                                        AS ticket_id,
    coalesce({{ zendesk_text('t.payload', "'support_type'") }}, 'agent') AS support_type,
    JSONExtractString(t.payload, 'status')             AS status_raw,
    multiIf(status_raw = 'hold', 'on_hold', status_raw = 'deleted', 'closed', status_raw) AS status,
    {{ zendesk_text('t.payload', "'priority'") }}      AS priority,
    {{ zendesk_text('t.payload', "'type'") }}          AS type,
    JSONExtractString(t.payload, 'via', 'channel')     AS channel,
    {{ zendesk_id('t.payload', "'brand_id'") }}        AS brand_id,
    {{ zendesk_id('t.payload', "'ticket_form_id'") }}  AS form_id,
    {{ zendesk_id('t.payload', "'requester_id'") }}    AS requester_id,
    {{ zendesk_id('t.payload', "'organization_id'") }} AS organization_id,
    {{ zendesk_id('t.payload', "'assignee_id'") }}     AS assignee_id,
    {{ zendesk_id('t.payload', "'group_id'") }}        AS group_id,
    {{ zendesk_time('t.payload', "'created_at'") }}    AS created_at,
    {{ zendesk_time("JSONExtractRaw(t.payload, 'metric_set')", "'solved_at'") }} AS solved_at,
    c.closed_at                                        AS closed_at,
    multiIf(
        d.ticket_id IS NOT NULL OR status_raw = 'deleted', 'deleted',
        m.ticket_id IS NOT NULL OR has(t.tags, 'closed_by_merge'), 'merged',
        'present'
    )                                                  AS availability,
    m.merged_into_id                                   AS merged_into_id,
    concat('{', arrayStringConcat(arrayFilter(
        x -> x != '',
        arrayMap(
            f -> if(JSONExtractRaw(f, 'value') IN ('', 'null'), '',
                    concat(toJSONString(toString(JSONExtractUInt(f, 'id'))), ':', JSONExtractRaw(f, 'value'))),
            JSONExtractArrayRaw(t.payload, 'custom_fields')
        )
    ), ','), '}')                                      AS custom_attrs,
    t.collected_at                                     AS collected_at,
    {{ zendesk_version() }}                            AS _version
FROM tickets AS t
LEFT JOIN merge_targets AS m
    ON m.insight_tenant_id = t.insight_tenant_id AND m.insight_source_id = t.insight_source_id AND m.ticket_id = t.ticket_id
LEFT JOIN deleted AS d
    ON d.insight_tenant_id = t.insight_tenant_id AND d.insight_source_id = t.insight_source_id AND d.ticket_id = t.ticket_id
LEFT JOIN closed AS c
    ON c.insight_tenant_id = t.insight_tenant_id AND c.insight_source_id = t.insight_source_id AND c.ticket_id = t.ticket_id
