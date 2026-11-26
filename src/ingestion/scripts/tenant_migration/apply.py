"""Move each table by copy, count check and EXCHANGE; undo the whole run on any failure.

Each table is copied into `<table>__tenant_copy` with every tenant set to the
install's and the tenant and source columns under their new names. The copy is
checked against the original and the two are EXCHANGEd: the migrated rows go
live, and only then is the original, now under the copy's name, renamed to
`<table>__tenant_backup` (or the first free `__tenant_backup_<n>`). So a
`__tenant_backup*` table always holds an original. Nothing here ever drops a
backup; `finalize` does, by hand.

Which table is which is read from ClickHouse, never assumed: both UUIDs are
recorded, and EXCHANGE and RENAME move names, not UUIDs. So when a step fails —
even a swap whose reply was lost — `undo` puts every original back live and
drops only tables that are copies. A run killed outright (SIGKILL) leaves at
most one `__tenant_copy`; the next run reads which it is (see `recover`).

INVARIANT: nothing writes to these tables while this runs (connectors, dbt and
reconcile stopped by the pre-upgrade hook).
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass

from tenant_migration import ddl, keys
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import BACKUP, COPY, KEY_COLUMN, Relation, Table, quote
from tenant_migration.plan import TablePlan

NIL_UUID = "00000000-0000-0000-0000-000000000000"
MAX_BACKUPS = 100


class MigrationError(RuntimeError):
    pass


class UndoError(MigrationError):
    """The run failed and not every table could be put back."""


@dataclass(frozen=True)
class Copy:
    """A rewritten copy of `rel` (ClickHouse UUID `uuid`) for the original `original`, whose backup name is `backup`."""

    rel: Relation
    uuid: str
    original: str
    backup: str


def table_uuid(ch: ClickHouse, rel: Relation, suffix: str = "") -> str | None:
    rows = ch.rows(
        "SELECT toString(uuid) FROM system.tables WHERE database = {database:String} AND name = {name:String}",
        params={"database": rel.database, "name": rel.name + suffix},
    )
    return rows[0][0] if rows else None


def backup_suffix(ch: ClickHouse, rel: Relation) -> str:
    """`__tenant_backup`, or past a backup an earlier deploy left, the first free `__tenant_backup_<n>`."""
    taken = {
        name
        for (name,) in ch.rows(
            "SELECT name FROM system.tables WHERE database = {database:String} AND startsWith(name, {prefix:String})",
            params={"database": rel.database, "prefix": rel.name + BACKUP},
        )
    }
    for n in range(1, MAX_BACKUPS):
        suffix = BACKUP if n == 1 else f"{BACKUP}_{n}"
        if f"{rel.name}{suffix}" not in taken:
            return suffix
    raise MigrationError(f"{rel}: {MAX_BACKUPS - 1} backups already stand — run `finalize` first")


def _create_copy(ch: ClickHouse, table: Table) -> None:
    rel = table.rel
    if table.renames:
        # The copy keeps the original's column order and keys, under the new names.
        original = ch.execute(ddl.show_create(rel), fmt="TabSeparatedRaw")
        ch.execute(ddl.renamed(ddl.retarget(original, rel, COPY), table))
    else:
        ch.execute(ddl.create_like(rel, COPY))
    if table.adds:
        ch.execute(ddl.add_tenant(rel, COPY, KEY_COLUMN if table.key else None))


def _insert(table: Table) -> str:
    columns, expressions = [], []
    for name, _ in table.columns:
        if name in table.computed:
            continue
        columns.append(table.renamed(name))
        if name == table.tenant:
            expressions.append(keys.TENANT)
        elif name == table.key and table.tenant:
            expressions.append(keys.key_expression(table))
        elif name == table.comment_id:
            expressions.append(keys.comment_id_expression(table))
        else:
            expressions.append(keys.col(name))
    if table.adds:
        columns.append(table.target)
        expressions.append(keys.TENANT)
    return ddl.insert(table.rel, COPY, columns, expressions)


def _check(ch: ClickHouse, table: Table, tenant: str) -> None:
    """The copy holds every row (every key, where merges may collapse rows), all under the tenant."""
    rel = table.rel
    if table.replacing and table.key and table.tenant:
        expected = ch.scalar(
            f"SELECT uniqExact({keys.key_expression(table)}) FROM {rel.sql()} AS src", params=keys.tenant_params(tenant)
        )
        actual = ch.scalar(f"SELECT uniqExact({quote(table.key)}) FROM {rel.sql(COPY)}")
        what = "keys"
    else:
        expected = ch.scalar(f"SELECT count() FROM {rel.sql()}")
        actual = ch.scalar(f"SELECT count() FROM {rel.sql(COPY)}")
        what = "rows"
    if actual != expected:
        raise MigrationError(f"{rel}: the copy holds {actual} {what}, the original {expected}")
    if table.tenant is None and not table.adds:
        return
    foreign = ch.scalar(
        f"SELECT count() FROM {rel.sql(COPY)} WHERE ifNull(toString({quote(table.target)}), '') != {keys.TENANT}",
        params=keys.tenant_params(tenant),
    )
    if foreign:
        raise MigrationError(f"{rel}: the copy still holds {foreign} row(s) under another tenant")


def migrate_table(ch: ClickHouse, table: Table, tenant: str, copies: list[Copy]) -> None:
    """Copy, check, swap, then name the original a backup; the copy is in `copies` as soon as it exists."""
    rel = table.rel
    backup = backup_suffix(ch, rel)
    original = table_uuid(ch, rel)
    _create_copy(ch, table)
    uuid = table_uuid(ch, rel, COPY)
    if not uuid or uuid == NIL_UUID or not original:
        ch.execute(ddl.drop(rel, COPY))
        raise MigrationError(f"{rel}: the copy has no UUID — EXCHANGE needs an Atomic database")
    copies.append(Copy(rel, uuid, original, backup))
    ch.execute(_insert(table), params=keys.tenant_params(tenant))
    _check(ch, table, tenant)
    ch.execute(ddl.exchange(rel, COPY))
    if table_uuid(ch, rel) != uuid:
        raise MigrationError(f"{rel}: after the swap the live table is not the copy")
    ch.execute(ddl.rename(rel, COPY, backup))


def _holding(ch: ClickHouse, copy: Copy, uuid: str) -> str | None:
    """Which of the copy's two work names holds the table `uuid` now."""
    return next((s for s in (COPY, copy.backup) if table_uuid(ch, copy.rel, s) == uuid), None)


def undo(ch: ClickHouse, copies: list[Copy]) -> list[str]:
    """Put every original back live and drop every copy, newest first; returns what it could not."""
    problems = []
    for copy in reversed(copies):
        try:
            if table_uuid(ch, copy.rel) == copy.uuid:
                where = _holding(ch, copy, copy.original)
                if where is None:
                    raise MigrationError("the original is under neither work name")
                ch.execute(ddl.exchange(copy.rel, where))
            if table_uuid(ch, copy.rel) != copy.original:
                raise MigrationError("the original is not live")
            where = _holding(ch, copy, copy.uuid)
            if where is not None:
                ch.execute(ddl.drop(copy.rel, where))
        except Exception as error:  # noqa: BLE001 — every table gets its chance; the caller reports all
            problems.append(f"{copy.rel}: {error}")
    return problems


def leftover_copies(ch: ClickHouse) -> list[Relation]:
    """Tables whose `__tenant_copy` a killed run left behind."""
    rows = ch.rows(
        "SELECT database, name FROM system.tables WHERE endsWith(name, {copy:String}) ORDER BY database, name",
        params={"copy": COPY},
    )
    return [Relation(database, name[: -len(COPY)]) for database, name in rows]


def recover(ch: ClickHouse, plans: list[TablePlan]) -> None:
    """Settle what a killed run left. A table still pending was never swapped: its copy is a partial
    one and goes. A table that is no longer pending was swapped: the copy's name holds its original,
    which becomes its backup."""
    pending = {p.table.rel for p in plans if p.pending}
    for rel in leftover_copies(ch):
        if table_uuid(ch, rel) is None:
            raise MigrationError(f"{rel}{COPY} stands without {rel}; inspect it by hand, nothing was changed")
        if rel in pending:
            print(f"dropping {rel}{COPY}: a killed run's partial copy", flush=True)
            ch.execute(ddl.drop(rel, COPY))
        else:
            backup = backup_suffix(ch, rel)
            print(f"renaming {rel}{COPY} to {rel.name}{backup}: the original a killed run swapped out", flush=True)
            ch.execute(ddl.rename(rel, COPY, backup))


def apply(ch: ClickHouse, plans: list[TablePlan], tenant: str) -> list[str]:
    """Migrate every pending table, or none: any failure — an interrupt included — undoes the run."""
    recover(ch, plans)
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
            raise UndoError(
                f"{error}; PUTTING THE ORIGINALS BACK FAILED for: {'; '.join(problems)} — "
                f"each original is in <table>{BACKUP}* beside it"
            ) from error
        raise MigrationError(f"{error}; every table is back as it was") from error
    return migrated


def finalize(ch: ClickHouse) -> list[str]:
    """Drop every `__tenant_backup*` table, an orphan whose live table has gone included."""
    dropped = []
    rows = ch.rows(
        "SELECT database, name FROM system.tables WHERE match(name, {pattern:String}) ORDER BY database, name",
        params={"pattern": f"^[A-Za-z0-9_]+{BACKUP}(_[0-9]+)?$"},
    )
    for database, name in rows:
        base = name[: name.index(BACKUP)]
        rel = Relation(database, base)
        if table_uuid(ch, rel) is None:
            print(f"{database}.{name}: {rel} no longer exists — dropping the orphan backup")
        ch.execute(ddl.drop(rel, name[len(base) :]))
        dropped.append(f"{database}.{name}")
    return dropped
