{{ config(
    materialized='incremental',
    unique_key='unique_key',
    order_by=['unique_key'],
    settings={'allow_nullable_key': 1},
    schema='staging',
    tags=['bitbucket-cloud', 'silver:class_git_ci_runs']
) }}

-- INVARIANT: read run_number and build_number in this CTE only. A ClickHouse
-- alias shadows a column of the same name in its own SELECT.
WITH pipeline_attempts AS (
    SELECT
        {{ bronze_tenant() }} AS insight_tenant_id,
        insight_source_id,
        concat(unique_key, ':', toString(COALESCE(run_number, 1))) AS attempt_key,
        COALESCE(run_number, 1) AS attempt,
        COALESCE(build_number, 0) AS build_number,
        COALESCE(repo_full_name, '') AS repo_full_name,
        if(
            COALESCE(selector_pattern, '') = '',
            COALESCE(selector_type, ''),
            concat(COALESCE(selector_type, ''), ':', COALESCE(selector_pattern, ''))
        ) AS pipeline_key,
        multiIf(
            trigger_name = 'PUSH' AND target_type = 'pipeline_pullrequest_target', 'pull_request',
            trigger_name = 'PUSH', 'push',
            trigger_name IN ('MANUAL', 'ON_DEMAND'), 'manual',
            trigger_name = 'SCHEDULE', 'schedule',
            'other'
        ) AS trigger_category,
        COALESCE(trigger_name, '') AS trigger_raw,
        multiIf(
            result_name = 'SUCCESSFUL', 'success',
            result_name IN ('FAILED', 'ERROR'), 'failure',
            result_name = 'STOPPED', 'cancelled',
            result_name = 'EXPIRED', 'timed_out',
            state_stage = 'PAUSED', 'success',
            ''
        ) AS outcome,
        COALESCE(nullIf(target_ref, ''), source_branch, '') AS branch,
        COALESCE(target_commit_sha, '') AS commit_sha,
        COALESCE(creator_account_id, '') AS actor_login,
        parseDateTimeBestEffortOrNull(created_on) AS created_at,
        COALESCE(
            parseDateTimeBestEffortOrNull(run_creation_date),
            parseDateTimeBestEffortOrNull(created_on)
        ) AS started_at,
        parseDateTimeBestEffortOrNull(completed_on) AS finished_at,
        duration_in_seconds,
        _airbyte_extracted_at
    FROM {{ source('bronze_bitbucket_cloud', 'pipelines') }} FINAL
    -- INVARIANT: selector_type is NULL only in a row stored before 7.11.0. That
    -- row has no pipeline or trigger, so it waits until a sync reads it again.
    WHERE selector_type IS NOT NULL
    {% if is_incremental() %}
        AND _airbyte_extracted_at > {{ instance_incremental_watermark('_airbyte_extracted_at') }}
    {% endif %}
)

SELECT
    insight_tenant_id,
    insight_source_id,
    attempt_key AS unique_key,
    repo_full_name,
    pipeline_key,
    pipeline_key AS pipeline_name,
    build_number AS run_id,
    build_number AS run_number,
    attempt,
    if(attempt > 1, 1, 0) AS is_retry,
    trigger_category,
    trigger_raw,
    outcome,
    if(
        trigger_category IN ('push', 'pull_request')
        AND outcome IN ('success', 'failure', 'timed_out'),
        1, 0
    ) AS is_gate,
    branch,
    commit_sha,
    actor_login,
    created_at,
    started_at,
    finished_at,
    if(outcome != '', duration_in_seconds, CAST(NULL AS Nullable(Int64))) AS duration_s,
    'insight_bitbucket_cloud' AS data_source,
    toUnixTimestamp64Milli(now64()) AS _version,
    _airbyte_extracted_at
FROM pipeline_attempts
