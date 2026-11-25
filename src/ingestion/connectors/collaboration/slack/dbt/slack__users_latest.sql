{{ config(
    materialized='table',
    engine=insight_engine('ReplacingMergeTree'),
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['slack']
) }}

{%- set members = adapter.get_relation(database=none, schema='bronze_slack', identifier='users') -%}
{%- set activity = adapter.get_relation(database=none, schema='bronze_slack', identifier='users_details') -%}

-- depends_on: {{ source('bronze_slack', 'users_details') }}
-- depends_on: {{ source('bronze_slack', 'users') }}

WITH
{% if activity %}
activity_users AS (
    SELECT
        insight_tenant_id,
        insight_source_id AS source_id,
        user_id,
        nullIf(argMaxIf(assumeNotNull(email_address), date, coalesce(email_address, '') != ''), '') AS activity_email,
        argMax(is_guest, date) AS activity_is_guest
    FROM {{ source('bronze_slack', 'users_details') }} FINAL
    WHERE insight_tenant_id IS NOT NULL
      AND insight_source_id IS NOT NULL
      AND coalesce(user_id, '') != ''
    GROUP BY
        insight_tenant_id,
        source_id,
        user_id
),
{% else %}
activity_users AS (
    SELECT
        CAST(NULL AS Nullable(String)) AS insight_tenant_id,
        CAST(NULL AS Nullable(String)) AS source_id,
        CAST(NULL AS Nullable(String)) AS user_id,
        CAST(NULL AS Nullable(String)) AS activity_email,
        CAST(NULL AS Nullable(Bool)) AS activity_is_guest
    WHERE 0
),
{% endif %}

{% if members %}
member_users AS (
    SELECT
        insight_tenant_id,
        insight_source_id AS source_id,
        user_id,
        nullIf(coalesce(email, ''), '') AS member_email,
        coalesce(nullIf(real_name, ''), nullIf(display_name, '')) AS member_display_name,
        is_bot AS member_is_bot,
        coalesce(is_restricted, false) OR coalesce(is_ultra_restricted, false) AS member_is_guest
    FROM {{ source('bronze_slack', 'users') }} FINAL
    WHERE insight_tenant_id IS NOT NULL
      AND insight_source_id IS NOT NULL
      AND coalesce(user_id, '') != ''
),
{% else %}
member_users AS (
    SELECT
        CAST(NULL AS Nullable(String)) AS insight_tenant_id,
        CAST(NULL AS Nullable(String)) AS source_id,
        CAST(NULL AS Nullable(String)) AS user_id,
        CAST(NULL AS Nullable(String)) AS member_email,
        CAST(NULL AS Nullable(String)) AS member_display_name,
        CAST(NULL AS Nullable(Bool)) AS member_is_bot,
        CAST(NULL AS Nullable(Bool)) AS member_is_guest
    WHERE 0
),
{% endif %}

known_users AS (
    SELECT
        insight_tenant_id,
        source_id,
        user_id
    FROM activity_users
    UNION DISTINCT
    SELECT
        insight_tenant_id,
        source_id,
        user_id
    FROM member_users
)

SELECT
    k.insight_tenant_id AS insight_tenant_id,
    k.source_id AS source_id,
    k.user_id AS user_id,
    -- INVARIANT: the Activity email wins; the Members email is the fallback.
    coalesce(a.activity_email, m.member_email) AS email,
    m.member_display_name AS display_name,
    concat(k.insight_tenant_id, '-', k.source_id, '-', k.user_id) AS unique_key
FROM known_users AS k
LEFT JOIN activity_users AS a
    ON a.insight_tenant_id = k.insight_tenant_id
   AND a.source_id = k.source_id
   AND a.user_id = k.user_id
LEFT JOIN member_users AS m
    ON m.insight_tenant_id = k.insight_tenant_id
   AND m.source_id = k.source_id
   AND m.user_id = k.user_id
-- INVARIANT: a bot or a proven guest never becomes an account. Each one would mint a person.
WHERE k.user_id != 'USLACKBOT'
  AND NOT coalesce(m.member_is_bot, false)
  AND NOT coalesce(m.member_is_guest, false)
  AND NOT coalesce(a.activity_is_guest, false)
