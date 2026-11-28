{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging']
) }}

SELECT
    {{ zendesk_key(["JSONExtractRaw(payload, 'id')"]) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    {{ zendesk_id('payload', "'id'") }}                AS user_id,
    multiIf(
        JSONExtractString(payload, 'role') IN ('agent', 'admin'), 'agent',
        JSONExtractString(payload, 'role') = 'end-user',          'end_user',
        'system'
    )                                                  AS author_kind
FROM {{ zendesk_bronze('zendesk_users') }}
