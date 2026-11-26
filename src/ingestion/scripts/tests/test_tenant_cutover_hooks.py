"""The cutover hooks against a fake cluster: suspend only when there is work,
put the writers back when the migration fails, and resume them only at the end
of the rebuild."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "tenant-cutover.sh"
TENANT = "0f6b3c2e-5d4a-4e7b-9c1d-2a3b4c5d6e7f"
CM = "insight-tenant-cutover"

# A kubectl that keeps the cluster in a JSON file: just the verbs the script uses.
FAKE_KUBECTL = r"""
import json, os, sys
path = os.environ["FAKE_CLUSTER"]
state = json.load(open(path))
args = sys.argv[1:]
if args[:1] == ["-n"]:
    args = args[2:]
state["calls"].append(" ".join(args))

def save():
    json.dump(state, open(path, "w"))

def items(kind):
    return [{"metadata": {"name": n, "labels": o.get("labels", {})}, "spec": {"suspend": o["suspend"]},
             "status": {"phase": o.get("phase", "")}} for n, o in state[kind].items()]

verb, rest = args[0], args[1:]
if verb == "get":
    kind = rest[0]
    if kind == "configmap":
        if rest[1] not in state["configmaps"]:
            sys.exit(1)
        print(state["configmaps"][rest[1]] if "jsonpath={.data.state\\.json}" in rest else "configmap/" + rest[1])
    elif kind in ("cronworkflows", "cronjobs", "workflows"):
        if kind == "workflows" and "-l" in rest:
            print(json.dumps({"items": [i for i in items(kind) if i["metadata"]["labels"]]}))
        else:
            print(json.dumps({"items": items(kind)}))
    elif kind in ("cronworkflow", "cronjob"):
        if rest[1] not in state[kind + "s"]:
            sys.exit(1)
        print(kind + "/" + rest[1])
    else:
        sys.exit(f"unexpected get {rest}")
elif verb == "create" and rest[0] == "configmap":
    state["configmaps"][rest[1]] = rest[2].split("=", 2)[2]
elif verb == "create" and rest[0] == "-o":
    body = json.load(sys.stdin)
    state["workflows"]["tenant-cutover-rebuild-x"] = {"suspend": False, "labels": body["metadata"]["labels"],
                                                     "phase": "Running", "template": body["spec"]["workflowTemplateRef"]["name"]}
    print("workflow.argoproj.io/tenant-cutover-rebuild-x")
elif verb == "delete":
    state["configmaps"].pop(rest[1])
elif verb == "patch":
    state[rest[0] + "s"][rest[1]]["suspend"] = json.loads(rest[5])["spec"]["suspend"]
elif verb == "label":
    pass
else:
    sys.exit(f"unexpected {args}")
save()
"""

FAKE_AIRBYTE = """
ab__curl() { printf '{"data": []}'; }
"""


def _cluster(**overrides: object) -> dict[str, object]:
    cluster: dict[str, object] = {
        "calls": [],
        "configmaps": {},
        "workflows": {},
        "cronjobs": {"insight-identity-resolution-seed": {"suspend": False}},
        "cronworkflows": {
            "insight-reconcile-loop": {"suspend": False, "labels": {"app.kubernetes.io/component": "reconcile-loop"}},
            "insight-data-quality": {"suspend": True},
            "jira-main-examplel-sync": {
                "suspend": False,
                "labels": {
                    "app.kubernetes.io/component": "connector-sync",
                    "insight.cyberfabric.com/tenant": "example-legacy",
                },
            },
            "zoom-main-0f6b3c2e-sync": {
                "suspend": False,
                "labels": {"app.kubernetes.io/component": "connector-sync", "insight.cyberfabric.com/tenant": TENANT},
            },
        },
    }
    cluster.update(overrides)
    return cluster


def _run(
    tmp_path: Path, command: str, cluster: dict[str, object], *, plan: int = 1, apply: int = 0, idle_timeout: str = "60"
) -> tuple[subprocess.CompletedProcess[str], dict]:
    bin_dir, lib = tmp_path / "bin", tmp_path / "lib"
    bin_dir.mkdir(exist_ok=True)
    lib.mkdir(exist_ok=True)
    (bin_dir / "kubectl").write_text(f"#!{sys.executable}\n{FAKE_KUBECTL}")
    (bin_dir / "kubectl").chmod(0o755)
    (lib / "airbyte.sh").write_text(FAKE_AIRBYTE)
    (bin_dir / "fake-migration").write_text(
        f'#!/bin/sh\necho "$@" >> {tmp_path}/migration.log\n[ "$1" = plan ] && exit {plan}\nexit {apply}\n'
    )
    (bin_dir / "fake-migration").chmod(0o755)
    state = tmp_path / "cluster.json"
    state.write_text(json.dumps(cluster))
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "FAKE_CLUSTER": str(state),
        "TENANT_MIGRATION": "fake-migration",
        "RECONCILE_LIB": str(lib),
        "INSIGHT_NAMESPACE": "insight",
        "CUTOVER_CONFIGMAP": CM,
        "INSIGHT_TENANT_ID": TENANT,
        "REBUILD_TEMPLATE": "tenant-cutover-rebuild",
        "AIRBYTE_URL": "http://airbyte",
        "POLL_SECONDS": "0",
        "IDLE_TIMEOUT_SECONDS": idle_timeout,
    }
    result = subprocess.run(
        ["bash", str(SCRIPT), command], check=False, env=env, capture_output=True, text=True, timeout=60
    )
    return result, json.loads(state.read_text())


def _suspended(cluster: dict) -> dict[str, bool]:
    return {n: o["suspend"] for kind in ("cronworkflows", "cronjobs") for n, o in cluster[kind].items()}


def test_with_nothing_to_migrate_pre_suspends_nothing_and_post_submits_nothing(tmp_path: Path) -> None:
    before = _cluster()

    pre, after_pre = _run(tmp_path, "pre", before, plan=0)
    post, after_post = _run(tmp_path, "post", after_pre)

    assert pre.returncode == 0 and post.returncode == 0, pre.stderr + post.stderr
    assert _suspended(after_post) == _suspended(before)
    assert not any(c.startswith(("patch", "create")) for c in after_post["calls"])
    assert after_post["workflows"] == {}


def test_pre_suspends_every_writer_migrates_and_keeps_them_suspended(tmp_path: Path) -> None:
    result, cluster = _run(tmp_path, "pre", _cluster())

    assert result.returncode == 0, result.stderr
    assert set(_suspended(cluster).values()) == {True}
    assert (tmp_path / "migration.log").read_text().splitlines() == ["plan --exit-code", "apply"]
    assert CM in cluster["configmaps"]


@pytest.mark.parametrize("apply", [2, 143])
def test_a_failed_migration_puts_the_writers_back_and_forgets_the_state(tmp_path: Path, apply: int) -> None:
    before = _cluster()

    result, cluster = _run(tmp_path, "pre", before, apply=apply)

    assert result.returncode != 0
    assert _suspended(cluster) == _suspended(before)
    assert cluster["configmaps"] == {}


def test_a_failed_undo_keeps_the_writers_stopped_for_the_next_deploy(tmp_path: Path) -> None:
    result, cluster = _run(tmp_path, "pre", _cluster(), apply=3)

    assert result.returncode != 0
    assert set(_suspended(cluster).values()) == {True}
    assert CM in cluster["configmaps"]


def test_a_busy_cluster_fails_the_deploy_after_the_bounded_wait_and_puts_the_writers_back(tmp_path: Path) -> None:
    before = _cluster(workflows={"jira-sync-123": {"suspend": False, "phase": "Running"}})

    result, cluster = _run(tmp_path, "pre", before, idle_timeout="0")

    assert result.returncode != 0
    assert "still busy" in result.stderr and "jira-sync-123" in result.stderr
    assert "apply" not in (tmp_path / "migration.log").read_text()
    assert _suspended(cluster) == _suspended(_cluster())
    assert cluster["configmaps"] == {}


def test_post_submits_one_rebuild_and_resume_restores_the_recorded_state(tmp_path: Path) -> None:
    before = _cluster()
    _, migrated = _run(tmp_path, "pre", before)

    post, submitted = _run(tmp_path, "post", migrated)
    again, resubmitted = _run(tmp_path, "post", submitted)
    resume, resumed = _run(tmp_path, "resume", resubmitted)

    assert post.returncode == 0 and again.returncode == 0 and resume.returncode == 0, resume.stderr
    assert list(resubmitted["workflows"]) == ["tenant-cutover-rebuild-x"]
    assert "already running" in again.stdout
    assert set(_suspended(submitted).values()) == {True}, "writers stay suspended until the rebuild ends"
    assert _suspended(resumed) == {
        "insight-reconcile-loop": False,
        "insight-data-quality": True,
        "jira-main-examplel-sync": True,
        "zoom-main-0f6b3c2e-sync": False,
        "insight-identity-resolution-seed": False,
    }, "the schedule named for the former tenant is left to reconcile"
    assert resumed["configmaps"] == {}


def test_a_redeploy_while_a_rebuild_is_owed_keeps_the_first_recorded_state(tmp_path: Path) -> None:
    _, migrated = _run(tmp_path, "pre", _cluster())
    recorded = migrated["configmaps"][CM]

    _, again = _run(tmp_path, "pre", migrated, apply=2)

    assert again["configmaps"][CM] == recorded, "a failed later run must not forget or overwrite the state"
    assert set(_suspended(again).values()) == {True}


def test_a_failed_rebuild_reports_loudly_resumes_the_writers_and_is_not_submitted_again(tmp_path: Path) -> None:
    _, migrated = _run(tmp_path, "pre", _cluster())
    _, submitted = _run(tmp_path, "post", migrated)
    submitted["workflows"]["tenant-cutover-rebuild-x"]["phase"] = "Failed"

    report, reported = _run(tmp_path, "report", submitted)
    _, resumed = _run(tmp_path, "resume", reported)
    post, after = _run(tmp_path, "post", resumed)

    assert report.returncode != 0 and "THE REBUILD FAILED" in report.stderr
    assert not any(c.startswith(("patch", "create", "delete")) for c in reported["calls"][len(submitted["calls"]) :])
    assert _suspended(resumed)["insight-reconcile-loop"] is False
    assert post.returncode == 0 and "no rebuild" in post.stdout
    assert list(after["workflows"]) == ["tenant-cutover-rebuild-x"]
