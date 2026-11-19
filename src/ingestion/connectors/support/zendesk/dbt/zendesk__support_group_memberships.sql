{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_group_memberships']
) }}

SELECT
    {{ zendesk_key([zendesk_id('payload', "'id'")]) }} AS unique_key,
    tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'id'") }}                AS membership_id,
    {{ zendesk_id('payload', "'user_id'") }}           AS agent_id,
    {{ zendesk_id('payload', "'group_id'") }}          AS group_id,
    toUInt8(JSONExtractBool(payload, 'default'))       AS is_default,
    {{ zendesk_time('payload', "'created_at'") }}      AS valid_from,
    CAST(NULL AS Nullable(DateTime64(3, 'UTC')))       AS valid_to,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM {{ zendesk_bronze('zendesk_group_memberships') }}
