"""The seeded metrics: each reads a silver table that the seed fills, or the dataset."""

from __future__ import annotations

from typing import Any, Final

from .dataset import DATASET_NAME
from .definition import Body, Definition

#: The metric that reads a column the table does not have. Its run fails in
#: ClickHouse, which is the failure a reader of the board must see.
#: INVARIANT: the names of the failing metric and widget do not sort first in
#: their lists. The portal smoke tests open the first item of each list and fail
#: on a server error.
MISSING_COLUMN: Final = "no_such_column"

#: A value no seeded pull request carries, so a metric filtered on it has no rows.
NO_SUCH_STATE: Final = "NO_SUCH_STATE"

_PULL_REQUESTS: Final[Body] = {"database": "silver", "table": "class_git_pull_requests"}
_CI_RUNS: Final[Body] = {"database": "silver", "table": "class_git_ci_runs"}
_DEPLOYMENTS: Final[Body] = {"database": "silver", "table": "class_git_deployments"}
_WIKI_PAGES: Final[Body] = {"database": "silver", "table": "class_wiki_pages"}
_DEALS: Final[Body] = {"database": "silver", "table": "class_crm_deals"}
_COMMITS: Final[Body] = {"database": "silver", "table": "class_git_commits"}


def _column(name: str, kind: str = "string", as_name: str | None = None, **extra: Any) -> Body:
    return {"column": name, "type": kind, "as_name": as_name or name, **extra}


def _count(column: str, as_name: str, **extra: Any) -> Body:
    return _column(column, "int", as_name, agg="count", **extra)


def _eq(column: str, value: str) -> Body:
    return {"column": column, "type": "string", "op": "eq", "value": value}


def _ratio(numerator: str, denominator: str, as_name: str, *, percent: bool) -> Body:
    return {
        "type": "float",
        "as_name": as_name,
        "divide": [numerator, denominator],
        "percent": percent,
    }


METRICS: Final[tuple[Definition, ...]] = (
    Definition(
        "stand-m-prs-over-time",
        "Stand: pull requests over time",
        {
            **_PULL_REQUESTS,
            "time": {"column": "created_on"},
            "fields": [
                _count("pr_id", "prs"),
                _count("pr_id", "merged", when=[_eq("state", "MERGED")]),
                _ratio("merged", "prs", "merged_share", percent=True),
            ],
        },
    ),
    Definition(
        "stand-m-prs-by-state",
        "Stand: pull requests by state",
        {
            **_PULL_REQUESTS,
            "fields": [_column("state"), _count("pr_id", "prs")],
            "group_by": ["state"],
        },
    ),
    Definition(
        "stand-m-ci-runs-by-pipeline-and-outcome",
        "Stand: CI runs by pipeline and outcome",
        {
            **_CI_RUNS,
            "time": {"column": "created_at"},
            "fields": [
                _column("pipeline_name"),
                _column("outcome"),
                _count("run_id", "runs"),
            ],
            "group_by": ["pipeline_name", "outcome"],
        },
    ),
    Definition(
        "stand-m-ci-success-by-pipeline",
        "Stand: CI success share by pipeline",
        {
            **_CI_RUNS,
            "time": {"column": "created_at"},
            "fields": [
                _column("pipeline_name"),
                _count("run_id", "runs"),
                _count("run_id", "succeeded", when=[_eq("outcome", "success")]),
                _ratio("succeeded", "runs", "success_share", percent=True),
            ],
            "group_by": ["pipeline_name"],
            "order_by": {"field": "pipeline_name"},
        },
    ),
    Definition(
        "stand-m-commits-by-author",
        "Stand: commits by author",
        {
            **_COMMITS,
            "time": {"column": "date"},
            "fields": [
                _column("author_name"),
                _count("commit_hash", "commits"),
                _column("lines_added", "int", "lines_added", agg="sum"),
            ],
            "group_by": ["author_name"],
            "order_by": {"field": "commits", "direction": "desc"},
        },
    ),
    Definition(
        "stand-m-deploys-by-environment",
        "Stand: deployments by environment",
        {
            **_DEPLOYMENTS,
            "fields": [_column("environment"), _count("deployment_id", "deploys")],
            "group_by": ["environment"],
            "order_by": {"field": "environment"},
        },
    ),
    Definition(
        "stand-m-wiki-edits-by-page-title",
        "Stand: wiki edits by page title",
        {
            **_WIKI_PAGES,
            "fields": [
                _column("title"),
                _column("version_count", "int", "edits", agg="sum"),
            ],
            "group_by": ["title"],
            "order_by": {"field": "edits", "direction": "desc"},
            "limit": 40,
        },
    ),
    Definition(
        "stand-m-pr-list",
        "Stand: every pull request",
        {
            **_PULL_REQUESTS,
            "fields": [
                _column("pr_number", "int"),
                _column("title"),
                _column("state"),
                _column("author_name"),
                _column("created_on"),
                _column("closed_on"),
                _column("lines_added", "int"),
            ],
            "order_by": {"field": "pr_number"},
            "limit": 1000,
        },
    ),
    Definition(
        "stand-m-deals-by-lead-source",
        "Stand: deals by lead source",
        {
            **_DEALS,
            "fields": [
                _column("lead_source"),
                _count("deal_id", "deals"),
                _column("amount", "float", "amount", agg="sum"),
            ],
            "group_by": ["lead_source"],
        },
    ),
    Definition(
        "stand-m-ci-skips-per-blocked-run",
        "Stand: CI skipped runs per run that waits for an action",
        {
            **_CI_RUNS,
            "fields": [
                _column("pipeline_name"),
                _count("run_id", "skipped", when=[_eq("outcome", "skipped")]),
                _count("run_id", "waiting", when=[_eq("outcome", "action_required")]),
                _ratio("skipped", "waiting", "skips_per_waiting_run", percent=False),
            ],
            "group_by": ["pipeline_name"],
            "order_by": {"field": "pipeline_name"},
        },
    ),
    Definition(
        "stand-m-latest-close-of-open-prs",
        "Stand: latest close of an open pull request",
        {
            **_PULL_REQUESTS,
            "fields": [_column("closed_on", "string", "latest_close", agg="max")],
            "filters": [_eq("state", "OPEN")],
        },
    ),
    Definition(
        "stand-m-no-rows",
        "Stand: pull requests in a state nobody uses",
        {
            **_PULL_REQUESTS,
            "time": {"column": "created_on"},
            "fields": [_column("state"), _count("pr_id", "prs")],
            "group_by": ["state"],
            "filters": [_eq("state", NO_SUCH_STATE)],
        },
    ),
    Definition(
        "stand-m-missing-column",
        "Stand: unknown column, fails on purpose",
        {
            **_PULL_REQUESTS,
            "fields": [_column(MISSING_COLUMN), _count("pr_id", "prs")],
            "group_by": [MISSING_COLUMN],
        },
    ),
    Definition(
        "stand-m-sample-points-by-team",
        "Stand: sample points by team",
        {
            "dataset": DATASET_NAME,
            "fields": [
                {"field": "team", "type": "string", "as_name": "team"},
                {"field": "points", "type": "int", "agg": "sum", "as_name": "points"},
            ],
            "group_by": ["team"],
            "order_by": {"field": "team"},
        },
    ),
)
