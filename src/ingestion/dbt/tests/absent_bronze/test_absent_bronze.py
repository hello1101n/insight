"""Absent and empty bronze are normal; a run builds around them, never through them.

A connector not configured on an install has no bronze; one configured and not
synced yet has empty bronze. `list_unbuildable_models` leaves out every model
that would read either (empty only while the model was never built), and every
model that would read one of those, each with a logged reason; `union_by_tag` leaves the same arms out of a silver class. What
it never does is hide a real failure: bronze that holds rows the model cannot
read still fails the run.

Bronze is laid down by hand here, not by the destination: the subject is the
decision (is the table there, does it hold rows), and the tables carry only the
columns the one chain that is built (Zulip's identity inputs) reads. Both
spellings of the source id column are present, so the shape survives the
`source_id` -> `insight_source_id` rename.
"""

from __future__ import annotations

from conftest import TENANT, Warehouse, dbt, unbuildable

#: Read with FINAL. An empty plain MergeTree here (what a full_refresh stream's
#: first sync leaves) refuses FINAL: the failure a full rebuild hit on real stands.
ISSUETYPES_MODEL = "jira__task_issuetypes"
ISSUETYPES_BRONZE = ("bronze_jira", "jira_issuetypes")

#: A connector whose identity chain reads one bronze table.
ZULIP_BRONZE = ("bronze_zulip_proxy", "users")
ZULIP_CHAIN = ("zulip_proxy__users_snapshot", "zulip_proxy__users_fields_history", "zulip_proxy__identity_inputs")
OUTLINE_BRONZE = ("bronze_outline", "wiki_users")
OUTLINE_CHAIN = ("outline__users_snapshot", "outline__users_fields_history", "outline__identity_inputs")

#: A class fed by one connector only.
LONE_CLASS = "class_crm_teams"


#: What every bronze table carries; `bronze_insert_events` reads it across all of them.
AIRBYTE_COLUMNS = (
    "_airbyte_raw_id String, _airbyte_extracted_at DateTime64(3), _airbyte_meta String, _airbyte_generation_id UInt32"
)


def _bronze(warehouse: Warehouse, database: str, table: str, columns: str, engine: str = "MergeTree") -> None:
    """A bronze table holding `columns` and the Airbyte ones, in that order."""
    columns = f"{columns}, {AIRBYTE_COLUMNS}"
    warehouse.execute("CREATE DATABASE IF NOT EXISTS {database:Identifier}", {"database": database})
    # Spelled out: ClickHouse binds an identifier where a statement reads one,
    # not as the object a CREATE TABLE names. Both are this module's constants.
    warehouse.execute(f"CREATE TABLE `{database}`.`{table}` ({columns}) ENGINE = {engine} ORDER BY unique_key")


def _zulip_users(
    warehouse: Warehouse,
    *,
    rows: bool,
    database: str = ZULIP_BRONZE[0],
    table: str = ZULIP_BRONZE[1],
    engine: str = "ReplacingMergeTree",
) -> None:
    _bronze(
        warehouse,
        database,
        table,
        "unique_key String, insight_tenant_id Nullable(String), source_id Nullable(String), "
        "insight_source_id Nullable(String), id Nullable(Int64), full_name Nullable(String), "
        "email Nullable(String), is_active Nullable(Bool), role Nullable(Int64), recipient_id Nullable(Int64), "
        "uuid Nullable(String)",
        engine=engine,
    )
    if rows:
        warehouse.execute(
            f"INSERT INTO `{database}`.`{table}` VALUES "
            f"('zulip-1', '{TENANT}', 'zulip-main', 'zulip-main', 1, 'Ada Lovelace', 'ada@example.com', true, "
            "400, 10, 'u-1', 'raw-1', now64(3), '{}', 1)"
        )


def _run(warehouse: Warehouse) -> str:
    completed = warehouse.run_dbt_sh()
    output = f"{completed.stdout[-12000:]}\n{completed.stderr[-4000:]}"
    assert completed.returncode == 0, output
    return completed.stdout


def test_a_connector_with_absent_bronze_is_left_out_with_its_reason(fresh_install: Warehouse) -> None:
    report = unbuildable(fresh_install)

    assert report[ISSUETYPES_MODEL] == "bronze absent: bronze_jira.jira_issuetypes"
    output = _run(fresh_install)
    assert f"not built: {ISSUETYPES_MODEL}\tbronze absent" in output
    assert f"staging.{ISSUETYPES_MODEL}" not in fresh_install.relations()


def test_a_connector_with_empty_bronze_is_left_out_with_its_reason(fresh_install: Warehouse) -> None:
    _bronze(fresh_install, *ISSUETYPES_BRONZE, "unique_key String")

    report = unbuildable(fresh_install)

    assert report[ISSUETYPES_MODEL] == "bronze empty: bronze_jira.jira_issuetypes"
    output = _run(fresh_install)
    assert f"not built: {ISSUETYPES_MODEL}\tbronze empty" in output
    assert f"staging.{ISSUETYPES_MODEL}" not in fresh_install.relations()


def test_a_model_left_out_takes_its_readers_with_it(fresh_install: Warehouse) -> None:
    _zulip_users(fresh_install, rows=False)

    report = unbuildable(fresh_install)

    assert report[ZULIP_CHAIN[0]] == "bronze empty: bronze_zulip_proxy.users"
    assert report[ZULIP_CHAIN[1]] == f"reads {ZULIP_CHAIN[0]}, which is not built"
    assert report[ZULIP_CHAIN[2]] == f"reads {ZULIP_CHAIN[1]}, which is not built"


def test_a_model_already_built_is_rebuilt_when_its_bronze_empties(fresh_install: Warehouse) -> None:
    # Empty means "not synced yet" only for a model never built; one that was
    # is rebuilt to match its bronze rather than left holding stale rows.
    _zulip_users(fresh_install, rows=True)
    _run(fresh_install)
    fresh_install.execute(f"TRUNCATE TABLE `{ZULIP_BRONZE[0]}`.`{ZULIP_BRONZE[1]}`")

    assert not set(ZULIP_CHAIN) & unbuildable(fresh_install).keys()
    _run(fresh_install)


def test_identity_inputs_builds_without_the_connector_whose_bronze_is_empty(fresh_install: Warehouse) -> None:
    # Outline's bronze exists and is empty, as a plain MergeTree the snapshot's
    # FINAL would refuse; were its chain kept in, it would fail and dbt would
    # skip the union with it.
    _zulip_users(fresh_install, rows=True)
    _zulip_users(fresh_install, rows=False, database=OUTLINE_BRONZE[0], table=OUTLINE_BRONZE[1], engine="MergeTree")

    report = unbuildable(fresh_install)
    assert "identity_inputs" not in report
    assert not set(ZULIP_CHAIN) & report.keys()
    assert set(OUTLINE_CHAIN) <= report.keys()

    _run(fresh_install)
    with fresh_install.client() as client:
        sources = {
            row[0]
            for row in client.query("SELECT DISTINCT insight_source_type FROM identity.identity_inputs").result_rows
        }
    assert sources == {"zulip_proxy"}


def test_a_class_with_no_contributor_and_no_table_is_left_out(fresh_install: Warehouse) -> None:
    report = unbuildable(fresh_install)

    assert report[LONE_CLASS] == f"no contributor tagged silver:{LONE_CLASS} is built"
    _run(fresh_install)
    assert f"silver.{LONE_CLASS}" not in fresh_install.relations()

    # Picked by hand past the exclusion, the union says why it cannot build
    # instead of failing on a table that is not there.
    picked = dbt(fresh_install, "run", "--select", LONE_CLASS)
    assert picked.returncode != 0
    assert "nothing to build it from" in picked.stdout, picked.stdout[-4000:]


def test_a_class_with_no_contributor_keeps_the_table_it_has(fresh_install: Warehouse) -> None:
    fresh_install.execute(
        f"CREATE TABLE silver.{LONE_CLASS} (unique_key String, team_id String, _version UInt64) "
        "ENGINE = ReplacingMergeTree(_version) ORDER BY unique_key"
    )
    fresh_install.execute(f"INSERT INTO silver.{LONE_CLASS} VALUES ('team-1', 'team-1', 1)")

    assert LONE_CLASS in unbuildable(fresh_install)
    _run(fresh_install)
    assert fresh_install.rows_in("silver", LONE_CLASS) == 1

    # Picked by hand, the union reads nothing and the table stays as it is.
    picked = dbt(fresh_install, "run", "--select", LONE_CLASS)
    assert picked.returncode == 0, picked.stdout[-4000:]
    assert fresh_install.rows_in("silver", LONE_CLASS) == 1


def test_a_contributor_outside_the_run_and_not_materialised_does_not_feed_its_class(fresh_install: Warehouse) -> None:
    # A run split into steps: the arm was this run's to build only in a step
    # that did not build it. Given the run's own node set, the class goes too.
    _zulip_users(fresh_install, rows=True)

    assert "identity_inputs" not in unbuildable(fresh_install)
    report = unbuildable(fresh_install, selected="identity_inputs")
    assert report == {"identity_inputs": "no contributor tagged silver:identity_inputs is built"}


def test_bronze_with_rows_the_model_cannot_read_still_fails(fresh_install: Warehouse) -> None:
    # Rows present, columns missing: the model is buildable by every rule here,
    # so its failure must reach the run, loudly.
    _bronze(fresh_install, *ISSUETYPES_BRONZE, "unique_key String", engine="ReplacingMergeTree")
    fresh_install.execute(
        f"INSERT INTO `{ISSUETYPES_BRONZE[0]}`.`{ISSUETYPES_BRONZE[1]}` VALUES ('it-1', 'raw-1', now64(3), '{{}}', 1)"
    )

    assert ISSUETYPES_MODEL not in unbuildable(fresh_install)
    completed = fresh_install.run_dbt_sh()
    assert completed.returncode != 0
    assert f"Database Error in model {ISSUETYPES_MODEL}" in completed.stdout, completed.stdout[-8000:]
