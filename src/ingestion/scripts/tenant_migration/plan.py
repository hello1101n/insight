"""What the migration would change. Nothing here writes."""

from __future__ import annotations

import json
from dataclasses import dataclass

from tenant_migration import keys
from tenant_migration.clickhouse import ClickHouse
from tenant_migration.inventory import InventoryError, Table, param_text

#: One install holds one tenant; a few more (empty, the UUID, a legacy name) are what a key can lead with.
MAX_TENANTS = 16
#: Free disk `apply` needs, as a multiple of the bytes the tables it changes take: the copies (1x;
#: the originals stay beside them as backups until `finalize`) plus the merges that settle each copy.
#: Measured: a peak of 1.23x with the copies' short `old_parts_lifetime` (apply.COPY_OLD_PARTS_LIFETIME);
#: at the default, 1.66x, and a dev run ran out of disk past 1.9x. 2x leaves room for a large table's
#: last merge.
DISK_HEADROOM = 2


class DiskSpaceError(RuntimeError):
    pass


@dataclass(frozen=True)
class Disk:
    """A ClickHouse disk, its free bytes, and the bytes on it of the tables `apply` would copy."""

    name: str
    free: int
    in_scope: int

    @property
    def needed(self) -> int:
        return DISK_HEADROOM * self.in_scope

    @property
    def short(self) -> bool:
        return self.free < self.needed


@dataclass(frozen=True)
class TablePlan:
    table: Table
    rows: int
    moving: int
    #: The tenants the table's rows hold now ('' for none); a table without a tenant column holds none.
    tenants: tuple[str, ...] = ()

    @property
    def pending(self) -> bool:
        return self.table.renames or self.table.adds or bool(self.table.drops) or self.moving > 0

    @property
    def change(self) -> str:
        table, parts = self.table, []
        if table.adds:
            parts.append(f"adds {table.target}")
        if table.renames_tenant:
            parts.append(f"renames {table.tenant} to {table.target}")
        if table.renames_source:
            parts.append(f"renames {table.source} to {table.source_target}")
        if table.drops:
            parts.append(f"drops the empty {', '.join(table.drops)}")
        return ", ".join(parts) or "sets the tenant"


def survey_table(ch: ClickHouse, table: Table, tenant: str) -> TablePlan:
    held = f"groupUniqArray({MAX_TENANTS})({keys.old_tenant(table)})" if table.tenant else "[]"
    ((rows, moving, tenants),) = ch.rows(
        f"SELECT count(), countIf({keys.foreign(table)}), toJSONString({held}) FROM {table.rel.sql()} AS src",
        params=keys.tenant_params(tenant),
    )
    if table.drops and int(rows):
        held = ", ".join(f"{c} beside insight_{c}" for c in table.drops)
        raise InventoryError(
            f"{table.rel}: holds {held} and has {rows} row(s) — the old columns are dropped only from an empty "
            "table; settle its rows by hand. Nothing was changed"
        )
    return TablePlan(table=table, rows=int(rows), moving=int(moving), tenants=tuple(sorted(json.loads(tenants))))


def survey(ch: ClickHouse, tables: list[Table], tenant: str) -> list[TablePlan]:
    return [survey_table(ch, t, tenant) for t in tables]


def render(plans: list[TablePlan]) -> str:
    pending = [p for p in plans if p.pending]
    lines = [f"{'relation':<64} {'rows':>12} {'moving':>12}  change"]
    lines += [f"{p.table.relation:<64} {p.rows:>12} {p.moving:>12}  {p.change}" for p in pending]
    lines.append(f"tables changing: {len(pending)}")
    return "\n".join(lines)


def disks(ch: ClickHouse, plans: list[TablePlan]) -> list[Disk]:
    """Each disk holding a pending table's active parts, with what those parts take."""
    names = [p.table.relation for p in plans if p.pending]
    if not names:
        return []
    rows = ch.rows(
        """
        SELECT p.disk_name, any(d.free_space), sum(p.bytes_on_disk)
        FROM system.parts AS p
        INNER JOIN system.disks AS d ON d.name = p.disk_name
        WHERE p.active AND concat(p.database, '.', p.table) IN {tables:Array(String)}
        GROUP BY p.disk_name
        ORDER BY p.disk_name
        """,
        params={"tables": "[" + ", ".join(param_text(n) for n in names) + "]"},
    )
    return [Disk(name, int(free), int(in_scope)) for name, free, in_scope in rows]


def _gib(n: int) -> str:
    return f"{n / 2**30:.1f} GiB"


def render_disks(found: list[Disk]) -> str:
    return "\n".join(
        f"disk {d.name}: {_gib(d.free)} free, the tables to migrate take {_gib(d.in_scope)}, "
        f"apply needs {_gib(d.needed)} free ({DISK_HEADROOM}x){' — TOO LITTLE' if d.short else ''}"
        for d in found
    )


def check_disks(found: list[Disk]) -> None:
    """Refuse before anything changes when a disk lacks the room the copies need."""
    short = [d for d in found if d.short]
    if short:
        raise DiskSpaceError(
            "; ".join(
                f"disk {d.name} has {_gib(d.free)} free, but the tables to migrate take {_gib(d.in_scope)} "
                f"and apply needs {DISK_HEADROOM}x that ({_gib(d.needed)}) free"
                for d in short
            )
            + ". Free disk space or grow the volume, then deploy again. Nothing was changed"
        )
