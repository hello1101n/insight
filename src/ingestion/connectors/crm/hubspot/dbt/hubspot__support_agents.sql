{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_agents']
) }}

WITH owners AS (
    SELECT
        {{ hubspot_support_scope() }},
        user_id,
        email,
        is_active,
        _version
    FROM {{ ref('hubspot__crm_users') }} FINAL
)

SELECT
    {{ hubspot_support_key(['user_id']) }}             AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    user_id                                            AS agent_id,
    lower(coalesce(email, ''))                         AS email,
    'agent'                                            AS role,
    toUInt8(coalesce(is_active, 0) = 1)                AS is_active,
    {{ hubspot_collected_at('_version') }}             AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM owners
