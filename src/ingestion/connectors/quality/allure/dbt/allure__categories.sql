{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='unique_key',
    engine=insight_engine('ReplacingMergeTree', '_version'),
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['allure']
) }}

WITH bronze AS (
    SELECT b.*
    FROM {{ source('bronze_allure', 'categories') }} AS b FINAL
    {% if is_incremental() %}
    LEFT JOIN (
        SELECT insight_tenant_id, insight_source_id, max(_airbyte_extracted_at) AS watermark
        FROM {{ this }}
        GROUP BY insight_tenant_id, insight_source_id
    ) AS w
        ON w.insight_tenant_id = {{ bronze_tenant('b.insight_tenant_id') }} AND w.insight_source_id = b.insight_source_id
    WHERE b._airbyte_extracted_at > coalesce(w.watermark, toDateTime64(0, 3))
    {% endif %}
)

SELECT
    {{ bronze_tenant() }} AS insight_tenant_id,
    insight_source_id,
    unique_key,
    toInt64(COALESCE(id, 0)) AS category_id,
    toInt64(COALESCE(project_id, 0)) AS project_id,
    COALESCE(name, '') AS category_name,
    COALESCE(color, '') AS color,
    COALESCE(description, '') AS description,
    fromUnixTimestamp64Milli(createdDate, 'UTC') AS created_at,
    fromUnixTimestamp64Milli(lastModifiedDate, 'UTC') AS last_modified_at,
    'insight_allure' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM bronze
