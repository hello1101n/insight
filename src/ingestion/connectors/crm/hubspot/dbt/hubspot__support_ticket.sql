{{ config(
    materialized='incremental',
    unique_key='unique_key',
    incremental_strategy='delete+insert',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['hubspot', 'silver:dim_support_ticket']
) }}

-- INVARIANT: column order and types follow zendesk__support_ticket; union_by_tag is a positional UNION ALL.
WITH tickets AS (
    SELECT
        tenant_id,
        insight_source_id,
        data_source,
        source_ticket_id,
        subject,
        status_canonical,
        priority_canonical,
        type_canonical,
        assignee_source_id,
        group_source_id,
        requester_source_id,
        org_source_id,
        created_at,
        updated_at,
        solved_at
    FROM {{ ref('hubspot__crm_tickets') }} FINAL
),

owners AS (
    SELECT
        tenant_id,
        source_id,
        user_id,
        argMax({{ normalized_email('email') }}, _version) AS person_key
    FROM {{ ref('hubspot__crm_users') }} FINAL
    GROUP BY tenant_id, source_id, user_id
)

SELECT
    t.tenant_id,
    t.insight_source_id,
    MD5(concat(t.tenant_id, '-', t.insight_source_id, '-', t.source_ticket_id)) AS unique_key,
    t.data_source,
    t.source_ticket_id,
    t.subject,
    t.status_canonical,
    t.priority_canonical,
    t.type_canonical,
    t.assignee_source_id,
    nullIf(o.person_key, '')                     AS assignee_person_key,
    t.group_source_id,
    t.requester_source_id,
    t.org_source_id,
    t.created_at,
    t.updated_at,
    t.solved_at,
    now()                                        AS collected_at,
    toUnixTimestamp64Milli(now64())              AS _version
FROM tickets AS t
LEFT JOIN owners AS o
    ON o.tenant_id = t.tenant_id
   AND o.source_id = t.insight_source_id
   AND o.user_id = t.assignee_source_id
