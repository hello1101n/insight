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
    SELECT
        b.*,
        if(JSONType(coalesce(toString(variable), 'null')) = 'String', JSONExtractString(coalesce(toString(variable), 'null')), coalesce(toString(variable), 'null')) AS variable_json
    FROM {{ source('bronze_allure', 'launch_environment') }} AS b FINAL
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
    toInt64(COALESCE(launch_id, 0)) AS launch_id,
    toInt64(COALESCE(project_id, 0)) AS project_id,
    toInt64(COALESCE(id, 0)) AS value_id,
    JSONExtractString(variable_json, 'name') AS variable_name,
    COALESCE(name, '') AS value,
    fromUnixTimestamp64Milli(lastModifiedDate, 'UTC') AS launch_last_modified_at,
    'insight_allure' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM bronze
