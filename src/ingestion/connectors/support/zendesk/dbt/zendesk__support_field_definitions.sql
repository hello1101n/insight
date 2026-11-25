{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_field_definitions']
) }}

SELECT
    {{ zendesk_key(['field_id']) }}                    AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'id'") }}                AS field_id,
    JSONExtractString(payload, 'type')                 AS type,
    JSONExtractString(payload, 'title')                AS title,
    toJSONString(arrayMap(
        o -> JSONExtractString(o, 'value'),
        JSONExtractArrayRaw(payload, 'custom_field_options')
    ))                                                 AS options,
    if(JSONExtractString(payload, 'type') IN ('multiselect', 'multi_lookup'), 'multi', 'single')
                                                       AS field_cardinality,
    toUInt8(JSONExtractBool(payload, 'active'))        AS is_active,
    {{ zendesk_time('payload', "'created_at'") }}      AS valid_from,
    CAST(NULL AS Nullable(DateTime64(3, 'UTC')))       AS valid_to,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM {{ zendesk_bronze('zendesk_ticket_fields') }}
