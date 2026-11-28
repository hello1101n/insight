{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_group_memberships']
) }}

-- HubSpot gives only the current teams of an owner, so the interval of a
-- membership has no known start.

WITH memberships AS (
    SELECT
        {{ hubspot_support_scope() }},
        user_id,
        team_id,
        primary_team_id,
        _version
    FROM {{ ref('hubspot__crm_users') }} FINAL
    ARRAY JOIN team_ids AS team_id
    WHERE team_id != ''
)

SELECT
    {{ hubspot_support_key(['user_id', 'team_id']) }}  AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    CAST(concat(coalesce(user_id, ''), '-', team_id) AS Nullable(String)) AS membership_id,
    user_id                                            AS agent_id,
    CAST(team_id AS Nullable(String))                  AS group_id,
    toUInt8(team_id = coalesce(primary_team_id, ''))   AS is_default,
    {{ hubspot_support_time('NULL') }}                 AS valid_from,
    {{ hubspot_support_time('NULL') }}                 AS valid_to,
    {{ hubspot_collected_at('_version') }}             AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM memberships
