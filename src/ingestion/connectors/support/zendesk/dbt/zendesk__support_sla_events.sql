{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_sla_events']
) }}

-- Zendesk's reply_time is the first reply on instance 1 and every next reply after it.

WITH events AS (
    SELECT
        tenant_id,
        insight_source_id,
        payload,
        JSONExtractString(payload, 'metric')           AS vendor_metric,
        toInt32(JSONExtractInt(payload, 'instance_id')) AS instance_id,
        JSONExtractString(payload, 'type')             AS vendor_type,
        collected_at
    FROM {{ zendesk_bronze('zendesk_ticket_metric_events') }}
)

SELECT
    {{ zendesk_key([zendesk_id('payload', "'id'")]) }} AS unique_key,
    tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    {{ zendesk_id('payload', "'ticket_id'") }}         AS ticket_id,
    multiIf(
        vendor_metric = 'reply_time' AND instance_id <= 1, 'first_reply',
        vendor_metric = 'reply_time',                      'next_reply',
        vendor_metric = 'periodic_update_time',            'periodic_update',
        vendor_metric = 'pausable_update_time',            'pausable_update',
        vendor_metric = 'requester_wait_time',             'requester_wait',
        vendor_metric = 'agent_work_time',                 'agent_work',
        vendor_metric = 'resolution_time',                 'resolution',
        vendor_metric = 'group_ownership_time',            'group_ownership',
        vendor_metric
    )                                                  AS metric,
    instance_id,
    if(vendor_type IN ('apply_sla', 'apply_group_sla'), 'apply', vendor_type) AS event_type,
    toUInt8(JSONExtractBool(payload, 'deleted'))       AS is_cancelled,
    if(JSONHas(payload, 'sla'), toInt32(JSONExtractInt(payload, 'sla', 'target')), NULL)
                                                       AS target_minutes,
    if(JSONHas(payload, 'sla'), toUInt8(JSONExtractBool(payload, 'sla', 'business_hours')), NULL)
                                                       AS business_hours,
    {{ zendesk_id("JSONExtractRaw(payload, 'sla', 'policy')", "'id'") }} AS policy_id,
    {{ zendesk_time('payload', "'time'") }}            AS occurred_at,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM events
