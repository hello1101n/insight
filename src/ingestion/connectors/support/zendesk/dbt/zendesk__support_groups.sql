{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_groups']
) }}

SELECT
    {{ zendesk_key([zendesk_id('payload', "'id'")]) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'id'") }}                AS group_id,
    JSONExtractString(payload, 'name')                 AS name,
    toUInt8(JSONExtractBool(payload, 'is_public'))     AS is_public,
    toUInt8(JSONExtractBool(payload, 'deleted'))       AS is_deleted,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM {{ zendesk_bronze('zendesk_groups') }}
