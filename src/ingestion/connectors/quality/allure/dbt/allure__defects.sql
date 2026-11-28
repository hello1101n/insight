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
        if(JSONType(coalesce(toString(issue), 'null')) = 'String', JSONExtractString(coalesce(toString(issue), 'null')), coalesce(toString(issue), 'null')) AS issue_json,
        if(JSONType(coalesce(toString(foundAtLaunch), 'null')) = 'String', JSONExtractString(coalesce(toString(foundAtLaunch), 'null')), coalesce(toString(foundAtLaunch), 'null')) AS found_launch_json,
        if(JSONType(coalesce(toString(lastFoundLaunch), 'null')) = 'String', JSONExtractString(coalesce(toString(lastFoundLaunch), 'null')), coalesce(toString(lastFoundLaunch), 'null')) AS last_found_launch_json
    FROM {{ source('bronze_allure', 'defects') }} AS b FINAL
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
    toInt64(COALESCE(id, 0)) AS defect_id,
    toInt64(COALESCE(projectId, 0)) AS project_id,
    COALESCE(name, '') AS defect_name,
    COALESCE(closed, false) AS is_closed,
    COALESCE(description, '') AS description,
    JSONExtractString(issue_json, 'name') AS issue_name,
    JSONExtractString(issue_json, 'url') AS issue_url,
    JSONExtract(found_launch_json, 'id', 'Nullable(Int64)') AS found_launch_id,
    JSONExtract(last_found_launch_json, 'id', 'Nullable(Int64)') AS last_found_launch_id,
    fromUnixTimestamp64Milli(lastFoundDate, 'UTC') AS last_found_at,
    fromUnixTimestamp64Milli(createdDate, 'UTC') AS created_at,
    fromUnixTimestamp64Milli(lastModifiedDate, 'UTC') AS last_modified_at,
    'insight_allure' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM bronze
