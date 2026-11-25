"""The Slack users snapshot heal gives a snapshot of the old shape the columns of
slack__users_latest, removes the bot and guest versions before it drops the guest flag,
leaves an absent table alone, and stops the hook on a column probe that did
not answer.

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

HEAL = "heal_slack_users_snapshot_columns"
REACHED_THE_END = "HOOK CONTINUED"
PROBE_FAILS = "FAILS"

SNAPSHOT = "staging.slack__users_snapshot"
ACTIVITY = "bronze_slack.users_details"
MEMBERS = "bronze_slack.users"

OWN_FLAGS = "coalesce(is_guest, false) OR user_id = 'USLACKBOT'"
ACTIVITY_GUESTS = (
    " OR (insight_tenant_id, source_id, user_id) IN (SELECT insight_tenant_id, insight_source_id, user_id"
    " FROM bronze_slack.users_details FINAL GROUP BY insight_tenant_id, insight_source_id, user_id"
    " HAVING argMax(coalesce(is_guest, false), date))"
)
MEMBERS_BOTS_AND_GUESTS = (
    " OR (insight_tenant_id, source_id, user_id) IN (SELECT insight_tenant_id, insight_source_id, user_id"
    " FROM bronze_slack.users FINAL"
    " WHERE coalesce(is_bot, false) OR coalesce(is_restricted, false) OR coalesce(is_ultra_restricted, false))"
)


def delete(predicate: str) -> str:
    return f"ALTER TABLE staging.slack__users_snapshot DELETE WHERE {predicate} SETTINGS mutations_sync = 2"


SHAPE_ALTERS = [
    "ALTER TABLE staging.slack__users_snapshot ADD COLUMN IF NOT EXISTS display_name Nullable(String) AFTER email",
    "ALTER TABLE staging.slack__users_snapshot MODIFY COLUMN display_name Nullable(String) AFTER email",
    "ALTER TABLE staging.slack__users_snapshot DROP COLUMN IF EXISTS is_guest, DROP COLUMN IF EXISTS is_billable_seat",
]


def function_body(name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", HEALS.read_text(), re.MULTILINE | re.DOTALL)
    assert match, f"{HEALS.name} no longer defines {name}"
    return match.group(0)


def run(tables: set[str], is_guest_type: str, tmp_path: Path) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """`tables` names the tables the system.tables probe finds; `is_guest_type` answers the
    probe of the is_guest column ('' when absent, PROBE_FAILS fails it). Every
    other statement is logged and answered with nothing."""
    log = tmp_path / "statements.log"
    log.touch()
    script = f"""
set -euo pipefail
export CLICKHOUSE_URL=http://127.0.0.1:1 CLICKHOUSE_USER=u CLICKHOUSE_PASSWORD=p
source "{EXEC_LIB}"
_ch_http_query() {{
  local sql
  sql="$(cat)"
  printf '%s\\n;;\\n' "$sql" >> "$LOG"
  case "$sql" in
{table_probes(tables)}
    *"FROM system.columns"*"name='is_guest'"*)
      [[ "{is_guest_type}" == "{PROBE_FAILS}" ]] && {{ printf 'Code: 999. DB::Exception: Service unavailable\\n'; return 22; }}
      printf '%s' "{is_guest_type}" ;;
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


def table_probes(tables: set[str]) -> str:
    cases = []
    for table in (SNAPSHOT, ACTIVITY, MEMBERS):
        database, name = table.split(".")
        found = 1 if table in tables else 0
        cases.append(
            f"""    *"FROM system.tables"*"database='{database}' AND name='{name}'"*) printf '{found}\\n' ;;"""
        )
    return "\n".join(cases)


def alters(statements: list[str]) -> list[str]:
    return [s for s in statements if s.startswith("ALTER TABLE")]


@pytest.mark.parametrize(
    ("tables", "predicate"),
    [
        ({SNAPSHOT}, OWN_FLAGS),
        ({SNAPSHOT, ACTIVITY}, OWN_FLAGS + ACTIVITY_GUESTS),
        ({SNAPSHOT, MEMBERS}, OWN_FLAGS + MEMBERS_BOTS_AND_GUESTS),
        ({SNAPSHOT, ACTIVITY, MEMBERS}, OWN_FLAGS + ACTIVITY_GUESTS + MEMBERS_BOTS_AND_GUESTS),
    ],
)
def test_the_old_shape_loses_its_bot_and_guest_versions_before_the_flag_goes(
    tables: set[str], predicate: str, tmp_path: Path
) -> None:
    result, statements = run(tables, "Nullable(Bool)", tmp_path)

    assert result.returncode == 0, result.stderr
    assert REACHED_THE_END in result.stdout
    assert alters(statements) == [delete(predicate), *SHAPE_ALTERS], f"tables: {sorted(tables)}"


def test_a_converged_snapshot_gets_only_the_idempotent_shape_alters(tmp_path: Path) -> None:
    result, statements = run({SNAPSHOT, ACTIVITY, MEMBERS}, "", tmp_path)

    assert result.returncode == 0, result.stderr
    assert REACHED_THE_END in result.stdout
    assert alters(statements) == SHAPE_ALTERS


def test_an_absent_snapshot_is_left_alone(tmp_path: Path) -> None:
    result, statements = run({ACTIVITY, MEMBERS}, "", tmp_path)

    assert result.returncode == 0, result.stderr
    assert REACHED_THE_END in result.stdout
    assert not alters(statements)


def test_an_unanswered_column_probe_stops_the_hook_before_any_alter(tmp_path: Path) -> None:
    result, statements = run({SNAPSHOT}, PROBE_FAILS, tmp_path)

    assert result.returncode != 0, result
    assert REACHED_THE_END not in result.stdout, "the hook carried on over a failed probe of is_guest"
    assert not alters(statements), "the heal altered the snapshot after a failed probe of is_guest"
