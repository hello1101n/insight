"""Write the custom catalogue into the stand: MariaDB rows and one dataset table.

The rows go into the database that `insight-v3-core` owns, the same way the
`analytics` step writes the analytics catalogue: straight into the tables that
the service's own migrations created. So the step runs after the service starts.

Why rows and not the `/api/v3` API:

* The API takes a write only from a person. It asks the identity service whose
  gateway session made the request, and only an administrator may create a
  definition. The seed has no browser session, and it must not mint a token.
* The API gives each new definition a new UUID. A seeded row keeps the id that
  `custom_catalogue` gives it. So a re-seed replaces the same rows, and
  `/dashboards/stand-every-widget-type` names the same board on every stand.

The service validates each seeded definition when it reads it:
`tests/stand/api/v3/test_seeded_catalogue.py` reads each board, lists its
widgets and runs each widget through the deployed gateway. Only the widgets
that the manifest names as failing may fail.

A re-seed is idempotent. One transaction deletes every row that this module
owns (the ids under `custom_catalogue.ID_PREFIX`, the folder and the dataset)
and writes them again. A row that a person created through the API has a UUID
id, so the delete never touches it.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import uuid as uuid_mod
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Final

import clickhouse_connect
import pymysql

from . import config, profiles
from .custom_catalogue import (
    BOARDS,
    DATASET_DECLARATION,
    DATASET_NAME,
    FOLDER_ID,
    FOLDER_NAME,
    ID_PREFIX,
    METRICS,
    WIDGETS,
    dataset_records,
)

LOG = logging.getLogger("seed.custom_catalogue")

#: INVARIANT: equals `DEFAULT_DATASETS_DATABASE` in insight-v3-core's config.rs.
#: The compose stack leaves the service at that default.
DATASETS_DATABASE: Final = "insight_datasets"

#: INVARIANT: the service names a dataset's table `ds_<name>_<operation token>`,
#: with the token a UUID in simple form. A fixed token keeps the name stable.
_DATASET_TOKEN: Final = uuid_mod.uuid5(uuid_mod.NAMESPACE_URL, f"insight-seed:{DATASET_NAME}").hex
DATASET_TABLE: Final = f"ds_{DATASET_NAME}_{_DATASET_TOKEN}"

_OWNED: Final = f"{ID_PREFIX}%"

_CLEAR: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    # INVARIANT: the grants, pins, folder entries and tags of a board cascade with it.
    ("DELETE FROM dashboards WHERE id LIKE %s", (_OWNED,)),
    ("DELETE FROM widgets WHERE id LIKE %s", (_OWNED,)),
    ("DELETE FROM metrics WHERE id LIKE %s", (_OWNED,)),
    ("DELETE FROM folders WHERE id = %s", (FOLDER_ID,)),
    ("DELETE FROM datasets WHERE name = %s", (DATASET_NAME,)),
)

_INSERT_METRIC: Final = "INSERT INTO metrics (id, name, body, updated_at) VALUES (%s, %s, %s, %s)"
_INSERT_WIDGET: Final = "INSERT INTO widgets (id, name, body, updated_at) VALUES (%s, %s, %s, %s)"
_INSERT_DASHBOARD: Final = (
    "INSERT INTO dashboards (id, name, body, updated_at, folder_id, owner_person_id) "
    "VALUES (%s, %s, %s, %s, NULL, %s)"
)
_INSERT_FOLDER: Final = (
    "INSERT INTO folders (id, name, created_at, updated_at, owner_person_id) "
    "VALUES (%s, %s, %s, %s, %s)"
)
_INSERT_FOLDER_ENTRY: Final = (
    "INSERT INTO folder_entries (folder_id, dashboard, placed_by, carries, created_at) "
    "VALUES (%s, %s, %s, TRUE, %s)"
)
_INSERT_GRANT: Final = (
    "INSERT INTO dashboard_grants (dashboard, grantee, level, granted_by, created_at) "
    "VALUES (%s, %s, 'viewer', %s, %s)"
)
_INSERT_PIN: Final = "INSERT INTO dashboard_pins (person, dashboard, pinned_at) VALUES (%s, %s, %s)"
_INSERT_DATASET: Final = (
    "INSERT INTO datasets (name, body, state, physical_table, updated_at) "
    "VALUES (%s, %s, 'ready', %s, %s)"
)

_DATASET_COLUMNS: Final = ["id", "table_name", "raw_data", "received_at"]


def _json(body: Any) -> str:
    return json.dumps(body, sort_keys=True, ensure_ascii=False)


def seeded_at(anchor: _dt.date) -> _dt.datetime:
    """One instant for every row, so two runs at one anchor write the same rows."""
    return _dt.datetime.combine(anchor, _dt.time(12, 0))


def mariadb_rows(anchor: _dt.date) -> list[tuple[str, tuple[Any, ...]]]:
    """Every statement the MariaDB half runs, in order. Pure, so a test reads it."""
    at = seeded_at(anchor)
    owner = profiles.ADMIN_OPERATOR_UUID
    statements: list[tuple[str, tuple[Any, ...]]] = list(_CLEAR)

    statements.append(
        (_INSERT_DATASET, (DATASET_NAME, _json(DATASET_DECLARATION), DATASET_TABLE, at))
    )

    statements += [(_INSERT_METRIC, (m.id, m.name, _json(m.body), at)) for m in METRICS]
    statements += [(_INSERT_WIDGET, (w.id, w.name, _json(w.body), at)) for w in WIDGETS]

    statements.append((_INSERT_FOLDER, (FOLDER_ID, FOLDER_NAME, at, at, owner)))
    for board in BOARDS:
        statements.append((_INSERT_DASHBOARD, (board.id, board.name, _json(board.body), at, owner)))
        if board.in_folder:
            statements.append((_INSERT_FOLDER_ENTRY, (FOLDER_ID, board.id, owner, at)))
        if board.shared_with_ceo:
            statements.append((_INSERT_GRANT, (board.id, profiles.CEO_UUID, owner, at)))
        if board.starred:
            statements.append((_INSERT_PIN, (owner, board.id, at)))

    return statements


@contextmanager
def _mariadb(database: str) -> Iterator[pymysql.connections.Connection]:
    target = config.parse_mariadb(os.environ, database=database)
    conn = pymysql.connect(
        host=target.host,
        port=target.port,
        user=target.user,
        password=target.password,
        database=target.database,
        autocommit=False,
        charset="utf8mb4",
    )
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _write_dataset_table(anchor: _dt.date) -> int:
    """Recreate the dataset's table with its records. Returns the record count."""
    target = config.parse_clickhouse(os.environ)
    client = clickhouse_connect.get_client(
        host=target.host, port=target.http_port, username=target.user, password=target.password
    )
    qualified = f"`{DATASETS_DATABASE}`.`{DATASET_TABLE}`"
    client.command(f"DROP TABLE IF EXISTS {qualified}")
    client.command(
        f"CREATE TABLE {qualified} (`id` UUID, `table_name` String, `raw_data` String, "
        "`received_at` DateTime64(3, 'UTC')) "
        "ENGINE = MergeTree ORDER BY (table_name, received_at, id)"
    )

    received = seeded_at(anchor).replace(tzinfo=_dt.UTC)
    rows = [
        [
            uuid_mod.uuid5(uuid_mod.NAMESPACE_URL, f"insight-seed:{DATASET_NAME}:{index}"),
            DATASET_NAME,
            record.raw_data(),
            received + _dt.timedelta(milliseconds=index),
        ]
        for index, record in enumerate(dataset_records(anchor))
    ]
    client.insert(DATASET_TABLE, rows, column_names=_DATASET_COLUMNS, database=DATASETS_DATABASE)
    return len(rows)


def run(database: str) -> None:
    """Seed the catalogue into `database`, the MariaDB database of insight-v3-core."""
    anchor = config.parse_anchor_date(os.environ)
    LOG.info("custom catalogue seed (database %s)", database)

    records = _write_dataset_table(anchor)
    with _mariadb(database) as conn:
        cur = conn.cursor()
        for statement, values in mariadb_rows(anchor):
            cur.execute(statement, values)

    LOG.info(
        "  %d metrics, %d widgets, %d dashboards, 1 folder, dataset %s with %d records",
        len(METRICS),
        len(WIDGETS),
        len(BOARDS),
        DATASET_NAME,
        records,
    )
