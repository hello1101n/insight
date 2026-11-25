{{ config(
    materialized='table',
    schema='staging',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    tags=['hubspot', 'staging', 'silver:class_support_customers']
) }}

-- Only the contacts and companies a ticket names are support customers; the
-- rest of the CRM stays in class_crm_*.

WITH tickets AS (
    SELECT
        {{ hubspot_support_scope('insight_source_id') }},
        requester_source_id,
        org_source_id
    FROM {{ ref('hubspot__crm_tickets') }} FINAL
),

requesters AS (
    SELECT DISTINCT insight_tenant_id, insight_source_id, requester_source_id AS contact_id
    FROM tickets
    WHERE requester_source_id IS NOT NULL
),

ticket_companies AS (
    SELECT DISTINCT insight_tenant_id, insight_source_id, org_source_id AS account_id
    FROM tickets
    WHERE org_source_id IS NOT NULL
),

contacts AS (
    SELECT
        {{ hubspot_support_scope() }},
        contact_id,
        account_id,
        _version
    FROM {{ ref('hubspot__crm_contacts') }} FINAL
),

companies AS (
    SELECT
        {{ hubspot_support_scope() }},
        account_id,
        _version
    FROM {{ ref('hubspot__crm_accounts') }} FINAL
),

customers AS (
    SELECT
        c.insight_tenant_id                                    AS insight_tenant_id,
        c.insight_source_id                            AS insight_source_id,
        c.contact_id                                   AS customer_id,
        'user'                                         AS kind,
        c.account_id                                   AS organization_id,
        c._version                                     AS source_version
    FROM contacts AS c
    INNER JOIN requesters AS r
        ON r.insight_tenant_id = c.insight_tenant_id AND r.insight_source_id = c.insight_source_id AND r.contact_id = c.contact_id

    UNION ALL

    SELECT
        a.insight_tenant_id,
        a.insight_source_id,
        a.account_id,
        'organization',
        a.account_id,
        a._version
    FROM companies AS a
    INNER JOIN ticket_companies AS t
        ON t.insight_tenant_id = a.insight_tenant_id AND t.insight_source_id = a.insight_source_id AND t.account_id = a.account_id
)

SELECT
    {{ hubspot_support_key(['kind', 'customer_id']) }} AS unique_key,
    insight_tenant_id,
    insight_source_id,
    'hubspot'                                          AS data_source,
    customer_id,
    kind,
    organization_id,
    {{ hubspot_collected_at('source_version') }}       AS collected_at,
    {{ hubspot_support_version() }}                    AS _version
FROM customers
