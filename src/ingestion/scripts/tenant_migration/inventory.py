"""Which tables hold a tenant the migration moves, and in which columns.

Bronze, operator config and the sync ledger are found by database; the dbt
relations a rebuild cannot reproduce come from `history-tables.txt`, packaged
beside this module. A table whose name carries `__tenant_` is the migration's
own and never in scope.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# nosemgrep: python.lang.compatibility.python37.python37-compatibility-importlib2 — requires-python >= 3.12
from importlib import resources

from tenant_migration.clickhouse import ClickHouse

HISTORY_TABLES = "history-tables.txt"
IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")


def quote(identifier: str) -> str:
    """A backquoted ClickHouse identifier; every name the migration puts into SQL text goes through here."""
    return "`" + identifier.replace("\\", "\\\\").replace("`", "\\`") + "`"


def param_text(value: str) -> str:
    """`value` as a quoted string inside a composite query parameter, e.g. `Array(Tuple(String, String))`."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


WORK_MARKER = "__tenant_"
BACKUP = "__tenant_backup"

TENANT_COLUMN = "insight_tenant_id"
OLD_TENANT_COLUMN = "tenant_id"
#: The sync ledger keeps `tenant_id`: it is a service table, not a warehouse layer.
LEDGER_DATABASE = "ingestion_history"
SOURCE_COLUMNS = ("source_id", "insight_source_id")
KEY_COLUMN = "unique_key"
STRING_TYPES = ("String", "Nullable(String)", "LowCardinality(String)", "LowCardinality(Nullable(String))")
#: Old YouTrack comment rows know their id only from the key; the copy writes it down.
COMMENT_IDS = ("bronze_youtrack", "youtrack_comments", "id")


class InventoryError(RuntimeError):
    pass


@dataclass(frozen=True)
class Relation:
    """A table by database and name, both plain identifiers."""

    database: str
    name: str

    def __post_init__(self) -> None:
        if not (IDENTIFIER.match(self.database) and IDENTIFIER.match(self.name)):
            raise ValueError(f"not a plain identifier: {self.database}.{self.name}")

    def sql(self, suffix: str = "") -> str:
        return f"{quote(self.database)}.{quote(self.name + suffix)}"

    def __str__(self) -> str:
        return f"{self.database}.{self.name}"


@dataclass(frozen=True)
class Table:
    """A table in scope: its columns in order, and the ones the rewrite reads."""

    rel: Relation
    engine: str
    columns: tuple[tuple[str, str], ...]
    tenant: str | None
    source: str | None
    key: str | None

    @property
    def relation(self) -> str:
        return str(self.rel)

    @property
    def types(self) -> dict[str, str]:
        return dict(self.columns)

    @property
    def target(self) -> str:
        """The tenant column the migrated table has."""
        return OLD_TENANT_COLUMN if self.rel.database == LEDGER_DATABASE else TENANT_COLUMN

    @property
    def renames(self) -> bool:
        return self.tenant is not None and self.tenant != self.target

    @property
    def adds(self) -> bool:
        """A history relation built before it carried a tenant: every row is the install's."""
        return self.tenant is None

    @property
    def replacing(self) -> bool:
        return "Replacing" in self.engine

    @property
    def comment_id(self) -> str | None:
        database, name, column = COMMENT_IDS
        found = (self.rel.database, self.rel.name) == (database, name) and column in self.types
        return column if found and self.key and self.source else None


def history_relations() -> list[tuple[str, str]]:
    text = resources.files("tenant_migration").joinpath(HISTORY_TABLES).read_text(encoding="utf-8")
    lines = (line.strip() for line in text.splitlines())
    relations = [tuple(line.split(".", 1)) for line in lines if line and not line.startswith("#")]
    if not relations:
        raise SystemExit(f"no relations listed in {HISTORY_TABLES}")
    return [(database, name) for database, name in relations]


def classify(database: str, name: str, engine: str, columns: list[tuple[str, str]], *, history: bool) -> Table | None:
    """The table as the migration reads it; None when it has nothing to migrate."""
    rel = Relation(database, name)
    if engine.startswith("Replicated"):
        # SAFETY: a copy made from SHOW CREATE would claim the original's Keeper path, or
        # leave its replicas behind. Every install runs a single-node ClickHouse; refuse.
        raise InventoryError(
            f"{rel}: engine {engine} is replicated — the cutover supports a single-node ClickHouse only; nothing was changed"
        )
    types = dict(columns)
    tenants = [c for c in (OLD_TENANT_COLUMN, TENANT_COLUMN) if c in types]
    if len(tenants) == 2:
        raise InventoryError(f"{rel}: holds both {OLD_TENANT_COLUMN} and {TENANT_COLUMN}")
    tenant = tenants[0] if tenants else None
    if tenant is None and not history:
        return None
    if tenant is not None and types[tenant] not in STRING_TYPES:
        raise InventoryError(f"{rel}: {tenant} is {types[tenant]}, not a string")
    source = next((c for c in SOURCE_COLUMNS if c in types), None)
    key = KEY_COLUMN if KEY_COLUMN in types else None
    return Table(rel, engine, tuple(columns), tenant, source, key)


SCOPE_SQL = (
    "(t.database LIKE 'bronze\\\\_%' OR t.database IN ('config', {ledger:String}) "
    "OR has({history:Array(Tuple(String, String))}, (t.database, t.name))) AND t.engine LIKE '%MergeTree' "
    "AND position(t.name, {marker:String}) = 0"
)


def _scope_params(history: list[tuple[str, str]]) -> dict[str, str]:
    pairs = ", ".join(f"({param_text(database)}, {param_text(name)})" for database, name in history)
    return {"ledger": LEDGER_DATABASE, "history": f"[{pairs}]", "marker": WORK_MARKER}


def discover(ch: ClickHouse, history: list[tuple[str, str]]) -> list[Table]:
    rows = ch.rows(
        f"""
        SELECT t.database, t.name, t.engine, c.name, c.type
        FROM system.tables AS t
        INNER JOIN system.columns AS c ON c.database = t.database AND c.table = t.name
        WHERE {SCOPE_SQL}
        ORDER BY t.database, t.name, c.position
        """,
        params=_scope_params(history),
    )
    found: dict[tuple[str, str, str], list[tuple[str, str]]] = {}
    for database, name, engine, column, column_type in rows:
        found.setdefault((database, name, engine), []).append((column, column_type))
    listed = set(history)
    tables = []
    for (database, name, engine), columns in found.items():
        if not (IDENTIFIER.match(database) and IDENTIFIER.match(name)):
            raise InventoryError(f"{database}.{name}: not a plain identifier")
        table = classify(database, name, engine, columns, history=(database, name) in listed)
        if table is not None:
            tables.append(table)
    return tables
