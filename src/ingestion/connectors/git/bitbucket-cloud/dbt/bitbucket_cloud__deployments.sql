{{ config(
    materialized='incremental',
    unique_key='unique_key',
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['bitbucket-cloud', 'silver:class_git_deployments']
) }}

SELECT
    {{ bronze_tenant() }} AS insight_tenant_id,
    insight_source_id,
    unique_key,
    COALESCE(repo_full_name, '') AS repo_full_name,
    COALESCE(uuid, '') AS deployment_id,
    COALESCE(environment_name, '') AS environment,
    if(COALESCE(environment_type, '') = 'Production', 1, 0) AS is_production,
    0 AS is_transient,
    '' AS ref,
    COALESCE(deployable_commit_sha, '') AS commit_sha,
    '' AS task,
    '' AS creator_login,
    parseDateTimeBestEffortOrNull(created_on) AS created_at,
    'insight_bitbucket_cloud' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM {{ source('bronze_bitbucket_cloud', 'deployments') }} FINAL
WHERE COALESCE(state_name, '') != 'UNDEPLOYED'
    -- INVARIANT: environment_type is NULL only in a row stored before 7.11.0. That
    -- row has no environment, so it waits until a sync reads it again.
    AND environment_type IS NOT NULL
{% if is_incremental() %}
    AND _airbyte_extracted_at > {{ instance_incremental_watermark('_airbyte_extracted_at') }}
{% endif %}
