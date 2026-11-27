{{ config(
    materialized='incremental',
    unique_key='unique_key',
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['bitbucket-cloud', 'silver:class_git_deployment_events']
) }}

SELECT
    tenant_id,
    source_id,
    concat(unique_key, ':', toString(COALESCE(version, 0))) AS unique_key,
    COALESCE(repo_full_name, '') AS repo_full_name,
    COALESCE(uuid, '') AS deployment_id,
    COALESCE(version, 0) AS event_id,
    multiIf(
        state_name = 'COMPLETED' AND state_status = 'SUCCESSFUL', 'success',
        state_name = 'COMPLETED' AND state_status = 'FAILED', 'failure',
        state_name = 'COMPLETED' AND state_status = 'STOPPED', 'cancelled',
        state_name = 'IN_PROGRESS', 'in_progress',
        ''
    ) AS state,
    COALESCE(environment_name, '') AS environment,
    '' AS creator_login,
    COALESCE(
        parseDateTimeBestEffortOrNull(last_update_time),
        parseDateTimeBestEffortOrNull(created_on)
    ) AS created_at,
    'insight_bitbucket_cloud' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM {{ source('bronze_bitbucket_cloud', 'deployments') }} FINAL
WHERE COALESCE(state_name, '') != 'UNDEPLOYED'
    -- INVARIANT: environment_type is NULL only in a row stored before 7.11.0. That
    -- row has no environment or state version, so it waits until a sync reads it again.
    AND environment_type IS NOT NULL
{% if is_incremental() %}
    AND _airbyte_extracted_at > {{ instance_incremental_watermark('_airbyte_extracted_at') }}
{% endif %}
