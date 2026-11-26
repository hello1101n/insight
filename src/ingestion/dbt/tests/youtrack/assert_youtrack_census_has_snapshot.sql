{{ config(
    tags=['connector_quality', 'youtrack'],
    meta={
        'title': 'A censused issue of the collection window has a snapshot',
        'domain': 'task-tracking',
        'category': 'completeness',
        'tier': 'error',
        'remediation': 'The newest census saw an issue inside the window the `updated:` search covers, yet no snapshot exists. Check the search slices and the stream state for youtrack_issues.'
    }
) }}

-- Every census issue the snapshot streams are meant to cover has a snapshot.
-- They cover the collection window: an issue last updated before
-- youtrack_start_date is in the census and deliberately never snapshotted, and
-- one updated after the newest search started was created or changed mid-sync
-- and is the next sync's. The window is read from youtrack_issues, the
-- `updated:` search that defines it.
-- INVARIANT: the window ends at the first read of the newest youtrack_issues
-- pass. The search fixes its upper bound when the pass starts, so an issue
-- changed during the read is outside it; the cursor lookback reads it next sync.
-- INVARIANT: only the newest census pass is the population. Every pass appends
-- its own rows (the key carries the read time), so an older pass still names
-- issues deleted since, which no snapshot can ever cover.
WITH snapshot_passes AS (
    SELECT insight_tenant_id, insight_source_id,
        toInt64(assumeNotNull(updated)) AS updated_ms,
        _airbyte_extracted_at AS read_at,
        JSONExtractInt(_airbyte_meta, 'sync_id') AS pass_id
    FROM {{ source('bronze_youtrack', 'youtrack_issues') }}
    WHERE updated IS NOT NULL
),

newest_search AS (
    SELECT insight_tenant_id, insight_source_id,
        min(updated_ms) AS window_start,
        argMax(pass_id, read_at) AS pass_id
    FROM snapshot_passes
    GROUP BY insight_tenant_id, insight_source_id
),

collection_window AS (
    SELECT s.insight_tenant_id AS insight_tenant_id, s.insight_source_id AS insight_source_id,
        any(s.window_start) AS window_start,
        toUnixTimestamp64Milli(min(p.read_at)) AS search_start
    FROM newest_search AS s
    INNER JOIN snapshot_passes AS p
        ON p.insight_tenant_id = s.insight_tenant_id AND p.insight_source_id = s.insight_source_id AND p.pass_id = s.pass_id
    GROUP BY s.insight_tenant_id, s.insight_source_id
),

census_passes AS (
    SELECT insight_tenant_id, insight_source_id, id, updated, JSONExtractInt(_airbyte_meta, 'sync_id') AS pass_id
    FROM {{ source('bronze_youtrack', 'youtrack_issue_census') }}
),

newest_pass AS (
    SELECT insight_tenant_id, insight_source_id, max(pass_id) AS pass_id
    FROM census_passes
    GROUP BY insight_tenant_id, insight_source_id
)

SELECT DISTINCT c.insight_tenant_id, c.insight_source_id, c.id
FROM census_passes AS c
INNER JOIN newest_pass AS p
    ON p.insight_tenant_id = c.insight_tenant_id AND p.insight_source_id = c.insight_source_id AND p.pass_id = c.pass_id
INNER JOIN collection_window AS w ON w.insight_tenant_id = c.insight_tenant_id AND w.insight_source_id = c.insight_source_id
LEFT ANTI JOIN {{ ref('youtrack__issues') }} AS i
    ON i.insight_tenant_id = c.insight_tenant_id AND i.insight_source_id = c.insight_source_id AND i.issue_id = c.id
WHERE toInt64(assumeNotNull(c.updated)) >= w.window_start
  AND toInt64(assumeNotNull(c.updated)) < w.search_start
