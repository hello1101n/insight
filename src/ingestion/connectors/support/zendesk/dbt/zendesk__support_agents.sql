{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_agents']
) }}

SELECT
    {{ zendesk_key([zendesk_id('payload', "'id'")]) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'id'") }}                AS agent_id,
    lower(JSONExtractString(payload, 'email'))         AS email,
    JSONExtractString(payload, 'role')                 AS role,
    toUInt8(JSONExtractBool(payload, 'active') AND NOT JSONExtractBool(payload, 'suspended')) AS is_active,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM {{ zendesk_bronze('zendesk_users') }}
WHERE JSONExtractString(payload, 'role') IN ('agent', 'admin')
