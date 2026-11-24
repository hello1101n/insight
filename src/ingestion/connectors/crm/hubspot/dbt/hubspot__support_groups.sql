{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_groups']
) }}

WITH teams AS (
    SELECT
        {{ hubspot_support_scope() }},
        team_id,
        name,
        _version
    FROM {{ ref('hubspot__crm_teams') }} FINAL
)

SELECT
    {{ hubspot_support_key(['team_id']) }}             AS unique_key,
    tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    CAST(team_id AS Nullable(String))                  AS group_id,
    name,
    toUInt8(0)                                         AS is_public,
    toUInt8(0)                                         AS is_deleted,
    {{ hubspot_collected_at('_version') }}             AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM teams
