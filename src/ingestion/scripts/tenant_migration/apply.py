"""Move each table by copy, count check and EXCHANGE; undo the whole run on any failure.

Each table is copied into `<table>__tenant_backup` (or the first free
`__tenant_backup_<n>`) with every tenant set to the install's, the copy is
checked against the original, and the two are EXCHANGEd: the migrated rows go
live and the original stays beside them under the backup name. Nothing here
ever drops a backup; `finalize` does, by hand.

Which table is which is read from ClickHouse, never assumed: the copy's UUID is
recorded when it is created, and EXCHANGE moves names, not UUIDs. So when a
step fails — even a swap whose reply was lost — `undo` swaps back every table
whose live name holds a copy, and drops only tables that are copies.

INVARIANT: nothing writes to these tables while this runs (connectors, dbt and
reconcile stopped by the pre-upgrade hook).
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass

from tenant_migration import ddl, keys
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import BACKUP, KEY_COLUMN, Relation, Table
from tenant_migration.plan import TablePlan

NIL_UUID = "00000000-0000-0000-0000-000000000000"
MAX_BACKUPS = 100


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Copy:
    """A rewritten copy of `rel`, created under `rel{suffix}` with ClickHouse UUID `uuid`."""

    rel: Relation
    suffix: str
    uuid: str


def table_uuid(ch: ClickHouse, rel: Relation, suffix: str = "") -> str | None:
    rows = ch.rows(
        f"SELECT toString(uuid) FROM system.tables WHERE database = '{rel.database}' AND name = '{rel.name}{suffix}'"
    )
    return rows[0][0] if rows else None


def backup_suffix(ch: ClickHouse, rel: Relation) -> str:
    """`__tenant_backup`, or past a backup an earlier deploy left, the first free `__tenant_backup_<n>`."""
    taken = {
        name
        for (name,) in ch.rows(
            f"SELECT name FROM system.tables WHERE database = '{rel.database}' "
            f"AND startsWith(name, '{rel.name}{BACKUP}')"
        )
    }
    for n in range(1, MAX_BACKUPS):
        suffix = BACKUP if n == 1 else f"{BACKUP}_{n}"
        if f"{rel.name}{suffix}" not in taken:
            return suffix
    raise MigrationError(f"{rel}: {MAX_BACKUPS - 1} backups already stand — run `finalize` first")


def _create_copy(ch: ClickHouse, table: Table, suffix: str) -> None:
    rel = table.rel
    if table.renames:
        # The copy keeps the original's column order and keys, under the new name.
        original = ch.execute(ddl.show_create(rel), fmt="TabSeparatedRaw")
        ch.execute(ddl.tenant_renamed(ddl.retarget(original, rel, suffix)))
        return
    ch.execute(ddl.create_like(rel, suffix))
    if table.adds:
        ch.execute(ddl.add_tenant(rel, suffix, KEY_COLUMN if table.key else None))


def _insert(table: Table, suffix: str, tenant: str) -> str:
    columns, expressions = [], []
    for name, _ in table.columns:
        columns.append(table.target if name == table.tenant else name)
        if name == table.tenant:
            expressions.append(keys.lit(tenant))
        elif name == table.key and table.tenant:
            expressions.append(keys.key_expression(table, tenant))
        elif name == table.comment_id:
            expressions.append(keys.comment_id_expression(table))
        else:
            expressions.append(keys.col(name))
    if table.adds:
        columns.append(table.target)
        expressions.append(keys.lit(tenant))
    return ddl.insert(table.rel, suffix, columns, expressions)


def _check(ch: ClickHouse, table: Table, suffix: str, tenant: str) -> None:
    """The copy holds every row (every key, where merges may collapse rows), all under the tenant."""
    rel = table.rel
    if table.replacing and table.key and table.tenant:
        expected = ch.scalar(f"SELECT uniqExact({keys.key_expression(table, tenant)}) FROM {rel.sql()} AS src")
        actual = ch.scalar(f"SELECT uniqExact(`{table.key}`) FROM {rel.sql(suffix)}")
        what = "keys"
    else:
        expected = ch.scalar(f"SELECT count() FROM {rel.sql()}")
        actual = ch.scalar(f"SELECT count() FROM {rel.sql(suffix)}")
        what = "rows"
    if actual != expected:
        raise MigrationError(f"{rel}: the copy holds {actual} {what}, the original {expected}")
    foreign = ch.scalar(
        f"SELECT count() FROM {rel.sql(suffix)} WHERE ifNull(toString(`{table.target}`), '') != '{tenant}'"
    )
    if foreign:
        raise MigrationError(f"{rel}: the copy still holds {foreign} row(s) under another tenant")


def migrate_table(ch: ClickHouse, table: Table, tenant: str, copies: list[Copy]) -> None:
    """Copy, check, swap; the copy is listed in `copies` as soon as it exists, for `undo`."""
    rel = table.rel
    suffix = backup_suffix(ch, rel)
    _create_copy(ch, table, suffix)
    uuid = table_uuid(ch, rel, suffix)
    if not uuid or uuid == NIL_UUID:
        ch.execute(ddl.drop(rel, suffix))
        raise MigrationError(f"{rel}: the copy has no UUID — EXCHANGE needs an Atomic database")
    copies.append(Copy(rel, suffix, uuid))
    ch.execute(_insert(table, suffix, tenant))
    _check(ch, table, suffix, tenant)
    ch.execute(ddl.exchange(rel, suffix))
    if table_uuid(ch, rel) != uuid:
        raise MigrationError(f"{rel}: after the swap the live table is not the copy")


def undo(ch: ClickHouse, copies: list[Copy]) -> list[str]:
    """Swap back every copy that went live and drop every copy, newest first; returns what it could not."""
    problems = []
    for copy in reversed(copies):
        try:
            if table_uuid(ch, copy.rel) == copy.uuid:
                ch.execute(ddl.exchange(copy.rel, copy.suffix))
            if table_uuid(ch, copy.rel) == copy.uuid:
                raise MigrationError("the copy is still live")
            if table_uuid(ch, copy.rel, copy.suffix) == copy.uuid:
                ch.execute(ddl.drop(copy.rel, copy.suffix))
        except Exception as error:  # noqa: BLE001 — every table gets its chance; the caller reports all
            problems.append(f"{copy.rel}: {error}")
    return problems


def apply(ch: ClickHouse, plans: list[TablePlan], tenant: str) -> list[str]:
    """Migrate every pending table, or none: any failure — an interrupt included — undoes the run."""
    copies: list[Copy] = []
    migrated: list[str] = []
    try:
        for plan in (p for p in plans if p.pending):
            print(f"migrating {plan.table.relation} ({plan.change}, {plan.rows} rows)", flush=True)
            migrate_table(ch, plan.table, tenant, copies)
            migrated.append(plan.table.relation)
    except BaseException as error:
        with contextlib.suppress(Exception):
            ch.cancel_running()
        problems = undo(ch, copies)
        if problems:
            raise MigrationError(
                f"{error}; PUTTING THE ORIGINALS BACK FAILED for: {'; '.join(problems)} — "
                f"each original is in <table>{BACKUP}* beside it"
            ) from error
        raise MigrationError(f"{error}; every table is back as it was") from error
    return migrated


def finalize(ch: ClickHouse) -> list[str]:
    """Drop every `__tenant_backup*` table whose live table stands."""
    dropped = []
    rows = ch.rows(
        f"SELECT database, name FROM system.tables WHERE match(name, '^[A-Za-z0-9_]+{BACKUP}(_[0-9]+)?$') "
        "ORDER BY database, name"
    )
    for database, name in rows:
        base = name[: name.index(BACKUP)]
        rel = Relation(database, base)
        if table_uuid(ch, rel) is None:
            print(f"kept {database}.{name}: {rel} does not exist")
            continue
        ch.execute(ddl.drop(rel, name[len(base) :]))
        dropped.append(f"{database}.{name}")
    return dropped
