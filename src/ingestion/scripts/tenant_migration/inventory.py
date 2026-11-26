"""Which tables the migration brings to the new shape, and in which columns.

In scope is every MergeTree table in `bronze_*`, `config`, `staging`, `silver`
and gold (`insight`), plus every history relation listed in `history-tables.txt`,
packaged beside this module. The migration's own tables (a name carrying
`__tenant_`) and materialized views' inner tables (a name starting with `.`)
never are; nor is any other database: not the sync ledger (`ingestion_history`,
a service table that keeps `tenant_id` and `source_id` and whose sweep writes
rows with an empty tenant every tick), `dbt_test__audit`, or operator databases
such as `presentation` or `backup_*`.

A table changes when it names its tenant `tenant_id`, names its stamped source
`source_id`, or holds a tenant other than the install's. A silver table or a
history relation without any tenant column gains one.
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
COPY = "__tenant_copy"

TENANT_COLUMN = "insight_tenant_id"
OLD_TENANT_COLUMN = "tenant_id"
SOURCE_COLUMN = "insight_source_id"
OLD_SOURCE_COLUMN = "source_id"
#: dbt's layers: staging, silver and gold. Gold is `insight` (the dbt var `gold_database`).
DBT_DATABASES = ("staging", "silver", "insight")
#: The layer whose every table carries a tenant: one built before it did gains it.
TENANT_EVERYWHERE = "silver"
#: Values that cannot be written by INSERT: the copy leaves them to the table.
COMPUTED = ("MATERIALIZED", "ALIAS", "EPHEMERAL")
KEY_COLUMN = "unique_key"
STRING_TYPES = ("String", "Nullable(String)", "LowCardinality(String)", "LowCardinality(Nullable(String))")
#: A tenant column dbt already types as a UUID; it is read and written as text like the rest.
TENANT_TYPES = (*STRING_TYPES, "UUID", "Nullable(UUID)")
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
    #: No tenant column, and the table must have one (a silver table or a history relation).
    needs_tenant: bool = False
    #: Columns the table computes itself (MATERIALIZED, ALIAS): never inserted.
    computed: frozenset[str] = frozenset()

    @property
    def relation(self) -> str:
        return str(self.rel)

    @property
    def types(self) -> dict[str, str]:
        return dict(self.columns)

    @property
    def target(self) -> str:
        """The tenant column the migrated table has."""
        return TENANT_COLUMN

    @property
    def renames_tenant(self) -> bool:
        return self.tenant is not None and self.tenant != self.target

    @property
    def source_target(self) -> str | None:
        """The source column the migrated table has, when it has one."""
        return SOURCE_COLUMN if self.source else None

    @property
    def renames_source(self) -> bool:
        return self.source is not None and self.source != self.source_target

    @property
    def renames(self) -> bool:
        return self.renames_tenant or self.renames_source

    @property
    def adds(self) -> bool:
        """A table built before it carried a tenant: every row is the install's."""
        return self.tenant is None and self.needs_tenant

    def renamed(self, column: str) -> str:
        """`column` as the migrated table names it."""
        if column == self.tenant:
            return self.target
        if column == self.source and self.source_target:
            return self.source_target
        return column

    @property
    def rekeys(self) -> bool:
        """The key leads with the tenant the copy moves: the row's own, or, gaining one, the key's."""
        return self.key is not None and (self.tenant is not None or (self.adds and self.source is not None))

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


def classify(
    database: str,
    name: str,
    engine: str,
    columns: list[tuple[str, str]],
    *,
    history: bool,
    computed: frozenset[str] = frozenset(),
) -> Table | None:
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
    if tenant is not None and types[tenant] not in TENANT_TYPES:
        raise InventoryError(f"{rel}: {tenant} is {types[tenant]}, not a string or UUID")
    sources = [c for c in (OLD_SOURCE_COLUMN, SOURCE_COLUMN) if c in types]
    if len(sources) == 2:
        raise InventoryError(f"{rel}: holds both {OLD_SOURCE_COLUMN} and {SOURCE_COLUMN}")
    source = sources[0] if sources else None
    key = KEY_COLUMN if KEY_COLUMN in types else None
    needs_tenant = history or database == TENANT_EVERYWHERE
    table = Table(rel, engine, tuple(columns), tenant, source, key, needs_tenant, computed)
    if tenant is None and not table.adds and not table.renames_source:
        return None
    return table


SCOPE_SQL = (
    "(t.database LIKE 'bronze\\\\_%' OR has({databases:Array(String)}, t.database) "
    "OR has({history:Array(Tuple(String, String))}, (t.database, t.name))) AND t.engine LIKE '%MergeTree' "
    "AND position(t.name, {marker:String}) = 0 AND NOT startsWith(t.name, '.')"
)


def _scope_params(history: list[tuple[str, str]]) -> dict[str, str]:
    pairs = ", ".join(f"({param_text(database)}, {param_text(name)})" for database, name in history)
    databases = ", ".join(param_text(d) for d in ("config", *DBT_DATABASES))
    return {"databases": f"[{databases}]", "history": f"[{pairs}]", "marker": WORK_MARKER}


def discover(ch: ClickHouse, history: list[tuple[str, str]]) -> list[Table]:
    rows = ch.rows(
        f"""
        SELECT t.database, t.name, t.engine, c.name, c.type, c.default_kind
        FROM system.tables AS t
        INNER JOIN system.columns AS c ON c.database = t.database AND c.table = t.name
        WHERE {SCOPE_SQL}
        ORDER BY t.database, t.name, c.position
        """,
        params=_scope_params(history),
    )
    found: dict[tuple[str, str, str], list[tuple[str, str]]] = {}
    computed: dict[tuple[str, str, str], set[str]] = {}
    for database, name, engine, column, column_type, default_kind in rows:
        found.setdefault((database, name, engine), []).append((column, column_type))
        if default_kind in COMPUTED:
            computed.setdefault((database, name, engine), set()).add(column)
    listed = set(history)
    tables = []
    for (database, name, engine), columns in found.items():
        if not (IDENTIFIER.match(database) and IDENTIFIER.match(name)):
            raise InventoryError(f"{database}.{name}: not a plain identifier")
        table = classify(
            database,
            name,
            engine,
            columns,
            history=(database, name) in listed,
            computed=frozenset(computed.get((database, name, engine), ())),
        )
        if table is not None:
            tables.append(table)
    return tables
