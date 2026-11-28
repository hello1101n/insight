{#-
  Logged worklog seconds per tracker account and day, keyed by the author's
  account and, where the directory states one, their email. The author joins
  LEFT with no email filter, so an author with no email or no directory row
  still owns the worklog through the account.
  Deletion awareness comes from the class contract's is_deleted (worklog
  tombstones + deleted parent issue).
-#}

{% macro task_worklog_per_account_day() %}
    SELECT
        w.insight_tenant_id                                                          AS insight_tenant_id,
        coalesce(u.email, '')                                                AS entity_id,
        {{ task_account_source_type('w.data_source') }}                      AS account_source_type,
        w.insight_source_id                                                  AS account_source_id,
        w.author_id                                                          AS account_id,
        toDate(w.work_date)                                                  AS metric_date,
        sum(ifNull(w.duration_seconds, 0))                                   AS worklog_seconds
    FROM {{ ref('class_task_worklogs') }} AS w FINAL
    LEFT JOIN (
        SELECT
            insight_tenant_id,
            insight_source_id,
            user_id,
            if(email LIKE '%@%', {{ normalized_email('email') }}, '') AS email
        FROM {{ ref('class_task_users') }} FINAL
    ) AS u
        ON u.insight_tenant_id = w.insight_tenant_id
        AND u.insight_source_id = w.insight_source_id
        AND u.user_id = w.author_id
    WHERE w.work_date IS NOT NULL
      AND ifNull(w.is_deleted, 0) = 0
      AND coalesce(w.author_id, '') != ''
    GROUP BY w.insight_tenant_id, entity_id, account_source_type, account_source_id, account_id, metric_date
{% endmacro %}
