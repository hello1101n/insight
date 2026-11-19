{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging']
) }}

-- An export record is one ticket update; its child events name the field they
-- set by key (`{"status": "open"}`) or, for custom fields, inside
-- `custom_ticket_fields`. DESIGN.md §3 "Event layout".

WITH audits AS (
    SELECT
        tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        {{ zendesk_id('payload', "'id'") }}            AS audit_id,
        {{ zendesk_time('payload', "'created_at'") }}  AS event_at,
        {{ zendesk_id('payload', "'updater_id'") }}    AS updater_id,
        JSONExtractString(payload, 'via')              AS audit_via,
        JSONExtractArrayRaw(payload, 'child_events')   AS children,
        collected_at
    FROM {{ zendesk_bronze('zendesk_ticket_events') }}
),

children AS (
    SELECT
        tenant_id,
        insight_source_id,
        ticket_id,
        audit_id,
        event_at,
        updater_id,
        audit_via,
        entry.1                                        AS child_index,
        entry.2                                        AS child,
        JSONExtractString(entry.2, 'event_type')       AS child_event_type,
        collected_at
    FROM audits
    ARRAY JOIN arrayZip(arrayEnumerate(children), children) AS entry
),

fields_set AS (
    SELECT
        *,
        arrayFilter(
            k -> k NOT IN ('id', 'via', 'via_reference_id', 'event_type', 'previous_value', 'added_tags', 'removed_tags'),
            JSONExtractKeys(child)
        ) AS field_keys
    FROM children
)

SELECT
    {{ zendesk_key(['audit_id', "coalesce(" ~ zendesk_id('child', "'id'") ~ ", toString(child_index))", 'field.1']) }} AS unique_key,
    tenant_id,
    insight_source_id,
    ticket_id,
    audit_id,
    {{ zendesk_id('child', "'id'") }}                  AS child_id,
    toUInt32(child_index)                              AS child_index,
    event_at,
    updater_id,
    audit_via,
    child_event_type,
    has(field_keys, 'custom_ticket_fields')            AS is_custom_field,
    field.1                                            AS field_key,
    field.2                                            AS value_raw,
    JSONExtractRaw(child, 'previous_value')            AS previous_value_raw,
    child,
    collected_at
FROM fields_set
ARRAY JOIN multiIf(
    child_event_type = 'Comment', [('', '')],
    has(field_keys, 'custom_ticket_fields'), JSONExtractKeysAndValuesRaw(child, 'custom_ticket_fields'),
    arrayMap(k -> (k, JSONExtractRaw(child, k)), field_keys)
) AS field
