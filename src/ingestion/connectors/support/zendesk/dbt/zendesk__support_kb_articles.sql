{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_kb_articles']
) }}

WITH articles AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS article_id,
        {{ zendesk_id('payload', "'author_id'") }}     AS author_id,
        {{ zendesk_time('payload', "'created_at'") }}  AS created_at,
        {{ zendesk_time('payload', "'updated_at'") }}  AS updated_at,
        collected_at
    FROM {{ zendesk_bronze('zendesk_kb_articles') }}
),

events AS (
    SELECT insight_tenant_id, insight_source_id, article_id, author_id, 'created' AS event_type, created_at AS occurred_at, collected_at
    FROM articles
    UNION ALL
    SELECT insight_tenant_id, insight_source_id, article_id, author_id, 'updated' AS event_type, updated_at AS occurred_at, collected_at
    FROM articles
    WHERE updated_at > created_at
)

SELECT
    {{ zendesk_key(['article_id', 'event_type', 'toUnixTimestamp64Milli(occurred_at)']) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    article_id,
    event_type,
    author_id,
    occurred_at,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM events
