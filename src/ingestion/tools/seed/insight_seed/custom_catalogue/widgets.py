"""The seeded widgets: every widget type, drawn over the seeded metrics."""

from __future__ import annotations

from typing import Any, Final

from .definition import Definition
from .metrics import MISSING_COLUMN


def _widget(slug: str, name: str, kind: str, metric: str, **columns: Any) -> Definition:
    return Definition(
        f"stand-w-{slug}", name, {"type": kind, "metric": f"stand-m-{metric}", **columns}
    )


WIDGETS: Final[tuple[Definition, ...]] = (
    _widget("prs-line", "Pull requests opened", "line", "prs-over-time", x="bucket", y="prs"),
    _widget("merged-area", "Pull requests merged", "area", "prs-over-time", x="bucket", y="merged"),
    _widget(
        "prs-stat",
        "Pull requests opened in the window",
        "stat",
        "prs-over-time",
        value="prs",
        label="opened",
    ),
    _widget(
        "merged-share-stat",
        "Merged share",
        "stat",
        "prs-over-time",
        value="merged_share",
        label="of opened pull requests",
    ),
    _widget(
        "merged-share-line",
        "Merged share over time",
        "line",
        "prs-over-time",
        x="bucket",
        y="merged_share",
    ),
    _widget(
        "prs-table",
        "Pull requests per bucket",
        "table",
        "prs-over-time",
        columns=["bucket", "prs", "merged", "merged_share"],
    ),
    _widget(
        "state-pie", "Pull requests by state", "pie", "prs-by-state", label="state", value="prs"
    ),
    _widget(
        "state-bar-labels",
        "Pull requests by state, with totals",
        "bar",
        "prs-by-state",
        x="state",
        y="prs",
        labels=True,
    ),
    _widget(
        "state-table",
        "Pull requests by state, as a table",
        "table",
        "prs-by-state",
        columns=["state", "prs"],
    ),
    _widget(
        "ci-stacked-bar",
        "CI runs by pipeline and outcome",
        "bar",
        "ci-runs-by-pipeline-and-outcome",
        x="pipeline_name",
        y="runs",
        series="outcome",
    ),
    _widget(
        "ci-success-table",
        "CI success share by pipeline",
        "table",
        "ci-success-by-pipeline",
        columns=["pipeline_name", "runs", "succeeded", "success_share"],
    ),
    _widget(
        "ci-success-bar",
        "CI success share by pipeline, as bars",
        "bar",
        "ci-success-by-pipeline",
        x="pipeline_name",
        y="success_share",
    ),
    _widget(
        "commits-bar", "Commits by author", "bar", "commits-by-author", x="author_name", y="commits"
    ),
    _widget(
        "commits-pie",
        "Lines added by author",
        "pie",
        "commits-by-author",
        label="author_name",
        value="lines_added",
    ),
    _widget(
        "deploys-bar",
        "Deployments in each of many environments",
        "bar",
        "deploys-by-environment",
        x="environment",
        y="deploys",
    ),
    _widget(
        "wiki-bar",
        "Wiki edits by page title",
        "bar",
        "wiki-edits-by-page-title",
        x="title",
        y="edits",
    ),
    _widget(
        "wiki-table",
        "Wiki edits by page title, as a table",
        "table",
        "wiki-edits-by-page-title",
        columns=["title", "edits"],
    ),
    _widget(
        "pr-list",
        "Every pull request",
        "table",
        "pr-list",
        columns=[
            "pr_number",
            "title",
            "state",
            "author_name",
            "created_on",
            "closed_on",
            "lines_added",
        ],
    ),
    _widget(
        "deals-bar",
        "Deals by lead source",
        "bar",
        "deals-by-lead-source",
        x="lead_source",
        y="deals",
    ),
    _widget(
        "deals-table",
        "Deals by lead source, as a table",
        "table",
        "deals-by-lead-source",
        columns=["lead_source", "deals", "amount"],
    ),
    _widget(
        "ci-ratio-table",
        "CI skipped runs per waiting run",
        "table",
        "ci-skips-per-blocked-run",
        columns=["pipeline_name", "skipped", "waiting", "skips_per_waiting_run"],
    ),
    _widget(
        "ci-ratio-bar",
        "CI skipped runs per waiting run, as bars",
        "bar",
        "ci-skips-per-blocked-run",
        x="pipeline_name",
        y="skips_per_waiting_run",
    ),
    _widget(
        "latest-close-stat",
        "Latest close of an open pull request",
        "stat",
        "latest-close-of-open-prs",
        value="latest_close",
    ),
    _widget("empty-line", "No rows, as a line", "line", "no-rows", x="bucket", y="prs"),
    _widget("empty-bar", "No rows, as bars", "bar", "no-rows", x="state", y="prs"),
    _widget("empty-pie", "No rows, as a pie", "pie", "no-rows", label="state", value="prs"),
    _widget("empty-table", "No rows, as a table", "table", "no-rows", columns=["state", "prs"]),
    _widget("empty-stat", "No rows, as a figure", "stat", "no-rows", value="prs"),
    _widget(
        "missing-column-table",
        "Unknown column, fails on purpose",
        "table",
        "missing-column",
        columns=[MISSING_COLUMN, "prs"],
    ),
    _widget(
        "sample-bar", "Sample points by team", "bar", "sample-points-by-team", x="team", y="points"
    ),
    _widget(
        "sample-table",
        "Sample points by team, as a table",
        "table",
        "sample-points-by-team",
        columns=["team", "points"],
    ),
)

#: The widget whose run fails, so a test knows which cell must show the failure.
FAILING_WIDGETS: Final = frozenset({"stand-w-missing-column-table"})
