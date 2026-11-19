# Bitbucket Cloud: CI streams

Proposal. Endpoints, fields and enum values below are confirmed against Bitbucket's OpenAPI spec and against live API responses.

## Goal

1. Bitbucket workspaces get the CI and deployment metrics that GitHub and GitLab already serve: `ci.runs`, `ci.gate_pass_rate`, `ci.gate_first_try_pass_rate`, `ci.gate_retry_share`, `ci.run_duration_min` (plus p90 and stddev), `ci.run_hours` and `ci.deployments`.
2. Then step-level, test-level and external-CI metrics, which no connector serves yet.

## Where we are

- `pipelines` and `deployments` land in bronze, but no dbt model maps them to a class. A Bitbucket workspace shows no CI metrics.
- `pipelines` copies a few fields out of `target`, `trigger` and `state`, then drops those objects. The pipeline's identity (its selector), whether it ran for a pull request, and the rerun count are lost.
- `deployments` carries only an environment uuid. Production cannot be told apart from staging.

## Summary

| Change | Endpoint | Extra calls per sync | Enables |
|---|---|---|---|
| Extend `pipelines` | existing | none | all `ci.*` run metrics |
| `environments` | `/repositories/{repo}/environments/` | 1 per repository visited | `ci.deployments` split by production |
| `pipeline_steps` | `/pipelines/{uuid}/steps/` | 1 per newly finished pipeline run | slow steps, flaky steps, queue time |
| `pipeline_test_reports` | `/pipelines/{uuid}/steps/{step}/test_reports` | 1 per newly finished step | test counts and failure rate |
| `pull_request_statuses` | `/pullrequests/{id}/statuses` | 1 per pull request in the window | CI that runs outside Bitbucket Pipelines |

## Phase 1: parity with GitHub and GitLab

### Extend the pipelines stream

Keep these fields:

- `selector_type`, `selector_pattern` from `target.selector`. Types: `branches`, `tags`, `bookmarks`, `default`, `custom`, `pull-requests`.
- `target_type` from `target.type`: `pipeline_ref_target`, `pipeline_commit_target` or `pipeline_pullrequest_target`.
- `pullrequest_id` from `target.pullrequest.id`, and `source_branch` from `target.source`. Both are set only on pull-request targets, which carry no `ref_name`.
- `trigger_name` is kept already. Values: `PUSH`, `MANUAL`, `SCHEDULE`, `ON_DEMAND`.
- `state_stage` from `state.stage.name`: `RUNNING`, `PAUSED` or `HALTED`.
- `run_number` and `run_creation_date`. A rerun keeps the pipeline's `uuid`, `build_number` and `created_on`, raises `run_number` and moves `run_creation_date` to the latest run.
- `build_seconds_used`: billed build time.

Unfinished runs need no new mechanism. Each visit to a repository re-reads at least its 100 newest pipelines, because the data-feed stop still emits the whole boundary page. A run that was in progress, or that was rerun, gets its new state on the next visit to its repository.

### New stream: environments

- One call per repository visited, full refresh.
- Fields: `uuid`, `name`, `slug`, `environment_type.name` (`Test`, `Staging` or `Production`), `rank`.
- Feeds `environment` and `is_production` in `class_git_deployments`. GitLab uses the same join.

### dbt models

| Model | Class | Built from |
|---|---|---|
| `bitbucket_cloud__ci_runs` | `class_git_ci_runs` | `pipelines` |
| `bitbucket_cloud__deployments` | `class_git_deployments` | `deployments` joined to `environments` |
| `bitbucket_cloud__deployment_events` | `class_git_deployment_events` | `deployments`, one event per deployment state, as GitLab does |

How pipeline fields map to `class_git_ci_runs`:

| Class column | Bitbucket |
|---|---|
| `pipeline_key`, `pipeline_name` | `selector_type:selector_pattern`, or `selector_type` alone when there is no pattern |
| `run_id`, `run_number` | `uuid`, `build_number` |
| `attempt`, `is_retry` | `run_number`, `run_number > 1` |
| `trigger_category` | pull-request target with `PUSH`: `pull_request`. Other `PUSH`: `push`. `MANUAL`, `ON_DEMAND`: `manual`. `SCHEDULE`: `schedule` |
| `outcome` | `SUCCESSFUL`: `success`. `FAILED`, `ERROR`: `failure`. `STOPPED`: `cancelled`. `EXPIRED`: `timed_out`. Stage `PAUSED`: `success`. `PENDING`, `RUNNING`, `HALTED`: empty (undecided) |
| `created_at`, `started_at`, `finished_at` | `created_on`, `run_creation_date`, `completed_on` |
| `duration_s` | `duration_in_seconds` |
| `branch`, `commit_sha` | `target.ref_name` (`source_branch` on a pull request), `target.commit.hash` |

Mapping decisions:

- **A paused pipeline counts as `success`.** Bitbucket pauses a pipeline only after every automatic step before the manual one has passed, and its own UI shows such a pipeline as Successful. Paused pipelines can stay paused indefinitely, so treating them as undecided would drop them from every metric. If the manual step later fails, the failure belongs to the deployment, and `class_git_deployments` records it.
- **`duration_s` is Bitbucket's `duration_in_seconds`**, not `completed_on` minus `run_creation_date`. Bitbucket's figure leaves out time spent paused on a manual step, which can last days and would distort duration percentiles.
- **`EXPIRED` maps to `timed_out`**, the class's only outcome for a run that lapsed in time. It counts as a decided gate result that did not pass.
- **`ON_DEMAND` maps to `manual`.** It is a run started through the API or by an app rather than by a commit, the same as GitHub's `workflow_dispatch`, which also maps to `manual`.
- **`HALTED` stays undecided.** A halted pipeline's step is still pending and has never started.

How deployments map:

- `environment` and `is_production` come from the environment: `environment_type.name = 'Production'`. `is_transient` is always `0`, because Bitbucket has no throwaway preview environments.
- Event state: `COMPLETED` with `SUCCESSFUL` is `success`, with `FAILED` is `failure`, with `STOPPED` is `cancelled`. `IN_PROGRESS` is `in_progress`.
- `UNDEPLOYED` rows are skipped. Such a deployment is a placeholder for a manual deploy step that has not run. It enters the class once it runs.

## Phase 2: steps (Bitbucket's jobs)

### New stream: pipeline steps

- Child of `pipelines`. Fetch steps once per finished run: only for pipelines whose `completed_on` is newer than the steps stream's cursor. A rerun sets a new `completed_on`, so its steps are fetched again. Re-emitted boundary-page pipelines cost no step calls.
- The endpoint returns only the latest run of each step.
- Fields: `uuid`, `pipeline_uuid`, `name`, `state.name`, `state.result.name` (`SUCCESSFUL`, `FAILED`, `ERROR`, `STOPPED`, `EXPIRED`, `NOT_RUN`), `trigger.type` (`pipeline_step_trigger_automatic`, `pipeline_step_trigger_manual`, `pipeline_step_trigger_rerun`), `started_on`, `completed_on`, `duration_in_seconds`, `build_seconds_used`, `run_number`, `maxTime`, `image.name`.
- Drop `setup_commands`, `script_commands` and `teardown_commands`. They are large and no metric reads them.
- A step can fail while its pipeline succeeds, when the step is allowed to fail. Step metrics read the step's own result.

Metrics it enables:

- Slowest steps: p50 and p90 duration per step name.
- Flaky steps: steps that passed only after a rerun (`run_number > 1` and `SUCCESSFUL`).
- Queue time: from the pipeline's `run_creation_date` to the first step's `started_on`.
- Manual-gate wait: time from the last automatic step's `completed_on` to the manual step's `started_on`.
- Build minutes per step.

No silver class holds job-level rows yet. This phase adds `class_git_ci_jobs`, shaped so GitLab's `jobs` stream (already in bronze) can feed it later.

## Phase 3: test reports

### New stream: pipeline test reports

- Child of `pipeline_steps`, one call per newly finished step. A step does not say whether it has a report, so every step is asked.
- A `404` with key `report-service.test-report.not-found` means the step published no report. Treat it as no row, not as an error.
- Fields: `uuid`, `step_uuid`, `number_of_test_cases`, `number_of_successful_test_cases`, `number_of_failed_test_cases`, `number_of_error_test_cases`, `number_of_skipped_test_cases`. The report has no duration.
- Rows exist only for steps that publish JUnit or Maven Surefire XML reports.

Metrics it enables: test count trend, test failure rate and skipped-test share, per repository and pipeline.

Per-test results (`.../test_reports/test_cases`) are out of scope. That endpoint returns no cases for a report in which every test passed, so it cannot support slowest-test or flaky-test metrics.

## Phase 4: build statuses from external CI

### New stream: pull request statuses

- Child of the windowed pull-request parent, like `pull_request_activity`. Merging a pull request updates it, so final statuses are read at merge at the latest.
- Fields: `key`, `name`, `state` (`SUCCESSFUL`, `FAILED`, `INPROGRESS`, `STOPPED`), `refname`, `url`, `description`, `created_on`, `updated_on`, and the commit hash from `links.commit`.
- Jenkins, TeamCity, CircleCI and other external CI tools report results here. A workspace that does not use Bitbucket Pipelines has no other CI signal.
- Skip statuses whose `url` contains `/addon/pipelines/home`. Those are Bitbucket Pipelines' own statuses, already collected by `pipelines`.
- The per-commit endpoint (`/commit/{sha}/statuses`) also covers branch builds without a pull request, but it costs one call per commit, so it is not used.

Metrics it enables: pass rate per check `key`, and approximate duration (`updated_on` minus `created_on`).

## Out of scope

Step logs, per-test results, Code Insights reports (`/commit/{sha}/reports`, which cover quality and security rather than CI), caches, variables, schedules, runners and `pipelines_config`.

## Known limits

- `pipelines`, `deployments` and `environments` visit only repositories pushed to since the last sync. A run that finishes after the last visit to its repository gets its outcome at the next push. Until then it stays undecided and outside every metric.
- A run is re-read only while it is among its repository's 100 newest pipelines. A rerun of an older pipeline is not picked up.
- Steps and test reports multiply calls against the hourly budget (`bitbucket_api_calls_per_hour`, 1000 by default). Steps cost one call per finished run. Test reports cost one call per finished step.
