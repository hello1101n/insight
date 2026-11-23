"""On a cluster, the database of the Bronze destination is Atomic."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
TOPOLOGY_LIB = SCRIPTS / "lib" / "ch-topology.sh"
CREATE_DATABASES = SCRIPTS / "create-databases.sh"

SCRIPTED = """
_ch_http_query() {
  local sql
  sql="$(cat)"
  printf '%s\\n' "${sql}" >> "${SQL_LOG}"
  case "${sql}" in
    *clusterAllReplicas*system.tables*) printf '\\n' ;;
    *system.user_directories*) printf '1\\n' ;;
    *system.macros*) printf '2\\n' ;;
    *system.zookeeper*"/replicas"*) printf '0\\n' ;;
    *engine_full*) printf '\\n' ;;
    *"system.databases WHERE name = '${CLICKHOUSE_DESTINATION_DATABASE:-}'"*) printf '%s\\n' "${DESTINATION_ENGINE}" ;;
    *system.databases*) printf '\\n' ;;
    *) printf '1\\n' ;;
  esac
}
"""


def deploy(
    tmp_path: Path, *, destination: str | None, cluster_mode: str = "true", destination_engine: str = ""
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    shims = tmp_path / "bin"
    shims.mkdir(exist_ok=True)
    (shims / "bash").write_text("#!/bin/sh\n")
    (shims / "bash").chmod(0o755)
    sql = tmp_path / "sql.log"

    exports = f"export CLICKHOUSE_DESTINATION_DATABASE='{destination}'" if destination is not None else ""
    script = f"""
set -euo pipefail
export CLICKHOUSE_URL=http://127.0.0.1:1 CLICKHOUSE_USER=u CLICKHOUSE_PASSWORD=p
export CLICKHOUSE_CLUSTER_MODE={cluster_mode} CLICKHOUSE_CLUSTER_NAME=insight_cluster
{exports}
source "$TOPOLOGY_LIB"
{SCRIPTED}
CLICKHOUSE_DATABASE=insight source "{CREATE_DATABASES}"
"""
    real_bash = shutil.which("bash", path="/usr/bin:/bin")
    assert real_bash, "no bash on /usr/bin:/bin"

    result = subprocess.run(
        [real_bash, "-c", script],
        capture_output=True,
        text=True,
        env={
            "TOPOLOGY_LIB": str(TOPOLOGY_LIB),
            "PATH": f"{shims}:/usr/bin:/bin",
            "DESTINATION_ENGINE": destination_engine,
            "SQL_LOG": str(sql),
        },
        check=False,
    )
    sent = sql.read_text().splitlines() if sql.exists() else []

    return result, [line for line in sent if line.startswith("CREATE DATABASE")]


def test_on_a_cluster_the_destination_database_is_created_atomic_on_every_replica(tmp_path: Path) -> None:
    result, creates = deploy(tmp_path, destination="airbyte_destination")

    assert result.returncode == 0, result.stderr
    assert len(creates) == 10, creates
    [created] = [line for line in creates if "`airbyte_destination`" in line]
    assert "ON CLUSTER insight_cluster" in created, created
    assert created.endswith("ENGINE = Atomic"), created


@pytest.mark.parametrize("destination", [None, "insight"])
def test_a_standalone_destination_on_the_app_database_creates_nothing_more(
    tmp_path: Path, destination: str | None
) -> None:
    result, creates = deploy(tmp_path, destination=destination, cluster_mode="false")

    assert result.returncode == 0, result.stderr
    assert len(creates) == 9, creates


def test_a_standalone_destination_of_its_own_is_atomic_without_a_cluster(tmp_path: Path) -> None:
    result, creates = deploy(tmp_path, destination="airbyte_destination", cluster_mode="false")

    assert result.returncode == 0, result.stderr
    [created] = [line for line in creates if "`airbyte_destination`" in line]
    assert "ON CLUSTER" not in created, created
    assert created.endswith("ENGINE = Atomic"), created


@pytest.mark.parametrize("destination", ["insight", "silver"])
def test_on_a_cluster_a_database_the_deploy_makes_replicated_is_refused(tmp_path: Path, destination: str) -> None:
    result, creates = deploy(tmp_path, destination=destination)

    assert result.returncode != 0, result.stdout
    assert not creates, f"the deploy created databases before refusing: {creates}"
    assert "Code 80" in result.stderr, result.stderr
    assert "ingestion.reconcile.destinationDatabase" in result.stderr, result.stderr


def test_on_a_cluster_a_replicated_database_standing_under_the_name_is_refused(tmp_path: Path) -> None:
    result, creates = deploy(tmp_path, destination="airbyte_destination", destination_engine="Replicated")

    assert result.returncode != 0, result.stdout
    assert not creates, creates
    assert "already" in result.stderr and "Replicated" in result.stderr, result.stderr


@pytest.mark.parametrize("destination", ["has space", "1leading", "a`b", "x; DROP DATABASE y"])
def test_a_destination_database_must_be_a_bare_identifier(tmp_path: Path, destination: str) -> None:
    result, creates = deploy(tmp_path, destination=destination)

    assert result.returncode != 0, result.stdout
    assert not creates, creates
    assert "bare ClickHouse identifier" in result.stderr, result.stderr


def test_a_cluster_deploy_that_names_no_destination_database_creates_the_default(tmp_path: Path) -> None:
    result, creates = deploy(tmp_path, destination=None)

    assert result.returncode == 0, result.stderr
    assert any("`airbyte_destination` ON CLUSTER insight_cluster ENGINE = Atomic" in line for line in creates), creates
