{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_customers']
) }}

WITH end_users AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS customer_id,
        'user'                                         AS kind,
        {{ zendesk_id('payload', "'organization_id'") }} AS organization_id,
        collected_at
    FROM {{ zendesk_bronze('zendesk_users') }}
    WHERE JSONExtractString(payload, 'role') = 'end-user'
),

organizations AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS customer_id,
        'organization'                                 AS kind,
        {{ zendesk_id('payload', "'id'") }}            AS organization_id,
        collected_at
    FROM {{ zendesk_bronze('zendesk_organizations') }}
),

customers AS (
    SELECT * FROM end_users
    UNION ALL
    SELECT * FROM organizations
)

SELECT
    {{ zendesk_key(['kind', 'customer_id']) }}         AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    customer_id,
    kind,
    organization_id,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM customers
