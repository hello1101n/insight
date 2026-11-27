{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_interactions']
) }}

WITH comments AS (
    SELECT
        tenant_id,
        insight_source_id,
        ticket_id,
        child_id,
        child,
        event_at,
        audit_via,
        collected_at
    FROM {{ ref('zendesk__ticket_event_items') }}
    WHERE child_event_type = 'Comment'
)

SELECT
    {{ zendesk_key(['c.child_id']) }}                  AS unique_key,
    c.tenant_id                                        AS tenant_id,
    c.insight_source_id                                AS insight_source_id,
    'zendesk'                                          AS data_source,
    c.child_id                                         AS interaction_id,
    c.ticket_id                                        AS ticket_id,
    {{ zendesk_id('c.child', "'author_id'") }}         AS author_id,
    if(author_id = '-1', 'system', coalesce(k.author_kind, 'system')) AS author_kind,
    toUInt8(JSONExtractBool(c.child, 'public'))        AS is_public,
    coalesce(nullIf(JSONExtractString(c.child, 'via', 'channel'), ''), lower(c.audit_via)) AS channel,
    coalesce({{ zendesk_time('c.child', "'created_at'") }}, c.event_at) AS occurred_at,
    c.collected_at                                     AS collected_at,
    {{ zendesk_version() }}                            AS _version
FROM comments AS c
LEFT JOIN {{ ref('zendesk__user_kinds') }} AS k
    ON k.tenant_id = c.tenant_id
   AND k.insight_source_id = c.insight_source_id
   AND k.user_id = {{ zendesk_id('c.child', "'author_id'") }}
