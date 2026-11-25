{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_field_definitions']
) }}

WITH ticket_properties AS (
    SELECT
        {{ hubspot_support_scope() }},
        name,
        label,
        type,
        field_type,
        options,
        is_deleted,
        created_at,
        _version
    FROM {{ ref('hubspot__crm_property_definitions') }} FINAL
    WHERE object_type = 'tickets'
)

SELECT
    {{ hubspot_support_key(['name']) }}                AS unique_key,
    tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    name                                               AS field_id,
    coalesce(field_type, type, '')                     AS type,
    coalesce(label, '')                                AS title,
    toJSONString(mapKeys(options))                     AS options,
    if(field_type = 'checkbox' AND type = 'enumeration', 'multi', 'single') AS field_cardinality,
    toUInt8(is_deleted = 0)                            AS is_active,
    {{ hubspot_support_time('created_at') }}           AS valid_from,
    {{ hubspot_support_time('NULL') }}                 AS valid_to,
    {{ hubspot_collected_at('_version') }}             AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM ticket_properties
