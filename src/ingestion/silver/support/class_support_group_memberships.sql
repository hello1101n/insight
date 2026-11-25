-- depends_on: {{ ref('zendesk__support_group_memberships') }}
-- depends_on: {{ ref('hubspot__support_group_memberships') }}
{{ config(
    materialized='table',
    schema='silver',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['silver']
) }}

SELECT *
FROM ( {{ union_by_tag('silver:class_support_group_memberships') }} )
