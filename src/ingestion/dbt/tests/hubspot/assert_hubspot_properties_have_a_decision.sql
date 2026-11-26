{{ config(
    tags=['connector_quality', 'hubspot'],
    severity='warn',
    store_failures=true,
    meta={
        'title': 'HubSpot properties without a collect or ignore decision',
        'domain': 'crm',
        'category': 'coverage',
        'tier': 'error',
        'remediation': 'problem=unreviewed: the portal defines a property that is in no list of hubspot_property_selection, and the connector does not request it. Add it to collect or ignore in the connector settings ConfigMap of this source. problem=conflict: a property in collect holds money, and the connector does not request it. Move it to ignore.'
    }
) }}

-- The connector re-reads every definition on each sync, so the newest row of a
-- property carries its current status.
WITH latest AS (
    SELECT
        tenant_id,
        source_id,
        argMax(objectType, _airbyte_extracted_at) AS object_type,
        argMax(name, _airbyte_extracted_at)       AS property_name,
        argMax(selection, _airbyte_extracted_at)  AS selection,
        argMax(archived, _airbyte_extracted_at)   AS archived
    FROM {{ source('bronze_hubspot', 'property_definitions') }}
    GROUP BY tenant_id, source_id, unique_key
)

SELECT
    selection AS problem,
    tenant_id,
    source_id,
    object_type,
    property_name
FROM latest
WHERE selection IN ('unreviewed', 'conflict')
  AND NOT coalesce(archived, false)
