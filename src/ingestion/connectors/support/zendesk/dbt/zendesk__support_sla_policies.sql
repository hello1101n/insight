{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_sla_policies']
) }}

WITH policy_metrics AS (
    SELECT
        tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS policy_id,
        JSONExtractString(payload, 'title')            AS title,
        toInt32(JSONExtractInt(payload, 'position'))   AS position,
        metric_json,
        collected_at
    FROM {{ zendesk_bronze('zendesk_sla_policies') }}
    ARRAY JOIN JSONExtractArrayRaw(payload, 'policy_metrics') AS metric_json
)

SELECT
    {{ zendesk_key(['policy_id', "JSONExtractString(metric_json, 'metric')", "JSONExtractString(metric_json, 'priority')"]) }} AS unique_key,
    tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    policy_id,
    title,
    position,
    replaceRegexpOne(JSONExtractString(metric_json, 'metric'), '_time$', '') AS metric,
    JSONExtractString(metric_json, 'priority')         AS priority,
    toInt32(JSONExtractInt(metric_json, 'target'))     AS target_minutes,
    toUInt8(JSONExtractBool(metric_json, 'business_hours')) AS business_hours,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM policy_metrics
