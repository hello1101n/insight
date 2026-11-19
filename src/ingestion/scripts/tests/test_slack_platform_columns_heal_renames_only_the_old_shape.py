"""The Slack activity heal renames `tenant_id` and `source_id` to their
`insight_` names on a table that still holds the old shape, leaves a converged
or absent table alone, and stops the hook on a column probe that did not answer.

The heal is lifted out of the deploy script and run against a stubbed
transport, since sourcing the script would run the deploy.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
EXEC_LIB = SCRIPTS / "lib" / "ch-exec.sh"
HEALS = SCRIPTS / "apply-ch-migrations.sh"

HEAL = "heal_slack_users_details_platform_columns"
REACHED_THE_END = "HOOK CONTINUED"
PROBE_FAILS = "FAILS"

OLD_SHAPE = {"tenant_id": "Nullable(String)", "source_id": "Nullable(String)"}
NEW_SHAPE = {"insight_tenant_id": "Nullable(String)", "insight_source_id": "Nullable(String)"}


def function_body(name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", HEALS.read_text(), re.MULTILINE | re.DOTALL)
    assert match, f"{HEALS.name} no longer defines {name}"
    return match.group(0)


def run(
    table_exists: str, columns: dict[str, str], tmp_path: Path
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """`table_exists` answers the system.tables probe; `columns` maps each column
    the table holds to its type (PROBE_FAILS fails that probe). Every other
    statement is logged and answered with nothing."""
    log = tmp_path / "statements.log"
    log.touch()
    column_cases = "\n".join(
        f"""    *"FROM system.columns"*"name='{name}'"*)
      [[ "{kind}" == "{PROBE_FAILS}" ]] && {{ printf 'Code: 999. DB::Exception: Service unavailable\\n'; return 22; }}
      printf '%s\\n' "{kind}" ;;"""
        for name, kind in columns.items()
    )
    script = f"""
set -euo pipefail
export CLICKHOUSE_URL=http://127.0.0.1:1 CLICKHOUSE_USER=u CLICKHOUSE_PASSWORD=p
source "{EXEC_LIB}"
_ch_http_query() {{
  local sql
  sql="$(cat)"
  printf '%s\\n;;\\n' "$sql" >> "$LOG"
  case "$sql" in
    *"FROM system.tables"*) printf '%s\\n' "{table_exists}" ;;
{column_cases}
    *"FROM system.columns"*) ;;
    *) ;;
  esac
}}
{function_body(HEAL)}
{HEAL}
echo '{REACHED_THE_END}'
"""
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "LOG": str(log)},
        check=False,
    )
    statements = [s.strip() for s in log.read_text().split("\n;;\n") if s.strip()]
    return result, statements


def alters(statements: list[str]) -> list[str]:
    return [s for s in statements if s.startswith("ALTER TABLE")]


def test_the_old_shape_gets_both_columns_renamed(tmp_path: Path) -> None:
    result, statements = run("1", OLD_SHAPE, tmp_path)

    assert result.returncode == 0, result.stderr
    assert REACHED_THE_END in result.stdout
    assert alters(statements) == [
        "ALTER TABLE bronze_slack.users_details RENAME COLUMN tenant_id TO insight_tenant_id",
        "ALTER TABLE bronze_slack.users_details RENAME COLUMN source_id TO insight_source_id",
    ]


@pytest.mark.parametrize(
    ("table_exists", "columns"),
    [("1", NEW_SHAPE), ("1", {**OLD_SHAPE, **NEW_SHAPE}), ("0", {})],
    ids=["converged", "both-names", "no-table"],
)
def test_a_table_without_the_old_shape_alone_is_left_alone(
    table_exists: str, columns: dict[str, str], tmp_path: Path
) -> None:
    result, statements = run(table_exists, columns, tmp_path)

    assert result.returncode == 0, result.stderr
    assert REACHED_THE_END in result.stdout
    assert not alters(statements), f"should not rename: {columns}"


@pytest.mark.parametrize("failing", ["tenant_id", "insight_tenant_id"])
def test_an_unanswered_column_probe_stops_the_hook_before_any_rename(failing: str, tmp_path: Path) -> None:
    columns = {**OLD_SHAPE, failing: PROBE_FAILS}

    result, statements = run("1", columns, tmp_path)

    assert result.returncode != 0, result
    assert REACHED_THE_END not in result.stdout, f"the hook carried on over a failed probe of {failing}"
    assert not alters(statements), f"the heal renamed after a failed probe of {failing}"
