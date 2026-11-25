{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_schedules']
) }}

SELECT
    {{ zendesk_key([zendesk_id('payload', "'id'")]) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'id'") }}                AS schedule_id,
    JSONExtractString(payload, 'name')                 AS name,
    JSONExtractString(payload, 'time_zone')            AS time_zone,
    JSONExtractRaw(payload, 'intervals')               AS weekly_intervals,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM {{ zendesk_bronze('zendesk_schedules') }}
