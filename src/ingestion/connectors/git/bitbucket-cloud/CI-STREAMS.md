# Bitbucket Cloud CI streams

Phase 1 is implemented. Phases 2 to 4 are proposals. Bitbucket's OpenAPI spec and live API responses confirm the endpoints, fields and enum values below.

## Goal

1. Bitbucket workspaces get the CI and deployment metrics that GitHub and GitLab already serve: `ci.runs`, `ci.gate_pass_rate`, `ci.gate_first_try_pass_rate`, `ci.gate_retry_share`, `ci.run_duration_min` with its p90 and stddev, `ci.run_hours` and `ci.deployments`.
2. After that, Bitbucket workspaces get step, test and external-CI metrics. No connector serves these yet.

## Where we are

- `pipelines` and `deployments` land in bronze, but no dbt model maps them to a class. A Bitbucket workspace shows no CI metrics.
- `pipelines` copies a few fields out of `target`, `trigger` and `state`, then drops those objects. The stream loses the selector that identifies the pipeline, the pull request the run belongs to, and the rerun count.
- `deployments` keeps only the environment uuid. No column separates production from staging.
- `deployments` filters records by `created_on` against the saved cursor. Once a newer deployment exists in the repository, an older one never updates in bronze. A manual production deploy that runs later keeps its placeholder state forever.

## Summary

| Change | Endpoint | Extra calls per sync | Enables |
|---|---|---|---|
| Extend `pipelines` | existing | none | all `ci.*` run metrics |
| Extend `deployments` | existing | none | `ci.deployments` split by production, and outcomes of deploys that run late |
| `pipeline_steps` | `/pipelines/{uuid}/steps/` | 1 per newly finished pipeline run | slow steps, flaky steps, queue time |
| `pipeline_test_reports` | `/pipelines/{uuid}/steps/{step}/test_reports` | 1 per newly finished step | test counts and failure rate |
| `pull_request_statuses` | `/pullrequests/{id}/statuses` | 1 per pull request in the window | CI that runs outside Bitbucket Pipelines |

## Phase 1. Parity with GitHub and GitLab

### Extend the pipelines stream

Keep these fields:

- `selector_type` and `selector_pattern`, from `target.selector`. The selector type is `branches`, `tags`, `bookmarks`, `default`, `custom` or `pull-requests`.
- `target_type`, from `target.type`. It is `pipeline_ref_target`, `pipeline_commit_target` or `pipeline_pullrequest_target`.
- `source_branch`, from `target.source`. Bitbucket sets it only on pull-request targets. A pull-request target has no `ref_name`.
- `trigger_name`, which the stream keeps already. It is `PUSH`, `MANUAL`, `SCHEDULE` or `ON_DEMAND`.
- `state_stage`, from `state.stage.name`. It is `RUNNING`, `PAUSED` or `HALTED`.
- `run_number` and `run_creation_date`. A rerun keeps the pipeline's `uuid`, `build_number` and `created_on`. It raises `run_number` and moves `run_creation_date` to the latest run.

Move the cursor from `created_on` to `changed_on`. The data feed drops every pipeline older than the saved cursor, and a rerun or a finished run keeps its `created_on`. Bitbucket gives a pipeline no update time. So `changed_on` is the latest of `created_on`, `run_creation_date` and `completed_on`, and a rerun or a finished run moves it.

The stream still stops paging at the first page whose oldest pipeline is unchanged. So each visit reads at least the repository's 100 newest pipelines and emits the ones that changed. A run that was in progress, or that was rerun, gets its new state on the next visit to its repository. This costs no extra calls.

### Extend the deployments stream

- Keep `environment_name` and `environment_type` from the deployment's embedded `environment`. The list response embeds the whole environment, so no environments stream is needed. `environment_type` is `Test`, `Staging` or `Production`.
- Keep `version`. Bitbucket raises it each time the deployment changes state.
- Move the cursor from `created_on` to `last_update_time`. Bitbucket moves `last_update_time` on every state change, so the client-side filter passes a deployment again whenever its state changed. The endpoint has no server-side filter, so this costs no extra calls.

### dbt models

| Model | Class | Built from |
|---|---|---|
| `bitbucket_cloud__ci_runs` | `class_git_ci_runs` | `pipelines` |
| `bitbucket_cloud__deployments` | `class_git_deployments` | `deployments` |
| `bitbucket_cloud__deployment_events` | `class_git_deployment_events` | `deployments`, one event per `version` a sync observed |

How pipeline fields map to `class_git_ci_runs`:

| Class column | Bitbucket |
|---|---|
| `pipeline_key`, `pipeline_name` | `selector_type:selector_pattern`, or `selector_type` alone when there is no pattern |
| `run_id`, `run_number` | `build_number` for both. The `uuid` is a string, and the class column is a number. |
| `attempt`, `is_retry` | `run_number`, `run_number > 1`. The row key carries `run_number`, so silver keeps one row per attempt it observed. |
| `trigger_category` | `PUSH` on a pull-request target is `pull_request`. Any other `PUSH` is `push`. `MANUAL` and `ON_DEMAND` are `manual`. `SCHEDULE` is `schedule`. |
| `outcome` | `SUCCESSFUL` is `success`. `FAILED` and `ERROR` are `failure`. `STOPPED` is `cancelled`. `EXPIRED` is `timed_out`. Stage `PAUSED` is `success`. `PENDING`, `RUNNING` and `HALTED` are empty, which means undecided. |
| `created_at`, `started_at`, `finished_at` | `created_on`, `run_creation_date`, `completed_on`. `started_at` falls back to `created_on` on rows synced before `run_creation_date` was kept. |
| `duration_s` | `duration_in_seconds` |
| `branch`, `commit_sha` | The branch is `target.ref_name`, or `source_branch` on a pull request. The commit is `target.commit.hash`. |

Mapping decisions:

- **A paused pipeline counts as `success`.** Bitbucket pauses a pipeline only after every automatic step before the manual one has passed. Its own UI shows such a pipeline as Successful. A pipeline can stay paused with no time limit, so treating it as undecided would drop it from every metric. If the manual step later fails, `class_git_deployments` records that failure.
- **`duration_s` is Bitbucket's `duration_in_seconds`**, not `completed_on` minus `run_creation_date`. Bitbucket's figure leaves out time spent paused on a manual step. A pause can last days and would distort the duration percentiles.
- **`EXPIRED` maps to `timed_out`.** It is the class's only outcome for a run that ran out of time. It counts as a decided gate result that did not pass.
- **`ON_DEMAND` maps to `manual`.** An API call or an app starts such a run, not a commit. GitHub's `workflow_dispatch` is the same kind of run, and it also maps to `manual`.
- **`HALTED` stays undecided.** A halted pipeline's step is still pending and has never started.

How deployments map:

- `environment` and `is_production` come from the embedded environment. `is_production` is true when `environment_type` is `Production`.
- `is_transient` is always `0`, because Bitbucket has no throwaway preview environments.
- A `COMPLETED` deployment becomes a `success`, `failure` or `cancelled` event when its result is `SUCCESSFUL`, `FAILED` or `STOPPED`. An `IN_PROGRESS` deployment becomes an `in_progress` event.
- Bronze keeps only a deployment's latest state. Each `version` a sync observes becomes one event in silver. `version` is the event id, and `last_update_time` is the event time.
- The model skips `UNDEPLOYED` rows. Bitbucket creates such a row as a placeholder for a manual deploy step that has not run. The row enters the class once the step runs.

## Phase 2. Steps, which are Bitbucket's jobs

### New pipeline steps stream

- The stream is a child of `pipelines`. It fetches steps once per finished run, only for pipelines whose `completed_on` is newer than its cursor.
- A rerun sets a new `completed_on`, so the stream fetches that run's steps again. A pipeline that the parent emits again with the same `completed_on` costs no step calls.
- The endpoint returns only the latest run of each step.
- Fields: `uuid`, `pipeline_uuid`, `name`, `state.name`, `state.result.name`, `trigger.type`, `started_on`, `completed_on`, `duration_in_seconds`, `build_seconds_used`, `run_number`, `maxTime` and `image.name`.
- `state.result.name` is `SUCCESSFUL`, `FAILED`, `ERROR`, `STOPPED`, `EXPIRED` or `NOT_RUN`.
- `trigger.type` is `pipeline_step_trigger_automatic`, `pipeline_step_trigger_manual` or `pipeline_step_trigger_rerun`.
- Drop `setup_commands`, `script_commands` and `teardown_commands`. They are large, and no metric reads them.
- A step can fail while its pipeline succeeds, when the pipeline configuration allows that step to fail. Step metrics read the step's own result.

Metrics it enables:

- Slowest steps, by p50 and p90 duration per step name.
- Flaky steps, which passed only after a rerun: `run_number > 1` and `SUCCESSFUL`.
- Queue time, from the pipeline's `run_creation_date` to the first step's `started_on`.
- Manual-gate wait, from the last automatic step's `completed_on` to the manual step's `started_on`.
- Build minutes per step.

No silver class holds job-level rows yet. This phase adds `class_git_ci_jobs`. GitLab's `jobs` stream is already in bronze and can feed the same class later, so the class columns must fit it too.

## Phase 3. Test reports

### New pipeline test reports stream

- The stream is a child of `pipeline_steps`. It makes one call per newly finished step.
- A step does not say whether it has a report, so the stream asks for every step's report.
- A `404` with key `report-service.test-report.not-found` means the step published no report. Treat it as no row, not as an error.
- Fields: `uuid`, `step_uuid`, `number_of_test_cases`, `number_of_successful_test_cases`, `number_of_failed_test_cases`, `number_of_error_test_cases` and `number_of_skipped_test_cases`. The report has no duration.
- Rows exist only for steps that publish JUnit or Maven Surefire XML reports.

Metrics it enables: test count trend, test failure rate and skipped-test share, per repository and pipeline.

Per-test results, from `.../test_reports/test_cases`, are out of scope. That endpoint returns no cases for a report in which every test passed. So it cannot support slowest-test or flaky-test metrics.

## Phase 4. Build statuses from external CI

### New pull request statuses stream

- The stream is a child of the windowed pull-request parent, as `pull_request_activity` is. Merging a pull request updates it, so the stream reads the final statuses at merge at the latest.
- Fields: `key`, `name`, `state`, `refname`, `url`, `description`, `created_on`, `updated_on`, and the commit hash from `links.commit`.
- `state` is `SUCCESSFUL`, `FAILED`, `INPROGRESS` or `STOPPED`.
- Jenkins, TeamCity, CircleCI and other external CI tools report results here. A workspace that does not use Bitbucket Pipelines has no other CI signal.
- Skip statuses whose `url` contains `/addon/pipelines/home`. Those are Bitbucket Pipelines' own statuses, and the `pipelines` stream collects them already.
- The per-commit endpoint, `/commit/{sha}/statuses`, also covers branch builds without a pull request. It costs one call per commit, so the stream does not use it.

Metrics it enables: pass rate per check `key`, and approximate duration, which is `updated_on` minus `created_on`.

## Out of scope

This spec leaves out step logs, per-test results, caches, variables, schedules, runners and `pipelines_config`. It also leaves out Code Insights reports at `/commit/{sha}/reports`, which cover code quality and security rather than CI.

## Known limits

- `pipelines` and `deployments` visit only repositories pushed to since the last sync. A run that finishes after the last visit to its repository gets its outcome at the next push. Until then it stays undecided and outside every metric.
- The stream sees a change to a run only while the run is on a page that the visit reads. That is at least the repository's 100 newest pipelines. It misses a rerun of an older pipeline.
- A run that pauses on a manual step moves none of `created_on`, `run_creation_date` and `completed_on`, because Bitbucket sets `completed_on` only when a run completes. Bronze keeps the stage that the last visit saw until the run completes or reruns.
- A row that a connector before 7.11.0 stored has no selector or environment. The CI classes leave it out until a visit reads its repository again. The runs and deployments of a repository that nobody pushes to after the upgrade stay outside every metric.
- Steps and test reports add calls against the hourly budget, `bitbucket_api_calls_per_hour`, which defaults to 1000. Steps cost one call per finished run. Test reports cost one call per finished step.
