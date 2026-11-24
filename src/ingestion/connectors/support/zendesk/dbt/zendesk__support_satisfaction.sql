{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['zendesk', 'staging', 'silver:class_support_satisfaction']
) }}

-- Both CSAT generations in one vocabulary (DESIGN.md §5 "Satisfaction"). A
-- survey response names no owner, so assignee and group are the ticket's
-- values at the moment it was rated.

WITH legacy AS (
    SELECT
        tenant_id,
        insight_source_id,
        {{ zendesk_id('payload', "'id'") }}            AS rating_id,
        'legacy'                                       AS survey_kind,
        {{ zendesk_id('payload', "'ticket_id'") }}     AS ticket_id,
        JSONExtractString(payload, 'score')            AS score,
        CAST(NULL AS Nullable(Float64))                AS rating,
        CAST(NULL AS Nullable(Int32))                  AS scale_max,
        toUInt8(JSONExtractString(payload, 'comment') != '') AS has_comment,
        coalesce({{ zendesk_text('payload', "'reason'") }}, {{ zendesk_id('payload', "'reason_code'") }}) AS reason,
        {{ zendesk_id('payload', "'assignee_id'") }}   AS assignee_id,
        {{ zendesk_id('payload', "'group_id'") }}      AS group_id,
        coalesce({{ zendesk_time('payload', "'updated_at'") }}, {{ zendesk_time('payload', "'created_at'") }}) AS rated_at,
        collected_at
    FROM {{ zendesk_bronze('zendesk_csat_ratings') }}
    WHERE JSONExtractString(payload, 'score') IN ('good', 'bad', 'offered')
),

survey_answers AS (
    SELECT
        tenant_id,
        insight_source_id,
        payload,
        arrayFilter(a -> JSONExtractString(a, 'type') = 'rating_scale', JSONExtractArrayRaw(payload, 'answers'))[1] AS rating_answer,
        arrayExists(
            a -> JSONExtractString(a, 'type') = 'open_ended' AND JSONExtractString(a, 'value') != '',
            JSONExtractArrayRaw(payload, 'answers')
        )                                              AS has_text,
        arrayMax(arrayMap(
            a -> coalesce({{ zendesk_time('a', "'updated_at'") }}, toDateTime64(0, 3, 'UTC')),
            JSONExtractArrayRaw(payload, 'answers')
        ))                                             AS answered_at,
        collected_at
    FROM {{ zendesk_bronze('zendesk_survey_responses') }}
),

survey AS (
    SELECT
        tenant_id,
        insight_source_id,
        JSONExtractString(payload, 'id')               AS rating_id,
        'survey'                                       AS survey_kind,
        arrayFirst(
            s -> JSONExtractString(s, 'type') = 'ticket',
            JSONExtractArrayRaw(payload, 'subjects')
        )                                              AS ticket_subject,
        nullIf(JSONExtractString(ticket_subject, 'id'), '') AS ticket_id,
        JSONExtractString(rating_answer, 'rating_category') AS score,
        if(rating_answer = '', NULL, JSONExtractFloat(rating_answer, 'rating')) AS rating,
        CAST(NULL AS Nullable(Int32))                  AS scale_max,
        toUInt8(has_text)                              AS has_comment,
        CAST(NULL AS Nullable(String))                 AS reason,
        if(answered_at = toDateTime64(0, 3, 'UTC'), {{ zendesk_time('payload', "'created_at'") }}, answered_at) AS rated_at,
        collected_at
    FROM survey_answers
    WHERE JSONExtractString(rating_answer, 'rating_category') IN ('good', 'neutral', 'bad')
),

owners AS (
    SELECT tenant_id, insight_source_id, ticket_id, field_id, event_at, JSONExtractString(value) AS owner_id
    FROM {{ ref('zendesk__support_ticket_field_history') }}
    WHERE field_id IN ('assignee_id', 'group_id')
),

survey_owned AS (
    SELECT
        s.tenant_id                                    AS tenant_id,
        s.insight_source_id                            AS insight_source_id,
        s.rating_id                                    AS rating_id,
        s.survey_kind                                  AS survey_kind,
        s.ticket_id                                    AS ticket_id,
        s.score                                        AS score,
        s.rating                                       AS rating,
        s.scale_max                                    AS scale_max,
        s.has_comment                                  AS has_comment,
        s.reason                                       AS reason,
        nullIf(argMaxIf(o.owner_id, o.event_at, o.field_id = 'assignee_id' AND o.event_at <= s.rated_at), '') AS assignee_id,
        nullIf(argMaxIf(o.owner_id, o.event_at, o.field_id = 'group_id' AND o.event_at <= s.rated_at), '')    AS group_id,
        s.rated_at                                     AS rated_at,
        s.collected_at                                 AS collected_at
    FROM survey AS s
    LEFT JOIN owners AS o
        ON o.tenant_id = s.tenant_id AND o.insight_source_id = s.insight_source_id AND o.ticket_id = s.ticket_id
    GROUP BY s.tenant_id, s.insight_source_id, s.rating_id, s.survey_kind, s.ticket_id, s.score, s.rating,
             s.scale_max, s.has_comment, s.reason, s.rated_at, s.collected_at
),

ratings AS (
    SELECT * FROM legacy
    UNION ALL
    SELECT * FROM survey_owned
)

SELECT
    {{ zendesk_key(['survey_kind', 'rating_id']) }}    AS unique_key,
    tenant_id,
    insight_source_id,
    'zendesk'                                          AS data_source,
    rating_id,
    survey_kind,
    ticket_id,
    score,
    rating,
    scale_max,
    has_comment,
    reason,
    assignee_id,
    group_id,
    rated_at,
    collected_at,
    {{ zendesk_version() }}                            AS _version
FROM ratings
