{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_ticket_issue_links']
) }}

-- INVARIANT: both link endpoints are full listings; bronze keeps a link Zendesk
-- no longer lists, so `last_seen_at` is how a reader tells a removed link.
WITH integration_links AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        {{ zendesk_id('payload', "'issue_id'") }}      AS issue_id,
        {{ zendesk_text('payload', "'issue_key'") }}   AS issue_key,
        'integration'                                  AS found_by,
        {{ zendesk_time('payload', "'created_at'") }}  AS linked_at,
        collected_at
    FROM {{ zendesk_bronze('zendesk_jira_links') }}
),

integration_v2_links AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        {{ zendesk_id('payload', "'issue_id'") }}      AS issue_id,
        {{ zendesk_text('payload', "'issue_key'") }}   AS issue_key,
        'integration_v2'                               AS found_by,
        CAST(NULL AS Nullable(DateTime64(3, 'UTC')))   AS linked_at,
        collected_at
    FROM {{ zendesk_bronze('zendesk_jira_links_v2') }}
),

links AS (
    SELECT * FROM integration_links
    UNION ALL
    SELECT * FROM integration_v2_links
),

link_pairs AS (
    SELECT
        insight_tenant_id,
        insight_source_id,
        ticket_id,
        issue_id,
        found_by,
        argMax(issue_key, collected_at)                AS issue_key,
        min(linked_at)                                 AS linked_at,
        max(collected_at)                              AS last_seen_at
    FROM links
    WHERE ticket_id IS NOT NULL AND issue_id IS NOT NULL
    GROUP BY insight_tenant_id, insight_source_id, ticket_id, issue_id, found_by
)

SELECT
    {{ zendesk_key(["'jira'", 'found_by', 'ticket_id', 'issue_id']) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    ticket_id,
    'jira'                                             AS tracker,
    issue_id,
    issue_key,
    found_by,
    linked_at,
    last_seen_at,
    last_seen_at                                       AS collected_at,
    {{ zendesk_version() }}                            AS _version
FROM link_pairs
